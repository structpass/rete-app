import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { PasswordChangeEnforcementGuard } from './password-change-enforcement.guard';

/**
 * 強制パスワード変更 遮断ガード（set-0035）の分岐単体テスト。
 * - 未認証 / mustChangePassword=false / 非 local / 除外 path は素通し
 * - mustChangePassword かつ local の保護ルートのみ 403 PASSWORD_CHANGE_REQUIRED で遮断
 * - 除外判定が部分文字列一致でなく厳密な base / base/... 照合であること（バイパス防止）
 */
describe('PasswordChangeEnforcementGuard', () => {
  let guard: PasswordChangeEnforcementGuard;

  beforeEach(() => {
    guard = new PasswordChangeEnforcementGuard();
  });

  const ctx = (req: Partial<Request>): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

  /** mustChangePassword=true の local 認証済リクエスト。 */
  const forcedReq = (path: string): Partial<Request> => ({
    user: { id: 'acc-1', mustChangePassword: true } as never,
    session: { authMethod: 'local', authOrigin: 'local' } as never,
    path,
  });

  it('未認証（req.user 不在）は素通し', () => {
    expect(guard.canActivate(ctx({ session: {} as never, path: '/desk' }))).toBe(true);
  });

  it('mustChangePassword=false は素通し', () => {
    const req = {
      user: { id: 'a', mustChangePassword: false } as never,
      session: { authMethod: 'local', authOrigin: 'local' } as never,
      path: '/desk',
    };
    expect(guard.canActivate(ctx(req))).toBe(true);
  });

  it('外部 IdP 認証（authOrigin=external-idp）は素通し（ローカルPWを持たない）', () => {
    const req = {
      user: { id: 'a', mustChangePassword: true } as never,
      session: { authOrigin: 'external-idp' } as never,
      path: '/desk',
    };
    expect(guard.canActivate(ctx(req))).toBe(true);
  });

  it('旧セッション（authMethod だけが sso・authOrigin 無し）は local 相当として強制する（d955）', () => {
    const req = {
      user: { id: 'a', mustChangePassword: true } as never,
      session: { authMethod: 'sso' } as never,
      path: '/desk',
    };
    expect(() => guard.canActivate(ctx(req))).toThrow(
      expect.objectContaining({
        response: { code: 'PASSWORD_CHANGE_REQUIRED', message: expect.any(String) },
      }),
    );
  });

  it('authOrigin 未設定（古いセッション等）は local 相当として強制対象に含める（fail-open 修正・cmn-0083）', () => {
    const req = {
      user: { id: 'a', mustChangePassword: true } as never,
      session: {} as never,
      path: '/desk',
    };
    expect(() => guard.canActivate(ctx(req))).toThrow(
      expect.objectContaining({
        response: { code: 'PASSWORD_CHANGE_REQUIRED', message: expect.any(String) },
      }),
    );
  });

  it('mustChangePassword かつ local の保護ルートは 403 PASSWORD_CHANGE_REQUIRED で遮断', () => {
    expect(() => guard.canActivate(ctx(forcedReq('/desk')))).toThrow(
      expect.objectContaining({
        response: { code: 'PASSWORD_CHANGE_REQUIRED', message: expect.any(String) },
      }),
    );
  });

  it('グローバル prefix 付き（/api/v1/...）でも遮断・除外が効く', () => {
    // cmn-0335: 例外の種類まで固定（どんな例外でも緑になる書き方を残さない）。
    expect(() => guard.canActivate(ctx(forcedReq('/api/v1/desk')))).toThrow(HttpException);
    expect(guard.canActivate(ctx(forcedReq('/api/v1/auth/change-password')))).toBe(true);
  });

  describe('除外 path（変更導線 / ポリシー取得 / me / logout / login）は素通し', () => {
    it.each([
      '/auth/change-password',
      '/settings/login/password-policy',
      '/auth/me',
      '/auth/logout',
      '/auth/login',
      '/auth/login/mfa',
      // OIDC フェデレーション handshake（session-login は到達時 authMethod='local' のため除外必須・set-0035 HIGH-1）
      '/auth/interaction',
      '/auth/interaction/abc-123/session-login',
      '/auth/interaction/abc-123/login',
    ])('%s は通す', (path) => {
      expect(guard.canActivate(ctx(forcedReq(path)))).toBe(true);
    });
  });

  it('除外は厳密照合＝部分文字列一致でバイパスできないこと（/auth/me-malicious は遮断）', () => {
    // cmn-0335: 例外の種類まで固定（どんな例外でも緑になる書き方を残さない）。
    expect(() => guard.canActivate(ctx(forcedReq('/auth/me-malicious')))).toThrow(HttpException);
  });
});
