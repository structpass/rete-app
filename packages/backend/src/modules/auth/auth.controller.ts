import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ok, okMessage } from '../../common/dto/response.dto';
import { clientIp, clientUserAgent } from '../../common/net/client-ip';
import { AuthService, AuthenticatedUser } from './auth.service';
import { toAccountResponse } from './auth.mapper';
import { OidcSessionLogoutService } from './oidc/oidc-session-logout.service';
import { clearOidcSessionCookies } from './oidc/oidc-session-cookie';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MfaCodeDto } from '../mfa/dto/mfa-code.dto';
import { MfaService } from '../mfa/mfa.service';
import { AuthenticatedGuard } from './guards/authenticated.guard';
import { setLocalAuthOrigin, setAuthOrigin } from './session-auth-origin';
import { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import { AUDIT_RETE_SYSTEM_NAME } from '../audit-logs/audit-logs.constants';
import { MFA_LOGIN_MAX_ATTEMPTS } from '../mfa/mfa.constants';
import { LoginSettingsService } from '../login-settings/login-settings.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly mfaService: MfaService,
    private readonly loginSettings: LoginSettingsService,
    private readonly auditRecorder: AuditRecorderService,
    private readonly oidcSessionLogout: OidcSessionLogoutService,
  ) {}

  // 資格情報を受ける高リスク endpoint はグローバル(30/60s)より厳しく 5 req / 60s に絞る（brute-force 抑制）。
  // R7: パスワード検証成功後、当該 account が MFA 有効なら full session を確立せず pendingMfa を session に退避し
  // { mfaRequired:true } を返す（HTTP 200・本人特定情報は最小）。MFA 無効なら従来どおり full session を確立する。
  // R8: enforced かつ MFA 未設定なら full session は確立しつつ { mfaSetupRequired:true } を返す（設定画面へ到達させる）。
  // R9: ローカル認証経路として出自を 'local' に印付け（MFA チャレンジ/Enforcement は 'local' のみ適用・
  // 旧欄 authMethod は互換のため併記・d955）。書く場所は session-auth-origin の 1 か所だけ（d1022）。
  // H5: login は横断 interceptor 対象外のため AuthController で actionType='login' を明示記録する（二重記録回避）。
  @ApiOperation({ summary: 'ログイン（email + password。MFA 有効時は要追加検証）' })
  @ApiBody({ type: LoginDto })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const user = await this.authService.validateCredentials(dto.email, dto.password);

    // MFA 有効なら full session を確立せず pending 状態へ（2 段階・R7）。
    if (await this.mfaService.verifyHasEnabledMfa(user.id)) {
      setLocalAuthOrigin(req);
      req.session.pendingMfaAccountId = user.id;
      req.session.pendingMfaAttempts = 0;
      delete req.session.pendingMfaInteractionUid;
      return ok({ mfaRequired: true });
    }

    await this.authService.resetLoginAttempts(user.id);
    await this.establishSession(req, user);
    setLocalAuthOrigin(req);
    delete req.session.mfaVerifiedAt;
    this.recordLogin(req, user);

    // enforced かつ MFA 未設定: session は確立しつつ設定フローへ誘導する（R8）。
    if (await this.requiresMfaSetup(user.id)) {
      return ok({ ...toAccountResponse(user), mfaSetupRequired: true });
    }
    return ok(toAccountResponse(user));
  }

  // R7: 2 段階目。pendingMfa を検証し、TOTP/バックアップコード成功で full session を確立する。
  // pending 不在は MFA_REQUIRED（先にパスワードログインが必要）。試行上限超で pending を破棄（MFA 段の独立カウンタ・H6 補完）。
  @ApiOperation({ summary: 'MFA チャレンジ（TOTP or バックアップコードで full session を確立）' })
  @ApiBody({ type: MfaCodeDto })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login/mfa')
  async loginMfa(@Body() dto: MfaCodeDto, @Req() req: Request) {
    if (req.session.pendingMfaInteractionUid) {
      throw new HttpException(
        { code: 'MFA_REQUIRED', message: 'OIDCログインは専用の認証画面から完了してください' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const accountId = req.session.pendingMfaAccountId;
    if (!accountId) {
      throw new HttpException(
        { code: 'MFA_REQUIRED', message: '先にメールアドレスとパスワードでログインしてください' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    await this.authService.assertMfaChallengeAllowed(accountId);
    const verified = await this.mfaService.verifyLoginChallenge(accountId, dto.code);
    if (!verified) {
      const accountLocked = await this.authService.registerFailedMfaAttempt(accountId);
      const attempts = (req.session.pendingMfaAttempts ?? 0) + 1;
      if (accountLocked || attempts >= MFA_LOGIN_MAX_ATTEMPTS) {
        // 上限到達: pending を破棄してパスワードからやり直させる（総当たり防御）。
        delete req.session.pendingMfaAccountId;
        delete req.session.pendingMfaAttempts;
      } else {
        req.session.pendingMfaAttempts = attempts;
      }
      throw new HttpException(
        { code: 'MFA_INVALID_CODE', message: '認証コードが正しくありません' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user = await this.authService.findActiveUser(accountId);
    if (!user) {
      // pending 中に account が無効化/削除された。pending を破棄して弾く。
      delete req.session.pendingMfaAccountId;
      delete req.session.pendingMfaAttempts;
      delete req.session.pendingMfaInteractionUid;
      throw new UnauthorizedException('アカウントが無効です');
    }

    await this.authService.resetLoginAttempts(accountId);
    delete req.session.pendingMfaAccountId;
    delete req.session.pendingMfaAttempts;
    delete req.session.pendingMfaInteractionUid;
    await this.establishSession(req, user);
    setLocalAuthOrigin(req);
    req.session.mfaVerifiedAt = Date.now();
    this.recordLogin(req, user);
    return ok(toAccountResponse(user));
  }

  // 開発機専用: パスワード段だけ済んだ状態（MFA チャレンジ待ち）を捨てて、パスワードからやり直させる。
  // 理由: 全員に MFA を強制した状態で MFA 未設定の開発用管理者しかいないと、ログインは通るがどの API も
  // 403（MFA_SETUP_REQUIRED）になり、設定を戻す道が閉じる（自分で自分の出口を塞ぐ）。試験や設定さえもできなく
  // なった時に、コードも DB も触らずに「ログインし直し」へ戻せる口を 1 つだけ置く。
  // 本番は NODE_ENV=production で 404（route 自体を生やさない）。MFA を弱める操作ではない（待ちを捨てるだけ）。
  @ApiOperation({ summary: '【開発機のみ】MFA チャレンジ待ちを破棄する' })
  @HttpCode(HttpStatus.OK)
  @Post('self-heal')
  async selfHeal(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('開発機でのみ使えます');
    }
    delete req.session.pendingMfaAccountId;
    delete req.session.pendingMfaAttempts;
    delete req.session.pendingMfaInteractionUid;
    // チャレンジ待ちを捨てたので、この接続は未ログインへ戻る（既に full session なら何も変わらない）。
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err) : resolve()));
    });
    res.clearCookie('connect.sid');
    return ok({ healed: true });
  }

  // status-check endpoint: 未ログインでも 401 にせず 200 + data:null を返す（rete-files-0024 / ADR 0030）。
  // 401 はブラウザが抑止不能な console error を出し、Next dev tools が「N Issues」として累積表示する。
  // 未ログインは正常状態でありエラー扱いしない。保護リソース側の 401（AuthenticatedGuard）は不変。
  // throttle は資格情報を受けないためグローバル既定（30 req/60s）に委ねる（login の 5/60s のような強化は不要）。
  @ApiOperation({ summary: '現在のログインユーザー情報（未ログインは data:null）' })
  @Get('me')
  async me(@Req() req: Request) {
    // authed のとき passport は req.user を必ず付与するが、deserialize の取りこぼしに備え req.user も併せて見る。
    const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
    if (!authed || !req.user) return ok(null);

    const user = req.user as AuthenticatedUser;
    const account = toAccountResponse(user);
    // 強制MFA × 未設定 × ローカル出自 の時だけ mfaSetupRequired を立てる（login R8 と同形・set-0032）。
    // リロード/画面遷移後もフロントが「設定強制中」を復元できるようにし、横断ゲートが業務操作をブロックし続ける。
    // 出自は authOrigin で見る（d955: interaction の完了では変わらない）。未設定は 'local' 相当として含める。
    if (
      (req.session?.authOrigin ?? 'local') === 'local' &&
      (await this.requiresMfaSetup(user.id))
    ) {
      return ok({ ...account, mfaSetupRequired: true });
    }
    return ok(account);
  }

  // set-0035: 強制パスワード変更（自己変更）。AuthenticatedGuard で認証境界を担保し、session の本人 id に対して
  // 現在PW照合 → 新PW がポリシー充足 → hash 更新＋mustChangePassword 解除を行う。PasswordChangeEnforcementGuard の
  // EXEMPT に含めて変更導線自体は遮断されない。資格情報を受けるため login と同じ 5 req/60s に絞る（総当たり抑制）。
  // actionType は明示記録（method 写像だと create になり不正確・H5 同旨）。
  @ApiOperation({ summary: '自己パスワード変更（強制変更フローの完了）' })
  @ApiBody({ type: ChangePasswordDto })
  @UseGuards(AuthenticatedGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('change-password')
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const user = req.user as AuthenticatedUser;
    const authMethod = req.session.authMethod;
    const authOrigin = req.session.authOrigin;
    const oidcSsoAt = req.session.oidcSsoAt;
    const mfaVerifiedAt = req.session.mfaVerifiedAt;
    await this.authService.changePassword(user.id, dto.currentPassword, dto.newPassword);

    // Password-versioned Passport principals revoke every other Rete session. Rotate and re-login this
    // browser with the new version so the user completing the forced-change flow stays signed in.
    const updatedUser = await this.authService.findActiveUser(user.id);
    if (!updatedUser) throw new UnauthorizedException('アカウントが無効です');
    await this.establishSession(req, updatedUser);
    // セッションを張り直した後も、認証の出自は張り直す前の値を引き継ぐ（d1022。書く場所は 1 か所だけ）。
    if (authMethod) req.session.authMethod = authMethod;
    if (authOrigin) setAuthOrigin(req, authOrigin);
    if (oidcSsoAt) req.session.oidcSsoAt = oidcSsoAt;
    if (mfaVerifiedAt) req.session.mfaVerifiedAt = mfaVerifiedAt;

    // 変更成功を fire-and-forget で監査記録（best-effort・記録失敗でもレスポンスを壊さない）。
    void this.auditRecorder.record({
      actorAccountId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      systemId: null,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'update',
      feature: '認証',
      summary: 'パスワードを変更しました',
      ipAddress: clientIp(req),
      userAgent: clientUserAgent(req),
    });

    return okMessage('パスワードを変更しました');
  }

  // H5: logout は POST だが method 写像すると actionType='create' になり不正確。
  // 横断 interceptor を除外して AuthController で actionType='logout' を明示記録する（二重記録回避）。
  // d1269: express-session の破棄だけでは oidc-provider の `_session`（SSO セッション・14 日）が残り、
  // Reference / 報告管理を開き直すとログイン画面を経ずに素通りしていた。SSO セッションも同じ操作で終わらせる。
  // 順序は SSO → express-session。SSO 側は best-effort（失敗しても throw しない）にして、DB の一時障害で
  // ログアウト自体が失敗する（画面に留まる）事態を避ける。cookie は成否に関わらず落とすので、ブラウザから
  // SSO セッションへ戻る道は残らない。
  @ApiOperation({ summary: 'ログアウト（Rete の session と OIDC の SSO セッションを破棄）' })
  @UseGuards(AuthenticatedGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // session destroy 前にスナップショットを取る（destroy 後は req.user が消える）。
    const user = req.user as AuthenticatedUser;
    const ip = clientIp(req);
    const ua = clientUserAgent(req);

    // 署名検証済みの `_session` だけを対象に SSO セッションを破棄する（他人の id を消せない）。
    // 消したかどうかに関わらず cookie 自体は落とす（不正・期限切れの残骸を残さない）。
    // service 側でも握るが、ここでも握ってログアウト本体を止めない（多層防御・d1269）。
    try {
      await this.oidcSessionLogout.endSession(req);
    } catch {
      // 失敗の痕跡は service が残す。ここでは「ログアウトは続行する」ことだけを保証する。
    }
    clearOidcSessionCookies(res, req.secure);

    await new Promise<void>((resolve, reject) => {
      req.logout((err) => (err ? reject(err as Error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err as Error) : resolve()));
    });

    // session 破棄成功後に記録（失敗時は Promise が reject してここに到達しない = 記録不要）。
    // fire-and-forget（best-effort）: 記録失敗でもレスポンスを壊さない。
    void this.auditRecorder.record({
      actorAccountId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      systemId: null,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'logout',
      feature: '認証',
      summary: 'ログアウトしました',
      ipAddress: ip,
      userAgent: ua,
    });

    return okMessage('ログアウトしました');
  }

  // --- 内部ヘルパー ---

  /** passport の req.logIn を Promise 化して full session を確立する（LocalAuthGuard.logIn 相当・serializeUser を起動）。 */
  // H10b: session fixation 対策。OWASP 定石どおり認証成功時に session ID を作り直す。
  // 攻撃者が事前に固定した session ID を認証後もそのまま昇格される余地を断つ（session.regenerate は
  // 旧 session を破棄して新しい session ID を発行する）。login（MFA 無効）/ loginMfa（MFA 成功）の
  // どちらも establishSession を通るため両経路で一律適用される。pendingMfa* は establishSession 直前に
  // 既に delete 済みのため、regenerate が保持すべき状態を壊すことはない。SSO は OIDC provider 自前
  // session（express-session と別系統）のため本経路では無影響。
  private establishSession(req: Request, user: AuthenticatedUser): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err as Error);
        req.logIn(user, (err2) => (err2 ? reject(err2 as Error) : resolve()));
      });
    });
  }

  /** enforced（全体強制）かつ当該 account が confirmed MFA 未設定か（設定フローへ誘導すべきか・R8）。 */
  private async requiresMfaSetup(accountId: string): Promise<boolean> {
    if (!(await this.loginSettings.isMfaEnforced())) return false;
    return !(await this.mfaService.hasConfirmedMfa(accountId));
  }

  /** ログイン成功を fire-and-forget で監査記録する（H5・記録失敗でもレスポンスを壊さない）。 */
  private recordLogin(req: Request, user: AuthenticatedUser): void {
    void this.auditRecorder.record({
      actorAccountId: user.id,
      actorName: user.name,
      actorEmail: user.email,
      systemId: null,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'login',
      feature: '認証',
      summary: 'ログインしました',
      ipAddress: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }
}
