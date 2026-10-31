import { describe, expect, it } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import { toInstant } from './calendar-dates';
import { calendarWeekLayout } from './calendar-week-layout';

function event(id: string, start: string, end: string): CalendarEventSummary {
  return {
    id,
    title: id,
    startAt: toInstant(start),
    endAt: toInstant(end),
    tags: [],
    allDay: false,
    revision: 1,
  };
}
describe('weekly time placement', () => {
  it('separates short adjacent appointments when their readable buttons would overlap', () => {
    const items = calendarWeekLayout(
      [
        event('first', '2026-10-24T09:00', '2026-10-24T09:15'),
        event('next', '2026-10-24T09:15', '2026-10-24T09:30'),
      ],
      '2026-10-24',
      30,
    );
    expect(items.map(({ column, columns }) => [column, columns])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(items[0]).toMatchObject({ start: 540, end: 555 });
  });
  it('places half-hour appointments using JST even in a UTC browser', () => {
    const [item] = calendarWeekLayout(
      [event('a', '2026-10-24T09:30', '2026-10-24T11:00')],
      '2026-10-24',
    );
    expect(item).toMatchObject({ start: 570, end: 660, column: 0, columns: 1 });
  });
  it('clips overnight events and omits the day after a midnight end', () => {
    const events = [
      event('night', '2026-10-23T23:30', '2026-10-24T01:00'),
      event('midnight', '2026-10-23T10:00', '2026-10-24T00:00'),
    ];
    expect(
      calendarWeekLayout(events, '2026-10-23').find((i) => i.event.id === 'night'),
    ).toMatchObject({ start: 1410, end: 1440 });
    expect(calendarWeekLayout(events, '2026-10-24')).toHaveLength(1);
    expect(calendarWeekLayout(events, '2026-10-24')[0]).toMatchObject({ start: 0, end: 60 });
  });
  it('keeps simultaneous appointments separate and reuses freed columns', () => {
    const events = [
      event('long', '2026-10-24T09:00', '2026-10-24T12:00'),
      event('first', '2026-10-24T09:30', '2026-10-24T10:00'),
      event('next', '2026-10-24T10:00', '2026-10-24T11:00'),
      event('later', '2026-10-24T12:00', '2026-10-24T13:00'),
    ];
    expect(
      calendarWeekLayout(events, '2026-10-24').map(({ column, columns }) => [column, columns]),
    ).toEqual([
      [0, 2],
      [1, 2],
      [1, 2],
      [0, 1],
    ]);
  });
});
