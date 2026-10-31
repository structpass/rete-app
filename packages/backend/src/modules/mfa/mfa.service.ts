import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { MfaSetting } from '@prisma/client';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import { ok } from '../../common/dto';
import {
  encryptSecret,
  decryptSecret,
  isSecretCryptoConfigured,
} from '../../common/security/secret-crypto';
import { MfaRepository } from './repositories/mfa.repository';
import { toMfaStatusResponse } from './mfa.mapper';
import {
  MFA_BACKUP_CODE_ALPHABET,
  MFA_BACKUP_CODE_COUNT,
  MFA_BACKUP_CODE_LENGTH,
  MFA_TOTP_DIGITS,
  MFA_TOTP_EPOCH_TOLERANCE_SEC,
  MFA_TOTP_PERIOD_SEC,
  MFA_TOTP_ISSUER,
} from './mfa.constants';

/** TOTP コードの形（N 桁の数字のみ）。otplib は桁数不一致で例外を投げるため事前判定に使う。 */
const TOTP_CODE_PATTERN = new RegExp(`^\\d{${MFA_TOTP_DIGITS}}$`);

/**
 * MFA/TOTP（Settings ST-2-2）のユースケース。TOTP secret 生成/検証・バックアップコード発行/消費・暗号化往復を担う。
 *
 * セキュリティ境界（厳守・§1）:
 * - 暗号化 secret / codeHash / 平文 secret は return しない。otpauth URI と バックアップコード平文は専用レスポンスで一度だけ返す。
 * - secret 暗号鍵（MFA_TOTP_ENC_KEY）未設定時は MFA 機能を graceful degradation で無効化する（503・アプリは止めない）。
 */
@Injectable()
export class MfaService {
  constructor(private readonly repo: MfaRepository) {}

  /**
   * TOTP コードを検証する（otplib v13 functional・±30s 許容）。
   * login challenge / MFA設定確認 / MFA無効化 / MFA再設定 の 4 経路が単一 choke point として通る
   * （cmn-0094 で replay 防御もここに集約。4 経路すべてで一律適用になる設計・design-reviewer 確認済）。
   *
   * @param setting TOTP secret と lastUsedCounter を含む MfaSetting（呼び出し側で findSetting 取得済を渡す）。
   * @returns 検証成功で true、失敗（コード不一致 / replay）で false。
   */
  private async checkTotp(setting: MfaSetting, code: string): Promise<boolean> {
    // 非 TOTP 入力（バックアップコード等）は事前に弾く。otplib は桁数不一致で例外を投げるため、
    // ここで false を返さないとバックアップコードへの fallback が壊れる。
    if (!TOTP_CODE_PATTERN.test(code)) return false;
    const secret = decryptSecret(setting.totpSecret);
    const result = await verifyTotp({
      secret,
      token: code,
      epochTolerance: MFA_TOTP_EPOCH_TOLERANCE_SEC,
    });
    if (!result.valid) return false;

    // cmn-0094 (H10a / ADR 0040 revisit) replay 防御:
    // otplib の delta から「使用された TOTP step counter」を算出し、既に同値以上が使われていれば拒否。
    // これで実効約90秒の replay window が「once」相当に縮退する（parallel race でも条件付き update で安全）。
    // code-reviewer MEDIUM-1（M1）: updateLastUsedCounterIfNewer の戻り値（count===1 = より新しい値の記録に成功）を見て
    // false なら「並行他経路で同値以上の counter が先に書き込まれた」= 並列 duplicate の 1 件化。true のみ受理。
    const currentCounter = Math.floor(Date.now() / 1000 / MFA_TOTP_PERIOD_SEC);
    const usedCounter = currentCounter + (result.delta ?? 0);
    if (setting.lastUsedCounter !== null && setting.lastUsedCounter >= usedCounter) {
      return false;
    }
    const updated = await this.repo.updateLastUsedCounterIfNewer(setting.accountId, usedCounter);
    return updated;
  }

  /** 暗号鍵が無ければ MFA 機能は利用不可（graceful degradation）。各書込系の冒頭で弾く。 */
  private assertCryptoReady(): void {
    if (!isSecretCryptoConfigured()) {
      throw new ServiceUnavailableException('MFA は現在利用できません（暗号鍵が未設定です）');
    }
  }

