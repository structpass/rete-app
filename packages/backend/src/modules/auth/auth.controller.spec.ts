import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from '../mfa/mfa.service';
import { LoginSettingsService } from '../login-settings/login-settings.service';
import { AuditRecorderService } from '../audit-logs/audit-recorder.service';

type MockSession = {
  destroy: jest.Mock;
  // H10b: express-session の session.regenerate(cb)。session fixation 対策で establishSession が呼ぶ。
  regenerate: jest.Mock;
  authMethod?: string;
  authOrigin?: 'local' | 'external-idp';
  oidcSsoAt?: number;
  pendingMfaAccountId?: string;
  pendingMfaAttempts?: number;
  pendingMfaInteractionUid?: string;
  mfaVerifiedAt?: number;
};

type MockReq = {
  user:
    | {
        id: string;
        email: string;
        name: string;
        role?: string;
        // set-0180: AccountResponseDto/AuthenticatedUser から featurePermissions/businessRoleId は撤去。
      }
    | undefined;
  isAuthenticated: jest.Mock;
  logIn: jest.Mock;
  logout: jest.Mock;
  session: MockSession;
  headers: Record<string, string>;
  ip: string;
  socket: { remoteAddress: string };
};

const makeReq = (overrides: Partial<MockReq> = {}): MockReq => ({
  user: {
    id: 'acc-1',
    email: 'user@example.com',
    name: '山田太郎',
    role: 'ADMIN',
    // set-0180: AccountResponseDto から featurePermissions/businessRoleId は撤去。
  },
  // passport が付与する isAuthenticated。me() は guard を外し自前で参照するため既定は true。
  isAuthenticated: jest.fn(() => true),
  // passport の req.logIn（full session 確立）。既定は成功。
  logIn: jest.fn((_user: unknown, cb: (err: Error | null) => void) => cb(null)),
  logout: jest.fn((cb: (err: Error | null) => void) => cb(null)),
  session: {
    destroy: jest.fn((cb: (err: Error | null) => void) => cb(null)),
    // H10b: 既定は成功 cb で即返す。regenerate の振る舞いは個別 test で上書き。
    regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
  },
  headers: { 'user-agent': 'jest-test' },
  ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' },
  ...overrides,
});

// set-0180: AccountResponseDto から featurePermissions/businessRoleId は撤去。
const ACCOUNT = {
  id: 'acc-1',
  email: 'user@example.com',
  name: '山田太郎',
  role: 'ADMIN',
};

