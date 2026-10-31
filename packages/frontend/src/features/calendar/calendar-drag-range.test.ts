import { describe, expect, it } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import { calendarDragDelta, calendarDragRange, calendarDropPoint } from './calendar-drag-range';
import { DAY, toInstant } from './calendar-dates';
const event: CalendarEventSummary = {
  id: 'e',
  title: '予定',
  startAt: toInstant('2026-10-31T09:15'),
  endAt: toInstant('2026-11-02T10:45'),
  revision: 1,
  allDay: false,
  tags: [],
};
describe('calendar drag ranges', () => {
  it('clamps crossing endpoints in whole gesture steps without changing clock minutes', () => {
    const short = {
      ...event,
      startAt: toInstant('2026-10-26T09:00'),
      endAt: toInstant('2026-10-27T10:00'),
    };
    expect(calendarDragRange(short, 'start', 2 * DAY, DAY).startAt).toBe(
      toInstant('2026-10-27T09:00'),
    );
    expect(calendarDragRange(short, 'end', -2 * DAY, DAY).endAt).toBe(
      toInstant('2026-10-26T10:00'),
    );
    const odd = { ...short, endAt: toInstant('2026-10-26T10:15') };
    expect(calendarDragRange(odd, 'start', DAY).startAt).toBe(toInstant('2026-10-26T09:30'));
  });
  it('rejects hidden rows outside a scroll viewport and timed rows occluded by its sticky header', () => {
    const root = document.createElement('div'),
      viewport = document.createElement('div'),
      day = document.createElement('div'),
      header = document.createElement('div');
    viewport.style.overflowY = 'auto';
    viewport.getBoundingClientRect = () =>
      ({ top: 100, bottom: 500, left: 0, right: 200, width: 200, height: 400 }) as DOMRect;
    day.dataset.calendarDropDay = '2026-11-01';
    day.dataset.calendarDropTime = 'true';
    day.getBoundingClientRect = () =>
      ({ top: 0, bottom: 1008, left: 0, right: 200, width: 200, height: 1008 }) as DOMRect;
    header.className = 'calendar-time-header';
    header.getBoundingClientRect = () =>
      ({ top: 100, bottom: 160, left: 0, right: 200, width: 200, height: 60 }) as DOMRect;
    root.append(viewport);
    viewport.append(header, day);
    document.body.append(root);
    expect(calendarDropPoint(root, 20, 90)).toBeNull();
    expect(calendarDropPoint(root, 20, 550)).toBeNull();
    expect(calendarDropPoint(root, 20, 120, true)).toBeNull();
    expect(calendarDropPoint(root, 20, 180, true)?.day).toBe('2026-11-01');
    root.remove();
  });
  it.each([DAY * 2, -DAY * 3, 30 * 60000])(
    'moves both endpoints by %s preserving exact duration',
    (delta) => {
      const range = calendarDragRange(event, 'move', delta);
      expect(Date.parse(range.startAt) - Date.parse(event.startAt)).toBe(delta);
      expect(Date.parse(range.endAt) - Date.parse(event.endAt)).toBe(delta);
    },
  );
  it('keeps the opposite endpoint fixed while resizing and prevents zero/negative durations', () => {
    const start = calendarDragRange(event, 'start', 10 * DAY);
    expect(start.endAt).toBe(event.endAt);
    expect(Date.parse(start.endAt) - Date.parse(start.startAt)).toBe(30 * 60000);
    const end = calendarDragRange(event, 'end', -10 * DAY);
    expect(end.startAt).toBe(event.startAt);
    expect(Date.parse(end.endAt) - Date.parse(end.startAt)).toBe(30 * 60000);
  });
  it('retains midnight and a minimum whole day for all-day resizing', () => {
    const allDay = {
      ...event,
      allDay: true,
      startAt: toInstant('2026-10-31T00:00'),
      endAt: toInstant('2026-11-03T00:00'),
    };
    const range = calendarDragRange(allDay, 'end', -10 * DAY);
    expect(range).toEqual({ startAt: allDay.startAt, endAt: toInstant('2026-11-01T00:00') });
  });
  it('calculates day and half-hour movement across midnight', () => {
    const origin = { day: '2026-10-31', minute: 1410 },
      target = { day: '2026-11-01', minute: 30 };
    expect(calendarDragDelta(origin, target, true)).toBe(60 * 60000);
    expect(calendarDragDelta(origin, target, false)).toBe(DAY);
  });
  it('uses measured day widths and actual time height and rejects blank/outside targets', () => {
    const root = document.createElement('div'),
      day = document.createElement('div');
    day.dataset.calendarDropDay = '2026-11-01';
    day.dataset.calendarDropTime = 'true';
    day.getBoundingClientRect = () =>
      ({ left: 100, right: 180, top: 50, bottom: 1058, width: 80, height: 1008 }) as DOMRect;
    root.append(day);
    expect(calendarDropPoint(root, 120, 50 + 21 * 19)).toEqual({ day: '2026-11-01', minute: 570 });
    expect(calendarDropPoint(root, 179, 1057)?.minute).toBe(1410);
    expect(calendarDropPoint(root, 180, 60)).toBeNull();
    expect(calendarDropPoint(root, 80, 60)).toBeNull();
  });
});