  /** 自分の MFA 状態を返す（secret は含めない）。 */
  async getStatus(accountId: string) {
    return ok(toMfaStatusResponse(await this.repo.findSetting(accountId)));
  }

  /**
   * setup: TOTP secret を新規生成・暗号化して enabled=false で保管し、QR 用 otpauth URI を一度だけ返す。
   * 既に有効化済み（enabled）の場合は再 setup を拒否する（secret 巻き戻しによる MFA ダウングレード防止）。
   * 再設定したい場合は先に disable（コード本人確認が必要）で無効化させる。未確認（enabled=false）の再 setup は許す。
   */
  async setup(accountId: string, accountEmail: string) {
    this.assertCryptoReady();
    // 有効化済み MFA を session だけで無検証ダウングレードできる穴を塞ぐ（要・先 disable）。
    const existing = await this.repo.findSetting(accountId);
    if (existing?.enabled) {
      throw new BadRequestException(
        '二段階認証は既に有効です。再設定するには一度無効化してください',
      );
    }
    const secret = generateSecret();
    const otpauthUri = generateURI({ issuer: MFA_TOTP_ISSUER, label: accountEmail, secret });
    await this.repo.upsertSecret(accountId, encryptSecret(secret));
    return ok({ otpauthUri });
  }

  /**
   * confirm: 初回 TOTP 検証に成功したら enabled=true + confirmedAt をセットし、バックアップコード平文配列を一度だけ返す。
   * setup 未実行（行不在）は BadRequest。コード不一致は MFA_INVALID_CODE。
   */
  async confirm(accountId: string, code: string) {
    this.assertCryptoReady();
    const setting = await this.repo.findSetting(accountId);
    if (!setting) {
      throw new BadRequestException('MFA のセットアップが開始されていません');
    }
    if (!(await this.checkTotp(setting, code))) {
      throw this.invalidCode();
    }
    const { plain, hashes } = await this.generateBackupCodes();
    await this.repo.confirmWithBackupCodes(accountId, hashes);
    return ok({ backupCodes: plain });
  }

  /**
   * disable: TOTP コード or バックアップコードで本人確認した上で MfaSetting/MfaBackupCode を削除する。
   * 有効化済み（enabled）でなければ無効化対象が無いため BadRequest。
   */
  async disable(accountId: string, code: string) {
    this.assertCryptoReady();
    const setting = await this.repo.findSetting(accountId);
    if (!setting || !setting.enabled) {
      throw new BadRequestException('MFA は有効化されていません');
    }
    const verified = await this.verifyCode(setting, code);
    if (!verified) {
      throw this.invalidCode();
    }
    await this.repo.deleteSetting(accountId);
    return ok({ disabled: true });
  }

  /**
   * regenerate: 本人確認の上でバックアップコードを再発行し、新しい平文配列を一度だけ返す（旧コードは全て失効）。
   */
  async regenerateBackupCodes(accountId: string, code: string) {
    this.assertCryptoReady();
    const setting = await this.repo.findSetting(accountId);
    if (!setting || !setting.enabled) {
      throw new BadRequestException('MFA は有効化されていません');
    }
    const verified = await this.verifyCode(setting, code);
    if (!verified) {
      throw this.invalidCode();
    }
    const { plain, hashes } = await this.generateBackupCodes();
    await this.repo.replaceBackupCodes(accountId, hashes);
    return ok({ backupCodes: plain });
  }

  /**
   * ログインチャレンジ（R7・auth から呼ばれる内部 API）。TOTP→バックアップコードの順で検証し、成否を bool で返す。
   * 有効化済み setting が無い account に対しては false（呼び出し側で弾く前提・防御的に false）。
   *
   * d21: 有効化の印（enabled）だけでなく、実際に MFA コードを照合できる状態まで確かめる。
   * 確認済み（confirmedAt あり）でない行に secret を上書きすれば、印を残したまま次のコードを攻撃者が
   * 握る secret で通せる（setup は未確認行の再実行を許す）。暗号鍵の欠落も照合不能として false（fail closed）。
   */
  async verifyLoginChallenge(accountId: string, code: string): Promise<boolean> {
    if (!isSecretCryptoConfigured()) return false;
    const setting = await this.repo.findEnabledSetting(accountId);
    if (!setting) return false;
    return this.verifyCode(setting, code);
  }