const mockAuthService = {
  validateCredentials: jest.fn(),
  findActiveUser: jest.fn(),
  resetLoginAttempts: jest.fn(),
  registerFailedMfaAttempt: jest.fn(),
  assertMfaChallengeAllowed: jest.fn(),
  changePassword: jest.fn(),
};
const mockMfaService = {
  verifyHasEnabledMfa: jest.fn(),
  verifyLoginChallenge: jest.fn(),
  hasConfirmedMfa: jest.fn(),
};
const mockLoginSettings = {
  isMfaEnforced: jest.fn(),
};
/** AuditRecorderService のモック（best-effort: always resolves）。 */
const mockAuditRecorder = { record: jest.fn() };

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    mockAuditRecorder.record.mockResolvedValue(undefined);
    // 既定: パスワード検証成功・MFA 無効・強制 OFF（個別 test で上書き）。
    mockAuthService.validateCredentials.mockResolvedValue(ACCOUNT);
    mockAuthService.findActiveUser.mockResolvedValue(ACCOUNT);
    mockAuthService.resetLoginAttempts.mockResolvedValue(undefined);
    mockAuthService.registerFailedMfaAttempt.mockResolvedValue(false);
    mockAuthService.assertMfaChallengeAllowed.mockResolvedValue(undefined);
    mockMfaService.verifyHasEnabledMfa.mockResolvedValue(false);
    mockMfaService.verifyLoginChallenge.mockResolvedValue(true);
    mockMfaService.hasConfirmedMfa.mockResolvedValue(true);
    mockLoginSettings.isMfaEnforced.mockResolvedValue(false);
    mockAuthService.changePassword.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: MfaService, useValue: mockMfaService },
        { provide: LoginSettingsService, useValue: mockLoginSettings },
        { provide: AuditRecorderService, useValue: mockAuditRecorder },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('コントローラーが定義されていること', () => {
    expect(controller).toBeDefined();
  });

  describe('login', () => {
    it('MFA 無効なら full session を確立し公開 DTO を返すこと（R7）', async () => {
      const req = makeReq();
      const result = await controller.login(
        { email: ACCOUNT.email, password: 'pw' } as never,
        req as never,
      );

      expect(req.logIn).toHaveBeenCalledTimes(1);
      expect(req.session.authMethod).toBe('local');
      expect(req.session.authOrigin).toBe('local');
      expect(result).toEqual({ success: true, data: ACCOUNT });
    });

    it('MFA 有効なら full session を確立せず mfaRequired を返すこと（R7・2段階）', async () => {
      mockMfaService.verifyHasEnabledMfa.mockResolvedValue(true);
      const req = makeReq();
      const result = await controller.login(
        { email: ACCOUNT.email, password: 'pw' } as never,
        req as never,
      );

      expect(req.logIn).not.toHaveBeenCalled();
      expect(req.session.pendingMfaAccountId).toBe('acc-1');
      expect(req.session.pendingMfaInteractionUid).toBeUndefined();
      expect(req.session.authMethod).toBe('local');
      expect(req.session.authOrigin).toBe('local');
      expect(mockAuthService.resetLoginAttempts).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, data: { mfaRequired: true } });
    });

    it('強制 ON かつ MFA 未設定なら session を確立しつつ mfaSetupRequired を返すこと（R8）', async () => {
      mockLoginSettings.isMfaEnforced.mockResolvedValue(true);
      mockMfaService.hasConfirmedMfa.mockResolvedValue(false);
      const req = makeReq();
      const result = await controller.login(
        { email: ACCOUNT.email, password: 'pw' } as never,
        req as never,
      );

      expect(req.logIn).toHaveBeenCalledTimes(1);
      expect(mockAuthService.resetLoginAttempts).toHaveBeenCalledWith('acc-1');
      expect(result).toEqual({
        success: true,
        data: { ...ACCOUNT, mfaSetupRequired: true },
      });
    });

    it('actionType=login で auditRecorder.record を呼ぶこと（H5 明示記録）', async () => {
      await controller.login({ email: ACCOUNT.email, password: 'pw' } as never, makeReq() as never);
      expect(mockAuditRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'login', feature: '認証' }),
      );
    });

    // H10b: 認証成功時に session ID を作り直す（OWASP 定石・session fixation 対策）。
    // establishSession が regenerate を呼んだ後に logIn を呼ぶことで、攻撃者固定の session ID
    // が認証後もそのまま昇格される余地を断つ。
    it('full session 確立で req.session.regenerate → req.logIn の順で呼ぶこと（H10b session fixation 対策）', async () => {
      const order: string[] = [];
      const req = makeReq({
        session: {
          destroy: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          regenerate: jest.fn((cb: (err: Error | null) => void) => {
            order.push('regenerate');
            cb(null);
          }),
        },
        logIn: jest.fn((_user: unknown, cb: (err: Error | null) => void) => {
          order.push('logIn');
          cb(null);
        }),
      });
      await controller.login({ email: ACCOUNT.email, password: 'pw' } as never, req as never);

      expect(order).toEqual(['regenerate', 'logIn']);
      expect(req.session.regenerate).toHaveBeenCalledTimes(1);
      expect(req.logIn).toHaveBeenCalledTimes(1);
    });

    it('regenerate が失敗したらエラーを返し logIn へ進まないこと（H10b）', async () => {
      const req = makeReq({
        session: {
          destroy: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          regenerate: jest.fn((cb: (err: Error | null) => void) =>
            cb(new Error('regenerate failed')),
          ),
        },
      });
      await expect(
        controller.login({ email: ACCOUNT.email, password: 'pw' } as never, req as never),
      ).rejects.toThrow('regenerate failed');
      expect(req.logIn).not.toHaveBeenCalled();
    });
  });

  describe('login/mfa', () => {
    it('pending 検証成功で full session を確立し公開 DTO を返すこと', async () => {
      const req = makeReq({
        session: {
          destroy: jest.fn(),
          // H10b: 既存テストでも regenerate モックが必要（型整合のみ・呼び出し順序は問わない）。
          regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          pendingMfaAccountId: 'acc-1',
        },
      });
      const result = await controller.loginMfa({ code: '123456' } as never, req as never);

      expect(req.logIn).toHaveBeenCalledTimes(1);
      expect(req.session.pendingMfaAccountId).toBeUndefined();
      expect(req.session.mfaVerifiedAt).toEqual(expect.any(Number));
      expect(mockAuthService.assertMfaChallengeAllowed).toHaveBeenCalledWith('acc-1');
      expect(mockAuthService.resetLoginAttempts).toHaveBeenCalledWith('acc-1');
      expect(result).toEqual({ success: true, data: ACCOUNT });
    });

    it('pending 不在なら MFA_REQUIRED を投げること', async () => {
      const req = makeReq();
      await expect(
        controller.loginMfa({ code: '123456' } as never, req as never),
      ).rejects.toMatchObject({ response: { code: 'MFA_REQUIRED' } });
      expect(req.logIn).not.toHaveBeenCalled();
    });

    it('コード不一致なら MFA_INVALID_CODE を投げ試行回数を加算すること', async () => {
      mockMfaService.verifyLoginChallenge.mockResolvedValue(false);
      const req = makeReq({
        session: {
          destroy: jest.fn(),
          regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          pendingMfaAccountId: 'acc-1',
          pendingMfaAttempts: 0,
        },
      });
      await expect(
        controller.loginMfa({ code: '000000' } as never, req as never),
      ).rejects.toMatchObject({ response: { code: 'MFA_INVALID_CODE' } });
      expect(req.session.pendingMfaAttempts).toBe(1);
      expect(mockAuthService.registerFailedMfaAttempt).toHaveBeenCalledWith('acc-1');
      expect(req.logIn).not.toHaveBeenCalled();
    });

    it('試行上限（5回目）到達で pending を破棄しパスワードからやり直させること（総当たり防御）', async () => {
      mockMfaService.verifyLoginChallenge.mockResolvedValue(false);
      // 直前で 4 回失敗済み（pendingMfaAttempts=4）→ 今回が 5 回目 = 上限到達。
      const req = makeReq({
        session: {
          destroy: jest.fn(),
          regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          pendingMfaAccountId: 'acc-1',
          pendingMfaAttempts: 4,
        },
      });
      await expect(
        controller.loginMfa({ code: '000000' } as never, req as never),
      ).rejects.toMatchObject({ response: { code: 'MFA_INVALID_CODE' } });
      // pending が破棄され、以降は MFA_REQUIRED（パスワードからやり直し）に倒れる。
      expect(req.session.pendingMfaAccountId).toBeUndefined();
      expect(req.session.pendingMfaAttempts).toBeUndefined();
      expect(req.logIn).not.toHaveBeenCalled();
    });

    it('MFA失敗でアカウントlockoutに達した場合はpendingを破棄する', async () => {
      mockMfaService.verifyLoginChallenge.mockResolvedValue(false);
      mockAuthService.registerFailedMfaAttempt.mockResolvedValue(true);
      const req = makeReq({
        session: {
          destroy: jest.fn(),
          regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          pendingMfaAccountId: 'acc-1',
          pendingMfaAttempts: 0,
        },
      });

      await expect(
        controller.loginMfa({ code: '000000' } as never, req as never),
      ).rejects.toMatchObject({ response: { code: 'MFA_INVALID_CODE' } });
      expect(req.session.pendingMfaAccountId).toBeUndefined();
    });

    it('OIDC MFA pendingは通常ログイン用endpointで消費できない', async () => {
      const req = makeReq({
        session: {
          destroy: jest.fn(),
          regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          pendingMfaAccountId: 'acc-1',
          pendingMfaInteractionUid: 'oidc-uid',
        },
      });

      await expect(
        controller.loginMfa({ code: '123456' } as never, req as never),
      ).rejects.toMatchObject({ response: { code: 'MFA_REQUIRED' } });
      expect(mockMfaService.verifyLoginChallenge).not.toHaveBeenCalled();
    });

    // H10b: MFA 検証成功の full session 確立でも regenerate が走る（攻撃者固定 session ID を昇格させない）。
    // establishSession 直前で pendingMfa* を delete 済みなため、regenerate は持ち越すべき状態が無い。
    it('full session 確立で regenerate → logIn の順で呼ぶこと（H10b・2段階目も対象）', async () => {
      const order: string[] = [];
      const req = makeReq({
        session: {
          destroy: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          regenerate: jest.fn((cb: (err: Error | null) => void) => {
            order.push('regenerate');
            cb(null);
          }),
          pendingMfaAccountId: 'acc-1',
        },
        logIn: jest.fn((_user: unknown, cb: (err: Error | null) => void) => {
          order.push('logIn');
          cb(null);
        }),
      });
      await controller.loginMfa({ code: '123456' } as never, req as never);

      expect(order).toEqual(['regenerate', 'logIn']);
      expect(req.session.regenerate).toHaveBeenCalledTimes(1);
      expect(req.logIn).toHaveBeenCalledTimes(1);
      // pending は regenerate より先に delete 済（確立の瞬間に carryover しない）。
      expect(req.session.pendingMfaAccountId).toBeUndefined();
    });

    // H10b: code-reviewer MEDIUM 対応（login 経路と対称な failure 系 spec を loginMfa 経路にも追加）。
    // establishSession 単一経路で実体は等価だが、回帰検知の観点で対称性を保つ。
    it('regenerate が失敗したらエラーを返し logIn へ進まないこと（H10b・2段階目も対象）', async () => {
      const req = makeReq({
        session: {
          destroy: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          regenerate: jest.fn((cb: (err: Error | null) => void) =>
            cb(new Error('regenerate failed')),
          ),
          pendingMfaAccountId: 'acc-1',
        },
      });
      await expect(controller.loginMfa({ code: '123456' } as never, req as never)).rejects.toThrow(
        'regenerate failed',
      );
      expect(req.logIn).not.toHaveBeenCalled();
    });
  });

  describe('me', () => {
    it('ログイン済みなら現在のユーザーを公開 DTO で返すこと', async () => {
      const result = await controller.me(makeReq() as never);
      expect(result).toEqual({ success: true, data: ACCOUNT });
    });

    it('未ログイン（isAuthenticated=false）なら 401 ではなく data:null を返すこと（rete-files-0024）', async () => {
      const result = await controller.me(
        makeReq({ isAuthenticated: jest.fn(() => false), user: undefined }) as never,
      );
      expect(result).toEqual({ success: true, data: null });
    });

    it('強制 ON × MFA 未設定 × local 経路なら mfaSetupRequired を立てること（set-0032・リロード後の復元）', async () => {
      mockLoginSettings.isMfaEnforced.mockResolvedValue(true);
      mockMfaService.hasConfirmedMfa.mockResolvedValue(false);
      const result = await controller.me(
        makeReq({
          session: {
            destroy: jest.fn(),
            regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
            authMethod: 'local',
          },
        }) as never,
      );
      expect(result).toEqual({ success: true, data: { ...ACCOUNT, mfaSetupRequired: true } });
    });

    it('強制 ON × MFA 未設定 でも外部 IdP 認証（authOrigin=external-idp）なら mfaSetupRequired を立てないこと（set-0032・R9 IdP MFA 尊重）', async () => {
      mockLoginSettings.isMfaEnforced.mockResolvedValue(true);
      mockMfaService.hasConfirmedMfa.mockResolvedValue(false);
      const result = await controller.me(
        makeReq({
          session: {
            destroy: jest.fn(),
            regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
            authOrigin: 'external-idp',
          },
        }) as never,
      );
      expect(result).toEqual({ success: true, data: ACCOUNT });
    });

    it('旧セッション（authMethod だけが sso・authOrigin 無し）でも強制 ON × MFA 未設定なら mfaSetupRequired を立てること（d955 の穴を塞ぐ）', async () => {
      mockLoginSettings.isMfaEnforced.mockResolvedValue(true);
      mockMfaService.hasConfirmedMfa.mockResolvedValue(false);
      const result = await controller.me(
        makeReq({
          session: {
            destroy: jest.fn(),
            regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
            authMethod: 'sso',
          },
        }) as never,
      );
      expect(result).toEqual({ success: true, data: { ...ACCOUNT, mfaSetupRequired: true } });
    });
  });

  describe('change-password（強制パスワード変更・set-0035）', () => {
    it('service.changePassword(本人id, 現在PW, 新PW) を呼び完了メッセージを返すこと', async () => {
      const req = makeReq();
      const result = await controller.changePassword(
        { currentPassword: 'current-pw', newPassword: 'newPassw0rd' } as never,
        req as never,
      );

      expect(mockAuthService.changePassword).toHaveBeenCalledWith(
        'acc-1',
        'current-pw',
        'newPassw0rd',
      );
      expect(mockAuthService.findActiveUser).toHaveBeenCalledWith('acc-1');
      expect(req.session.regenerate).toHaveBeenCalledTimes(1);
      expect(req.logIn).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, data: { message: 'パスワードを変更しました' } });
    });

    it('パスワード変更後も現在ブラウザの出自（authOrigin）とMFA証跡を保持してsessionを再発行する', async () => {
      const req = makeReq({
        session: {
          destroy: jest.fn(),
          regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
          authMethod: 'local',
          authOrigin: 'local',
          oidcSsoAt: 5678,
          mfaVerifiedAt: 1234,
        },
      });

      await controller.changePassword(
        { currentPassword: 'current-pw', newPassword: 'newPassw0rd' } as never,
        req as never,
      );

      expect(req.session.authMethod).toBe('local');
      expect(req.session.authOrigin).toBe('local');
      expect(req.session.oidcSsoAt).toBe(5678);
      expect(req.session.mfaVerifiedAt).toBe(1234);
    });

    it('変更成功で actionType=update / feature=認証 の監査を記録すること', async () => {
      await controller.changePassword(
        { currentPassword: 'current-pw', newPassword: 'newPassw0rd' } as never,
        makeReq() as never,
      );
      expect(mockAuditRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'update', feature: '認証', actorAccountId: 'acc-1' }),
      );
    });

    it('service が失敗を投げたら伝播し監査記録しないこと', async () => {
      mockAuthService.changePassword.mockRejectedValue(
        new Error('現在のパスワードが正しくありません'),
      );
      await expect(
        controller.changePassword(
          { currentPassword: 'wrong', newPassword: 'newPassw0rd' } as never,
          makeReq() as never,
        ),
      ).rejects.toThrow('現在のパスワードが正しくありません');
      expect(mockAuditRecorder.record).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('req.logout → session.destroy の順で破棄し完了メッセージを返すこと', async () => {
      const req = makeReq();
      const result = await controller.logout(req as never);

      expect(req.logout).toHaveBeenCalledTimes(1);
      expect(req.session.destroy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, data: { message: 'ログアウトしました' } });
    });

    it('actionType=logout で auditRecorder.record を呼ぶこと（H5 明示記録・session 破棄成功後）', async () => {
      const req = makeReq();
      await controller.logout(req as never);
      expect(mockAuditRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'logout', feature: '認証' }),
      );
    });

    it('req.logout が失敗したらエラーを伝播し session.destroy へ進まないこと', async () => {
      const req = makeReq({
        logout: jest.fn((cb: (err: Error | null) => void) => cb(new Error('logout failed'))),
      });

      await expect(controller.logout(req as never)).rejects.toThrow('logout failed');
      expect(req.session.destroy).not.toHaveBeenCalled();
    });

    it('session.destroy が失敗したらエラーを伝播すること', async () => {
      const req = makeReq({
        session: {
          destroy: jest.fn((cb: (err: Error | null) => void) => cb(new Error('destroy failed'))),
          // H10b: 既存テストでも regenerate モックが必要（型整合のみ・logout は regenerate を呼ばない）。
          regenerate: jest.fn((cb: (err: Error | null) => void) => cb(null)),
        },
      });

      await expect(controller.logout(req as never)).rejects.toThrow('destroy failed');
    });
  });
});
