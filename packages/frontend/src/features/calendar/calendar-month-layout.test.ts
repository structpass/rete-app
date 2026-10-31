import { describe, expect, it } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import { calendarMonthLayout } from './calendar-month-layout';
import { addDays, toInstant } from './calendar-dates';
const week = (start: string) => Array.from({ length: 7 }, (_, index) => addDays(start, index));
const item = (id: string, start: string, end: string): CalendarEventSummary => ({
  id,
  title: id,
  startAt: toInstant(start),
  endAt: toInstant(end),
  allDay: false,
  tags: [],
  revision: 1,
});
describe('month connected weekly bars', () => {
  it('merges adjacent dates once per week and starts a new segment after Sunday', () => {
    const event = item('long', '2026-10-24T09:00', '2026-10-27T10:00');
    const first = calendarMonthLayout([event], week('2026-10-19')).segments;
    const second = calendarMonthLayout([event], week('2026-10-26')).segments;
    expect(first).toEqual([{ event, start: 5, end: 7, lane: 0 }]);
    expect(second).toEqual([{ event, start: 0, end: 2, lane: 0 }]);
  });
  it('does not occupy the exclusive midnight ending date and reuses the free lane', () => {
    const events = [
      item('a', '2026-10-19T00:00', '2026-10-21T00:00'),
      item('b', '2026-10-21T09:00', '2026-10-21T10:00'),
    ];
    expect(
      calendarMonthLayout(events, week('2026-10-19')).segments.map(({ start, end, lane }) => ({
        start,
        end,
        lane,
      })),
    ).toEqual([
      { start: 0, end: 2, lane: 0 },
      { start: 2, end: 3, lane: 0 },
    ]);
  });
  it('keeps overlapping multi-day bars in separate lanes and counts hidden events on each day', () => {
    const events = Array.from({ length: 4 }, (_, index) =>
      item(String(index), '2026-10-19T09:00', '2026-10-21T10:00'),
    );
    const layout = calendarMonthLayout(events, week('2026-10-19'));
    expect(layout.segments.map(({ lane }) => lane)).toEqual([0, 1, 2]);
    expect(layout.hidden).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });
  it('clips an event spanning the entire week to seven columns without duplicating it', () => {
    const event = item('whole', '2026-09-30T12:00', '2026-11-01T00:00');
    expect(calendarMonthLayout([event], week('2026-10-19')).segments).toEqual([
      { event, start: 0, end: 7, lane: 0 },
    ]);
  });
});
