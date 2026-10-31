import { toCalendarEventDetail, toCalendarEventSummary } from './calendar-events.mapper';

const person = { id: 'account', name: '開発統括' };
function tag(name: string, archivedAt: Date | null = null) {
  return { id: `tag-${name}`, name, icon: 'Tag', color: 'green', archivedAt };
}
function row() {
  return {
    id: 'event',
    title: '定例会',
    startAt: new Date('2026-10-25T00:00:00Z'),
    endAt: new Date('2026-10-25T01:30:00Z'),
    allDay: false,
    revision: 3,
    memo: '議事メモ',
    createdBy: person,
    updatedBy: person,
    createdAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-24T00:00:00Z'),
  };
}
describe('予定の応答の形（d814）', () => {
  it('一覧の行は日時を UTC の ISO 文字列にし、タグを合わせた形で返す', () => {
    const summary = toCalendarEventSummary({ ...row(), tagAssignments: [{ tag: tag('会議') }] });
    expect(summary).toEqual({
      id: 'event',
      title: '定例会',
      startAt: '2026-10-25T00:00:00.000Z',
      endAt: '2026-10-25T01:30:00.000Z',
      allDay: false,
      revision: 3,
      tags: [{ id: 'tag-会議', name: '会議', icon: 'Tag', color: 'green', archived: false }],
    });
    // 一覧に要らない列（メモ・作成者・作成日時）は載せない。
    expect(summary).not.toHaveProperty('memo');
    expect(summary).not.toHaveProperty('createdBy');
    expect(summary).not.toHaveProperty('createdAt');
    // DB の形（付与行）をそのまま応答へ漏らさない。
    expect(summary).not.toHaveProperty('tagAssignments');
  });

  it('タグの archivedAt は archived へ畳み、生の archivedAt は応答に載せない', () => {
    const [archived] = toCalendarEventSummary({
      ...row(),
      tagAssignments: [{ tag: tag('旧', new Date('2026-09-01T00:00:00Z')) }],
    }).tags;
    expect(archived).toEqual({
      id: 'tag-旧',
      name: '旧',
      icon: 'Tag',
      color: 'green',
      archived: true,
    });
    expect(archived).not.toHaveProperty('archivedAt');
  });

  it('タグの並びは入力順に頼らず名前昇順にそろえる', () => {
    const tags = toCalendarEventSummary({
      ...row(),
      tagAssignments: [{ tag: tag('さ') }, { tag: tag('あ') }, { tag: tag('か') }],
    }).tags;
    expect(tags.map((t) => t.name)).toEqual(['あ', 'か', 'さ']);
  });

  it('タグの無い予定は空の配列を返す（null にしない）', () => {
    expect(toCalendarEventSummary({ ...row(), tagAssignments: [] }).tags).toEqual([]);
  });

  it('一覧の応答は決めた列だけを載せる（行が余分な列を運んできても漏らさない）', () => {
    // Repository の read に列が増えても、一覧の形は mapper が決めるので応答は変わらない。
    const leaked = { ...row(), tagAssignments: [], extra: '漏れ', memo: '漏れ' };
    const summary = toCalendarEventSummary(leaked);
    expect(summary).not.toHaveProperty('extra');
    expect(summary).not.toHaveProperty('memo');
    expect(summary).not.toHaveProperty('createdBy');
    expect(Object.keys(summary).sort()).toEqual(
      ['allDay', 'endAt', 'id', 'revision', 'startAt', 'tags', 'title'].sort(),
    );
  });

  it('詳細は一覧の形にメモ・作成/更新者・作成/更新日時を足し、タグは一覧と同じ形で返す', () => {
    const assignments = [{ tag: tag('会議') }];
    expect(toCalendarEventDetail({ ...row(), tagAssignments: assignments })).toEqual({
      ...toCalendarEventSummary({ ...row(), tagAssignments: assignments }),
      memo: '議事メモ',
      createdBy: person,
      updatedBy: person,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z',
    });
  });
});
