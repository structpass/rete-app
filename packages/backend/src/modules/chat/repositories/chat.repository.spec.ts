import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { ChatRepository } from './chat.repository';
import { PrismaService } from '../../../database/prisma.service';
import { INTERACTIVE_SAVE_TX_OPTIONS } from '../../../common/database/serializable-tx';
import { installTxPassthrough } from '../../../__tests__/tx-passthrough';

const txMock = {
  chatMessage: {
    create: jest.fn(),
    update: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  chatMessageMention: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  // テーマ宛先（説明面 / rete-desk-0116）の作成・差し替え。createTheme / updateTheme が tx 内で使う。
  chatThemeMention: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  chatTheme: {
    create: jest.fn(),
    update: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  // 同時投稿の直列化に使う行ロック（SELECT … FOR NO KEY UPDATE）。
  $queryRaw: jest.fn(),
};

const mockPrisma = {
  chatTheme: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    // v2-255: メッセージの親テーマ spaceId を関係フィルタで引く（findMessageById）。
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  chatMessageMention: {
    findMany: jest.fn(),
  },
  // テーマ宛先（説明/顛末 / rete-desk-0116）の自分宛集約。hasMentionToMe をメッセージ宛と合流させる。
  chatThemeMention: {
    findMany: jest.fn(),
  },
  // 未読集約（rete-desk-0075）: 既読時刻の取得・他者投稿最新時刻の groupBy・既読化 upsert。
  chatReadState: {
    findMany: jest.fn(),
    upsert: jest.fn(),
  },
  chatMessage: {
    groupBy: jest.fn(),
    // v2-255: メッセージ単体の存在確認（findMessageById）。
    findUnique: jest.fn(),
  },
  reaction: {
    findFirst: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
  },
  account: {
    count: jest.fn(),
  },
  // $transaction(cb) は cb(txMock) を実行して結果を返す（実装は beforeEach で毎回再設定）。
  $transaction: jest.fn(),
};

describe('ChatRepository', () => {
  let repo: ChatRepository;

  // cmn-0335: $transaction の通し設定を共通ヘルパへ委譲（見張り込みで beforeEach/afterEach を自前登録）。
  installTxPassthrough(mockPrisma, txMock);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repo = module.get<ChatRepository>(ChatRepository);
    // 未読集約クエリは既定で空（行なし）。未読シナリオを検証する個別テストで上書きする。
    mockPrisma.chatReadState.findMany.mockResolvedValue([]);
    mockPrisma.chatMessage.groupBy.mockResolvedValue([]);
    // テーマ宛先の自分宛集約も既定で空。hasMentionToMe の合流を検証する個別テストで上書きする。
    mockPrisma.chatThemeMention.findMany.mockResolvedValue([]);
  });

  describe('findThemesAndCount', () => {
    it('昇格済み（リンク済みタスクを持つ）テーマを一覧から除外する where を findMany / count 双方に適用すること', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({ page: 1, limit: 20 } as never);

      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where).toMatchObject({
        promotedTasks: { none: {} },
      });
      expect(mockPrisma.chatTheme.count.mock.calls[0][0].where).toMatchObject({
        promotedTasks: { none: {} },
      });
    });

    it('status / search 指定時も昇格除外と AND で併用すること', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({
        page: 1,
        limit: 20,
        status: 'OPEN',
        search: '在庫',
      } as never);

      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where).toMatchObject({
        promotedTasks: { none: {} },
        status: 'OPEN',
        OR: [
          { title: { contains: '在庫', mode: 'insensitive' } },
          { description: { contains: '在庫', mode: 'insensitive' } },
          { messages: { some: { body: { contains: '在庫', mode: 'insensitive' } } } },
        ],
      });
    });

    it('mentionFrom のみ指定時はメッセージ宛 OR テーマ本文宛（authorId in かつ mentions.some({})）で絞ること（From=メンション発信者 / rete-desk-0049・0116）', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({
        page: 1,
        limit: 20,
        mentionFrom: ['u1', 'u2'],
      } as never);

      // From だけでも「（誰かに）メンションした」ことを要求。メッセージ宛 OR テーマ本文宛（起票者）のいずれか。
      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where).toMatchObject({
        promotedTasks: { none: {} },
        AND: [
          {
            OR: [
              { messages: { some: { authorId: { in: ['u1', 'u2'] }, mentions: { some: {} } } } },
              { authorId: { in: ['u1', 'u2'] }, mentions: { some: {} } },
            ],
          },
        ],
      });
    });

    it('mentionTo のみ指定時はメッセージ宛 OR テーマ本文宛の accountId in で絞ること（To 内 OR / rete-desk-0116）', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({
        page: 1,
        limit: 20,
        mentionTo: ['u3'],
      } as never);

      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where).toMatchObject({
        AND: [
          {
            OR: [
              { messages: { some: { mentions: { some: { accountId: { in: ['u3'] } } } } } },
              { mentions: { some: { accountId: { in: ['u3'] } } } },
            ],
          },
        ],
      });
    });

    it('From+To 指定時はメッセージ宛（同一発話 AND）OR テーマ本文宛（起票者 AND）で絞ること（From×To AND / rete-desk-0116）', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({
        page: 1,
        limit: 20,
        mentionFrom: ['u1'],
        mentionTo: ['u3'],
      } as never);

      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where).toMatchObject({
        AND: [
          {
            OR: [
              {
                messages: {
                  some: {
                    authorId: { in: ['u1'] },
                    mentions: { some: { accountId: { in: ['u3'] } } },
                  },
                },
              },
              { authorId: { in: ['u1'] }, mentions: { some: { accountId: { in: ['u3'] } } } },
            ],
          },
        ],
      });
    });

    it('既定（archiveOnly 未指定）はアーカイブ済を除外する where（archivedAt: null）を適用すること（rete-desk-0061 を server 化）', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({ page: 1, limit: 20 } as never);

      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where).toMatchObject({
        archivedAt: null,
      });
      expect(mockPrisma.chatTheme.count.mock.calls[0][0].where).toMatchObject({
        archivedAt: null,
      });
    });

    it('archiveOnly=true 時はアーカイブ済のみ（archivedAt: { not: null }）へ反転すること', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({ page: 1, limit: 20, archiveOnly: true } as never);

      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where).toMatchObject({
        archivedAt: { not: null },
      });
    });

    it('tenmatsuOnly=true 時は顛末記録済（tenmatsu: { not: null }）のみへ絞ること（rete-desk-0050 を server 化）', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({ page: 1, limit: 20, tenmatsuOnly: true } as never);

      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where).toMatchObject({
        tenmatsu: { not: null },
      });
    });

    it('tenmatsuOnly 未指定時は tenmatsu 条件を付けないこと（記録済/未記録の両方を返す）', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({ page: 1, limit: 20 } as never);

      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where.tenmatsu).toBeUndefined();
    });

    it('search 指定時はタイトル / 説明 / スレッド本文の OR 部分一致（contains / insensitive）を where に適用すること（rete-desk-0048）', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({ page: 1, limit: 20, search: '在庫' } as never);

      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].where).toMatchObject({
        OR: [
          { title: { contains: '在庫', mode: 'insensitive' } },
          { description: { contains: '在庫', mode: 'insensitive' } },
          { messages: { some: { body: { contains: '在庫', mode: 'insensitive' } } } },
        ],
      });
    });

    it('search と mention を同時指定時は where.OR（検索）と where.AND（mention）が共存し AND 結合されること（rete-desk-0048・0116）', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({
        page: 1,
        limit: 20,
        search: '在庫',
        mentionFrom: ['u1'],
      } as never);

      const where = mockPrisma.chatTheme.findMany.mock.calls[0][0].where;
      // OR（検索）は top-level、mention は AND 内の OR。キーが別なので両立し AND 結合される。
      expect(where.OR).toEqual([
        { title: { contains: '在庫', mode: 'insensitive' } },
        { description: { contains: '在庫', mode: 'insensitive' } },
        { messages: { some: { body: { contains: '在庫', mode: 'insensitive' } } } },
      ]);
      expect(where.AND).toEqual([
        {
          OR: [
            { messages: { some: { authorId: { in: ['u1'] }, mentions: { some: {} } } } },
            { authorId: { in: ['u1'] }, mentions: { some: {} } },
          ],
        },
      ]);
    });

    it('include に take:1 のメッセージプローブを付けないこと（N+1 回避 / hasMentionToMe は別集約クエリ）', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([]);
      mockPrisma.chatTheme.count.mockResolvedValue(0);

      await repo.findThemesAndCount({ page: 1, limit: 20 } as never, 'me');

      // テーマ毎の take:1 ネストプローブは廃止（N+1 の元）。include は author / _count のみ。
      expect(mockPrisma.chatTheme.findMany.mock.calls[0][0].include.messages).toBeUndefined();
    });

    it('currentUserId 指定時は取得ページのテーマ id 群に対し単一の集約クエリで hasMentionToMe を判定すること', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
      mockPrisma.chatTheme.count.mockResolvedValue(2);
      // t1 のメッセージにのみ自分宛メンションがある状態。
      mockPrisma.chatMessageMention.findMany.mockResolvedValue([{ message: { themeId: 't1' } }]);

      const result = await repo.findThemesAndCount({ page: 1, limit: 20 } as never, 'me');

      // 1 クエリで「自分宛メンション × ページ内テーマ id」を引く（N 件のプローブにしない）。
      expect(mockPrisma.chatMessageMention.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.chatMessageMention.findMany.mock.calls[0][0]).toMatchObject({
        where: { accountId: 'me', message: { themeId: { in: ['t1', 't2'] } } },
        select: { message: { select: { themeId: true } } },
      });
      expect(result.mentionedThemeIds.has('t1')).toBe(true);
      expect(result.mentionedThemeIds.has('t2')).toBe(false);
    });

    it('テーマ本文（説明/顛末）宛メンション（rete-desk-0116）も hasMentionToMe へ合流すること', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
      mockPrisma.chatTheme.count.mockResolvedValue(2);
      // メッセージ宛は無し・テーマ本文（説明/顛末）で t2 が自分宛。
      mockPrisma.chatMessageMention.findMany.mockResolvedValue([]);
      mockPrisma.chatThemeMention.findMany.mockResolvedValue([{ themeId: 't2' }]);

      const result = await repo.findThemesAndCount({ page: 1, limit: 20 } as never, 'me');

      expect(mockPrisma.chatThemeMention.findMany.mock.calls[0][0]).toMatchObject({
        where: { accountId: 'me', themeId: { in: ['t1', 't2'] } },
        select: { themeId: true },
      });
      expect(result.mentionedThemeIds.has('t2')).toBe(true);
      expect(result.mentionedThemeIds.has('t1')).toBe(false);
    });

    it('currentUserId 無し時は hasMentionToMe 集約クエリを発行せず空集合を返すこと', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([{ id: 't1' }]);
      mockPrisma.chatTheme.count.mockResolvedValue(1);

      const result = await repo.findThemesAndCount({ page: 1, limit: 20 } as never);

      expect(mockPrisma.chatMessageMention.findMany).not.toHaveBeenCalled();
      expect(result.mentionedThemeIds.size).toBe(0);
    });
  });

  describe('未読集約（hasUnread / rete-desk-0075）', () => {
    const T0 = new Date('2026-06-01T00:00:00.000Z'); // テーマ起票
    const T1 = new Date('2026-06-02T00:00:00.000Z'); // 既読時刻
    const T2 = new Date('2026-06-03T00:00:00.000Z'); // 他者投稿の最新

    it('currentUserId 指定時は既読時刻と他者投稿最新時刻の 2 クエリで未読を判定すること', async () => {
      // t1: 他者投稿(T2)が既読(T1)より後 → 未読 / t2: 他者投稿(T0)が既読(T2)より前 → 既読
      mockPrisma.chatTheme.findMany.mockResolvedValue([
        { id: 't1', authorId: 'me', createdAt: T0 },
        { id: 't2', authorId: 'me', createdAt: T0 },
      ]);
      mockPrisma.chatTheme.count.mockResolvedValue(2);
      mockPrisma.chatMessageMention.findMany.mockResolvedValue([]);
      mockPrisma.chatReadState.findMany.mockResolvedValue([
        { themeId: 't1', lastReadAt: T1 },
        { themeId: 't2', lastReadAt: T2 },
      ]);
      mockPrisma.chatMessage.groupBy.mockResolvedValue([
        { themeId: 't1', _max: { createdAt: T2 } },
        { themeId: 't2', _max: { createdAt: T0 } },
      ]);

      const result = await repo.findThemesAndCount({ page: 1, limit: 20 } as never, 'me');

      // 既読時刻は本人 × ページ内テーマ id に限定して 1 クエリ。
      expect(mockPrisma.chatReadState.findMany.mock.calls[0][0]).toMatchObject({
        where: { accountId: 'me', themeId: { in: ['t1', 't2'] } },
        select: { themeId: true, lastReadAt: true },
      });
      // 他者投稿最新時刻は authorId != 自分で groupBy（自分の投稿は未読に数えない）。
      expect(mockPrisma.chatMessage.groupBy.mock.calls[0][0]).toMatchObject({
        by: ['themeId'],
        where: { themeId: { in: ['t1', 't2'] }, authorId: { not: 'me' } },
        _max: { createdAt: true },
      });
      expect(result.unreadThemeIds.has('t1')).toBe(true);
      expect(result.unreadThemeIds.has('t2')).toBe(false);
    });

    it('自分起票で他者活動が無いテーマは未読に数えないこと', async () => {
      // 自分起票（authorId=me）・他者投稿なし・既読行なし → 未読ゼロ（epoch 同士の比較で false）。
      mockPrisma.chatTheme.findMany.mockResolvedValue([
        { id: 't1', authorId: 'me', createdAt: T0 },
      ]);
      mockPrisma.chatTheme.count.mockResolvedValue(1);
      mockPrisma.chatMessageMention.findMany.mockResolvedValue([]);
      // chatReadState.findMany / chatMessage.groupBy は既定の空配列。

      const result = await repo.findThemesAndCount({ page: 1, limit: 20 } as never, 'me');

      expect(result.unreadThemeIds.size).toBe(0);
    });

    it('他者起票テーマは自分が未読込みなら未読に数えること（theme.createdAt を他者活動として扱う）', async () => {
      // 他者起票（authorId=other）・他者投稿なし・既読行なし → テーマ起票(T0) > epoch で未読。
      mockPrisma.chatTheme.findMany.mockResolvedValue([
        { id: 't1', authorId: 'other', createdAt: T0 },
      ]);
      mockPrisma.chatTheme.count.mockResolvedValue(1);
      mockPrisma.chatMessageMention.findMany.mockResolvedValue([]);

      const result = await repo.findThemesAndCount({ page: 1, limit: 20 } as never, 'me');

      expect(result.unreadThemeIds.has('t1')).toBe(true);
    });

    it('currentUserId 無し時は未読集約クエリを発行せず空集合を返すこと', async () => {
      mockPrisma.chatTheme.findMany.mockResolvedValue([
        { id: 't1', authorId: 'other', createdAt: T0 },
      ]);
      mockPrisma.chatTheme.count.mockResolvedValue(1);

      const result = await repo.findThemesAndCount({ page: 1, limit: 20 } as never);

      expect(mockPrisma.chatReadState.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.chatMessage.groupBy).not.toHaveBeenCalled();
      expect(result.unreadThemeIds.size).toBe(0);
    });
  });

  describe('markThemeRead', () => {
    it('最終既読時刻を現在時刻で upsert すること（冪等・複合キー account×theme）', async () => {
      mockPrisma.chatReadState.upsert.mockResolvedValue({ accountId: 'me', themeId: 't1' });

      await repo.markThemeRead('t1', 'me');

      const call = mockPrisma.chatReadState.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ accountId_themeId: { accountId: 'me', themeId: 't1' } });
      expect(call.create).toMatchObject({ accountId: 'me', themeId: 't1' });
      expect(call.create.lastReadAt).toBeInstanceOf(Date);
      expect(call.update.lastReadAt).toBeInstanceOf(Date);
    });
  });

  describe('createMessage', () => {
    beforeEach(() => {
      txMock.chatMessage.create.mockResolvedValue({
        id: 'm1',
        createdAt: new Date('2026-06-06T00:00:00Z'),
      });
      txMock.chatMessage.findUniqueOrThrow.mockResolvedValue({ id: 'm1' });
      // d623: 既定は親テーマが未更新（同じ or 古い）＝ 今回の投稿で前進する。
      txMock.chatTheme.findUniqueOrThrow.mockResolvedValue({
        lastMessageAt: new Date('2026-06-05T00:00:00Z'),
      });
    });

    it('メンション指定時はメッセージ作成と同一トランザクションで mention 行を createMany すること', async () => {
      await repo.createMessage('t1', 'author1', {
        body: '本文',
        mentionAccountIds: ['u2', 'u3'],
      } as never);

      expect(txMock.chatMessageMention.createMany.mock.calls[0][0].data).toEqual([
        { messageId: 'm1', accountId: 'u2' },
        { messageId: 'm1', accountId: 'u3' },
      ]);
    });

    it('メンション 0 件なら createMany を呼ばないこと（従来どおりの投稿）', async () => {
      await repo.createMessage('t1', 'author1', { body: '本文' } as never);
      expect(txMock.chatMessageMention.createMany).not.toHaveBeenCalled();
    });

    it('作成後に mentions(account id+name) を include して再取得し返すこと', async () => {
      await repo.createMessage('t1', 'author1', {
        body: '本文',
        mentionAccountIds: ['u2'],
      } as never);
      const call = txMock.chatMessage.findUniqueOrThrow.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'm1' });
      expect(call.include.mentions).toEqual({
        include: { account: { select: { id: true, name: true } } },
      });
    });

    it('親テーマの lastMessageAt を作成メッセージの createdAt に更新すること', async () => {
      await repo.createMessage('t1', 'author1', { body: '本文' } as never);
      expect(txMock.chatTheme.update.mock.calls[0][0]).toMatchObject({
        where: { id: 't1' },
        data: { lastMessageAt: new Date('2026-06-06T00:00:00Z') },
      });
    });

    // d623: 同時投稿で古い投稿の親更新が後から完了しても、lastMessageAt を過去へ戻さない。
    it('親の現在値が新しい投稿時刻より進んでいれば lastMessageAt を書き換えないこと', async () => {
      txMock.chatTheme.findUniqueOrThrow.mockResolvedValue({
        lastMessageAt: new Date('2026-06-06T00:00:01Z'),
      });

      await repo.createMessage('t1', 'author1', { body: '古い投稿' } as never);

      expect(txMock.chatTheme.update).not.toHaveBeenCalled();
      // 投稿自体は成功し、永続化した本文の再取得まで従来どおり行う。
      expect(txMock.chatMessage.findUniqueOrThrow).toHaveBeenCalled();
    });

    it('親の現在値と同時刻なら書き換えないこと（前進しない更新を省く）', async () => {
      txMock.chatTheme.findUniqueOrThrow.mockResolvedValue({
        lastMessageAt: new Date('2026-06-06T00:00:00Z'),
      });

      await repo.createMessage('t1', 'author1', { body: '同時刻' } as never);

      expect(txMock.chatTheme.update).not.toHaveBeenCalled();
    });

    it('外部キー検査と両立する行ロックを親更新より先に取ること（同時投稿の直列化）', async () => {
      const calls: string[] = [];
      txMock.$queryRaw.mockImplementation(() => {
        calls.push('lock');
        return Promise.resolve([{ id: 't1' }]);
      });
      txMock.chatTheme.findUniqueOrThrow.mockImplementation(() => {
        calls.push('read');
        return Promise.resolve({ lastMessageAt: new Date('2026-06-05T00:00:00Z') });
      });
      txMock.chatTheme.update.mockImplementation(() => {
        calls.push('update');
        return Promise.resolve({ id: 't1' });
      });

      await repo.createMessage('t1', 'author1', { body: '本文' } as never);

      expect(calls).toEqual(['lock', 'read', 'update']);
      const lockSql = (txMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
      expect(lockSql).toContain('FOR NO KEY UPDATE');
      // 表名の直書きは Prisma の @@map("chat_themes") と一致している必要がある（実 DB で存在しない
      // テーブルを掴むと投稿が全て失敗する）。FROM の直後を切り出して完全一致で照合する。
      expect(lockSql).toMatch(/(?:^|\s)FROM\s+"?(\w+)"?(?:\s|$)/);
      expect(lockSql.match(/(?:^|\s)FROM\s+"?(\w+)"?(?:\s|$)/)?.[1]).toBe('chat_themes');
    });
  });

  describe('updateMessage（rete-desk-0146: 自分の発話の本文編集）', () => {
    beforeEach(() => {
      txMock.chatMessage.update.mockResolvedValue({ id: 'm1' });
      txMock.chatMessage.findUniqueOrThrow.mockResolvedValue({ id: 'm1' });
    });

    it('body 差し替えと宛先全置換（deleteMany→createMany）を同一トランザクションで行うこと', async () => {
      await repo.updateMessage('m1', { body: '<p>修正後</p>', mentionAccountIds: ['u2', 'u3'] });
      expect(txMock.chatMessage.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'm1' },
        data: { body: '<p>修正後</p>' },
      });
      expect(txMock.chatMessageMention.deleteMany).toHaveBeenCalledWith({
        where: { messageId: 'm1' },
      });
      expect(txMock.chatMessageMention.createMany.mock.calls[0][0].data).toEqual([
        { messageId: 'm1', accountId: 'u2' },
        { messageId: 'm1', accountId: 'u3' },
      ]);
    });

    it('mentionAccountIds が空配列なら deleteMany のみ（全クリア・createMany は呼ばない）', async () => {
      await repo.updateMessage('m1', { body: '<p>x</p>', mentionAccountIds: [] });
      expect(txMock.chatMessageMention.deleteMany).toHaveBeenCalledWith({
        where: { messageId: 'm1' },
      });
      expect(txMock.chatMessageMention.createMany).not.toHaveBeenCalled();
    });

    it('mentionAccountIds 未指定なら宛先を一切触らない（据え置き / deleteMany も createMany も呼ばない）', async () => {
      await repo.updateMessage('m1', { body: '<p>x</p>' });
      expect(txMock.chatMessageMention.deleteMany).not.toHaveBeenCalled();
      expect(txMock.chatMessageMention.createMany).not.toHaveBeenCalled();
    });

    it('lastMessageAt は触らない（編集であって新規投稿ではない）', async () => {
      await repo.updateMessage('m1', { body: '<p>x</p>' });
      expect(txMock.chatTheme.update).not.toHaveBeenCalled();
    });

    it('更新後に author + mentions(account id+name) を include して再取得し返すこと', async () => {
      await repo.updateMessage('m1', { body: '<p>x</p>' });
      const call = txMock.chatMessage.findUniqueOrThrow.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'm1' });
      expect(call.include.mentions).toEqual({
        include: { account: { select: { id: true, name: true } } },
      });
    });
  });

  describe('countAccountsByIds', () => {
    it('指定 id 群のうち実在するアカウント数を返すこと（存在検証用）', async () => {
      mockPrisma.account.count.mockResolvedValue(2);
      const n = await repo.countAccountsByIds(['u1', 'u2']);
      expect(mockPrisma.account.count.mock.calls[0][0].where).toEqual({ id: { in: ['u1', 'u2'] } });
      expect(n).toBe(2);
    });
  });

  describe('findReaction', () => {
    it('messageId 指定時は themeId/taskCommentId/taskId を null にして既存リアクションを引くこと（4択 XOR の1つ）', async () => {
      mockPrisma.reaction.findFirst.mockResolvedValue(null);
      await repo.findReaction({ messageId: 'm1' }, 'acc1', '👍');
      expect(mockPrisma.reaction.findFirst.mock.calls[0][0].where).toEqual({
        authorId: 'acc1',
        emoji: '👍',
        messageId: 'm1',
        themeId: null,
        taskCommentId: null,
        taskId: null,
      });
    });

    it('themeId 指定時は messageId/taskCommentId/taskId を null にして引くこと', async () => {
      mockPrisma.reaction.findFirst.mockResolvedValue(null);
      await repo.findReaction({ themeId: 't1' }, 'acc1', '🎉');
      expect(mockPrisma.reaction.findFirst.mock.calls[0][0].where).toEqual({
        authorId: 'acc1',
        emoji: '🎉',
        messageId: null,
        themeId: 't1',
        taskCommentId: null,
        taskId: null,
      });
    });

    it('taskCommentId 指定時は messageId/themeId/taskId を null にして引くこと（dsk-0297・task-comments モジュールが cross-module DI で呼ぶ経路）', async () => {
      mockPrisma.reaction.findFirst.mockResolvedValue(null);
      await repo.findReaction({ taskCommentId: 'c1' }, 'acc1', '🎉');
      expect(mockPrisma.reaction.findFirst.mock.calls[0][0].where).toEqual({
        authorId: 'acc1',
        emoji: '🎉',
        messageId: null,
        themeId: null,
        taskCommentId: 'c1',
        taskId: null,
      });
    });

    it('taskId 指定時は messageId/themeId/taskCommentId を null にして引くこと（dsk-0297・tasks モジュールが cross-module DI で呼ぶ起点カード経路）', async () => {
      mockPrisma.reaction.findFirst.mockResolvedValue(null);
      await repo.findReaction({ taskId: 5 }, 'acc1', '🎉');
      expect(mockPrisma.reaction.findFirst.mock.calls[0][0].where).toEqual({
        authorId: 'acc1',
        emoji: '🎉',
        messageId: null,
        themeId: null,
        taskCommentId: null,
        taskId: 5,
      });
    });
  });

  describe('createReaction', () => {
    it('渡された target + author + emoji をそのまま create.data に載せること', async () => {
      mockPrisma.reaction.create.mockResolvedValue({ id: 'r1' });
      await repo.createReaction({ messageId: 'm1', authorId: 'acc1', emoji: '👍' });
      expect(mockPrisma.reaction.create.mock.calls[0][0].data).toEqual({
        messageId: 'm1',
        authorId: 'acc1',
        emoji: '👍',
      });
    });

    it('taskCommentId も target としてそのまま create.data に載せること（dsk-0297・4択 XOR の1つ）', async () => {
      mockPrisma.reaction.create.mockResolvedValue({ id: 'r2' });
      await repo.createReaction({ taskCommentId: 'c1', authorId: 'acc1', emoji: '🎉' });
      expect(mockPrisma.reaction.create.mock.calls[0][0].data).toEqual({
        taskCommentId: 'c1',
        authorId: 'acc1',
        emoji: '🎉',
      });
    });

    it('taskId も target としてそのまま create.data に載せること（dsk-0297・起点カード経路）', async () => {
      mockPrisma.reaction.create.mockResolvedValue({ id: 'r3' });
      await repo.createReaction({ taskId: 5, authorId: 'acc1', emoji: '🎉' });
      expect(mockPrisma.reaction.create.mock.calls[0][0].data).toEqual({
        taskId: 5,
        authorId: 'acc1',
        emoji: '🎉',
      });
    });
  });

  describe('deleteReactions', () => {
    it('messageId 指定時は themeId/taskCommentId/taskId を null にした where で deleteMany すること（冪等・対象0でもエラー化しない）', async () => {
      mockPrisma.reaction.deleteMany.mockResolvedValue({ count: 1 });
      await repo.deleteReactions({ messageId: 'm1' }, 'acc1', '👍');
      expect(mockPrisma.reaction.deleteMany.mock.calls[0][0].where).toEqual({
        authorId: 'acc1',
        emoji: '👍',
        messageId: 'm1',
        themeId: null,
        taskCommentId: null,
        taskId: null,
      });
    });

    it('themeId 指定時は messageId/taskCommentId/taskId を null にした where で deleteMany すること', async () => {
      mockPrisma.reaction.deleteMany.mockResolvedValue({ count: 0 });
      await repo.deleteReactions({ themeId: 't1' }, 'acc1', '🎉');
      expect(mockPrisma.reaction.deleteMany.mock.calls[0][0].where).toEqual({
        authorId: 'acc1',
        emoji: '🎉',
        messageId: null,
        themeId: 't1',
        taskCommentId: null,
        taskId: null,
      });
    });

    it('taskCommentId 指定時は messageId/themeId/taskId を null にした where で deleteMany すること（dsk-0297）', async () => {
      mockPrisma.reaction.deleteMany.mockResolvedValue({ count: 0 });
      await repo.deleteReactions({ taskCommentId: 'c1' }, 'acc1', '🎉');
      expect(mockPrisma.reaction.deleteMany.mock.calls[0][0].where).toEqual({
        authorId: 'acc1',
        emoji: '🎉',
        messageId: null,
        themeId: null,
        taskCommentId: 'c1',
        taskId: null,
      });
    });

    it('taskId 指定時は messageId/themeId/taskCommentId を null にした where で deleteMany すること（dsk-0297・起点カード経路）', async () => {
      mockPrisma.reaction.deleteMany.mockResolvedValue({ count: 0 });
      await repo.deleteReactions({ taskId: 5 }, 'acc1', '🎉');
      expect(mockPrisma.reaction.deleteMany.mock.calls[0][0].where).toEqual({
        authorId: 'acc1',
        emoji: '🎉',
        messageId: null,
        themeId: null,
        taskCommentId: null,
        taskId: 5,
      });
    });
  });

  describe('createTheme', () => {
    beforeEach(() => {
      txMock.chatTheme.create.mockResolvedValue({ id: 't1' });
      txMock.chatTheme.findUniqueOrThrow.mockResolvedValue({ id: 't1' });
    });

    it('descriptionMentionAccountIds 指定時はテーマ作成と同一 tx で説明面（field=DESCRIPTION）を createMany すること', async () => {
      await repo.createTheme('author1', {
        title: 'T',
        description: '本文',
        descriptionMentionAccountIds: ['u2', 'u3'],
      } as never);

      expect(txMock.chatThemeMention.createMany.mock.calls[0][0].data).toEqual([
        { themeId: 't1', accountId: 'u2', field: 'DESCRIPTION' },
        { themeId: 't1', accountId: 'u3', field: 'DESCRIPTION' },
      ]);
    });

    it('宛先 0 件なら createMany を呼ばないこと（従来どおりの作成）', async () => {
      await repo.createTheme('author1', { title: 'T' } as never);
      expect(txMock.chatThemeMention.createMany).not.toHaveBeenCalled();
    });

    it('spaceId 未指定なら DEFAULT_CHANNEL_ID を刻印すること（CM-2 孤児化防止）', async () => {
      await repo.createTheme('author1', { title: 'T' } as never);
      expect(txMock.chatTheme.create.mock.calls[0][0].data.spaceId).toBe(
        '00000000-0000-4000-b000-000000000003',
      );
    });

    it('spaceId 指定時はその器に刻印すること', async () => {
      const spaceId = '00000000-0000-4000-b000-000000000099';
      await repo.createTheme('author1', { title: 'T', spaceId } as never);
      expect(txMock.chatTheme.create.mock.calls[0][0].data.spaceId).toBe(spaceId);
    });
  });

  describe('updateTheme', () => {
    beforeEach(() => {
      txMock.chatTheme.findUniqueOrThrow.mockResolvedValue({ id: 't1' });
    });

    it('共通ヘルパ経由の Serializable tx で走ること（timeout / maxWait が落ちない）', async () => {
      await repo.updateTheme('t1', { title: '改題' });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // 直に $transaction を呼ぶ実装（isolationLevel だけ指定）へ戻すとここで落ちる＝リトライ・
      // 時間予算が効かない経路の復活を防ぐ（cmn-0251）。
      // 上限は対話保存向けの短いセット＝reorder 向け既定（15s）を人が待つ保存に被せない。
      expect(mockPrisma.$transaction.mock.calls[0][1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: INTERACTIVE_SAVE_TX_OPTIONS.timeout,
        maxWait: INTERACTIVE_SAVE_TX_OPTIONS.maxWait,
      });
    });

    it('本体更新を tx 内 update へ渡し（宛先キーは載せない）summary 用 include で再取得すること', async () => {
      await repo.updateTheme('t1', { title: '改題' });
      const upd = txMock.chatTheme.update.mock.calls[0][0];
      expect(upd.where).toEqual({ id: 't1' });
      expect(upd.data).toEqual({ title: '改題' });
      const refetch = txMock.chatTheme.findUniqueOrThrow.mock.calls[0][0];
      expect(refetch.include._count).toEqual({ select: { messages: true } });
    });

    it('descriptionMentionAccountIds 指定時は説明面（field=DESCRIPTION）を delete→createMany で全置換すること', async () => {
      await repo.updateTheme('t1', {
        description: '本文',
        descriptionMentionAccountIds: ['u2', 'u3'],
      });
      expect(txMock.chatThemeMention.deleteMany.mock.calls[0][0]).toEqual({
        where: { themeId: 't1', field: 'DESCRIPTION' },
      });
      expect(txMock.chatThemeMention.createMany.mock.calls[0][0].data).toEqual([
        { themeId: 't1', accountId: 'u2', field: 'DESCRIPTION' },
        { themeId: 't1', accountId: 'u3', field: 'DESCRIPTION' },
      ]);
    });

    it('descriptionMentionAccountIds が空配列なら説明面を delete のみ（createMany なし）で全クリアすること', async () => {
      await repo.updateTheme('t1', { description: '本文', descriptionMentionAccountIds: [] });
      expect(txMock.chatThemeMention.deleteMany).toHaveBeenCalledTimes(1);
      expect(txMock.chatThemeMention.createMany).not.toHaveBeenCalled();
    });

    it('descriptionMentionAccountIds 未指定なら宛先を一切触らないこと（顛末面も含め据え置き）', async () => {
      await repo.updateTheme('t1', { tenmatsu: '結論' });
      expect(txMock.chatThemeMention.deleteMany).not.toHaveBeenCalled();
      expect(txMock.chatThemeMention.createMany).not.toHaveBeenCalled();
    });

    it('tenmatsuMentionAccountIds 指定時は顛末面（field=TENMATSU）を delete→createMany で全置換すること（Phase B）', async () => {
      await repo.updateTheme('t1', { tenmatsu: '結論', tenmatsuMentionAccountIds: ['u4', 'u5'] });
      expect(txMock.chatThemeMention.deleteMany.mock.calls[0][0]).toEqual({
        where: { themeId: 't1', field: 'TENMATSU' },
      });
      expect(txMock.chatThemeMention.createMany.mock.calls[0][0].data).toEqual([
        { themeId: 't1', accountId: 'u4', field: 'TENMATSU' },
        { themeId: 't1', accountId: 'u5', field: 'TENMATSU' },
      ]);
    });

    it('tenmatsuMentionAccountIds が空配列なら顛末面を delete のみ（createMany なし）で全クリアすること（Phase B）', async () => {
      await repo.updateTheme('t1', { tenmatsu: '', tenmatsuMentionAccountIds: [] });
      expect(txMock.chatThemeMention.deleteMany.mock.calls[0][0]).toEqual({
        where: { themeId: 't1', field: 'TENMATSU' },
      });
      expect(txMock.chatThemeMention.createMany).not.toHaveBeenCalled();
    });

    it('説明面と顛末面を同時指定すると各 field を独立に置換すること（面別独立保存 / Phase B）', async () => {
      await repo.updateTheme('t1', {
        description: '本文',
        descriptionMentionAccountIds: ['u2'],
        tenmatsu: '結論',
        tenmatsuMentionAccountIds: ['u4'],
      });
      const deleteFields = txMock.chatThemeMention.deleteMany.mock.calls.map(
        (c) => c[0].where.field,
      );
      expect(deleteFields).toEqual(['DESCRIPTION', 'TENMATSU']);
      const created = txMock.chatThemeMention.createMany.mock.calls.flatMap((c) => c[0].data);
      expect(created).toEqual([
        { themeId: 't1', accountId: 'u2', field: 'DESCRIPTION' },
        { themeId: 't1', accountId: 'u4', field: 'TENMATSU' },
      ]);
    });
  });

  // v2-255: メッセージ 1 件の取得は、対象の実在に依存せず常に同じ 2 クエリ（メッセージ + 親テーマの spaceId）を
  // 通る。親テーマを include（同梱）で取ると 2 本目は親行が在るときだけ走り、その 1 本の差が応答時間に現れて
  // 「行が在るか」の oracle になる（不在 1 本 / 実在 2 本）。
  describe('findMessageById（v2-255: 不在でも親テーマの解決を必ず通る）', () => {
    it('対象が不在でも親テーマの spaceId 解決を同じ 1 クエリで走らせ、null を返す', async () => {
      mockPrisma.chatMessage.findUnique.mockResolvedValue(null);
      mockPrisma.chatTheme.findFirst.mockResolvedValue(null);

      const result = await repo.findMessageById('m-missing');

      expect(result).toBeNull();
      expect(mockPrisma.chatMessage.findUnique).toHaveBeenCalledWith({
        where: { id: 'm-missing' },
      });
      // 不在でも親テーマの解決を省略しない（クエリ数が実在/不在で変わらない＝入力依存不変条件）。
      expect(mockPrisma.chatTheme.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.chatTheme.findFirst.mock.calls[0][0]).toMatchObject({
        where: { messages: { some: { id: 'm-missing' } } },
        select: { spaceId: true },
      });
    });

    it('実在時はメッセージに親テーマの spaceId を同梱して返す（呼び出し側の読み口は従来どおり）', async () => {
      mockPrisma.chatMessage.findUnique.mockResolvedValue({
        id: 'm1',
        themeId: 't1',
        authorId: 'a1',
      });
      mockPrisma.chatTheme.findFirst.mockResolvedValue({ spaceId: 'space-x' });

      const result = await repo.findMessageById('m1');

      expect(result).toMatchObject({ id: 'm1', theme: { spaceId: 'space-x' } });
      expect(mockPrisma.chatTheme.findFirst).toHaveBeenCalledTimes(1);
    });
  });
});
