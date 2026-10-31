import type { CalendarEventSummary } from '@rete/shared';
import { addDays, localInput } from './calendar-dates';
export const calendarShortDate = (key: string) =>
  `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
export function calendarEventRange(
  event: Pick<CalendarEventSummary, 'startAt' | 'endAt' | 'allDay'>,
) {
  const start = localInput(event.startAt),
    end = localInput(event.endAt);
  if (event.allDay) {
    const last = addDays(end.slice(0, 10), -1);
    return start.slice(0, 10) === last
      ? `${calendarShortDate(start)} 終日`
      : `${calendarShortDate(start)} ～ ${calendarShortDate(last)} 終日`;
  }
  const timed = (key: string) =>
    `${calendarShortDate(key)} ${Number(key.slice(11, 13))}:${key.slice(14, 16)}`;
  return `${timed(start)} ～ ${timed(end)}`;
}

/** Compact formatting for event-list rows. All-day endAt remains exclusive in storage. */
export function calendarEventListRange(
  event: Pick<CalendarEventSummary, 'startAt' | 'endAt' | 'allDay'>,
) {
  const start = localInput(event.startAt),
    end = localInput(event.endAt);
  const first = start.slice(0, 10);
  const last = event.allDay ? addDays(end.slice(0, 10), -1) : end.slice(0, 10);
  if (event.allDay)
    return first === last
      ? calendarShortDate(first)
      : `${calendarShortDate(first)} ～ ${calendarShortDate(last)}`;
  const time = (value: string) => `${Number(value.slice(11, 13))}:${value.slice(14, 16)}`;
  return first === last
    ? `${calendarShortDate(first)} ${time(start)} ～ ${time(end)}`
    : `${calendarShortDate(first)}（${time(start)}） ～ ${calendarShortDate(last)}（${time(end)}）`;
}
