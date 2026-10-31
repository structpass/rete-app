import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { MfaEnforcementGuard } from './mfa-enforcement.guard';
import type { LoginSettingsService } from '../../login-settings/login-settings.service';
import type { MfaService } from '../../mfa/mfa.service';

/**
 * 全体強制 MFA 遮断ガード（R8）の分岐単体テスト。
 * - 未認証 / 非 local / 除外 path / enforced OFF / confirmed 済 は素通し
 * - enforced かつ local かつ未設定の認証済リクエストのみ 403 MFA_SETUP_REQUIRED で遮断
 * - 除外判定が部分文字列一致でなく厳密な base / base/... 照合であること（バイパス防止）
 */
describe('MfaEnforcementGuard', () => {
  let loginSettings: { isMfaEnforced: jest.Mock };
  let mfaService: { hasConfirmedMfa: jest.Mock };
  let guard: MfaEnforcementGuard;

  beforeEach(() => {
    loginSettings = { isMfaEnforced: jest.fn().mockResolvedValue(true) };
    mfaService = { hasConfirmedMfa: jest.fn().mockResolvedValue(false) };
    guard = new MfaEnforcementGuard(
      loginSettings as unknown as LoginSettingsService,
      mfaService as unknown as MfaService,
    );
  });

  const ctx = (req: Partial<Request>): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

  const localReq = (path: string): Partial<Request> => ({
    user: { id: 'acc-1' } as never,
    session: { authMethod: 'local', authOrigin: 'local' } as never,
    path,
  });

  it('未認証（req.user 不在）は素通し', async () => {
    expect(await guard.canActivate(ctx({ session: {} as never, path: '/desk' }))).toBe(true);
    expect(loginSettings.isMfaEnforced).not.toHaveBeenCalled();
  });

  it('外部 IdP 認証（authOrigin=external-idp）は素通し（IdP MFA 尊重）', async () => {
    const req = {
      user: { id: 'a' } as never,
      session: { authOrigin: 'external-idp' } as never,
      path: '/desk',
    };
    expect(await guard.canActivate(ctx(req))).toBe(true);
    expect(loginSettings.isMfaEnforced).not.toHaveBeenCalled();
  });

  it.each(['external', '', 'EXTERNAL-IDP'])(
    '未知の authOrigin（%s）は fail-open せず強制対象に含める（d955）',
    async (authOrigin) => {
      const req = {
        user: { id: 'a' } as never,
        session: { authOrigin } as never,
        path: '/desk',
      };
      await expect(guard.canActivate(ctx(req))).rejects.toMatchObject({
        response: { code: 'MFA_SETUP_REQUIRED' },
      });
    },
  );

  it('旧セッション（authMethod だけが sso・authOrigin 無し）は local 相当として強制対象に含める（d955 の穴を塞ぐ）', async () => {
    const req = {
      user: { id: 'a' } as never,
      session: { authMethod: 'sso' } as never,
      path: '/desk',
    };
    await expect(guard.canActivate(ctx(req))).rejects.toMatchObject({
      response: { code: 'MFA_SETUP_REQUIRED' },
    });
    expect(loginSettings.isMfaEnforced).toHaveBeenCalled();
  });

  it('authOrigin 未設定（古いセッション等）は local 相当として強制対象に含める（fail-open 修正）', async () => {
    const req = { user: { id: 'a' } as never, session: {} as never, path: '/desk' };
    await expect(guard.canActivate(ctx(req))).rejects.toMatchObject({
      response: { code: 'MFA_SETUP_REQUIRED' },
    });
    expect(loginSettings.isMfaEnforced).toHaveBeenCalled();
  });

  it('全体強制 OFF なら素通し', async () => {
    loginSettings.isMfaEnforced.mockResolvedValue(false);
    expect(await guard.canActivate(ctx(localReq('/desk')))).toBe(true);
    expect(mfaService.hasConfirmedMfa).not.toHaveBeenCalled();
  });

  it('confirmed MFA を持つなら素通し', async () => {
    mfaService.hasConfirmedMfa.mockResolvedValue(true);
    expect(await guard.canActivate(ctx(localReq('/desk')))).toBe(true);
  });

  it('OIDC interaction を完了したローカルセッションも強制対象（後から MFA 必須にしても効く・d955）', async () => {
    const req = {
      user: { id: 'a' } as never,
      session: { authOrigin: 'local', oidcSsoAt: 1_700_000_000 } as never,
      path: '/desk',
    };
    await expect(guard.canActivate(ctx(req))).rejects.toMatchObject({
      response: { code: 'MFA_SETUP_REQUIRED' },
    });
  });

  it('enforced かつ local かつ未設定の保護ルートは 403 MFA_SETUP_REQUIRED で遮断', async () => {
    await expect(guard.canActivate(ctx(localReq('/desk')))).rejects.toMatchObject({
      response: { code: 'MFA_SETUP_REQUIRED' },
    });
    await expect(guard.canActivate(ctx(localReq('/api/v1/tasks')))).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it.each([
    '/settings/mfa',
    '/settings/mfa/setup',
    '/settings/login', // set-0134: MFA 制御盤（ADMIN 限定）= 制御盤自体は除外
    '/settings/login/password-policy', // 同上の sub path
    '/api/v1/settings/login/ip-whitelist', // グローバル prefix 込みでも除外される
    '/auth/me',
    '/auth/logout',
    '/auth/login',
    '/auth/login/mfa',
    '/api/v1/settings/mfa/confirm', // グローバル prefix 込みでも剥がして判定
  ])('除外 path %s は enforced+未設定でも素通し', async (path) => {
    expect(await guard.canActivate(ctx(localReq(path)))).toBe(true);
  });

  it.each([
    '/api/v1/settings/login/password-policy',
    '/api/v1/settings/login/mfa-enforcement-policy', // /settings/login/mfa と部分一致する名前（prefix 剥がしの確認）
  ])(
    '出口（強制を外す操作）%s は、強制の ON/OFF を評価する前に素通しする（自分で出口を塞がない）',
    async (path) => {
      expect(await guard.canActivate(ctx(localReq(path)))).toBe(true);
      // ON/OFF の読み出しにすら入らないこと（強制中でも戻せる）。
      expect(loginSettings.isMfaEnforced).not.toHaveBeenCalled();
      expect(mfaService.hasConfirmedMfa).not.toHaveBeenCalled();
    },
  );

  it('出口の素通しは /settings/login 配下の除外 1 本で成立する（別リストに二重に書かない・d849）', async () => {
    // EXEMPT_BASES から /settings/login を外すと、パスワードポリシーの読み書きは遮断される。
    // 出口が「EXEMPT_BASES の 1 本」で決まっていること（別の出口リストに依存していないこと）を固定する。
    const exemptBases = (MfaEnforcementGuard as unknown as { EXEMPT_BASES: string[] }).EXEMPT_BASES;
    expect(exemptBases).toContain('/settings/login');
    expect((MfaEnforcementGuard as unknown as Record<string, unknown>).EXIT_PATHS).toBeUndefined();
  });

  it.each([
    '/settings/mfa-export', // base の部分文字列だが別ルート → 遮断対象
    '/settings/loginator', // set-0134: /settings/login の部分文字列一致では除外しない（誤除外防止・base 一致 / base/... のみ）
    '/admin/auth/login/audit', // 中間に /auth/login を含むが base 一致でない → 遮断対象
  ])('部分文字列一致では除外しない（%s は遮断）', async (path) => {
    await expect(guard.canActivate(ctx(localReq(path)))).rejects.toBeInstanceOf(HttpException);
  });
});
