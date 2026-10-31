import type { AuthenticatedUser } from '../auth/auth.service';
import type { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import { CalendarEventsService } from './calendar-events.service';
import type { CalendarEventsRepository } from './calendar-events.repository';

/**
 * 応答の形を Service の出口（findAll / findOne / save）で固定する（d814）。
 * 変換を mapper へ寄せたので、列や時刻の形が変わると本文のこの形の照合が必ず赤くなる。
 */
describe('予定の応答の形（Service の出口・d814）', () => {
  const person = { id: 'account', name: '開発統括' };
  const tag = {
    id: 'tag-1',
    name: '会議',
    icon: 'Tag',
    color: 'green',
    archivedAt: null,
  };
  const row = {
    id: 'event',
    title: '定例会',
    startAt: new Date('2026-10-25T00:00:00Z'),
    endAt: new Date('2026-10-25T01:00:00Z'),
    allDay: false,
    revision: 2,
    memo: '議事メモ',
    createdBy: person,
    updatedBy: person,
    createdAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-24T00:00:00Z'),
    tagAssignments: [{ tag }],
  };
  const expectedTag = {
    id: 'tag-1',
    name: '会議',
    icon: 'Tag',
    color: 'green',
    archived: false,
  };
  const actor = { id: 'actor', name: 'tester', email: 't@example.com' } as AuthenticatedUser;
  const audit = { record: jest.fn() } as unknown as AuditRecorderService;

  it('一覧は日時を ISO 文字列にした行とタグだけを返す（詳細だけの列を載せない）', async () => {
    const repo = { findRange: jest.fn().mockResolvedValue([row]) };
    const service = new CalendarEventsService(repo as unknown as CalendarEventsRepository, audit);

    const response = await service.findAll({
      from: '2026-10-25T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
    });

    expect(response.data).toEqual([
      {
        id: 'event',
        title: '定例会',
        startAt: '2026-10-25T00:00:00.000Z',
        endAt: '2026-10-25T01:00:00.000Z',
        allDay: false,
        revision: 2,
        tags: [expectedTag],
      },
    ]);
    // 一覧の形は変えない（詳細だけが持つ列が混ざらないこと）。
    expect(Object.keys(response.data[0]).sort()).toEqual(
      ['allDay', 'endAt', 'id', 'revision', 'startAt', 'tags', 'title'].sort(),
    );
  });

  it('詳細は一覧の形にメモ・作成/更新者・作成/更新日時を足した形で返す', async () => {
    const repo = { findById: jest.fn().mockResolvedValue(row) };
    const service = new CalendarEventsService(repo as unknown as CalendarEventsRepository, audit);

    const response = await service.findOne('event');

    expect(response.data).toEqual({
      id: 'event',
      title: '定例会',
      startAt: '2026-10-25T00:00:00.000Z',
      endAt: '2026-10-25T01:00:00.000Z',
      allDay: false,
      revision: 2,
      tags: [expectedTag],
      memo: '議事メモ',
      createdBy: person,
      updatedBy: person,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z',
    });
  });

  it('保存の応答も詳細と同じ形で返す', async () => {
    const repo = { save: jest.fn().mockResolvedValue({ row }) };
    const service = new CalendarEventsService(repo as unknown as CalendarEventsRepository, audit);

    const response = await service.save(actor, {
      title: '定例会',
      startAt: '2026-10-25T09:00:00+09:00',
      endAt: '2026-10-25T10:00:00+09:00',
    });

    expect(response.data).toMatchObject({
      id: 'event',
      startAt: '2026-10-25T00:00:00.000Z',
      tags: [expectedTag],
      memo: '議事メモ',
    });
  });
});
