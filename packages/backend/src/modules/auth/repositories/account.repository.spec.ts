import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AccountRepository } from './account.repository';
import { PrismaService } from '../../../database';

/**
 * cmn-0185: 資格情報 lookup（AccountRepository）の単体テスト。prisma はモックし、
 * ①ログイン失敗記録の 0 行フォールバック（undefined destructure による 500 の防止）
 * ②パスワード更新とフラグ解除の単一 UPDATE 原子化
 * ③session deserialize 用 select に passwordHash が含まれないこと
 * を検証する。SQL 自体の正しさ（RETURNING の値・並行更新時のロック挙動）は DB 実行が要るため
 * ここでは扱わず、呼び出し形と戻り値の整形のみを固定する。
 */
const mockPrisma = {
  account: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  $queryRaw: jest.fn(),
};

describe('AccountRepository', () => {
  let repo: AccountRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AccountRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    repo = module.get<AccountRepository>(AccountRepository);
  });

  describe('registerFailedAttempt', () => {
    it('ロック発火 SQL をパラメータバインドで組む（閾値式・CASE 節・バインド順を固定）', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ failedLoginAttempts: 1, locked: false }]);
      const lockedUntil = new Date('2026-07-27T00:00:00.000Z');

      await repo.registerFailedAttempt('acc-1', 5, lockedUntil);

      const [sql] = mockPrisma.$queryRaw.mock.calls[0];
      // Prisma.sql タグ済みオブジェクト（strings + values）であること。文字列連結や
      // $queryRawUnsafe への書き換え（＝injection）は typeof が string になり落ちる。
      // Prisma.Sql クラスは @prisma/client から値として export されないため構造で判定する。
      expect(Array.isArray(sql.strings)).toBe(true);
      // id / 閾値 / ロック期限が値として埋め込まれずバインドされること＋埋め込み順。
      expect(sql.values).toEqual([5, lockedUntil, 'acc-1', 5]);
      const text = sql.strings.join('?');
      // increment と閾値ロックの原子化（CASE 節）が消える退行を落とす。
      expect(text).toContain('failed_login_attempts + 1 >=');
      expect(text).toContain('locked_until = CASE');
    });

    it('RETURNING が 0 行（findByEmail 後にアカウント削除）なら 0 件・未ロックへフォールバックする', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      // files 側で起きた undefined destructure 由来の 500 を構造的に防ぐ分岐。
      // 呼び出し側は「失敗記録なし・未ロック」として 401 に倒せる。
      expect(await repo.registerFailedAttempt('acc-gone', 5, new Date())).toEqual({
        failedLoginAttempts: 0,
        locked: false,
      });
    });

    it('閾値到達行（locked: true）はそのまま素通しする', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ failedLoginAttempts: 5, locked: true }]);

      expect(await repo.registerFailedAttempt('acc-1', 5, new Date())).toEqual({
        failedLoginAttempts: 5,
        locked: true,
      });
    });

    it('閾値未満の行は locked: false のまま返す', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ failedLoginAttempts: 2, locked: false }]);

      expect(await repo.registerFailedAttempt('acc-1', 5, new Date())).toEqual({
        failedLoginAttempts: 2,
        locked: false,
      });
    });
  });

  describe('updatePasswordAndClearFlag', () => {
    it('passwordHash と mustChangePassword: false を単一 update で同時に渡す', async () => {
      mockPrisma.account.update.mockResolvedValue({});

      await repo.updatePasswordAndClearFlag('acc-1', 'hashed');

      // 2 クエリに割ると「hash だけ変わってフラグが残る」中間状態が生まれる。単一 UPDATE を固定する。
      expect(mockPrisma.account.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.account.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: {
          passwordHash: 'hashed',
          mustChangePassword: false,
          credentialsChangedAt: expect.any(Date),
        },
      });
    });
  });

  describe('resetLoginState', () => {
    it('対象アカウントだけを狙い、失敗カウント 0 と lockedUntil: null を同時に渡す', async () => {
      mockPrisma.account.updateMany.mockResolvedValue({ count: 1 });

      await repo.resetLoginState('acc-1');

      // lockedUntil を undefined にすると Prisma では「その列を更新しない」となりロックが
      // 永久に解けない（H6 の解除側が死ぬ）。null であることを完全一致で固定する。
      expect(mockPrisma.account.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.account.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'acc-1',
          // 対象を id だけで絞らず「未解除の行」に限定する条件。既に 0/null の行を書き換え対象から
          // 外すことで、無変更の UPDATE が並行ログインの書き込みと噛み合う窓を狭める。
          OR: [{ failedLoginAttempts: { not: 0 } }, { lockedUntil: { not: null } }],
        },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    });

    it('対象アカウントが消えている極小窓は 0 件更新の no-op として扱い、例外を外へ出さない（cmn-0232 LOW2）', async () => {
      // updateMany は対象 0 件でも P2025 を投げず { count: 0 } を返す。旧実装（update + try/catch）が
      // P2025 を握り潰して保っていた「アカウント不在なら何も起きない」性質は、単一レコード更新ではなく
      // 一括更新を使うこと自体で構造的に成立する（chat.repository の deleteMany と同じ理由）。
      // ここで count: 0 を返して reject しないことを固定し、update 系へ戻す退行を検出する。
      mockPrisma.account.updateMany.mockResolvedValue({ count: 0 });

      await expect(repo.resetLoginState('acc-gone')).resolves.toBeUndefined();
      // 単一レコード更新（update）へ退行すると、アカウント不在時に P2025 が外へ出る経路が復活する。
      expect(mockPrisma.account.update).not.toHaveBeenCalled();
    });

    it('Prisma エラーは握り潰さずそのまま外へ投げる', async () => {
      const otherError = new Prisma.PrismaClientKnownRequestError('other', {
        code: 'P2002',
        clientVersion: 'test',
      });
      mockPrisma.account.updateMany.mockRejectedValue(otherError);

      await expect(repo.resetLoginState('acc-1')).rejects.toBe(otherError);
    });
  });

  describe('findByEmail / findById', () => {
    // cmn-0237: 秘密列（passwordHash 含む）を返す読み出し側の select allowlist をキー集合完全一致で固定する。
    // 将来 Account に列や relation が追加された時、ここで必ず落ちる＝「この列を認証処理に載せてよいか」を
    // 必ず人に問う関門。denylist（passwordHash 決め打ち）ではなく allowlist で守る方針。
    const expectedCredentialKeys = [
      'email',
      'failedLoginAttempts',
      'id',
      'isActive',
      'lockedUntil',
      'mustChangePassword',
      'name',
      'passwordHash',
      'role',
    ];

    it('findByEmail は email 一意キーで findUnique へ委譲し、allowlist のキー集合を完全一致で渡す', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      await repo.findByEmail('a@example.com');

      const arg = mockPrisma.account.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({ email: 'a@example.com' });
      expect(Object.keys(arg.select).sort()).toEqual(expectedCredentialKeys);
    });

    it('findById は id 一意キーで findUnique へ委譲し、allowlist のキー集合を完全一致で渡す', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);

      await repo.findById('acc-1');

      const arg = mockPrisma.account.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'acc-1' });
      expect(Object.keys(arg.select).sort()).toEqual(expectedCredentialKeys);
    });
  });
});
