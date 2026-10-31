import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { FavoritesRepository } from './favorites.repository';
import { PrismaService } from '../../../database/prisma.service';
import { DEFAULT_MAX_WAIT_MS, DEFAULT_TIMEOUT_MS } from '../../../common/database/serializable-tx';

/**
 * FavoritesRepository のユニットテスト。Prisma はモックし、DB アクセス層の境界だけを固定する。
 *
 * ここで検証すること:
 * - 全メソッドが accountId で行を絞ること（IDOR 防止）。特に deleteOwned が `{ id, accountId }` の
 *   deleteMany であること、reorder の一括 SQL に accountId が乗ること。
 * - reorder が共通ヘルパ経由の Serializable interactive transaction 1 本で走り、集合検証（過剰 / 欠落 /
 *   件数同一で中身違い）を tx 内で行い、不一致時は write を発行しないこと。
 * - 競合 abort（P2034）で自動リトライし、それ以外のエラーはリトライせず投げること。
 *
 * E2E / 実 DB へ委譲すること:
 * - 実 PostgreSQL の直列化（SSI）の実挙動、実際の並行 abort の発生条件、Prisma が最終的に発行する SQL。
 */

// tx 内で使う Prisma client モック（$transaction のコールバックに渡す）。
const txMock = {
  $executeRaw: jest.fn(),
  userFavorite: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn(),
  },
};

const mockPrisma = {
  userFavorite: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    // 単数 delete は生やさない（deleteOwned が deleteMany 以外を使ったら TypeError で落ちる）。
  },
  // runInSerializableTransaction は prisma.$transaction(fn, { isolationLevel }) を呼ぶ。
  // コールバックに txMock を渡し、tx 内の呼び出しを検証可能にする（実装は beforeEach で毎回再設定）。
  $transaction: jest.fn(),
};

const ACCOUNT = 'acc-1';