  /** account が confirmed（有効化済）な MFA を持つか（enforcement guard 用）。 */
  async hasConfirmedMfa(accountId: string): Promise<boolean> {
    return (await this.repo.findConfirmedSetting(accountId)) !== null;
  }

  /**
   * 管理者による MFA 強制リセット（set-0033・P6）。本人のコード検証を経ずに対象 account の
   * MfaSetting/バックアップコードを削除する。TOTP・バックアップコードを全喪失した利用者を
   * DB 直編集せず運用で復旧するための管理者専用パス（リセット後は強制 MFA 有効なら次回ログインで再設定を要求）。
   *
   * - self-service の `disable`（本人がコード確認の上で削除）と異なり**コード本人確認はしない**。
   *   認可境界は呼び出し側の @Roles(ADMIN)（MembersService 経由でのみ到達・actor は必ずシステム管理者）。
   * - 削除は純 DB 操作のため暗号鍵未設定（graceful degradation）でも実行できる（assertCryptoReady は課さない＝復旧をブロックしない）。
   * @returns 実際にリセットした（設定が存在した）なら true / 元から未設定なら false（呼び出し側が no-op 判定に使う）。
   */
  async adminResetMfa(targetAccountId: string): Promise<boolean> {
    const setting = await this.repo.findSetting(targetAccountId);
    if (!setting) return false;
    await this.repo.deleteSetting(targetAccountId);
    return true;
  }

  /**
   * account が MFA チャレンジを課すべきか（= enabled な MfaSetting を持つか・R7 のログイン段階分岐用）。
   * 暗号鍵未設定（graceful degradation）時は MFA を課せないため false（パスワードのみで通す）。
   */
  async verifyHasEnabledMfa(accountId: string): Promise<boolean> {
    if (!isSecretCryptoConfigured()) return false;
    const setting = await this.repo.findSetting(accountId);
    return Boolean(setting?.enabled);
  }

  // --- 内部ヘルパー ---

  /**
   * code を TOTP として検証し、失敗時はバックアップコードとして照合する。
   * バックアップコードは未使用分を 1 件ずつ argon2 verify し、一致したら consume（single-use・条件付き update で二重消費防止）。
   *
   * 4 経路（login challenge / confirm / disable / regenerate）が通る単一 choke point。
   * TOTP パスは checkTotp に replay 防御を集約したため、本メソッド経由でも 4 経路一律で replay が塞がる
   * （cmn-0094・design-reviewer 確認済の構造）。
   */
  private async verifyCode(setting: MfaSetting, code: string): Promise<boolean> {
    if (await this.checkTotp(setting, code)) {
      return true;
    }
    // バックアップコード照合（single-use・replay 防御は usedAt null 条件で repo 側に閉じる）。
    const candidates = await this.repo.findUnusedBackupCodes(setting.accountId);
    for (const candidate of candidates) {
      const matched = await verify(candidate.codeHash, code).catch(() => false);
      if (matched) {
        // 条件付き update で usedAt をセット。並行検証で既に消費済みなら false（実質再利用拒否）。
        return this.repo.consumeBackupCode(candidate.id);
      }
    }
    return false;
  }

  /** バックアップコードを N 個生成し、平文配列（一度だけ返す用）と argon2 ハッシュ配列を返す。 */
  private async generateBackupCodes(): Promise<{ plain: string[]; hashes: string[] }> {
    const plain = Array.from({ length: MFA_BACKUP_CODE_COUNT }, () => randomBackupCode());
    const hashes = await Promise.all(plain.map((c) => hash(c)));
    return { plain, hashes };
  }

  /** MFA_INVALID_CODE（401）。auth/設定の両経路で同一 code を返す。 */
  private invalidCode(): HttpException {
    return new HttpException(
      { code: 'MFA_INVALID_CODE', message: '認証コードが正しくありません' },
      HttpStatus.UNAUTHORIZED,
    );
  }
}

/** 紛らわしい文字を除いた alphabet から暗号学的乱数でバックアップコードを 1 個生成する。 */
function randomBackupCode(): string {
  let out = '';
  for (let i = 0; i < MFA_BACKUP_CODE_LENGTH; i++) {
    out += MFA_BACKUP_CODE_ALPHABET[randomInt(MFA_BACKUP_CODE_ALPHABET.length)];
  }
  return out;
}
