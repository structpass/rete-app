import { hash } from '@node-rs/argon2';
import { generate, generateSecret } from 'otplib';
import { BadRequestException } from '@nestjs/common';
import { MfaService } from './mfa.service';
import { encryptSecret } from '../../common/security/secret-crypto';
import { MFA_BACKUP_CODE_COUNT } from './mfa.constants';

/**
 * MfaService のユニットテスト。Repository はモックし、otplib / argon2 / AES-GCM は実値で round-trip 検証する
 * （secret 暗号往復・TOTP 検証・バックアップコード single-use 消費）。
 */
describe('MfaService', () => {
  const ORIGINAL = process.env.MFA_TOTP_ENC_KEY;
  let repo: {
    findSetting: jest.Mock;
    findEnabledSetting: jest.Mock;
    findConfirmedSetting: jest.Mock;
    upsertSecret: jest.Mock;
    confirmWithBackupCodes: jest.Mock;
    replaceBackupCodes: jest.Mock;
    deleteSetting: jest.Mock;
    findUnusedBackupCodes: jest.Mock;
    consumeBackupCode: jest.Mock;
    updateLastUsedCounterIfNewer: jest.Mock;
  };
  let service: MfaService;

  beforeAll(() => {
    process.env.MFA_TOTP_ENC_KEY = 'b'.repeat(64);
  });
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.MFA_TOTP_ENC_KEY;
    else process.env.MFA_TOTP_ENC_KEY = ORIGINAL;
  });

  beforeEach(() => {
    repo = {
      findSetting: jest.fn(),
      findEnabledSetting: jest.fn().mockResolvedValue(null),
      findConfirmedSetting: jest.fn().mockResolvedValue(null),
      upsertSecret: jest.fn().mockResolvedValue(undefined),
      confirmWithBackupCodes: jest.fn().mockResolvedValue(undefined),
      replaceBackupCodes: jest.fn().mockResolvedValue(undefined),
      deleteSetting: jest.fn().mockResolvedValue(undefined),
      findUnusedBackupCodes: jest.fn().mockResolvedValue([]),
      consumeBackupCode: jest.fn().mockResolvedValue(true),
      updateLastUsedCounterIfNewer: jest.fn().mockResolvedValue(true),
    };
    service = new MfaService(repo as never);
  });

  const currentToken = async (secret: string): Promise<string> =>
    String(await generate({ secret }));

  describe('setup', () => {
    it('secret を暗号化して保管し（平文を持たない）otpauth URI を返す', async () => {
      const res = await service.setup('acc-1', 'a@b.c');
      expect(repo.upsertSecret).toHaveBeenCalledTimes(1);
      const [accId, stored] = repo.upsertSecret.mock.calls[0];
      expect(accId).toBe('acc-1');
      expect(String(stored).split(':')).toHaveLength(3); // iv:tag:cipher = 暗号化済
      expect(res.data.otpauthUri).toMatch(/^otpauth:\/\//);
    });

    it('既に有効化済みなら再 setup を拒否し secret を巻き戻さない（ダウングレード防止）', async () => {
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: 'x',
        enabled: true,
        lastUsedCounter: null,
      });
      // cmn-0335: 例外の種類まで固定（どんな例外でも緑になる書き方を残さない）。
      await expect(service.setup('acc-1', 'a@b.c')).rejects.toThrow(BadRequestException);
      expect(repo.upsertSecret).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    it('正しい TOTP で有効化し 10 個のバックアップコードを返す', async () => {
      const secret = generateSecret();
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(secret),
        enabled: false,
        lastUsedCounter: null,
      });
      const res = await service.confirm('acc-1', await currentToken(secret));
      expect(repo.confirmWithBackupCodes).toHaveBeenCalledTimes(1);
      expect(res.data.backupCodes).toHaveLength(MFA_BACKUP_CODE_COUNT);
    });

    it('誤コードは MFA_INVALID_CODE を投げ有効化しない', async () => {
      const secret = generateSecret();
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(secret),
        enabled: false,
        lastUsedCounter: null,
      });
      await expect(service.confirm('acc-1', '000000')).rejects.toMatchObject({
        response: { code: 'MFA_INVALID_CODE' },
      });
      expect(repo.confirmWithBackupCodes).not.toHaveBeenCalled();
    });

    it('setup 未実行（行不在）は BadRequest', async () => {
      repo.findSetting.mockResolvedValue(null);
      // cmn-0335: 例外の種類まで固定（どんな例外でも緑になる書き方を残さない）。
      await expect(service.confirm('acc-1', '123456')).rejects.toThrow(BadRequestException);
    });
  });

  describe('verifyLoginChallenge', () => {
    it('有効化済み + 正しい TOTP で true', async () => {
      const secret = generateSecret();
      const setting = {
        accountId: 'acc-1',
        totpSecret: encryptSecret(secret),
        enabled: true,
        confirmedAt: new Date(),
        lastUsedCounter: null,
      };
      repo.findSetting.mockResolvedValue(setting);
      repo.findEnabledSetting.mockResolvedValue(setting);
      expect(await service.verifyLoginChallenge('acc-1', await currentToken(secret))).toBe(true);
    });

    it('未有効化（enabled=false）なら false', async () => {
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(generateSecret()),
        enabled: false,
        lastUsedCounter: null,
      });
      expect(await service.verifyLoginChallenge('acc-1', '123456')).toBe(false);
    });

    it('暗号鍵が未設定なら MFA を課さない・コードも受け付けない（fail closed・d21）', async () => {
      const original = process.env.MFA_TOTP_ENC_KEY;
      delete process.env.MFA_TOTP_ENC_KEY;
      try {
        repo.findSetting.mockResolvedValue({
          accountId: 'acc-1',
          totpSecret: 'x',
          enabled: true,
          confirmedAt: new Date(),
          lastUsedCounter: null,
        });
        expect(await service.verifyHasEnabledMfa('acc-1')).toBe(false);
        expect(await service.verifyLoginChallenge('acc-1', '123456')).toBe(false);
        // 鍵で読めない行を照合対象にしない（未確認行の照合拒否とは別の経路で確かめる）。
        expect(repo.findEnabledSetting).not.toHaveBeenCalled();
      } finally {
        process.env.MFA_TOTP_ENC_KEY = original;
      }
    });

    it('enabled でも確認済みでない行は照合しない（d21・確認前の secret 上書きで印だけ残る穴を塞ぐ）', async () => {
      const secret = generateSecret();
      // enabled=true だが confirmedAt なし（未確認の印だけを立てた状態）。
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(secret),
        enabled: true,
        confirmedAt: null,
        lastUsedCounter: null,
      });
      repo.findEnabledSetting.mockResolvedValue(null);

      expect(await service.verifyLoginChallenge('acc-1', await currentToken(secret))).toBe(false);
      expect(repo.consumeBackupCode).not.toHaveBeenCalled();
    });

    it('TOTP 不一致でもバックアップコード一致なら true・consume される（single-use）', async () => {
      const secret = generateSecret();
      const setting = {
        accountId: 'acc-1',
        totpSecret: encryptSecret(secret),
        enabled: true,
        confirmedAt: new Date(),
        lastUsedCounter: null,
      };
      repo.findSetting.mockResolvedValue(setting);
      repo.findEnabledSetting.mockResolvedValue(setting);
      const backup = 'ABCDEFGHJK';
      repo.findUnusedBackupCodes.mockResolvedValue([{ id: 'bc-1', codeHash: await hash(backup) }]);

      expect(await service.verifyLoginChallenge('acc-1', backup)).toBe(true);
      expect(repo.consumeBackupCode).toHaveBeenCalledWith('bc-1');
    });
  });

  describe('disable', () => {
    it('有効化済み + 正しい TOTP で MfaSetting を削除する', async () => {
      const secret = generateSecret();
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(secret),
        enabled: true,
        lastUsedCounter: null,
      });
      const res = await service.disable('acc-1', await currentToken(secret));
      expect(repo.deleteSetting).toHaveBeenCalledWith('acc-1');
      expect(res.data.disabled).toBe(true);
    });

    it('TOTP 不一致でもバックアップコード一致なら削除（fallback + consume）', async () => {
      const secret = generateSecret();
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(secret),
        enabled: true,
        lastUsedCounter: null,
      });
      const backup = 'ABCDEFGHJK';
      repo.findUnusedBackupCodes.mockResolvedValue([{ id: 'bc-1', codeHash: await hash(backup) }]);
      await service.disable('acc-1', backup);
      expect(repo.consumeBackupCode).toHaveBeenCalledWith('bc-1');
      expect(repo.deleteSetting).toHaveBeenCalledWith('acc-1');
    });

    it('未有効化（enabled=false）は BadRequest・削除しない', async () => {
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(generateSecret()),
        enabled: false,
        lastUsedCounter: null,
      });
      // cmn-0335: 例外の種類まで固定（どんな例外でも緑になる書き方を残さない）。
      await expect(service.disable('acc-1', '123456')).rejects.toThrow(BadRequestException);
      expect(repo.deleteSetting).not.toHaveBeenCalled();
    });

    it('誤コードは MFA_INVALID_CODE・削除しない', async () => {
      const secret = generateSecret();
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(secret),
        enabled: true,
        lastUsedCounter: null,
      });
      await expect(service.disable('acc-1', '000000')).rejects.toMatchObject({
        response: { code: 'MFA_INVALID_CODE' },
      });
      expect(repo.deleteSetting).not.toHaveBeenCalled();
    });
  });

  describe('adminResetMfa（管理者強制リセット・set-0033）', () => {
    it('対象に MfaSetting があればコード検証なしで削除し true を返す', async () => {
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(generateSecret()),
        enabled: true,
        lastUsedCounter: null,
      });
      const result = await service.adminResetMfa('acc-1');
      expect(result).toBe(true);
      expect(repo.deleteSetting).toHaveBeenCalledWith('acc-1');
    });

    it('未確認（enabled=false）の設定も管理者リセットの対象にする（中途半端な設定の掃除）', async () => {
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(generateSecret()),
        enabled: false,
        lastUsedCounter: null,
      });
      const result = await service.adminResetMfa('acc-1');
      expect(result).toBe(true);
      expect(repo.deleteSetting).toHaveBeenCalledWith('acc-1');
    });

    it('対象が MFA 未設定なら何もせず false を返す（no-op・呼び出し側の監査汚染を防ぐ）', async () => {
      repo.findSetting.mockResolvedValue(null);
      const result = await service.adminResetMfa('acc-1');
      expect(result).toBe(false);
      expect(repo.deleteSetting).not.toHaveBeenCalled();
    });

    it('暗号鍵が未設定でもリセットできる（復旧をブロックしない・assertCryptoReady を課さない）', async () => {
      const original = process.env.MFA_TOTP_ENC_KEY;
      delete process.env.MFA_TOTP_ENC_KEY;
      try {
        repo.findSetting.mockResolvedValue({
          accountId: 'acc-1',
          totpSecret: 'x',
          enabled: true,
          lastUsedCounter: null,
        });
        const result = await service.adminResetMfa('acc-1');
        expect(result).toBe(true);
        expect(repo.deleteSetting).toHaveBeenCalledWith('acc-1');
      } finally {
        process.env.MFA_TOTP_ENC_KEY = original;
      }
    });
  });

  describe('regenerateBackupCodes', () => {
    it('有効化済み + 正しい TOTP で 10 個を再発行（旧コード全置換）', async () => {
      const secret = generateSecret();
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(secret),
        enabled: true,
        lastUsedCounter: null,
      });
      const res = await service.regenerateBackupCodes('acc-1', await currentToken(secret));
      expect(repo.replaceBackupCodes).toHaveBeenCalledTimes(1);
      expect(res.data.backupCodes).toHaveLength(MFA_BACKUP_CODE_COUNT);
    });

    it('未有効化は BadRequest・再発行しない', async () => {
      repo.findSetting.mockResolvedValue({
        accountId: 'acc-1',
        totpSecret: encryptSecret(generateSecret()),
        enabled: false,
        lastUsedCounter: null,
      });
      // cmn-0335: 例外の種類まで固定（どんな例外でも緑になる書き方を残さない）。
      await expect(service.regenerateBackupCodes('acc-1', '123456')).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.replaceBackupCodes).not.toHaveBeenCalled();
    });
  });

  // cmn-0094: TOTP replay 防御（checkTotp に集約・4 経路一律）。
  // 単一 choke point 経由のため verifyLoginChallenge で代表検証し、他 3 経路は構造的に同じ振る舞いに
  // なる（confirm / disable / regenerate は verifyLoginChallenge と同じく checkTotp を経由するため）。
  describe('TOTP replay 対策 (cmn-0094)', () => {
    /** verifyLoginChallenge が読む確認済み（enabled + confirmedAt）の行。lastUsedCounter だけ差し替える。 */
    const confirmedSetting = (totpSecret: string, lastUsedCounter: number | null = null) => ({
      accountId: 'acc-1',
      totpSecret: encryptSecret(totpSecret),
      enabled: true,
      confirmedAt: new Date(),
      lastUsedCounter,
    });

    it('検証成功で updateLastUsedCounterIfNewer が (accountId, usedCounter) で呼ばれ true が返る', async () => {
      const secret = generateSecret();
      repo.findEnabledSetting.mockResolvedValue(confirmedSetting(secret));

      expect(await service.verifyLoginChallenge('acc-1', await currentToken(secret))).toBe(true);
      expect(repo.updateLastUsedCounterIfNewer).toHaveBeenCalledTimes(1);
      const [callAccountId, calledCounter] = repo.updateLastUsedCounterIfNewer.mock.calls[0];
      expect(callAccountId).toBe('acc-1');
      expect(typeof calledCounter).toBe('number');
      // counter は現在時刻基準の妥当な範囲（epochTolerance = ±1 step ＝ otplib delta ∈ {-1, 0, +1}）
      // L1 (cmn-0094): 上限・下限とも ±1 step に絞り CI での epoch boundary flake を防ぐ。
      const floorNow = Math.floor(Date.now() / 1000 / 30);
      expect(calledCounter).toBeGreaterThanOrEqual(floorNow - 1);
      expect(calledCounter).toBeLessThanOrEqual(floorNow + 1);
    });

    it('並行 race で updateLastUsedCounterIfNewer が false を返したら checkTotp は false（並列 1 件化・M1）', async () => {
      const secret = generateSecret();
      repo.findEnabledSetting.mockResolvedValue(confirmedSetting(secret));
      // 他経路で先に書き込まれた想定（並列他リクエストが同 step の counter を記録済）
      repo.updateLastUsedCounterIfNewer.mockResolvedValueOnce(false);
      // backup 経路を走らせない
      repo.findUnusedBackupCodes.mockResolvedValueOnce([]);

      expect(await service.verifyLoginChallenge('acc-1', await currentToken(secret))).toBe(false);
    });

    it('同一 TOTP コードを2回連続で送ると2回目は false（replay 拒否）で updateLastUsedCounterIfNewer は呼ばれない', async () => {
      const secret = generateSecret();
      const token = await currentToken(secret);

      // 1回目: 成功経路で lastUsedCounter=null → 真の replay 防御が効く状態
      repo.findEnabledSetting.mockResolvedValueOnce(confirmedSetting(secret));
      expect(await service.verifyLoginChallenge('acc-1', token)).toBe(true);
      const firstCallCalls = repo.updateLastUsedCounterIfNewer.mock.calls.length;
      expect(firstCallCalls).toBeGreaterThanOrEqual(1);

      // 2回目: 1回目で書き込まれた lastUsedCounter を返却（findSetting が DB を読む想定）
      const recordedCounter = repo.updateLastUsedCounterIfNewer.mock.calls[0][1];
      repo.findEnabledSetting.mockResolvedValueOnce(confirmedSetting(secret, recordedCounter));
      // backup 経路も走らないようバックアップコードは空に固定
      repo.findUnusedBackupCodes.mockResolvedValueOnce([]);

      expect(await service.verifyLoginChallenge('acc-1', token)).toBe(false);
      // 2回目は replay で拒否 = updateLastUsedCounterIfNewer は増えない
      expect(repo.updateLastUsedCounterIfNewer).toHaveBeenCalledTimes(firstCallCalls);
    });

    it('既存の lastUsedCounter が usedCounter 以上の状態で正しいコードを送ると false', async () => {
      const secret = generateSecret();
      // 大きすぎる lastUsedCounter を入れて、ある TOTP は全て replay と判定される状態を作る
      repo.findEnabledSetting.mockResolvedValue(confirmedSetting(secret, Number.MAX_SAFE_INTEGER));
      // backup 経路を走らせない
      repo.findUnusedBackupCodes.mockResolvedValue([]);

      expect(await service.verifyLoginChallenge('acc-1', await currentToken(secret))).toBe(false);
      // replay 拒否なので更新は走らない
      expect(repo.updateLastUsedCounterIfNewer).not.toHaveBeenCalled();
    });
  });
});
