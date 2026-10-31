import { CalendarEventsRepository } from './calendar-events.repository';
import { CalendarEventsService } from './calendar-events.service';
import type { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import type { PrismaService } from '../../database/prisma.service';

/**
 * 一覧の応答の形が「Repository が実際に選ぶ列」と食い違ったら赤くなる試験（d814・独立の目の指摘）。
 *
 * mapper だけを人工の行で試すと、Repository の select に列が増えても応答が変わらないように
 * 見えてしまい、実際のずれを捕まえられない。ここでは Repository が組み立てた問い合わせを
 * そのまま使い、select に載せた列だけを持つ行を返して、応答のキーを固定する。
 */
describe('一覧の応答の形と Repository の read の結び付き（d814）', () => {
  const tag = { id: 'tag-1', name: '会議', icon: 'Tag', color: 'green', archivedAt: null };

  /** select の指定どおりに、指定された列だけを持つ行を作る（実際の DB の返り方を写す）。 */
  function rowFromSelect(select: Record<string, unknown>, allDay: boolean) {
    const row: Record<string, unknown> = {};
    for (const key of Object.keys(select)) row[key] = key === 'allDay' ? allDay : valueOf(key);
    return row;
  }
  function valueOf(key: string): unknown {
    switch (key) {
      case 'id':
        return 'event';
      case 'title':
        return '定例会';
      case 'startAt':
        return new Date('2026-10-25T00:00:00Z');
      case 'endAt':
        return new Date('2026-10-25T01:00:00Z');
      case 'revision':
        return 2;
      case 'allDay':
        return false;
      case 'tagAssignments':
        return [{ tag }];
      default:
        throw new Error(`一覧の read に想定外の列が増えている: ${key}`);
    }
  }

  async function listResponse(allDay = false) {
    let query: { select: Record<string, unknown> } | undefined;
    const prisma = {
      calendarEvent: {
        findMany: jest.fn((args: { select: Record<string, unknown> }) => {
          query = args;
          return Promise.resolve([rowFromSelect(args.select, allDay)]);
        }),
      },
    };
    const repo = new CalendarEventsRepository(prisma as unknown as PrismaService);
    const service = new CalendarEventsService(repo, {
      record: jest.fn(),
    } as unknown as AuditRecorderService);
    const response = await service.findAll({
      from: '2026-10-25T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
    });
    return { response, query: query! };
  }

  it.each([false, true])('一覧は終日の印 %s を含めた表示に必要な項目だけを返す', async (allDay) => {
    const { response } = await listResponse(allDay);
    expect(response.data).toEqual([
      {
        id: 'event',
        title: '定例会',
        startAt: '2026-10-25T00:00:00.000Z',
        endAt: '2026-10-25T01:00:00.000Z',
        allDay,
        revision: 2,
        tags: [{ id: 'tag-1', name: '会議', icon: 'Tag', color: 'green', archived: false }],
      },
    ]);
    expect(Object.keys(response.data[0]).sort()).toEqual(
      ['allDay', 'endAt', 'id', 'revision', 'startAt', 'tags', 'title'].sort(),
    );
  });

  it('一覧の read は一覧に要る列だけを選ぶ（詳細用の列を読まない）', async () => {
    const { query } = await listResponse();
    expect(Object.keys(query.select).sort()).toEqual(
      ['allDay', 'endAt', 'id', 'revision', 'startAt', 'tagAssignments', 'title'].sort(),
    );
  });
});
