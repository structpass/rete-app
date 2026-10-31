import type { CalendarEventSummary } from '@rete/shared';
import { addDays, dayInstant, overlaps } from './calendar-dates';

/** Clip to a JST day, then give each connected overlap group its own columns. */
export function calendarWeekLayout(
  events: CalendarEventSummary[],
  day: string,
  minimumMinutes = 0,
) {
  const midnight = +new Date(dayInstant(day));
  const items = events
    .filter((event) => overlaps(event, day, addDays(day, 1)))
    .map((event) => ({
      event,
      start: Math.max(0, (+new Date(event.startAt) - midnight) / 60000),
      end: Math.min(1440, (+new Date(event.endAt) - midnight) / 60000),
      column: 0,
      columns: 1,
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.event.id.localeCompare(b.event.id));
  let group: typeof items = [];
  let groupEnd = 0;
  let columnEnds: number[] = [];
  function finishGroup() {
    for (const item of group) item.columns = columnEnds.length;
    group = [];
    columnEnds = [];
  }
  for (const item of items) {
    if (group.length && item.start >= groupEnd) finishGroup();
    const available = columnEnds.findIndex((end) => end <= item.start);
    item.column = available === -1 ? columnEnds.length : available;
    const visibleEnd = Math.max(item.end, item.start + minimumMinutes);
    columnEnds[item.column] = visibleEnd;
    groupEnd = group.length ? Math.max(groupEnd, visibleEnd) : visibleEnd;
    group.push(item);
  }
  finishGroup();
  return items;
}
