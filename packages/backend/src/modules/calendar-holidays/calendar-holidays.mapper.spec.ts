import { toCalendarHolidayDate, toCalendarHolidayResponse } from './calendar-holidays.mapper';

describe('祝日の応答の形（d815）', () => {
  it('日付だけの入力を UTC の 0 時として保存し、応答では YYYY-MM-DD へ戻す', () => {
    const row = { date: toCalendarHolidayDate('2026-01-01'), name: '元日' };
    expect(row.date.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(toCalendarHolidayResponse(row)).toEqual({ date: '2026-01-01', name: '元日' });
  });

  it('日本時間の前後で日付がずれても、保存した日付のまま返す', () => {
    // 保存は UTC の 0 時。日本時間へ直すと 9 時に見えるが、応答は日付だけを返す。
    expect(
      toCalendarHolidayResponse({ date: new Date('2026-05-06T00:00:00.000Z'), name: '休日' }),
    ).toEqual({ date: '2026-05-06', name: '休日' });
    expect(
      toCalendarHolidayResponse({ date: new Date('2026-12-31T00:00:00.000Z'), name: '年末' }),
    ).toEqual({ date: '2026-12-31', name: '年末' });
  });

  it('応答に時刻や Date を持ち込まない（形は date と name の 2 つだけ）', () => {
    const response = toCalendarHolidayResponse({
      date: toCalendarHolidayDate('2026-03-20'),
      name: '春分',
    });
    expect(Object.keys(response).sort()).toEqual(['date', 'name']);
    expect(typeof response.date).toBe('string');
  });
});
