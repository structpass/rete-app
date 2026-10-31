import { describe, expect, it } from 'vitest';
import { calendarEventListRange } from './calendar-event-presentation';
import { toInstant } from './calendar-dates';
describe('event list date formats', () => {
  it.each([
    {
      start: '2026-10-12T09:00',
      end: '2026-10-12T10:00',
      allDay: false,
      text: '10/12 9:00 ～ 10:00',
    },
    {
      start: '2026-10-12T09:00',
      end: '2026-10-13T10:00',
      allDay: false,
      text: '10/12（9:00） ～ 10/13（10:00）',
    },
    { start: '2026-10-12T00:00', end: '2026-10-13T00:00', allDay: true, text: '10/12' },
    { start: '2026-10-12T00:00', end: '2026-10-14T00:00', allDay: true, text: '10/12 ～ 10/13' },
  ])('formats $text', ({ start, end, allDay, text }) =>
    expect(
      calendarEventListRange({ startAt: toInstant(start), endAt: toInstant(end), allDay }),
    ).toBe(text),
  );
  it('uses Japan dates rather than UTC dates when deciding whether the endpoints share a day', () => {
    expect(
      calendarEventListRange({
        startAt: '2026-10-11T15:00:00.000Z',
        endAt: '2026-10-12T01:00:00.000Z',
        allDay: false,
      }),
    ).toBe('10/12 0:00 ～ 10:00');
  });
});
