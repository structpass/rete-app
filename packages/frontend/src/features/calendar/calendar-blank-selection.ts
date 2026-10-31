import type { CalendarEditor } from './use-calendar-editor';
import type { useCalendarPeriod } from './use-calendar-period';
export function calendarBlankSelection(
  period: ReturnType<typeof useCalendarPeriod>,
  editor: CalendarEditor,
  clearFilter: () => void,
) {
  const select = (action: () => void, focus: () => void) =>
    editor.returnToList(() => {
      clearFilter();
      action();
      focus();
    });
  return {
    onSelectDay: (day: string, focus: () => void) => select(() => period.selectDate(day), focus),
    onSelectSlot: (day: string, slot: number, focus: () => void) =>
      select(() => period.selectSlot(day, slot), focus),
  };
}
