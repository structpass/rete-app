import { BadRequestException, Injectable } from '@nestjs/common';
import { DEFAULT_PASSWORD_POLICY, type PasswordPolicyShape } from '@rete/shared';
import { ok } from '../../common/dto';
import { isValidCidr, isIpAllowed } from '../../common/net/cidr';
import { LoginSettingsRepository } from './repositories/login-settings.repository';
import { toIpWhitelistEntryResponse, toPasswordPolicyResponse } from './login-settings.mapper';
import { UpdateIpWhitelistDto } from './dto/update-ip-whitelist.dto';
import { UpdatePasswordPolicyDto } from './dto/update-password-policy.dto';

/**
 * ログイン設定（Settings ST-2）のユースケース。パスワードポリシー（singleton）と IP 許可リスト（全置換）。
 * パスワード強度の強制適用は本トラックの責務外。IP 遮断そのものは `IpAllowlistGuard` が行い、ここは
 * 保存時に「この保存で自分が外に出ないか」だけを guard と同じ判定で見る（自己ロックアウトの穴・d827）。
 */
@Injectable()
export class LoginSettingsService {
  constructor(private readonly repo: LoginSettingsRepository) {}

  /** パスワードポリシーを返す。未設定なら既定値（mapper が補完）。 */
  async getPasswordPolicy() {
    return ok(toPasswordPolicyResponse(await this.repo.findPasswordPolicy()));
  }

  /** パスワードポリシーを全置換 upsert し、反映後の値を返す。 */
  async updatePasswordPolicy(dto: UpdatePasswordPolicyDto) {
    const updated = await this.repo.upsertPasswordPolicy({
      requireLowercase: dto.requireLowercase,
      requireUppercase: dto.requireUppercase,
      requireNumber: dto.requireNumber,
      requireSymbol: dto.requireSymbol,
      minLength: dto.minLength,
      mfaEnforced: dto.mfaEnforced,
    });
    return ok(toPasswordPolicyResponse(updated));
  }

  /**
   * 適用中のパスワード強度ポリシーを素の shape で返す（認証フロー＝強制パスワード変更検証用・set-0035）。
   * 未設定（行不在）は最小桁数のみ・文字種要求なしの既定（invite.service の effectivePolicy / frontend
   * の FALLBACK_POLICY と同値）。ok() ラップせず内部 API として直接返す。
   */
  async getEffectivePasswordPolicy(): Promise<PasswordPolicyShape> {
    const row = await this.repo.findPasswordPolicy();
    return {
      minLength: row?.minLength ?? DEFAULT_PASSWORD_POLICY.minLength,
      requireLowercase: row?.requireLowercase ?? DEFAULT_PASSWORD_POLICY.requireLowercase,
      requireUppercase: row?.requireUppercase ?? DEFAULT_PASSWORD_POLICY.requireUppercase,
      requireNumber: row?.requireNumber ?? DEFAULT_PASSWORD_POLICY.requireNumber,
      requireSymbol: row?.requireSymbol ?? DEFAULT_PASSWORD_POLICY.requireSymbol,
    };
  }

  /**
   * 全体強制 MFA が ON か（認証フロー / MfaEnforcementGuard 用の素の bool 読み出し）。
   * 未設定（行不在）は既定 false。ok() ラップせず内部 API として bool を直接返す。
   */
  async isMfaEnforced(): Promise<boolean> {
    const row = await this.repo.findPasswordPolicy();
    return row?.mfaEnforced ?? false;
  }

  /**
   * IP 許可リストの CIDR だけを返す（IpAllowlistGuard 用の内部読み出し・ok() ラップなし）。
   * 空配列＝制限なし（guard 側で "空＝全許可" を別扱いし自己ロックアウトを防ぐ）。
   */
  async getIpWhitelistCidrs(): Promise<string[]> {
    const rows = await this.repo.findIpWhitelist();
    return rows.map((r) => r.cidr);
  }

  /** IP 許可リストを返す。検出した currentIp（自己ロックアウト警告用）を同梱する。 */
  async getIpWhitelist(currentIp: string) {
    const rows = await this.repo.findIpWhitelist();
    return ok({ entries: rows.map(toIpWhitelistEntryResponse), currentIp });
  }

  /**
   * IP 許可リストを全置換し、反映後の一覧 + currentIp を返す。CIDR は DTO の IsCidrConstraint で検証済みだが、
   * 直叩き / 将来の経路追加に備え service でも二重防御で弾く（不正 1 件でも書き込まない）。
   * cmn-0233 MEDIUM4/5: 同じ CIDR を 2 行以上含む保存要求も、書式検査の後に弾く（全置換の事前検閲＝
   * 部分保存しない）。IPv6 は英字大小が同じ範囲を指すため小文字化して同一判定し、表記ゆれ由来の
   * 重複を取りこぼさない。検査順は「書式不正 → 重複」の順で固定し、書式不正と同時入力時は書式不正を
   * 優先する（criteria 4）。
   */
  async updateIpWhitelist(dto: UpdateIpWhitelistDto, currentIp: string) {
    for (const e of dto.entries) {
      if (!isValidCidr(e.cidr)) {
        throw new BadRequestException(`不正な CIDR です: ${e.cidr}`);
      }
    }
    // 重複検査（書式検査パス後のため全件が妥当な CIDR）。DB 側の一意制約は足さない方針（criteria 5）＝
    // 既存データの重複有無で migration が落ちうる / 利用者に重複値を返せない / の両害を避けるため。
    const seen = new Set<string>();
    for (const e of dto.entries) {
      // IPv6 の表記は `2001:DB8::/32` と `2001:db8::/32` が同じ範囲。toLowerCase での同一判定は
      // CIDR の prefix 部分（数字）には影響しない。IPv4 は数字と `.` のみで構成されるため変化しない。
      const key = e.cidr.toLowerCase();
      if (seen.has(key)) {
        throw new BadRequestException(`重複した CIDR です: ${e.cidr}`);
      }
      seen.add(key);
    }
    // 自己ロックアウトの穴（d827）: 遮断は保存の直後に効くため、自分の IP を含まないリストを保存すると
    // 管理セッションごと 403 になり、戻すための同じ PUT も遮断される（API からは戻す手が無く、DB を
    // 直接空にするしかない）。画面は「現在 IP を追加」を押させる手順にしていたが、押し忘れと API からの
    // 保存で出口が閉じるため、遮断の入口（guard）と同じ判定で保存要求そのものを断る。
    // 空リスト（制限解除）は遮断を解く向きなので、判定せず通す（出口は必ずこちらへ開いている）。
    if (dto.entries.length > 0) {
      const cidrs = dto.entries.map((e) => e.cidr);
      if (!currentIp || !isIpAllowed(currentIp, cidrs)) {
        throw new BadRequestException(
          `保存するとこの接続（${currentIp || 'IP を検出できません'}）が許可リストの外になり、管理画面ごと遮断されます。` +
            '現在の IP を含めて保存するか、すべて消して制限を解除してください。',
        );
      }
    }
    const rows = await this.repo.replaceIpWhitelist(
      dto.entries.map((e) => ({ cidr: e.cidr, note: e.note ?? '' })),
    );
    return ok({ entries: rows.map(toIpWhitelistEntryResponse), currentIp });
  }
}
