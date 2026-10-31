import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database';

/**
 * 認証本線がアカウントから読み出す列の allowlist（cmn-0237・MEDIUM3 切り出し）。
 *
 * 含まれるもの: 認証照合（passwordHash / isActive / mustChangePassword / failedLoginAttempts /
 * lockedUntil）と本人特定・最小ユーザー構築に要する列（id / email / name / role）。
 *
 * 含まれないもの（列追加/relation 追加で絶対に増えてはならない）: familyName / givenName /
 * createdAt / updatedAt および全 relation。
 *
 * **passwordHash を含むため、戻り値は Controller / DTO へ素通ししてはならない**。
 * 消費者（現在 2 箇所＝validateCredentials / changePassword、mapper 1 箇所＝toMinimalUser）
 * は必要な項目だけへ詰め替えるか、戻り型 `AccountCredentials` で受けて読み出しを allowlist 範囲に閉じる。
 * allowlist 外を読もうとすると TypeScript の型検査で落ちる（`Prisma.AccountGetPayload<...>` 由来）。
 *
 * 機械強制: spec のキー集合完全一致アサーションが「列が増えたら必ず落ちる」唯一のゲート。
 * 将来 Account に列や relation が追加された時、本ファイル更新を強制するためにこのファイルを
 * 編集する人は spec の差分を必ず確認すること。
 */
const accountCredentialsSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  passwordHash: true,
  failedLoginAttempts: true,
  lockedUntil: true,
} as const;

/** 認証本線が読み出す Account（passwordHash 等の秘密列を含む）。backend 内に閉じる（@rete/shared へ出さない）。 */
export type AccountCredentials = Prisma.AccountGetPayload<{
  select: typeof accountCredentialsSelect;
}>;

/**
 * Account の data-access 層（architecture-invariants §2）。
 * Service は Prisma を直接呼ばず、この Repository 経由で DB に触る。Entity をそのまま返す。
 */
@Injectable()
export class AccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 認証本線がアカウントをメール一意キーで読み出す（cmn-0237）。
   * 戻り型 `AccountCredentials` は allowlist 由来の狭い型で、allowlist 外を読むとコンパイルエラー。
   * **passwordHash を含むため、戻り値を Controller / DTO へ素通ししてはならない**。
   */
  findByEmail(email: string): Promise<AccountCredentials | null> {
    return this.prisma.account.findUnique({
      where: { email },
      select: accountCredentialsSelect,
    });
  }

  /**
   * 認証本線がアカウントを id 一意キーで読み出す（cmn-0237）。
   * 戻り型 `AccountCredentials` は allowlist 由来の狭い型で、allowlist 外を読むとコンパイルエラー。
   * **passwordHash を含むため、戻り値を Controller / DTO へ素通ししてはならない**。
   */
  findById(id: string): Promise<AccountCredentials | null> {
    return this.prisma.account.findUnique({
      where: { id },
      select: accountCredentialsSelect,
    });
  }

  /**
   * パスワードハッシュを更新し、強制変更フラグ（mustChangePassword）を落とす（set-0035）。
   * 強制パスワード変更の完了経路。フラグ解除と hash 更新を単一 UPDATE で原子化する。
   */
  async updatePasswordAndClearFlag(id: string, passwordHash: string): Promise<void> {
    await this.prisma.account.update({
      where: { id },
      data: { passwordHash, mustChangePassword: false, credentialsChangedAt: new Date() },
    });
  }

  findOidcCredentialState(id: string) {
    return this.prisma.account.findUnique({
      where: { id },
      select: { passwordHash: true, isActive: true, credentialsChangedAt: true },
    });
  }

  /**
   * ログイン失敗を 1 件記録し、閾値到達なら同一クエリ内で lockedUntil も立てる（H6）。
   * increment と「閾値判定 → ロック」を単一 UPDATE で原子化し、read-then-write の TOCTOU
   * （並行失敗でロックがすり抜ける / ロック期限が上書きで延びない）を構造的に排除する。
   * @param maxAttempts ロック発火の失敗回数閾値
   * @param lockedUntil 閾値到達時に設定するロック解除時刻
   * @returns 更新後の失敗回数と、この呼び出し時点でロック対象（閾値到達）かどうか
   */
  async registerFailedAttempt(
    id: string,
    maxAttempts: number,
    lockedUntil: Date,
  ): Promise<{ failedLoginAttempts: number; locked: boolean }> {
    const rows = await this.prisma.$queryRaw<
      { failedLoginAttempts: number; locked: boolean }[]
    >(Prisma.sql`
      UPDATE accounts
      SET failed_login_attempts = failed_login_attempts + 1,
          locked_until = CASE
            WHEN failed_login_attempts + 1 >= ${maxAttempts} THEN ${lockedUntil}
            ELSE locked_until
          END,
          updated_at = now()
      WHERE id = ${id}
      RETURNING failed_login_attempts AS "failedLoginAttempts",
                (failed_login_attempts >= ${maxAttempts}) AS locked
    `);
    // findByEmail 後にアカウントが削除されると RETURNING は 0 行。失敗記録なし・未ロック扱いで
    // 呼び出し側を 401 に倒す（undefined destructure による 500 を防ぐ）。
    return rows[0] ?? { failedLoginAttempts: 0, locked: false };
  }

  /**
   * 認証完了後・ロック期限切れ時に失敗カウントとロックを解除する（H6）。
   * cmn-0232 LOW2: findByEmail 後にアカウントが削除されている極小窓で P2025
   * （対象レコード無し）が投げられ、prisma-exception.filter が 404「対象のレコードが
   * 見つかりません」へ倒す設計と、認証失敗（401）側の応答とがズレる。対称となる
   * registerFailedAttempt は RETURNING 0 行を「失敗記録なし・未ロック」へフォールバック
   * して呼び出し側を 401 に倒す形のため、本関数も同じ形に揃え P2025 を握り潰して何事も
   * なかったかのように返す（呼び出し側は既に 401 経路で応答を確定しているため 200/204 を
   * 返して害はない）。
   */
  async resetLoginState(id: string): Promise<void> {
    await this.prisma.account.updateMany({
      where: {
        id,
        OR: [{ failedLoginAttempts: { not: 0 } }, { lockedUntil: { not: null } }],
      },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }
}
