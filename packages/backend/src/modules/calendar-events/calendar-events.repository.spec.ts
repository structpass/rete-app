import { CalendarEventsRepository } from './calendar-events.repository';
import { toCalendarEventSummary } from './calendar-events.mapper';
import type { PrismaService } from '../../database/prisma.service';

// 保存は直列化トランザクションの中で走る。ここでは中身の組み立てだけを見るので素通しにする。
jest.mock('../../common/database/serializable-tx', () => ({
  INTERACTIVE_SAVE_TX_OPTIONS: {},
  runInSerializableTransaction: (tx: unknown, work: (tx: unknown) => unknown) => work(tx),
}));

describe('CalendarEventsRepository.findRange（d814）', () => {
  const from = new Date('2026-10-25T00:00:00Z');
  const to = new Date('2026-11-01T00:00:00Z');
  const tagA = { id: 'tag-1', name: 'あ', icon: 'Tag', color: 'green', archivedAt: null };
  const tagB = { id: 'tag-2', name: 'ぶ', icon: 'Tag', color: 'blue', archivedAt: null };
  const first = {
    id: 'event-1',
    title: '定例会',
    startAt: new Date('2026-10-25T00:00:00Z'),
    endAt: new Date('2026-10-25T01:00:00Z'),
    allDay: false,
    revision: 1,
    tagAssignments: [{ tag: tagB }, { tag: tagA }],
  };
  const second = {
    id: 'event-2',
    title: 'タグなし',
    startAt: new Date('2026-10-26T00:00:00Z'),
    endAt: new Date('2026-10-26T01:00:00Z'),
    allDay: false,
    revision: 1,
    tagAssignments: [],
  };

  function fixture(rows: object[]) {
    const prisma = { calendarEvent: { findMany: jest.fn().mockResolvedValue(rows) } };
    return { prisma, repo: new CalendarEventsRepository(prisma as unknown as PrismaService) };
  }

  it('予定とタグを 1 つの問い合わせで取り、応答の形は mapper が組む', async () => {
    const { prisma, repo } = fixture([first, second]);

    const rows = await repo.findRange(from, to, '  定例  ', []);

    const query = prisma.calendarEvent.findMany.mock.calls[0][0];
    // タグは DTO に要る列だけを read する（DTO の形や jsonb の組み立てを問い合わせ側で作らない）。
    expect(query.select.tagAssignments).toEqual({
      select: {
        tag: { select: { id: true, name: true, icon: true, color: true, archivedAt: true } },
      },
      orderBy: { tag: { name: 'asc' } },
    });
    // 空の検索語で全件を消さない（前後の空白は詰める）。
    expect(query.where.AND).toEqual([
      {
        OR: [
          { title: { contains: '定例', mode: 'insensitive' } },
          { memo: { contains: '定例', mode: 'insensitive' } },
        ],
      },
    ]);
    // 期間の絞りは「期間の中で始まる」と「期間より前から続く」の 2 本に分ける（d883）。
    expect(query.where.OR).toEqual([
      { startAt: { gte: from, lt: to } },
      { startAt: { lt: from }, endAt: { gt: from } },
    ]);
    expect(query.where.startAt).toBeUndefined();
    expect(query.where.endAt).toBeUndefined();
    // タグの絞り込みは付与の有無で表す。
    expect(query.where.tagAssignments).toBeUndefined();
    expect(query.take).toBe(2001);

    // Repository は付与行のまま渡し、畳み込みは mapper が行う。
    expect(rows[0].tagAssignments).toEqual([{ tag: tagB }, { tag: tagA }]);
    expect(toCalendarEventSummary(rows[0]).tags.map((t) => t.name)).toEqual(['あ', 'ぶ']);
    expect(toCalendarEventSummary(rows[1]).tags).toEqual([]);
  });

  it('タグの並びも read の側で決める（mapper の再ソート任せにしない）', async () => {
    const { prisma, repo } = fixture([]);

    await repo.findRange(from, to, '', []);

    const { select } = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(select.tagAssignments).toMatchObject({ orderBy: { tag: { name: 'asc' } } });
  });

  it('検索語が空なら、文字の条件を作らない（期間の 2 本だけにする）', async () => {
    const { prisma, repo } = fixture([]);

    await repo.findRange(from, to, '   ', []);

    const { where } = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(where.AND).toBeUndefined();
    expect(where.OR).toEqual([
      { startAt: { gte: from, lt: to } },
      { startAt: { lt: from }, endAt: { gt: from } },
    ]);
  });

  it('タグの絞り込みは付与の有無で問い合わせる', async () => {
    const { prisma, repo } = fixture([]);

    await repo.findRange(from, to, '', ['tag-1']);

    expect(prisma.calendarEvent.findMany.mock.calls[0][0].where.tagAssignments).toEqual({
      some: { tagId: { in: ['tag-1'] } },
    });
  });
});

describe('CalendarEventsRepository.save の終日の印（d814）', () => {
  // 従来の呼び出し（終日の印を渡さない登録・更新）が、今の値を消さないことを固定する。
  function fixture() {
    const tx = {
      calendarEvent: {
        findUnique: jest.fn().mockResolvedValue({ revision: 1, tagAssignments: [] }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'event' }),
      },
      announcementTag: { findMany: jest.fn().mockResolvedValue([]) },
      calendarEventTagAssignment: { deleteMany: jest.fn(), createMany: jest.fn() },
    };
    const repo = new CalendarEventsRepository(tx as unknown as PrismaService);
    const data = {
      title: '定例会',
      startAt: new Date('2026-10-25T00:00:00Z'),
      endAt: new Date('2026-10-25T01:00:00Z'),
      memo: '',
    };
    return { tx, repo, data };
  }

  it('終日の印を渡さない更新では、その列を書かない（今の値を保つ）', async () => {
    const { tx, repo, data } = fixture();

    await repo.save('event', 'actor', data, 1);

    const written = tx.calendarEvent.updateMany.mock.calls[0][0].data;
    expect(written).not.toHaveProperty('allDay');
    expect(written).toMatchObject({ title: '定例会', memo: '' });
  });

  it('終日の印を渡した時は、その値を書く', async () => {
    const { tx, repo, data } = fixture();

    await repo.save('event', 'actor', { ...data, allDay: true }, 1);

    expect(tx.calendarEvent.updateMany.mock.calls[0][0].data).toMatchObject({ allDay: true });
  });
});
