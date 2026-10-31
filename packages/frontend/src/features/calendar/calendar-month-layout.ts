import type { CalendarEventSummary } from '@rete/shared';
import { addDays, overlaps } from './calendar-dates';
export function calendarMonthLayout(events: CalendarEventSummary[], days: string[], limit = 3) {
  const lanes: number[] = [];
  const segments: { event: CalendarEventSummary; start: number; end: number; lane: number }[] = [];
  const hidden = days.map(() => 0);
  const sorted = [...events].sort(
    (a, b) =>
      a.startAt.localeCompare(b.startAt) ||
      b.endAt.localeCompare(a.endAt) ||
      a.id.localeCompare(b.id),
  );
  for (const event of sorted) {
    const positions = days.flatMap((day, index) =>
      overlaps(event, day, addDays(day, 1)) ? [index] : [],
    );
    if (!positions.length) continue;
    const start = positions[0],
      end = positions.at(-1)! + 1;
    const mask = ((1 << (end - start)) - 1) << start;
    let lane = lanes.findIndex((occupied) => (occupied & mask) === 0);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(0);
    }
    lanes[lane] |= mask;
    if (lane < limit) segments.push({ event, start, end, lane });
    else for (const index of positions) hidden[index]++;
  }
  return { segments, hidden };
}
