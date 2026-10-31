import { Injectable } from '@nestjs/common';
import { MfaBackupCode, MfaSetting } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

/**
 * MFA/TOTP のデータアクセス層（§2 Repository 分離）。Service は本クラス経由でのみ DB に触る。
 * 暗号化 secret / codeHash の生成・検証ロジックは Service の責務で、Repo は永続化操作のみを担う。
 */
@Injectable()
export class MfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** account の MFA 設定を引く（未設定なら null）。 */
  findSetting(accountId: string): Promise<MfaSetting | null> {
    return this.prisma.mfaSetting.findUnique({ where: { accountId } });
  }

  /** 有効化済み（enabled=true かつ confirmedAt あり）の MFA 設定を引く（未設定・未確認・無効なら null）。 */
  findEnabledSetting(accountId: string): Promise<MfaSetting | null> {
    return this.prisma.mfaSetting.findFirst({
      where: { accountId, enabled: true, confirmedAt: { not: null } },
    });
  }

  /**
   * setup: 暗号化 secret を enabled=false で upsert する（既存があれば未確認状態へ巻き戻す＝再セットアップ）。
   * confirm 前の secret は何度上書きしても安全（有効化していない）。再 setup 時は確認状態をリセットする。
   * lastUsedCounter も同時に null へリセットする（旧 secret の step を引きずらない・cmn-0094 LOW1 是正）。
   */
  upsertSecret(accountId: string, encryptedSecret: string): Promise<MfaSetting> {
    return this.prisma.mfaSetting.upsert({
      where: { accountId },
      create: { accountId, totpSecret: encryptedSecret, enabled: false, confirmedAt: null },
      update: {
        totpSecret: encryptedSecret,
        enabled: false,
        confirmedAt: null,
        lastUsedCounter: null,
      },
    });
  }

  /**
   * confirm: enabled=true + confirmedAt をセットし、バックアップコードを総入れ替えする（旧コード全削除→新規作成）を
   * 単一トランザクションで原子的に実行する。途中失敗は全ロールバック（有効化とコード発行の片側成立を防ぐ）。
   */
  async confirmWithBackupCodes(accountId: string, codeHashes: string[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.mfaBackupCode.deleteMany({ where: { accountId } }),
      this.prisma.mfaBackupCode.createMany({
        data: codeHashes.map((codeHash) => ({ accountId, codeHash })),
      }),
      this.prisma.mfaSetting.update({
        where: { accountId },
        data: { enabled: true, confirmedAt: new Date() },
      }),
    ]);
  }

  /** regenerate: バックアップコードのみ総入れ替えする（setting は変更しない）。 */
  async replaceBackupCodes(accountId: string, codeHashes: string[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.mfaBackupCode.deleteMany({ where: { accountId } }),
      this.prisma.mfaBackupCode.createMany({
        data: codeHashes.map((codeHash) => ({ accountId, codeHash })),
      }),
    ]);
  }

  /** disable: MfaSetting を削除する（onDelete Cascade で関連 MfaBackupCode も消えるが、明示削除で原子化する）。 */
  async deleteSetting(accountId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.mfaBackupCode.deleteMany({ where: { accountId } }),
      this.prisma.mfaSetting.deleteMany({ where: { accountId } }),
    ]);
  }

  /** 未使用のバックアップコードを引く（検証で 1 件ずつ argon2 照合する）。 */
  findUnusedBackupCodes(accountId: string): Promise<MfaBackupCode[]> {
    return this.prisma.mfaBackupCode.findMany({
      where: { accountId, usedAt: null },
    });
  }

  /**
   * バックアップコードを使用済みにする（single-use）。usedAt が既にセットされていれば更新 0 件で false を返す
   * （並行検証で同一コードを二重消費するのを防ぐ条件付き update）。
   */
  async consumeBackupCode(id: string): Promise<boolean> {
    const result = await this.prisma.mfaBackupCode.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return result.count === 1;
  }

  /** account が confirmed（有効化済）な MfaSetting を持つか引く（enforcement guard 用）。無ければ null。 */
  findConfirmedSetting(accountId: string): Promise<MfaSetting | null> {
    return this.prisma.mfaSetting.findFirst({
      where: { accountId, enabled: true, confirmedAt: { not: null } },
    });
  }

  /**
   * replay 対策（cmn-0094・ADR 0040 revisit H10a）で TOTP 検証成功時に最後の使用 counter を記録する。
   * 条件: `lastUsedCounter < counter`（null を含む）を満たす行だけ更新する。
   * これで並行検証で counter が同値・過去値に固着しても「より新しい counter だけ」が勝つ（write-write race でも
   * 後続の同等 refresh が過去側に巻き戻らない）。count が 1 なら「より新しい値で更新できた」、0 なら
   * 「既に同値以上が他経路で記録されていた」= replay 防御上は等価（何もしない）。
   *
   * @returns 更新できたら true / 既存値が同等以上なら false（service 層は結果を見ないが、replay 関連の将来
   *   監査ログ用に bool で返す）。
   */
  async updateLastUsedCounterIfNewer(accountId: string, counter: number): Promise<boolean> {
    const result = await this.prisma.mfaSetting.updateMany({
      where: {
        accountId,
        OR: [{ lastUsedCounter: null }, { lastUsedCounter: { lt: counter } }],
      },
      data: { lastUsedCounter: counter },
    });
    return result.count === 1;
  }
}