describe('FavoritesRepository', () => {
  let repo: FavoritesRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FavoritesRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repo = module.get<FavoritesRepository>(FavoritesRepository);
    // resetMocks により実装は毎テストで剥がれるため、パススルーをここで張り直す。
    mockPrisma.$transaction.mockImplementation(
      async (cb: (tx: typeof txMock) => unknown, _options?: unknown): Promise<unknown> =>
        cb(txMock),
    );
  });

  describe('findByAccount', () => {
    it('accountId で絞り sortOrder→createdAt 昇順で findMany を 1 回呼び、結果をそのまま返す', async () => {
      const rows = [{ id: 'f1' }, { id: 'f2' }];
      mockPrisma.userFavorite.findMany.mockResolvedValue(rows);

      const result = await repo.findByAccount(ACCOUNT);

      expect(mockPrisma.userFavorite.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.userFavorite.findMany).toHaveBeenCalledWith({
        where: { accountId: ACCOUNT },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      expect(result).toBe(rows);
    });
  });

  describe('findByTarget', () => {
    it('複合一意キー accountId_kind_targetRef で findUnique を呼ぶ', async () => {
      mockPrisma.userFavorite.findUnique.mockResolvedValue({ id: 'f1' });

      await repo.findByTarget(ACCOUNT, 'system', 'rete');

      expect(mockPrisma.userFavorite.findUnique).toHaveBeenCalledWith({
        where: {
          accountId_kind_targetRef: { accountId: ACCOUNT, kind: 'system', targetRef: 'rete' },
        },
      });
    });

    it('未登録（null）はそのまま null を返す', async () => {
      mockPrisma.userFavorite.findUnique.mockResolvedValue(null);

      await expect(repo.findByTarget(ACCOUNT, 'system', 'none')).resolves.toBeNull();
    });
  });

  describe('maxSortOrder', () => {
    it('accountId スコープの aggregate で _max.sortOrder を引く', async () => {
      mockPrisma.userFavorite.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });

      const result = await repo.maxSortOrder(ACCOUNT);

      expect(mockPrisma.userFavorite.aggregate).toHaveBeenCalledWith({
        where: { accountId: ACCOUNT },
        _max: { sortOrder: true },
      });
      expect(result).toBe(4);
    });

    it('未登録時は null を返す（採番起点の判定を service に委ねる）', async () => {
      mockPrisma.userFavorite.aggregate.mockResolvedValue({ _max: { sortOrder: null } });

      await expect(repo.maxSortOrder(ACCOUNT)).resolves.toBeNull();
    });
  });

  describe('create', () => {
    it('渡された CreateFavoriteData がそのまま create({ data }) に渡る', async () => {
      mockPrisma.userFavorite.create.mockResolvedValue({ id: 'f1' });
      const data = {
        accountId: ACCOUNT,
        kind: 'system',
        targetRef: 'rete',
        label: 'Rete',
        sortOrder: 3,
      };

      await repo.create(data);

      expect(mockPrisma.userFavorite.create).toHaveBeenCalledWith({ data });
    });
  });

  // ============================================================
  // createWithAutoSortOrder（cmn-0151 分割B④・categories の前例を移植）
  // ============================================================
  describe('createWithAutoSortOrder', () => {
    it('tx 内で max+1 を採番して create する（Serializable 1 本・明示指定なし）', async () => {
      txMock.userFavorite.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
      txMock.userFavorite.create.mockResolvedValue({ id: 'f5', sortOrder: 5 });

      const result = await repo.createWithAutoSortOrder(ACCOUNT, {
        kind: 'system',
        targetRef: 'rete',
        label: 'Rete',
      });

      // 採番と create が同一 tx 内（共通ヘルパ経由の Serializable・cmn-0251）。
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: DEFAULT_TIMEOUT_MS,
        maxWait: DEFAULT_MAX_WAIT_MS,
      });
      expect(txMock.userFavorite.aggregate).toHaveBeenCalledWith({
        where: { accountId: ACCOUNT },
        _max: { sortOrder: true },
      });
      expect(txMock.userFavorite.create).toHaveBeenCalledWith({
        data: {
          accountId: ACCOUNT,
          kind: 'system',
          targetRef: 'rete',
          label: 'Rete',
          sortOrder: 5,
        },
      });
      // ヘルパ外の prisma を触らない。
      expect(mockPrisma.userFavorite.aggregate).not.toHaveBeenCalled();
      expect(mockPrisma.userFavorite.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'f5', sortOrder: 5 });
    });

    it('0 件時は 0 から採番する（現行の max===null → 0 を維持・cmn-0346 criteria 4）', async () => {
      txMock.userFavorite.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      txMock.userFavorite.create.mockResolvedValue({ id: 'f1', sortOrder: 0 });

      await repo.createWithAutoSortOrder(ACCOUNT, {
        kind: 'system',
        targetRef: 'rete',
        label: 'Rete',
      });

      expect(txMock.userFavorite.create).toHaveBeenCalledWith({
        data: {
          accountId: ACCOUNT,
          kind: 'system',
          targetRef: 'rete',
          label: 'Rete',
          sortOrder: 0,
        },
      });
    });

    it('明示指定があれば採番せずその値を使う', async () => {
      txMock.userFavorite.create.mockResolvedValue({ id: 'f9', sortOrder: 9 });

      await repo.createWithAutoSortOrder(
        ACCOUNT,
        { kind: 'system', targetRef: 'rete', label: 'Rete' },
        9,
      );

      expect(txMock.userFavorite.aggregate).not.toHaveBeenCalled();
      expect(txMock.userFavorite.create).toHaveBeenCalledWith({
        data: {
          accountId: ACCOUNT,
          kind: 'system',
          targetRef: 'rete',
          label: 'Rete',
          sortOrder: 9,
        },
      });
    });
  });

  // ============================================================
  // deleteOwned（IDOR 防止＝accountId スコープの deleteMany）
  // ============================================================
  describe('deleteOwned', () => {
    it('deleteMany を { where: { id, accountId } } で呼ぶ（accountId 無しの単数 delete ではない）', async () => {
      mockPrisma.userFavorite.deleteMany.mockResolvedValue({ count: 1 });

      const result = await repo.deleteOwned(ACCOUNT, 'f1');

      expect(mockPrisma.userFavorite.deleteMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.userFavorite.deleteMany).toHaveBeenCalledWith({
        where: { id: 'f1', accountId: ACCOUNT },
      });
      expect(result).toBe(1);
    });

    it('他人の id では 0 件削除になり 0 を返す（service が NotFound に翻訳する）', async () => {
      mockPrisma.userFavorite.deleteMany.mockResolvedValue({ count: 0 });

      await expect(repo.deleteOwned(ACCOUNT, 'other-account-fav')).resolves.toBe(0);
    });
  });

  // ============================================================
  // reorder（tx 内の集合検証・Serializable 直列化・IDOR スコープ）
  // ============================================================
  describe('reorder', () => {
    it('集合一致なら要求順の全件を一括 SQL で更新し、tx 内再読込を返す', async () => {
      const items = [
        { id: 'f1', sortOrder: 0 },
        { id: 'f2', sortOrder: 1 },
      ];
      txMock.userFavorite.findMany
        .mockResolvedValueOnce([{ id: 'f2' }, { id: 'f1' }])
        .mockResolvedValueOnce(items);
      txMock.$executeRaw.mockResolvedValue(2);

      const result = await repo.reorder(ACCOUNT, ['f1', 'f2']);

      expect(txMock.userFavorite.findMany).toHaveBeenNthCalledWith(1, {
        where: { accountId: ACCOUNT },
        select: { id: true },
      });
      const query = txMock.$executeRaw.mock.calls[0][0] as Prisma.Sql;
      expect(query.values).toEqual([
        JSON.stringify(['f1', 'f2']),
        ACCOUNT,
        expect.any(Date),
        ACCOUNT,
      ]);
      expect(query.text).toContain('favorite.account_id = $2');
      expect(query.text).toContain('favorite.account_id = $4');
      expect(txMock.userFavorite.findMany).toHaveBeenNthCalledWith(2, {
        where: { accountId: ACCOUNT },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      // 回数まで固定する（Nth だけだと二重ループ等で余計な write / read を撃つ実装でも緑のまま通る）。
      expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
      expect(txMock.userFavorite.updateMany).not.toHaveBeenCalled();
      expect(txMock.userFavorite.findMany).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ ok: true, items });
    });

    it('$transaction が Serializable 指定つきで 1 回だけ呼ばれる（共通ヘルパ経由の直列化）', async () => {
      txMock.userFavorite.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await repo.reorder(ACCOUNT, []);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: DEFAULT_TIMEOUT_MS,
        maxWait: DEFAULT_MAX_WAIT_MS,
      });
    });

    it('現存に無い id を含む（過剰）と set-mismatch を返し write も再読込もしない', async () => {
      txMock.userFavorite.findMany.mockResolvedValueOnce([{ id: 'f1' }]);

      const result = await repo.reorder(ACCOUNT, ['f1', 'ghost']);

      expect(result).toEqual({ ok: false, reason: 'set-mismatch' });
      expect(txMock.userFavorite.updateMany).not.toHaveBeenCalled();
      expect(txMock.$executeRaw).not.toHaveBeenCalled();
      expect(txMock.userFavorite.findMany).toHaveBeenCalledTimes(1);
    });

    it('現存の一部しか含まない（欠落）場合も set-mismatch で write も再読込もしない', async () => {
      txMock.userFavorite.findMany.mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }]);

      const result = await repo.reorder(ACCOUNT, ['f1']);

      expect(result).toEqual({ ok: false, reason: 'set-mismatch' });
      expect(txMock.userFavorite.updateMany).not.toHaveBeenCalled();
      expect(txMock.$executeRaw).not.toHaveBeenCalled();
      expect(txMock.userFavorite.findMany).toHaveBeenCalledTimes(1);
    });

    it('件数は同じでも他人の id にすり替わっていれば set-mismatch（サイズ比較だけでは通る穴を塞ぐ）', async () => {
      txMock.userFavorite.findMany.mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }]);

      const result = await repo.reorder(ACCOUNT, ['f1', 'other-account-fav']);

      expect(result).toEqual({ ok: false, reason: 'set-mismatch' });
      expect(txMock.userFavorite.updateMany).not.toHaveBeenCalled();
      expect(txMock.$executeRaw).not.toHaveBeenCalled();
    });

    it('200 件でも SQL は 1 回で、リクエスト順と id 昇順のロックを区別する', async () => {
      const ids = Array.from({ length: 200 }, (_, index) => `f${199 - index}`);
      txMock.userFavorite.findMany
        .mockResolvedValueOnce(ids.map((id) => ({ id })))
        .mockResolvedValueOnce([]);
      txMock.$executeRaw.mockResolvedValue(200);

      await repo.reorder(ACCOUNT, ids);

      expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
      const query = txMock.$executeRaw.mock.calls[0][0] as Prisma.Sql;
      expect(query.values[0]).toBe(JSON.stringify(ids));
      expect(query.text).toMatch(/ORDER BY favorite.id\s+FOR UPDATE OF favorite/);
      expect(query.text).toContain('(requested.position - 1)::integer');
      expect(txMock.userFavorite.updateMany).not.toHaveBeenCalled();
    });

    it('同じ id が重複していれば set-mismatch で write を発行しない（Set 化で潰れる穴を塞ぐ・repository 単体の契約）', async () => {
      txMock.userFavorite.findMany.mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }]);

      const result = await repo.reorder(ACCOUNT, ['f1', 'f1', 'f2']);

      expect(result).toEqual({ ok: false, reason: 'set-mismatch' });
      expect(txMock.userFavorite.updateMany).not.toHaveBeenCalled();
      expect(txMock.$executeRaw).not.toHaveBeenCalled();
      expect(txMock.userFavorite.findMany).toHaveBeenCalledTimes(1);
    });

    it('空配列 × 現存 0 件は {ok:true, items:[]} で write を発行しない', async () => {
      txMock.userFavorite.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await repo.reorder(ACCOUNT, []);

      expect(result).toEqual({ ok: true, items: [] });
      expect(txMock.userFavorite.updateMany).not.toHaveBeenCalled();
      expect(txMock.$executeRaw).not.toHaveBeenCalled();
    });

    it('競合 abort（P2034）は共通ヘルパが自動リトライし、2 回目で解決する', async () => {
      mockPrisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: '6.2.0',
        }),
      );
      txMock.userFavorite.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await repo.reorder(ACCOUNT, []);

      expect(result).toEqual({ ok: true, items: [] });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('P2034 以外（P2002）はリトライせずそのまま投げる', async () => {
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.2.0',
      });
      mockPrisma.$transaction.mockRejectedValueOnce(error);

      await expect(repo.reorder(ACCOUNT, [])).rejects.toBe(error);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
