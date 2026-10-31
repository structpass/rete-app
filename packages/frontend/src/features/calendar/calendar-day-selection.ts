import type { MouseEvent } from 'react';
/** Select the clicked cell and focus its own date, including dates repeated in adjacent months. */
export function selectCalendarDay(
  event: MouseEvent<HTMLElement>,
  day: string,
  selectDate: (day: string) => void,
  busy: boolean,
  onSelectDay?: (day: string, focus: () => void) => void,
) {
  if (busy || (event.target as Element).closest('.calendar-event, .calendar-more')) return;
  const cell = event.currentTarget;
  const button =
    cell.querySelector<HTMLButtonElement>('.calendar-date') ??
    cell
      .closest('.calendar-time-week, .calendar-week')
      ?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`);
  const focus = () => button?.focus({ preventScroll: true });
  if (onSelectDay) onSelectDay(day, focus);
  else {
    selectDate(day);
    focus();
  }
}
