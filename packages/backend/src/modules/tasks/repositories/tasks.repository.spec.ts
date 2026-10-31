import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { DEFAULT_CHANNEL_ID } from '@rete/shared';
import { TasksRepository } from './tasks.repository';
import { PrismaService } from '../../../database/prisma.service';
import { INTERACTIVE_SAVE_TX_OPTIONS } from '../../../common/database/serializable-tx';
import { makeTaskEntity } from '../../../__tests__/factories';
import { installTxPassthrough } from '../../../__tests__/tx-passthrough';
// 本番の LIST_CONFIG を import 参照し、allowedSortFields のハードコード複製（ドリフト）を防ぐ。
import { LIST_CONFIG } from '../tasks.service';

// tx 内で使う Prisma client モック（$transaction のコールバックに渡す）。
// 基準兄弟の read も tx 経由（tx.task.findUnique）になったため findUnique を含める。
// taskMention（説明/顛末の宛先 / dsk-0203・dsk-0284で顛末面をcreateWithSortOrderにも対称配線）は
// createWithSortOrder（説明面/顛末面とも createMany のみ）と update（面別差し替え）の両方が tx 内で使う。
const txMock = {
  task: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    aggregate: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  taskMention: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const mockPrisma = {
  task: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  category: {
    findUnique: jest.fn(),
  },
  chatTheme: {
    findUnique: jest.fn(),
  },
  account: {
    count: jest.fn(),
  },
  // 自分宛メンション集約（hasMentionToMe / dsk-0203）。タスク本文宛（taskMention）とコメント宛
  // （taskCommentMention）の 2 クエリで判定する（chat.repository の hasMentionToMe 集約と同方式）。
  taskMention: {
    findMany: jest.fn(),
  },
  taskCommentMention: {
    findMany: jest.fn(),
  },
  // コールバックに txMock を渡し、tx 内の呼び出しを検証可能にする。
  // 第2引数（isolationLevel 等の tx オプション）も受けて検証できるようにする（update の Serializable 分岐）。
  // 実装は beforeEach で毎回再設定する。
  $transaction: jest.fn(),
};

describe('TasksRepository', () => {
  let repo: TasksRepository;

  // cmn-0335: $transaction の通し設定を共通ヘルパへ委譲（見張り込みで beforeEach/afterEach を自前登録）。
  installTxPassthrough(mockPrisma, txMock);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TasksRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repo = module.get<TasksRepository>(TasksRepository);
  });

  describe('findManyPaginated', () => {
    it('findMany + count を呼び、Entity 配列 + meta を返すこと（DTO 変換は Service 層の責務）', async () => {
      mockPrisma.task.findMany.mockResolvedValue([makeTaskEntity()]);
      mockPrisma.task.count.mockResolvedValue(1);

      const result = await repo.findManyPaginated({ page: 1, limit: 20 }, LIST_CONFIG);

      expect(result.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
      expect(result.data).toHaveLength(1);
      // Repository は Prisma Entity をそのまま返す（Date は Date のまま、ISO 変換しない）
      expect(result.data[0].createdAt).toBeInstanceOf(Date);
      expect(result.data[0].id).toBe(1);
      expect(result.data[0].title).toBe('入荷データ取込');
    });

    it('一覧でも読者別の可視性を判定できるよう sourceTheme の spaceId を取得すること', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      await repo.findManyPaginated({ page: 1, limit: 20 }, LIST_CONFIG);

      expect(mockPrisma.task.findMany.mock.calls[0][0].include).toEqual({
        sourceTheme: { select: { id: true, title: true, spaceId: true } },
      });
    });

    it('search 指定時に searchFields を OR で検索すること', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      await repo.findManyPaginated({ search: '入荷', page: 1, limit: 20 }, LIST_CONFIG);

      const call = mockPrisma.task.findMany.mock.calls[0][0];
      expect(call.where.OR).toEqual([{ title: { contains: '入荷', mode: 'insensitive' } }]);
    });

    it('categoryId 指定時に where へ categoryId フィルタを乗せること', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      await repo.findManyPaginated({ categoryId: 3, page: 1, limit: 20 }, LIST_CONFIG);

      const call = mockPrisma.task.findMany.mock.calls[0][0];
      expect(call.where.categoryId).toBe(3);
    });

    // メンション From/To 絞り込み（dsk-0203・chat.findThemesAndCount のタスク版）。
    // コメント起因（TaskComment.authorId / TaskCommentMention）OR タスク本文起因（Task.ownerId / TaskMention）。
    it('mentionFrom のみ指定時はコメント起因 OR 本文起因（発信者 in かつ mentions.some({})）で絞ること（From=メンション発信者）', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      await repo.findManyPaginated({ page: 1, limit: 20, mentionFrom: ['u1', 'u2'] }, LIST_CONFIG);

      // From だけでも「（誰かに）メンションした」ことを要求（単なる投稿者/作成者一致では拾わない）。
      const where = mockPrisma.task.findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual([
        {
          OR: [
            { comments: { some: { authorId: { in: ['u1', 'u2'] }, mentions: { some: {} } } } },
            { ownerId: { in: ['u1', 'u2'] }, mentions: { some: {} } },
          ],
        },
      ]);
    });

    it('mentionTo のみ指定時はコメント宛 OR 本文宛の accountId in で絞ること', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      await repo.findManyPaginated({ page: 1, limit: 20, mentionTo: ['u3'] }, LIST_CONFIG);

      const where = mockPrisma.task.findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual([
        {
          OR: [
            { comments: { some: { mentions: { some: { accountId: { in: ['u3'] } } } } } },
            { mentions: { some: { accountId: { in: ['u3'] } } } },
          ],
        },
      ]);
    });

    it('From+To 併用時はコメント起因（同一コメント AND）OR 本文起因（作成者 AND）で絞ること', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      await repo.findManyPaginated(
        { page: 1, limit: 20, mentionFrom: ['u1'], mentionTo: ['u3'] },
        LIST_CONFIG,
      );

      const where = mockPrisma.task.findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual([
        {
          OR: [
            {
              comments: {
                some: {
                  authorId: { in: ['u1'] },
                  mentions: { some: { accountId: { in: ['u3'] } } },
                },
              },
            },
            { ownerId: { in: ['u1'] }, mentions: { some: { accountId: { in: ['u3'] } } } },
          ],
        },
      ]);
    });

    it('メンションフィルタは baseWhere の OR（非アーカイブ分類 OR 未分類）を潰さず AND の 1 要素として共存すること', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      await repo.findManyPaginated({ page: 1, limit: 20, mentionTo: ['u3'] }, LIST_CONFIG);

      const where = mockPrisma.task.findMany.mock.calls[0][0].where;
      // baseWhere 由来の OR は top-level に残り、mention は AND 内の OR（キーが別なので AND 結合される）。
      expect(where.OR).toEqual([{ category: { archivedAt: null } }, { categoryId: null }]);
      expect(where.AND).toHaveLength(1);
    });

    it('baseWhere に既存 AND（単一オブジェクト）が設定済みでも配列へ正規化して欠落させずに追加すること', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      const config = { ...LIST_CONFIG, baseWhere: { AND: { spaceId: 's1' } } };
      await repo.findManyPaginated({ page: 1, limit: 20, mentionTo: ['u3'] }, config);

      const where = mockPrisma.task.findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual([
        { spaceId: 's1' },
        {
          OR: [
            { comments: { some: { mentions: { some: { accountId: { in: ['u3'] } } } } } },
            { mentions: { some: { accountId: { in: ['u3'] } } } },
          ],
        },
      ]);
    });

    it('mentionFrom / mentionTo 両方未指定ならメンションフィルタを掛けないこと（AND を生やさない）', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);
      mockPrisma.task.count.mockResolvedValue(0);

      await repo.findManyPaginated({ page: 1, limit: 20 }, LIST_CONFIG);

      expect(mockPrisma.task.findMany.mock.calls[0][0].where.AND).toBeUndefined();
    });

    it('currentUserId 指定時は取得ページのタスク id 群から mentionedTaskIds を集約して返すこと（hasMentionToMe の配線）', async () => {
      mockPrisma.task.findMany.mockResolvedValue([makeTaskEntity()]); // id=1
      mockPrisma.task.count.mockResolvedValue(1);
      mockPrisma.taskMention.findMany.mockResolvedValue([{ taskId: 1 }]);
      mockPrisma.taskCommentMention.findMany.mockResolvedValue([]);

      const result = await repo.findManyPaginated({ page: 1, limit: 20 }, LIST_CONFIG, 'me');

      expect(result.mentionedTaskIds.has(1)).toBe(true);
    });
  });

  describe('findMentionedTaskIds', () => {
    // 自分宛メンション集約（dsk-0203・chat 側 hasMentionToMe のミラー）。
    // タスク本文宛（TaskMention）とコメント宛（TaskCommentMention）の定数 2 クエリで判定する。
    it('本文宛とコメント宛の定数 2 クエリで自分宛タスク id を合流して返すこと（N+1 なし）', async () => {
      mockPrisma.taskMention.findMany.mockResolvedValue([{ taskId: 1 }]);
      mockPrisma.taskCommentMention.findMany.mockResolvedValue([{ comment: { taskId: 2 } }]);

      const result = await repo.findMentionedTaskIds([1, 2, 3], 'me');

      // 本文宛: 自分 × ページ内タスク id に限定して 1 クエリ。
      expect(mockPrisma.taskMention.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.taskMention.findMany.mock.calls[0][0]).toEqual({
        where: { accountId: 'me', taskId: { in: [1, 2, 3] } },
        select: { taskId: true },
      });
      // コメント宛: comment リレーション経由で親 taskId へ畳む。
      expect(mockPrisma.taskCommentMention.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.taskCommentMention.findMany.mock.calls[0][0]).toEqual({
        where: { accountId: 'me', comment: { taskId: { in: [1, 2, 3] } } },
        select: { comment: { select: { taskId: true } } },
      });
      expect([...result].sort()).toEqual([1, 2]);
      expect(result.has(3)).toBe(false);
    });

    it('currentUserId 無し時はクエリを発行せず空集合を返すこと（早期 return）', async () => {
      const result = await repo.findMentionedTaskIds([1, 2]);

      expect(mockPrisma.taskMention.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.taskCommentMention.findMany).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });

    it('対象タスク id が空ならクエリを発行せず空集合を返すこと（早期 return）', async () => {
      const result = await repo.findMentionedTaskIds([], 'me');

      expect(mockPrisma.taskMention.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.taskCommentMention.findMany).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });
  });

  describe('update', () => {
    it('id と data を渡し、sourceTheme(id/title) を include して update を呼ぶこと（更新後も元チャットリンクを保つ）', async () => {
      const entity = makeTaskEntity({ title: '更新' });
      mockPrisma.task.update.mockResolvedValue(entity);
      const result = await repo.update(1, { title: '更新' });
      expect(mockPrisma.task.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { title: '更新' },
        include: {
          sourceTheme: { select: { id: true, title: true, spaceId: true } },
          assignee: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
        },
      });
      expect(result).toBe(entity);
    });

    it('面指定なし（両面 undefined）は $transaction を使わず単発 update に留めること（status 変更等の高頻度経路）', async () => {
      mockPrisma.task.update.mockResolvedValue(makeTaskEntity());

      await repo.update(1, { status: 'DONE' } as never);

      expect(mockPrisma.task.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('説明面指定時は Serializable tx で本体 update + DESCRIPTION 面のみ deleteMany→createMany 全置換すること', async () => {
      const entity = makeTaskEntity();
      txMock.task.update.mockResolvedValue(entity);

      const result = await repo.update(1, { description: '<p>本文</p>' } as never, {
        descriptionMentionAccountIds: ['u2', 'u3'],
      });

      // 単発 update ではなく tx 経由（write skew 防止のため Serializable / chat.updateTheme と同方針）。
      expect(mockPrisma.task.update).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // 共通ヘルパ（runInSerializableTransaction）経由であることを tx オプションで固定する。
      // 直に $transaction を呼ぶ実装へ戻すと timeout / maxWait が落ちてここで落ちる（cmn-0251）。
      // 上限は対話保存向けの短いセット＝reorder 向け既定（15s）を人が待つ保存に被せない。
      expect(mockPrisma.$transaction.mock.calls[0][1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: INTERACTIVE_SAVE_TX_OPTIONS.timeout,
        maxWait: INTERACTIVE_SAVE_TX_OPTIONS.maxWait,
      });
      // 本体 update は tx 内で include 付き。
      expect(txMock.task.update.mock.calls[0][0]).toMatchObject({
        where: { id: 1 },
        data: { description: '<p>本文</p>' },
      });
      // 説明面のみ全置換（面を跨がない: deleteMany は DESCRIPTION の 1 回だけ）。
      expect(txMock.taskMention.deleteMany).toHaveBeenCalledTimes(1);
      expect(txMock.taskMention.deleteMany).toHaveBeenCalledWith({
        where: { taskId: 1, field: 'DESCRIPTION' },
      });
      expect(txMock.taskMention.createMany.mock.calls[0][0].data).toEqual([
        { taskId: 1, accountId: 'u2', field: 'DESCRIPTION' },
        { taskId: 1, accountId: 'u3', field: 'DESCRIPTION' },
      ]);
      // delete → create の順序（全置換のセマンティクス）。
      const deleteOrder = txMock.taskMention.deleteMany.mock.invocationCallOrder[0];
      const createOrder = txMock.taskMention.createMany.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(createOrder);
      expect(result).toBe(entity);
    });

    it('顛末面指定時は TENMATSU 面のみ全置換し説明面を据え置くこと', async () => {
      txMock.task.update.mockResolvedValue(makeTaskEntity());

      await repo.update(1, { tenmatsu: '結論' } as never, { tenmatsuMentionAccountIds: ['u4'] });

      expect(txMock.taskMention.deleteMany).toHaveBeenCalledTimes(1);
      expect(txMock.taskMention.deleteMany).toHaveBeenCalledWith({
        where: { taskId: 1, field: 'TENMATSU' },
      });
      expect(txMock.taskMention.createMany.mock.calls[0][0].data).toEqual([
        { taskId: 1, accountId: 'u4', field: 'TENMATSU' },
      ]);
    });

    it('両面同時指定は各面を独立に全置換すること（面別独立保存）', async () => {
      txMock.task.update.mockResolvedValue(makeTaskEntity());

      await repo.update(1, { description: '本文', tenmatsu: '結論' } as never, {
        descriptionMentionAccountIds: ['u2'],
        tenmatsuMentionAccountIds: ['u4'],
      });

      const deleteFields = txMock.taskMention.deleteMany.mock.calls.map((c) => c[0].where.field);
      expect(deleteFields).toEqual(['DESCRIPTION', 'TENMATSU']);
      const created = txMock.taskMention.createMany.mock.calls.flatMap((c) => c[0].data);
      expect(created).toEqual([
        { taskId: 1, accountId: 'u2', field: 'DESCRIPTION' },
        { taskId: 1, accountId: 'u4', field: 'TENMATSU' },
      ]);
    });

    it('空配列の面は deleteMany のみ（全クリア・createMany なし）で置換すること', async () => {
      txMock.task.update.mockResolvedValue(makeTaskEntity());

      await repo.update(1, { description: '' } as never, { descriptionMentionAccountIds: [] });

      expect(txMock.taskMention.deleteMany).toHaveBeenCalledWith({
        where: { taskId: 1, field: 'DESCRIPTION' },
      });
      expect(txMock.taskMention.createMany).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('id 指定で delete を呼ぶこと', async () => {
      const entity = makeTaskEntity();
      mockPrisma.task.delete.mockResolvedValue(entity);
      await repo.delete(1);
      expect(mockPrisma.task.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });
  });

  describe('findAllForTree', () => {
    it('アーカイブ済分類を除外しつつ未分類も残し、category + sourceTheme(select id/title) include、(カテゴリ sortOrder → sortOrder → id) 昇順で findMany を呼ぶこと', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);

      await repo.findAllForTree();

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
        // アーカイブ済分類のタスクはツリーに出さない（rete-desk-0140）が、未分類（categoryId=null /
        // rete-desk-0158）は残す。OR で「非アーカイブ分類 OR 未分類」を許す。
        where: { OR: [{ category: { archivedAt: null } }, { categoryId: null }] },
        include: {
          category: true,
          sourceTheme: { select: { id: true, title: true, spaceId: true } },
          assignee: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
        },
        orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { id: 'asc' }],
      });
    });
  });

  describe('findById', () => {
    // dsk-0356: 内部バリデーション用。reactions を含まない。
    it('sourceTheme + assignee + owner を include し reactions は含めないこと（dsk-0356）', async () => {
      mockPrisma.task.findUnique.mockResolvedValue(makeTaskEntity());
      await repo.findById(1);
      expect(mockPrisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        include: {
          sourceTheme: { select: { id: true, title: true, spaceId: true } },
          assignee: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
        },
      });
      const arg = mockPrisma.task.findUnique.mock.calls[0][0];
      expect(arg.include).not.toHaveProperty('reactions');
    });
  });

  describe('findByIdWithReactions', () => {
    it('sourceTheme + reactions(select emoji/authorId・dsk-0297) を include して findUnique を呼ぶこと（dsk-0356）', async () => {
      mockPrisma.task.findUnique.mockResolvedValue(makeTaskEntity());
      await repo.findByIdWithReactions(1);
      expect(mockPrisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        include: {
          sourceTheme: { select: { id: true, title: true, spaceId: true } },
          assignee: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
          reactions: { select: { emoji: true, authorId: true } },
        },
      });
    });
  });

  describe('findThemeById', () => {
    it('chatTheme.findUnique を id 指定・id/spaceId select で呼ぶこと（可視性確認に必要な列だけ取得）', async () => {
      mockPrisma.chatTheme.findUnique.mockResolvedValue({ id: 'theme-1', spaceId: 'space-1' });
      const result = await repo.findThemeById('theme-1');
      expect(mockPrisma.chatTheme.findUnique).toHaveBeenCalledWith({
        where: { id: 'theme-1' },
        select: { id: true, spaceId: true },
      });
      expect(result).toEqual({ id: 'theme-1', spaceId: 'space-1' });
    });

    it('存在しなければ null を返すこと', async () => {
      mockPrisma.chatTheme.findUnique.mockResolvedValue(null);
      expect(await repo.findThemeById('missing')).toBeNull();
    });
  });

  describe('getDepth', () => {
    // depth = ルートから当該タスクまでの階層数（ルート=1）。親チェーンを辿って算出する。
    it('親が無い（ルート）タスクの depth は 1', async () => {
      mockPrisma.task.findUnique.mockResolvedValueOnce({ parentTaskId: null });
      expect(await repo.getDepth(10)).toBe(1);
    });

    it('親チェーンを辿って depth を数えること（3 階層 → depth 3）', async () => {
      // id:30 → parent 20 → parent 10 → parent null
      mockPrisma.task.findUnique
        .mockResolvedValueOnce({ parentTaskId: 20 })
        .mockResolvedValueOnce({ parentTaskId: 10 })
        .mockResolvedValueOnce({ parentTaskId: null });
      expect(await repo.getDepth(30)).toBe(3);
      expect(mockPrisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 30 },
        select: { parentTaskId: true },
      });
    });

    it('対象タスクが存在しなければ 0 を返すこと（呼び出し側で NOT_FOUND 判断）', async () => {
      mockPrisma.task.findUnique.mockResolvedValueOnce(null);
      expect(await repo.getDepth(999)).toBe(0);
    });
  });

  describe('createWithSortOrder', () => {
    const baseData = {
      title: '昇格タスク',
      category: { connect: { id: 1 } },
    } as never;

    it('append（afterTaskId 省略・トップレベル）: 兄弟グループ max+1 を sortOrder にして末尾 create', async () => {
      txMock.task.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
      txMock.task.create.mockResolvedValue(makeTaskEntity({ sortOrder: 5 }));

      await repo.createWithSortOrder(baseData, {
        spaceId: DEFAULT_CHANNEL_ID,
        categoryId: 1,
        parentTaskId: null,
      });

      // 兄弟グループ（categoryId + parentTaskId）の max(sortOrder) を集計
      expect(txMock.task.aggregate).toHaveBeenCalledWith({
        where: { spaceId: DEFAULT_CHANNEL_ID, categoryId: 1, parentTaskId: null },
        _max: { sortOrder: true },
      });
      // 末尾に追加: max(4)+1 = 5
      expect(txMock.task.create.mock.calls[0][0].data.sortOrder).toBe(5);
      // シフトは発生しない
      expect(txMock.task.updateMany).not.toHaveBeenCalled();
    });

    it('append で兄弟が居ない（max=null）場合は sortOrder=0 で create', async () => {
      txMock.task.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      txMock.task.create.mockResolvedValue(makeTaskEntity({ sortOrder: 0 }));

      await repo.createWithSortOrder(baseData, {
        spaceId: DEFAULT_CHANNEL_ID,
        categoryId: 1,
        parentTaskId: null,
      });

      expect(txMock.task.create.mock.calls[0][0].data.sortOrder).toBe(0);
    });

    it('child（parentTaskId 指定・afterTaskId 省略）: 子グループ max+1 で末尾 create', async () => {
      txMock.task.findUnique.mockResolvedValue({ spaceId: DEFAULT_CHANNEL_ID });
      txMock.task.aggregate.mockResolvedValue({ _max: { sortOrder: 1 } });
      txMock.task.create.mockResolvedValue(makeTaskEntity({ parentTaskId: 7, sortOrder: 2 }));

      await repo.createWithSortOrder(baseData, {
        spaceId: DEFAULT_CHANNEL_ID,
        categoryId: 1,
        parentTaskId: 7,
      });

      expect(txMock.task.aggregate).toHaveBeenCalledWith({
        where: { spaceId: DEFAULT_CHANNEL_ID, categoryId: 1, parentTaskId: 7 },
        _max: { sortOrder: true },
      });
      expect(txMock.task.create.mock.calls[0][0].data.sortOrder).toBe(2);
      expect(txMock.task.updateMany).not.toHaveBeenCalled();
    });

    it('sibling（afterTaskId 指定）: 基準兄弟の直後に挿入し、それ以降の兄弟を +1 シフトしてから create', async () => {
      // 基準兄弟（afterTaskId=42）の sortOrder=3。read は tx 経由（tx.task.findUnique）。
      txMock.task.findUnique.mockResolvedValueOnce({
        sortOrder: 3,
        spaceId: DEFAULT_CHANNEL_ID,
        categoryId: 1,
        parentTaskId: null,
      });
      txMock.task.create.mockResolvedValue(makeTaskEntity({ sortOrder: 4 }));

      await repo.createWithSortOrder(baseData, {
        spaceId: DEFAULT_CHANNEL_ID,
        categoryId: 1,
        parentTaskId: null,
        afterTaskId: 42,
      });

      // 基準兄弟の sortOrder を tx 内で取得（tx 外 read 禁止）
      expect(txMock.task.findUnique).toHaveBeenCalledWith({
        where: { id: 42 },
        select: { sortOrder: true, spaceId: true, categoryId: true, parentTaskId: true },
      });
      // tx 外の prisma.task.findUnique は使われない
      expect(mockPrisma.task.findUnique).not.toHaveBeenCalled();
      // sortOrder >= 4 の兄弟を +1 シフト（同一兄弟グループ内）
      expect(txMock.task.updateMany).toHaveBeenCalledWith({
        where: {
          spaceId: DEFAULT_CHANNEL_ID,
          categoryId: 1,
          parentTaskId: null,
          sortOrder: { gte: 4 },
        },
        data: { sortOrder: { increment: 1 } },
      });
      // 挿入: afterTask.sortOrder + 1 = 4
      expect(txMock.task.create.mock.calls[0][0].data.sortOrder).toBe(4);
      // シフト → create の順序（create の前に updateMany が呼ばれる）
      const shiftOrder = txMock.task.updateMany.mock.invocationCallOrder[0];
      const createOrder = txMock.task.create.mock.invocationCallOrder[0];
      expect(shiftOrder).toBeLessThan(createOrder);
    });

    it('create に渡す data へ sourceThemeId を含められること（昇格永続化）', async () => {
      txMock.task.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      txMock.task.create.mockResolvedValue(makeTaskEntity({ sourceThemeId: 'theme-1' }));

      const data = {
        title: '昇格',
        category: { connect: { id: 1 } },
        sourceTheme: { connect: { id: 'theme-1' } },
      } as never;
      await repo.createWithSortOrder(data, {
        spaceId: DEFAULT_CHANNEL_ID,
        categoryId: 1,
        parentTaskId: null,
      });

      expect(txMock.task.create.mock.calls[0][0].data.sourceTheme).toEqual({
        connect: { id: 'theme-1' },
      });
    });

    it('mentions.descriptionMentionAccountIds 指定時は DESCRIPTION 面で createMany すること（dsk-0203）', async () => {
      txMock.task.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      txMock.task.create.mockResolvedValue(makeTaskEntity({ id: 9 }));

      await repo.createWithSortOrder(
        baseData,
        { spaceId: DEFAULT_CHANNEL_ID, categoryId: 1, parentTaskId: null },
        {
          descriptionMentionAccountIds: ['u1', 'u2'],
        },
      );

      expect(txMock.taskMention.createMany).toHaveBeenCalledTimes(1);
      expect(txMock.taskMention.createMany.mock.calls[0][0].data).toEqual([
        { taskId: 9, accountId: 'u1', field: 'DESCRIPTION' },
        { taskId: 9, accountId: 'u2', field: 'DESCRIPTION' },
      ]);
    });

    it('mentions.tenmatsuMentionAccountIds 指定時は TENMATSU 面で createMany すること（dsk-0284）', async () => {
      txMock.task.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      txMock.task.create.mockResolvedValue(makeTaskEntity({ id: 10 }));

      await repo.createWithSortOrder(
        baseData,
        { spaceId: DEFAULT_CHANNEL_ID, categoryId: 1, parentTaskId: null },
        {
          tenmatsuMentionAccountIds: ['u3'],
        },
      );

      expect(txMock.taskMention.createMany).toHaveBeenCalledTimes(1);
      expect(txMock.taskMention.createMany.mock.calls[0][0].data).toEqual([
        { taskId: 10, accountId: 'u3', field: 'TENMATSU' },
      ]);
    });

    it('両面とも指定時は面ごとに独立して createMany すること（dsk-0284）', async () => {
      txMock.task.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      txMock.task.create.mockResolvedValue(makeTaskEntity({ id: 11 }));

      await repo.createWithSortOrder(
        baseData,
        { spaceId: DEFAULT_CHANNEL_ID, categoryId: 1, parentTaskId: null },
        {
          descriptionMentionAccountIds: ['u1'],
          tenmatsuMentionAccountIds: ['u2'],
        },
      );

      expect(txMock.taskMention.createMany).toHaveBeenCalledTimes(2);
      const created = txMock.taskMention.createMany.mock.calls.flatMap((c) => c[0].data);
      expect(created).toEqual([
        { taskId: 11, accountId: 'u1', field: 'DESCRIPTION' },
        { taskId: 11, accountId: 'u2', field: 'TENMATSU' },
      ]);
    });

    it('mentions 未指定 / 空配列では createMany を呼ばないこと', async () => {
      txMock.task.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      txMock.task.create.mockResolvedValue(makeTaskEntity({ id: 12 }));

      await repo.createWithSortOrder(baseData, {
        spaceId: DEFAULT_CHANNEL_ID,
        categoryId: 1,
        parentTaskId: null,
      });

      expect(txMock.taskMention.createMany).not.toHaveBeenCalled();
    });
  });

  describe('findCategoryById', () => {
    it('category.findUnique を id 指定・id + name + archivedAt + spaceId select で呼ぶこと（存在 + アーカイブ + Space 整合判定用 / name は監査ログ流用）', async () => {
      mockPrisma.category.findUnique.mockResolvedValue({
        id: 3,
        name: '出荷',
        archivedAt: null,
        spaceId: 'space-1',
      });
      const result = await repo.findCategoryById(3);
      expect(mockPrisma.category.findUnique).toHaveBeenCalledWith({
        where: { id: 3 },
        // spaceId は rete-desk-0158 の Space 整合検証（category.spaceId === task.spaceId）に使う。
        // name は監査ログ（dsk-0223）の新カテゴリ表示ラベルへ流用する（検証と同一クエリで取得し二重 SELECT を防ぐ）。
        select: { id: true, name: true, archivedAt: true, spaceId: true },
      });
      expect(result).not.toBeNull();
    });

    it('存在しなければ null を返すこと', async () => {
      mockPrisma.category.findUnique.mockResolvedValue(null);
      expect(await repo.findCategoryById(999)).toBeNull();
    });
  });

  describe('getSubtreeHeight', () => {
    // 高さ = 対象を根とするサブツリーの最大階層数（対象のみ=1、対象+子=2）。
    // 子孫方向を BFS で走査し、frontend 申告（subtreeDepth）を信用せず backend で自前算出する。
    it('葉ノード（子なし）の高さは 1', async () => {
      mockPrisma.task.findMany.mockResolvedValueOnce([]); // 子なし
      expect(await repo.getSubtreeHeight(10)).toBe(1);
      expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
        where: { parentTaskId: { in: [10] } },
        select: { id: true },
      });
    });

    it('2 段（対象 → 子）の高さは 2', async () => {
      mockPrisma.task.findMany
        .mockResolvedValueOnce([{ id: 11 }, { id: 12 }]) // 10 の子
        .mockResolvedValueOnce([]); // 11,12 の子なし
      expect(await repo.getSubtreeHeight(10)).toBe(2);
    });

    it('3 段（対象 → 子 → 孫）の高さは 3', async () => {
      mockPrisma.task.findMany
        .mockResolvedValueOnce([{ id: 11 }]) // 10 の子
        .mockResolvedValueOnce([{ id: 21 }]) // 11 の子
        .mockResolvedValueOnce([]); // 21 の子なし
      expect(await repo.getSubtreeHeight(10)).toBe(3);
    });
  });

  describe('moveTask', () => {
    // 移動対象 id=100。読み取りは tx 経由（tx 外 read を禁止）。
    const movingTask = (over = {}) => ({
      id: 100,
      spaceId: DEFAULT_CHANNEL_ID,
      categoryId: 1,
      parentTaskId: null,
      sortOrder: 2,
      ...over,
    });

    it('同一兄弟グループ内の並べ替え: 移動元の穴埋め（>old を -1）→ 挿入位置で押し出し（>=insert を +1）→ 自身を update', async () => {
      // 対象は categoryId=1 トップレベル sortOrder=2。同グループ内で afterTaskId=5（sortOrder=4）の直後へ。
      txMock.task.findUnique
        .mockResolvedValueOnce(movingTask()) // 対象本体
        .mockResolvedValueOnce({
          sortOrder: 4,
          spaceId: DEFAULT_CHANNEL_ID,
          categoryId: 1,
          parentTaskId: null,
        }); // afterTask（穴埋め後の読み取り）
      txMock.task.findMany.mockResolvedValue([]); // 子孫なし（カテゴリ波及なし）
      txMock.task.update.mockResolvedValue(makeTaskEntity({ id: 100, sortOrder: 4 }));

      await repo.moveTask(100, { parentTaskId: null, categoryId: 1, afterTaskId: 5 });

      // 穴埋め: 移動元グループで old(2) より後ろを -1
      expect(txMock.task.updateMany).toHaveBeenCalledWith({
        where: {
          spaceId: DEFAULT_CHANNEL_ID,
          categoryId: 1,
          parentTaskId: null,
          sortOrder: { gt: 2 },
        },
        data: { sortOrder: { decrement: 1 } },
      });
      // 押し出し: 移動先グループで insertAt(=afterSortOrder 4 +1? ) 以上を +1
      const pushCall = txMock.task.updateMany.mock.calls.find(
        (c) => c[0].data.sortOrder?.increment === 1,
      );
      expect(pushCall).toBeDefined();
      // 自身の update: 新 parentTaskId/categoryId/sortOrder
      const updateCall = txMock.task.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 100 });
      expect(updateCall.data.parentTaskId).toBe(null);
      expect(updateCall.data.categoryId).toBe(1);
      expect(typeof updateCall.data.sortOrder).toBe('number');
    });

    it('未設定の Space（null）のタスクは、既定の器の兄弟を巻き込まずに自分のグループで穴埋めすること（d687）', async () => {
      // null 行は migration で既定の器へ backfill 済み。万一残っていても、穴埋めの絞りは実列の
      // 値（null）で組み、`space_id = 既定の器` に当たらない。null を既定の器へ読み替えると
      // 既定の器の兄弟まで -1 して採番がずれる。
      txMock.task.findUnique.mockResolvedValueOnce(
        movingTask({ spaceId: null, categoryId: 1, parentTaskId: null, sortOrder: 2 }),
      );
      txMock.task.findMany.mockResolvedValue([]);
      txMock.task.update.mockResolvedValue(makeTaskEntity({ id: 100, sortOrder: 0 }));

      await repo.moveTask(100, { parentTaskId: null, categoryId: 1, afterTaskId: null });

      const fillCall = txMock.task.updateMany.mock.calls.find(
        (c) => c[0].data.sortOrder?.decrement === 1,
      );
      expect(fillCall?.[0].where).toEqual({
        spaceId: null,
        categoryId: 1,
        parentTaskId: null,
        sortOrder: { gt: 2 },
      });
    });

    it('afterTaskId=null（兄弟グループ先頭挿入）: insertAt=0 で押し出し、sortOrder=0 で update', async () => {
      txMock.task.findUnique.mockResolvedValueOnce(
        movingTask({ categoryId: 1, parentTaskId: null, sortOrder: 3 }),
      );
      txMock.task.findMany.mockResolvedValue([]);
      txMock.task.update.mockResolvedValue(makeTaskEntity({ id: 100, sortOrder: 0 }));

      txMock.task.findUnique.mockResolvedValue({ spaceId: DEFAULT_CHANNEL_ID });
      await repo.moveTask(100, { parentTaskId: 7, categoryId: 1, afterTaskId: null });

      // 移動先グループ（parentTaskId=7）で sortOrder>=0 を +1 押し出し
      expect(txMock.task.updateMany).toHaveBeenCalledWith({
        where: {
          spaceId: DEFAULT_CHANNEL_ID,
          categoryId: 1,
          parentTaskId: 7,
          sortOrder: { gte: 0 },
        },
        data: { sortOrder: { increment: 1 } },
      });
      const updateCall = txMock.task.update.mock.calls[0][0];
      expect(updateCall.data.parentTaskId).toBe(7);
      expect(updateCall.data.sortOrder).toBe(0);
    });

    it('別カテゴリ移動: 対象＋子孫の categoryId を移動先へ一括更新すること', async () => {
      // 対象 categoryId=1 → 移動先 categoryId=9。子孫 [200,201] を波及。
      txMock.task.findUnique.mockResolvedValueOnce(
        movingTask({ categoryId: 1, parentTaskId: null, sortOrder: 0 }),
      );
      txMock.task.findMany
        .mockResolvedValueOnce([{ id: 200 }]) // 100 の子
        .mockResolvedValueOnce([{ id: 201 }]) // 200 の子
        .mockResolvedValueOnce([]); // 201 の子なし
      txMock.task.update.mockResolvedValue(makeTaskEntity({ id: 100, categoryId: 9 }));

      await repo.moveTask(100, { parentTaskId: null, categoryId: 9, afterTaskId: null });

      // 子孫の categoryId を一括で移動先へ（updateMany で descendant id を指定）
      const cascadeCall = txMock.task.updateMany.mock.calls.find(
        (c) => c[0].data.categoryId === 9 && c[0].where.id?.in,
      );
      expect(cascadeCall).toBeDefined();
      expect((cascadeCall![0].where.id.in as number[]).sort((a, b) => a - b)).toEqual([200, 201]);
      // 自身の categoryId も移動先
      expect(txMock.task.update.mock.calls[0][0].data.categoryId).toBe(9);
    });

    it('同一カテゴリ内移動では categoryId 波及 updateMany を発行しないこと', async () => {
      txMock.task.findUnique.mockResolvedValueOnce(movingTask({ categoryId: 1 }));
      txMock.task.findMany.mockResolvedValue([]);
      txMock.task.update.mockResolvedValue(makeTaskEntity({ id: 100 }));

      await repo.moveTask(100, { parentTaskId: null, categoryId: 1, afterTaskId: null });

      const cascadeCall = txMock.task.updateMany.mock.calls.find((c) => c[0].where.id?.in);
      expect(cascadeCall).toBeUndefined();
    });

    it('全操作を単一 $transaction に束ねること', async () => {
      txMock.task.findUnique.mockResolvedValueOnce(movingTask());
      txMock.task.findMany.mockResolvedValue([]);
      txMock.task.update.mockResolvedValue(makeTaskEntity({ id: 100 }));

      await repo.moveTask(100, { parentTaskId: null, categoryId: 1, afterTaskId: null });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('子孫収集が循環ガードで打ち切られた場合 tx を throw すること（サイレント部分波及の防止 / 指摘[4]）', async () => {
      // カテゴリ変更（1→9）で子孫波及を起動。各レベルが常に子を返す＝循環相当でガードに到達。
      // 打ち切り時点で未走査の子孫が categoryId 波及から漏れるため、握りつぶさず throw する。
      txMock.task.findUnique.mockResolvedValueOnce(
        movingTask({ categoryId: 1, parentTaskId: null, sortOrder: 0 }),
      );
      // 何回呼ばれても子を返し続ける（ループが MAX_TASK_DEPTH+1 ガードで打ち切られる状況）。
      txMock.task.findMany.mockResolvedValue([{ id: 999 }]);

      // cmn-0335: 例外の種類まで固定（どんな例外でも緑になる書き方を残さない）。
      await expect(
        repo.moveTask(100, { parentTaskId: null, categoryId: 9, afterTaskId: null }),
      ).rejects.toThrow('Descendant traversal exceeded depth guard');
      // 子孫が確定しないため本体 update には到達しない。
      expect(txMock.task.update).not.toHaveBeenCalled();
    });
  });
});
