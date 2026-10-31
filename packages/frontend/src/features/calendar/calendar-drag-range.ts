import type { CalendarEventSummary } from '@rete/shared';
import { DAY, dayInstant } from './calendar-dates';

export type CalendarRange = { startAt: string; endAt: string };
export type CalendarDragMode = 'move' | 'start' | 'end';
export type CalendarDropPoint = { day: string; minute: number };

export function calendarDragRange(
  event: CalendarEventSummary,
  mode: CalendarDragMode,
  delta: number,
  unit = event.allDay ? DAY : 30 * 60000,
): CalendarRange {
  const start = Date.parse(event.startAt),
    end = Date.parse(event.endAt);
  const minimum = event.allDay ? DAY : Math.min(30 * 60000, end - start);
  if (mode === 'start') delta = Math.min(delta, Math.floor((end - start - minimum) / unit) * unit);
  if (mode === 'end') delta = Math.max(delta, Math.ceil((minimum - (end - start)) / unit) * unit);
  return {
    startAt: new Date(
      mode === 'end'
        ? start
        : mode === 'start'
          ? Math.min(start + delta, end - minimum)
          : start + delta,
    ).toISOString(),
    endAt: new Date(
      mode === 'start'
        ? end
        : mode === 'end'
          ? Math.max(end + delta, start + minimum)
          : end + delta,
    ).toISOString(),
  };
}

const clips = (overflow: string, value: number, start: number, end: number) =>
  /auto|scroll|hidden|clip/.test(overflow) && (value < start || value >= end);
function clipped(element: Element, root: Element, x: number, y: number) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent),
      rect = parent.getBoundingClientRect();
    if (clips(style.overflowY || style.overflow, y, rect.top, rect.bottom)) return true;
    if (clips(style.overflowX || style.overflow, x, rect.left, rect.right)) return true;
    if (parent === root) break;
  }
  if (element.getAttribute('data-calendar-drop-time') === 'true') {
    const header = root.querySelector('.calendar-time-header')?.getBoundingClientRect();
    if (header && y >= header.top && y < header.bottom) return true;
  }
  return false;
}
export function calendarDropPoint(
  root: Element,
  x: number,
  y: number,
  timeOnly = false,
): CalendarDropPoint | null {
  for (const element of root.querySelectorAll<HTMLElement>('[data-calendar-drop-day]')) {
    if (timeOnly && element.dataset.calendarDropTime !== 'true') continue;
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      x < rect.left ||
      x >= rect.right ||
      y < rect.top ||
      y >= rect.bottom
    )
      continue;
    if (clipped(element, root, x, y)) continue;
    const minute =
      element.dataset.calendarDropTime === 'true'
        ? Math.min(1410, Math.floor(((y - rect.top) / rect.height) * 48) * 30)
        : 0;
    return { day: element.dataset.calendarDropDay!, minute };
  }
  return null;
}

export function calendarDragDelta(
  origin: CalendarDropPoint,
  target: CalendarDropPoint,
  timed: boolean,
) {
  return (
    Date.parse(dayInstant(target.day)) -
    Date.parse(dayInstant(origin.day)) +
    (timed ? (target.minute - origin.minute) * 60000 : 0)
  );
}
