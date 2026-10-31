import { HttpStatus, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { hash, verify } from '@node-rs/argon2';
import { Role } from '@rete/shared';
import { AuthService } from './auth.service';
import { LOGIN_LOCKOUT_CONFIG } from './login-lockout.config';
import { AccountRepository } from './repositories/account.repository';
import { LoginSettingsService } from '../login-settings/login-settings.service';

// argon2 は重い & 環境依存なのでモックする。検証ロジック（分岐 / 漏洩防止）に焦点を当てる。
jest.mock('@node-rs/argon2', () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

const mockedHash = hash as jest.MockedFunction<typeof hash>;
const mockedVerify = verify as jest.MockedFunction<typeof verify>;

describe('AuthService', () => {
  let service: AuthService;
  let accounts: {
    findByEmail: jest.Mock;
    findById: jest.Mock;
    findOidcCredentialState: jest.Mock;
    registerFailedAttempt: jest.Mock;
    resetLoginState: jest.Mock;
    updatePasswordAndClearFlag: jest.Mock;
  };
  let loginSettings: { getEffectivePasswordPolicy: jest.Mock };

  const lockoutConfig = { maxAttempts: 5, lockoutMs: 15 * 60_000 };

  /** 緩いポリシー（最小桁数 8・文字種要求なし）。changePassword の既定。 */
  const lenientPolicy = {
    minLength: 8,
    requireLowercase: false,
    requireUppercase: false,
    requireNumber: false,
    requireSymbol: false,
  };

  const activeAccount = {
    id: 'acc-1',
    email: 'admin@rete.local',
    name: 'Rete 管理者',
    passwordHash: 'stored-hash',
    isActive: true,
    role: Role.ADMIN,
    failedLoginAttempts: 0,
    lockedUntil: null,
  };

  beforeEach(async () => {
    accounts = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      findOidcCredentialState: jest.fn(),
      registerFailedAttempt: jest.fn(),
      resetLoginState: jest.fn(),
      updatePasswordAndClearFlag: jest.fn(),
    };
    loginSettings = { getEffectivePasswordPolicy: jest.fn().mockResolvedValue(lenientPolicy) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AccountRepository, useValue: accounts },
        { provide: LoginSettingsService, useValue: loginSettings },
        { provide: LOGIN_LOCKOUT_CONFIG, useValue: lockoutConfig },
      ],
    }).compile();
    service = moduleRef.get(AuthService);

    mockedHash.mockReset();
    mockedHash.mockResolvedValue('dummy-hash');
    mockedVerify.mockReset();
    mockedVerify.mockResolvedValue(false);

    // 失敗記録の既定戻り値（閾値未満・未ロック）。ロック発火テストでは個別に上書きする。
    accounts.registerFailedAttempt.mockResolvedValue({ failedLoginAttempts: 1, locked: false });
    accounts.resetLoginState.mockResolvedValue(undefined);
  });

  describe('validateCredentials', () => {
    it('資格情報が正しければ passwordHash を含まない最小ユーザーを返す', async () => {
      accounts.findByEmail.mockResolvedValue(activeAccount);
      mockedVerify.mockResolvedValue(true);

      const user = await service.validateCredentials('admin@rete.local', 'correct-pw');

      expect(user).toEqual({
        id: 'acc-1',
        email: 'admin@rete.local',
        name: 'Rete 管理者',
        role: Role.ADMIN,
        mustChangePassword: undefined,
        sessionCredentialVersion: createHmac(
          'sha256',
          process.env.SESSION_SECRET || 'dev-insecure-session-secret-change-me',
        )
          .update('stored-hash')
          .digest('base64url'),
      });
      expect(user).not.toHaveProperty('passwordHash');
    });

    it('アカウント不在でも dummy verify を 1 回回してから一律 401（timing 均一化）', async () => {
      accounts.findByEmail.mockResolvedValue(null);

      await expect(service.validateCredentials('nobody@rete.local', 'pw')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockedHash).toHaveBeenCalledTimes(1);
      expect(mockedVerify).toHaveBeenCalledTimes(1);
    });

    it('アカウントが無効化されていれば 401', async () => {
      accounts.findByEmail.mockResolvedValue({ ...activeAccount, isActive: false });

      await expect(service.validateCredentials('admin@rete.local', 'pw')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('パスワードが一致しなければ 401', async () => {
      accounts.findByEmail.mockResolvedValue(activeAccount);
      mockedVerify.mockResolvedValue(false);

      await expect(
        service.validateCredentials('admin@rete.local', 'wrong-pw'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    describe('ロックアウト（H6 / brute-force 防御）', () => {
      it('失敗時に registerFailedAttempt(id, maxAttempts, ロック期限) を呼ぶ（increment + 閾値ロックを原子化）', async () => {
        accounts.findByEmail.mockResolvedValue(activeAccount);
        mockedVerify.mockResolvedValue(false);

        await expect(
          service.validateCredentials('admin@rete.local', 'wrong-pw'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(accounts.registerFailedAttempt).toHaveBeenCalledTimes(1);
        const [id, maxAttempts, lockedUntil] = accounts.registerFailedAttempt.mock.calls[0];
        expect(id).toBe('acc-1');
        expect(maxAttempts).toBe(5);
        expect(lockedUntil).toBeInstanceOf(Date);
        // ロック期限は現在より未来（lockoutMs 後）。
        expect((lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());
      });

      it('registerFailedAttempt が locked:true を返したらロック警告を残す', async () => {
        accounts.findByEmail.mockResolvedValue(activeAccount);
        mockedVerify.mockResolvedValue(false);
        accounts.registerFailedAttempt.mockResolvedValue({ failedLoginAttempts: 5, locked: true });
        const warnSpy = jest
          .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
          .mockImplementation(() => undefined);

        await expect(
          service.validateCredentials('admin@rete.local', 'wrong-pw'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [message] = warnSpy.mock.calls[0];
        expect(message).not.toContain('admin@rete.local');
        expect(message).toContain('***@rete.local');
      });

      it('locked:false なら警告を残さない', async () => {
        accounts.findByEmail.mockResolvedValue(activeAccount);
        mockedVerify.mockResolvedValue(false);
        accounts.registerFailedAttempt.mockResolvedValue({ failedLoginAttempts: 2, locked: false });
        const warnSpy = jest
          .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
          .mockImplementation(() => undefined);

        await expect(
          service.validateCredentials('admin@rete.local', 'wrong-pw'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('ロック中（lockedUntil が未来）は実パスワード検証も失敗記録もせず 429、ただし timing 均一化の dummy verify は回す', async () => {
        const future = new Date(Date.now() + 10 * 60_000);
        accounts.findByEmail.mockResolvedValue({
          ...activeAccount,
          failedLoginAttempts: 5,
          lockedUntil: future,
        });

        await expect(
          service.validateCredentials('admin@rete.local', 'correct-pw'),
        ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
        // 応答時間均一化のため dummy hash に対しては verify を回すが、実 passwordHash では検証しない。
        expect(mockedVerify).toHaveBeenCalledTimes(1);
        expect(mockedVerify).toHaveBeenCalledWith('dummy-hash', 'correct-pw');
        expect(mockedVerify).not.toHaveBeenCalledWith('stored-hash', expect.anything());
        // ロック中は失敗記録（increment）しない。
        expect(accounts.registerFailedAttempt).not.toHaveBeenCalled();
      });

      it('ロック中の警告ログは email をマスクする（cmn-0075）', async () => {
        const future = new Date(Date.now() + 10 * 60_000);
        accounts.findByEmail.mockResolvedValue({
          ...activeAccount,
          failedLoginAttempts: 5,
          lockedUntil: future,
        });
        const warnSpy = jest
          .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
          .mockImplementation(() => undefined);

        await expect(
          service.validateCredentials('admin@rete.local', 'correct-pw'),
        ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [message] = warnSpy.mock.calls[0];
        expect(message).not.toContain('admin@rete.local');
        expect(message).toContain('***@rete.local');
      });

      it('ロック中の 429 応答は概算分を message にのみ載せ、details に数値を晒さない（set-0038）', async () => {
        // 約 10 分後に解除予定 → 切り上げで 10 分（境界の経過時間ぶれを吸収して 9〜10 を許容）。
        const future = new Date(Date.now() + 10 * 60_000);
        accounts.findByEmail.mockResolvedValue({
          ...activeAccount,
          failedLoginAttempts: 5,
          lockedUntil: future,
        });

        await service
          .validateCredentials('admin@rete.local', 'correct-pw')
          .then(() => {
            throw new Error('should have thrown');
          })
          .catch((err) => {
            expect(err.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
            const body = err.getResponse() as {
              code: string;
              message: string;
              details?: unknown;
            };
            expect(body.code).toBe('TOO_MANY_REQUESTS');
            // 機械可読な details に retryAfterMinutes 等の数値を晒さない（set-0038・情報露出の解消）。
            expect(body.details).toBeUndefined();
            // 文言は「ロック中の事実 + 概算分 + 管理者へ解除依頼の案内」（criteria 3）。概算分は message にのみ。
            expect(body.message).toContain('アカウントがロックされています');
            expect(body.message).toMatch(/約\d+分/);
            expect(body.message).toContain('管理者に解除を依頼');
          });
      });

      it('ロック期限切れ（lockedUntil が過去）はリセットしてから検証を続行し、正しい資格情報でログインできる', async () => {
        const past = new Date(Date.now() - 60_000);
        accounts.findByEmail.mockResolvedValue({
          ...activeAccount,
          failedLoginAttempts: 5,
          lockedUntil: past,
        });
        mockedVerify.mockResolvedValue(true);

        const user = await service.validateCredentials('admin@rete.local', 'correct-pw');

        expect(user.id).toBe('acc-1');
        expect(accounts.resetLoginState).toHaveBeenCalledWith('acc-1');
      });

      it('MFAを含む認証完了前は、成功したパスワード検証でも失敗カウントを残す', async () => {
        accounts.findByEmail.mockResolvedValue({ ...activeAccount, failedLoginAttempts: 3 });
        mockedVerify.mockResolvedValue(true);

        await service.validateCredentials('admin@rete.local', 'correct-pw');

        expect(accounts.resetLoginState).not.toHaveBeenCalled();
      });

      it('成功時、状態がクリーン（失敗 0・ロックなし）なら無駄な書き込みをしない', async () => {
        accounts.findByEmail.mockResolvedValue(activeAccount);
        mockedVerify.mockResolvedValue(true);

        await service.validateCredentials('admin@rete.local', 'correct-pw');

        expect(accounts.resetLoginState).not.toHaveBeenCalled();
      });
    });
  });

  describe('MFA challenge lockout', () => {
    it('アカウント単位の失敗回数を既存lockoutへ加算する', async () => {
      accounts.findById.mockResolvedValue(activeAccount);
      accounts.registerFailedAttempt.mockResolvedValue({ failedLoginAttempts: 4, locked: false });

      await expect(service.registerFailedMfaAttempt('acc-1')).resolves.toBe(false);

      expect(accounts.registerFailedAttempt).toHaveBeenCalledWith('acc-1', 5, expect.any(Date));
    });

    it('pending MFAもAccountがロック中なら429で拒否する', async () => {
      accounts.findById.mockResolvedValue({
        ...activeAccount,
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 60_000),
      });

      await expect(service.assertMfaChallengeAllowed('acc-1')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });

    it('MFA後の認証完了でAccountの失敗状態をリセットする', async () => {
      await service.resetLoginAttempts('acc-1');
      expect(accounts.resetLoginState).toHaveBeenCalledWith('acc-1');
    });
  });

  describe('findActiveUser', () => {
    it('有効なアカウントなら完全ユーザーを返す', async () => {
      accounts.findById.mockResolvedValue(activeAccount);

      await expect(service.findActiveUser('acc-1')).resolves.toEqual({
        id: 'acc-1',
        email: 'admin@rete.local',
        name: 'Rete 管理者',
        role: Role.ADMIN,
        mustChangePassword: undefined,
        sessionCredentialVersion: createHmac(
          'sha256',
          process.env.SESSION_SECRET || 'dev-insecure-session-secret-change-me',
        )
          .update('stored-hash')
          .digest('base64url'),
      });
    });

    it('存在しないアカウントなら null（強制ログアウト）', async () => {
      accounts.findById.mockResolvedValue(null);

      await expect(service.findActiveUser('missing')).resolves.toBeNull();
    });

    it('無効化済みなら null（強制ログアウト）', async () => {
      accounts.findById.mockResolvedValue({ ...activeAccount, isActive: false });

      await expect(service.findActiveUser('acc-1')).resolves.toBeNull();
    });
  });

  describe('changePassword（強制パスワード変更・set-0035）', () => {
    it('現在PW一致・新PWが別物でポリシー充足なら hash 更新＋フラグ解除する', async () => {
      accounts.findById.mockResolvedValue(activeAccount);
      // 1回目=現在PW照合(true)、2回目=新PWが現在と同一か(false=別物)。
      mockedVerify.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await service.changePassword('acc-1', 'current-pw', 'newPassw0rd');

      expect(mockedHash).toHaveBeenCalledWith('newPassw0rd');
      expect(accounts.updatePasswordAndClearFlag).toHaveBeenCalledWith('acc-1', 'dummy-hash');
    });

    it('現在PWが一致しなければ 401・更新しない', async () => {
      accounts.findById.mockResolvedValue(activeAccount);
      mockedVerify.mockResolvedValue(false);

      await expect(
        service.changePassword('acc-1', 'wrong-pw', 'newPassw0rd'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(accounts.updatePasswordAndClearFlag).not.toHaveBeenCalled();
    });

    it('新PWが現在と同一なら 422・更新しない（強制変更の無意味化を防ぐ）', async () => {
      accounts.findById.mockResolvedValue(activeAccount);
      // 1回目=現在PW照合(true)、2回目=新PWが現在と同一か(true=同一)。
      mockedVerify.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      await expect(
        service.changePassword('acc-1', 'current-pw', 'current-pw'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(accounts.updatePasswordAndClearFlag).not.toHaveBeenCalled();
    });

    it('新PWがポリシー違反なら 422・更新しない', async () => {
      accounts.findById.mockResolvedValue(activeAccount);
      mockedVerify.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      loginSettings.getEffectivePasswordPolicy.mockResolvedValue({
        ...lenientPolicy,
        minLength: 12,
      });

      await expect(service.changePassword('acc-1', 'current-pw', 'short1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(accounts.updatePasswordAndClearFlag).not.toHaveBeenCalled();
    });

    it('account 不在なら 401', async () => {
      accounts.findById.mockResolvedValue(null);

      await expect(service.changePassword('missing', 'pw', 'newPassw0rd')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('account が無効化済み（isActive=false）なら 401・PW照合まで進めない', async () => {
      accounts.findById.mockResolvedValue({ ...activeAccount, isActive: false });

      await expect(
        service.changePassword('acc-1', 'current-pw', 'newPassw0rd'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockedVerify).not.toHaveBeenCalled();
      expect(accounts.updatePasswordAndClearFlag).not.toHaveBeenCalled();
    });

    describe('ロックアウト共用（set-0041・validateCredentials と同じ機構）', () => {
      it('現在PW照合失敗時に registerFailedAttempt を呼ぶ', async () => {
        accounts.findById.mockResolvedValue(activeAccount);
        mockedVerify.mockResolvedValue(false);

        await expect(
          service.changePassword('acc-1', 'wrong-pw', 'newPassw0rd'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(accounts.registerFailedAttempt).toHaveBeenCalledTimes(1);
        const [id, maxAttempts, lockedUntil] = accounts.registerFailedAttempt.mock.calls[0];
        expect(id).toBe('acc-1');
        expect(maxAttempts).toBe(5);
        expect(lockedUntil).toBeInstanceOf(Date);
      });

      it('ロック中（lockedUntil が未来）は PW照合をスキップし TOO_MANY_REQUESTS で弾く', async () => {
        const lockedAccount = {
          ...activeAccount,
          failedLoginAttempts: 5,
          lockedUntil: new Date(Date.now() + 10 * 60_000),
        };
        accounts.findById.mockResolvedValue(lockedAccount);

        await expect(
          service.changePassword('acc-1', 'current-pw', 'newPassw0rd'),
        ).rejects.toMatchObject({
          status: HttpStatus.TOO_MANY_REQUESTS,
          response: { code: 'TOO_MANY_REQUESTS' },
        });
        expect(mockedVerify).not.toHaveBeenCalled();
        expect(accounts.updatePasswordAndClearFlag).not.toHaveBeenCalled();
      });

      it('ロック期限切れなら resetLoginState を呼んでから通常の PW照合を続行する', async () => {
        const expiredLockAccount = {
          ...activeAccount,
          failedLoginAttempts: 5,
          lockedUntil: new Date(Date.now() - 1000),
        };
        accounts.findById.mockResolvedValue(expiredLockAccount);
        mockedVerify.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        await service.changePassword('acc-1', 'current-pw', 'newPassw0rd');

        expect(accounts.resetLoginState).toHaveBeenCalledWith('acc-1');
        expect(accounts.updatePasswordAndClearFlag).toHaveBeenCalledWith('acc-1', 'dummy-hash');
      });

      it('照合成功時、失敗カウントが残っていれば resetLoginState で解除する', async () => {
        accounts.findById.mockResolvedValue({ ...activeAccount, failedLoginAttempts: 2 });
        mockedVerify.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        await service.changePassword('acc-1', 'current-pw', 'newPassw0rd');

        expect(accounts.resetLoginState).toHaveBeenCalledWith('acc-1');
      });
    });
  });
});
