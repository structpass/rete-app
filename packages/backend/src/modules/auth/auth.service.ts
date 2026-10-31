import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Role } from '@rete/shared';
import { maskEmail } from '../../common/security/mask-email';
import { validatePassword } from '../../common/security/password-policy';
import { LoginSettingsService } from '../login-settings/login-settings.service';
import { LOGIN_LOCKOUT_CONFIG, type LoginLockoutConfig } from './login-lockout.config';
import { AccountRepository, AccountCredentials } from './repositories/account.repository';

/**
 * session / OIDC sub に載せる最小ユーザー情報。passwordHash は決して含めない。
 * role は権限判定（Roles ガード）と frontend の出し分けに使う（session には id のみ載せ、
 * deserialize で毎回 DB から引き直すため role 変更も即時反映される）。
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /**
   * 強制パスワード変更フラグ（set-0035）。管理者の初期/一時パスワード配布時に立つ。
   * true の間は PasswordChangeEnforcementGuard が業務 API を 403 で遮断し、フロントは変更画面へ誘導する。
   * 変更完了で false に落ちる（毎リクエスト DB から引き直すため即時反映）。
   * production の mapper（toMinimalUser/toUser）は必ず boolean を設定する。optional は全消費者が
   * falsy=未強制として安全に扱えるため（既存テストの AuthenticatedUser リテラルを壊さない最小差分）。
   */
  mustChangePassword?: boolean;
  /** Keyed password version stored with the Passport principal, never returned by auth.mapper. */
  sessionCredentialVersion?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly accounts: AccountRepository,
    private readonly loginSettings: LoginSettingsService,
    @Inject(LOGIN_LOCKOUT_CONFIG) private readonly lockout: LoginLockoutConfig,
  ) {}

  // account 不在時にも argon2 verify を 1 回回し、応答時間差で email の存在有無が漏れるのを防ぐ
  // （timing-based user enumeration 対策）。ダミー hash は初回のみ算出してキャッシュする。
  private dummyHashPromise: Promise<string> | null = null;
  private getDummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = hash('timing-equalization-placeholder');
    }
    return this.dummyHashPromise;
  }

  /**
   * email + password を検証し、成功時に最小ユーザー情報を返す。
   * 失敗は存在/不一致/無効を区別せず一律 UnauthorizedException（user enumeration 防止）。
   */
  async validateCredentials(email: string, password: string): Promise<AuthenticatedUser> {
    const account = await this.accounts.findByEmail(email);
    if (!account || !account.isActive) {
      // 存在するユーザーと同等の計算コストを払ってから一律で弾く（応答時間を均一化）。
      await verify(await this.getDummyHash(), password).catch(() => false);
      throw new UnauthorizedException('メールアドレスまたはパスワードが正しくありません');
    }

    // H6 ロックアウト判定。ロック中は資格情報を一切検証せず弾く（brute-force を時間で律速）。
    // 失敗カウント/ロック期限は DB 保持のため、IP やインスタンスを変えても回避できない。
    const now = new Date();
    if (account.lockedUntil) {
      if (account.lockedUntil > now) {
        // ロック中は資格情報を一切検証しないが、応答時間を通常経路（verify あり）と均一化するため
        // dummy verify を 1 回回す（ロック有無が応答時間差で漏れるのを防ぐ）。
        await verify(await this.getDummyHash(), password).catch(() => false);
        // ログイン失敗（warn）と同列の事象（operational-policy §2）。email は出すが資格情報は出さない。
        this.logger.warn(
          `Login blocked: account locked until ${account.lockedUntil.toISOString()} (${maskEmail(email)})`,
        );
        // 自動解除までの概算分（最低 1 分・切り上げ）。人間可読の message にのみ概算分を載せ、
        // 機械可読な details に数値（retryAfterMinutes）を晒さない（set-0038・自動化解析を難しくする＝MEDIUM 情報露出の解消）。
        const retryAfterMinutes = Math.max(
          1,
          Math.ceil((account.lockedUntil.getTime() - now.getTime()) / 60_000),
        );
        throw new HttpException(
          {
            code: 'TOO_MANY_REQUESTS',
            message: `アカウントがロックされています（自動解除まで約${retryAfterMinutes}分）。お急ぎの場合は管理者に解除を依頼してください`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      // ロック期限切れ: 新しい試行窓として失敗カウントをリセットしてから検証を続行する。
      await this.accounts.resetLoginState(account.id);
    }

    const valid = await verify(account.passwordHash, password);
    if (!valid) {
      // 失敗カウント increment と閾値到達時のロックを単一クエリで原子化（repository 側 / TOCTOU 排除）。
      const { failedLoginAttempts, locked } = await this.accounts.registerFailedAttempt(
        account.id,
        this.lockout.maxAttempts,
        new Date(now.getTime() + this.lockout.lockoutMs),
      );
      if (locked) {
        this.logger.warn(
          `Account locked after ${failedLoginAttempts} failed attempts (${maskEmail(email)})`,
        );
      }
      throw new UnauthorizedException('メールアドレスまたはパスワードが正しくありません');
    }

    // MFA利用者は第2要素を通るまで未認証なので、ここでは失敗状態を消さない。
    // 認証完了後にControllerがリセットし、pending sessionを作り直す総当たりを防ぐ。
    return this.toMinimalUser(account);
  }

  /** MFAを含む認証完了後に、アカウント単位の失敗/ロック状態を解除する。 */
  async resetLoginAttempts(accountId: string): Promise<void> {
    await this.accounts.resetLoginState(accountId);
  }

  /** Reject or release a pending MFA challenge using the same account lockout window as password login. */
  async assertMfaChallengeAllowed(accountId: string): Promise<void> {
    const account = await this.accounts.findById(accountId);
    if (!account || !account.isActive) {
      throw new UnauthorizedException('アカウントが無効です');
    }
    if (!account.lockedUntil) return;

    const now = new Date();
    if (account.lockedUntil > now) {
      const retryAfterMinutes = Math.max(
        1,
        Math.ceil((account.lockedUntil.getTime() - now.getTime()) / 60_000),
      );
      throw new HttpException(
        {
          code: 'TOO_MANY_REQUESTS',
          message: `アカウントがロックされています（自動解除まで約${retryAfterMinutes}分）。お急ぎの場合は管理者に解除を依頼してください`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // An expired lock starts a new failure window, matching validateCredentials.
    await this.accounts.resetLoginState(accountId);
  }

  /** MFA失敗もアカウント単位のDB lockoutへ加算し、session作り直しによる回避を防ぐ。 */
  async registerFailedMfaAttempt(accountId: string): Promise<boolean> {
    const account = await this.accounts.findById(accountId);
    if (!account || !account.isActive) return false;
    const { failedLoginAttempts, locked } = await this.accounts.registerFailedAttempt(
      accountId,
      this.lockout.maxAttempts,
      new Date(Date.now() + this.lockout.lockoutMs),
    );
    if (locked) {
      this.logger.warn(
        `Account locked after ${failedLoginAttempts} failed authentication attempts (${maskEmail(account.email)})`,
      );
    }
    return locked;
  }

  /**
   * session deserialize 用。account が削除/無効化されていれば null（= 強制ログアウト）。
   * 毎リクエスト DB から引き直すため、role 変更は即時反映される。
   */
  async findActiveUser(id: string): Promise<AuthenticatedUser | null> {
    const account = await this.accounts.findById(id);
    if (!account || !account.isActive) return null;
    return this.toUser(account);
  }

  /** login 直後（session 確立前）の最小マッピング。 */
  private toMinimalUser(account: AccountCredentials): AuthenticatedUser {
    return {
      id: account.id,
      email: account.email,
      name: account.name,
      role: account.role as Role,
      mustChangePassword: account.mustChangePassword,
      sessionCredentialVersion: this.sessionCredentialVersion(account.passwordHash),
    };
  }

  /** session deserialize 後の完全マッピング。 */
  private toUser(account: AccountCredentials): AuthenticatedUser {
    return {
      id: account.id,
      email: account.email,
      name: account.name,
      role: account.role as Role,
      mustChangePassword: account.mustChangePassword,
      sessionCredentialVersion: this.sessionCredentialVersion(account.passwordHash),
    };
  }

  /** Changing the password hash changes this keyed Passport-session version without a schema migration. */
  private sessionCredentialVersion(passwordHash: string): string {
    const secret = process.env.SESSION_SECRET || 'dev-insecure-session-secret-change-me';
    return createHmac('sha256', secret).update(passwordHash).digest('base64url');
  }

  /** Compare the first factor's version and original time, including pending MFA and in-flight requests. */
  async assertCurrentOidcLogin(user: AuthenticatedUser, authenticatedAt: number): Promise<void> {
    const current = await this.accounts.findOidcCredentialState(user.id);
    if (
      !current?.isActive ||
      !user.sessionCredentialVersion ||
      user.sessionCredentialVersion !== this.sessionCredentialVersion(current.passwordHash) ||
      !Number.isSafeInteger(authenticatedAt) ||
      (current.credentialsChangedAt &&
        authenticatedAt * 1000 <= current.credentialsChangedAt.getTime())
    ) {
      // OIDC auth_time uses integer seconds: a password change in the same second requires a retry.
      throw new UnauthorizedException(
        '認証の有効期限が切れました。少し待ってログインし直してください',
      );
    }
  }

  /**
   * 認証済みユーザー自身のパスワードを変更し、強制変更フラグ（mustChangePassword）を落とす（set-0035）。
   * 強制パスワード変更フローの本線。検証順:
   *  ① 現在のパスワード照合（誤りなら 401・本人確認）
   *  ② 新パスワードが現在と同一でないこと（強制変更が無意味化するのを防ぐ・422）
   *  ③ 適用中のパスワードポリシー充足（invite.accept と同じ validatePassword・違反は 422）
   *  ④ argon2 hash → repository で hash 更新＋フラグ解除を原子化
   * 認証境界は呼び出し側（AuthenticatedGuard）が担保し、userId は session の本人 id を渡す。
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const account = await this.accounts.findById(userId);
    // 認証済み前提だが、session 確立後に account が削除/無効化されている可能性に備える。
    if (!account || !account.isActive) {
      throw new UnauthorizedException('アカウントが無効です');
    }

    // set-0041: validateCredentials と同じロックアウト機構を共用する（セッション奪取後の
    // 現在パスワード総当たりを時間で律速。専用カウンタは作らず既存の failedLoginAttempts を使い回す）。
    const now = new Date();
    let priorAttempts = account.failedLoginAttempts;
    if (account.lockedUntil) {
      if (account.lockedUntil > now) {
        const retryAfterMinutes = Math.max(
          1,
          Math.ceil((account.lockedUntil.getTime() - now.getTime()) / 60_000),
        );
        throw new HttpException(
          {
            code: 'TOO_MANY_REQUESTS',
            message: `アカウントがロックされています（自動解除まで約${retryAfterMinutes}分）。お急ぎの場合は管理者に解除を依頼してください`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await this.accounts.resetLoginState(account.id);
      priorAttempts = 0;
    }

    // ① 現在のパスワード照合（本人確認）。
    if (!(await verify(account.passwordHash, currentPassword))) {
      const { failedLoginAttempts, locked } = await this.accounts.registerFailedAttempt(
        account.id,
        this.lockout.maxAttempts,
        new Date(now.getTime() + this.lockout.lockoutMs),
      );
      if (locked) {
        this.logger.warn(
          `Account locked after ${failedLoginAttempts} failed changePassword attempts (${maskEmail(account.email)})`,
        );
      }
      throw new UnauthorizedException('現在のパスワードが正しくありません');
    }

    // 成功: 失敗カウント/ロックが残っていれば解除する。
    if (priorAttempts > 0) {
      await this.accounts.resetLoginState(account.id);
    }

    // ② 新パスワードが現在と同一なら強制変更の意味がないため弾く。
    if (await verify(account.passwordHash, newPassword)) {
      throw new UnprocessableEntityException('現在のパスワードと異なるものを設定してください');
    }

    // ③ 適用中ポリシー充足（招待受諾と同一の合成検査・ドリフトなし）。
    const policy = await this.loginSettings.getEffectivePasswordPolicy();
    const violations = validatePassword(newPassword, policy);
    if (violations.length > 0) {
      throw new UnprocessableEntityException(violations.join(' / '));
    }

    // ④ hash 更新＋フラグ解除（原子化）。
    const passwordHash = await hash(newPassword);
    await this.accounts.updatePasswordAndClearFlag(account.id, passwordHash);
  }
}
