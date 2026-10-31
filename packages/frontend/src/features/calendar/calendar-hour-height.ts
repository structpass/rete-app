/** Initial visible time range; all 24 hours remain scrollable. */
export const calendarWorkStart = 8;
export const calendarWorkEnd = 20;
/** Unmeasured fallback: 70% of the previous 42px tick. */
export const calendarMinHourHeight = 42 * 0.7;
// Keep the requested twelve-hour range even when the holiday/all-day header is tall.
export const calendarFloorHourHeight = 1;
export const defaultHeaderHeight = 76;
export const calendarGridPadding = 24;

/** Measure the constrained viewport, excluding its sticky header. Never measure the day body. */
export function calendarHourHeight(
  available: number,
  headerHeight = defaultHeaderHeight,
): number | null {
  if (!(available > 0)) return null;
  return Math.max(
    calendarFloorHourHeight,
    (available - headerHeight - calendarGridPadding) / (calendarWorkEnd - calendarWorkStart),
  );
}
export function calendarInitialScroll(view: {
  available: number;
  scrollHeight: number;
  hourHeight: number;
}): number {
  return Math.min(
    Math.max(0, view.scrollHeight - view.available),
    calendarGridPadding / 2 + view.hourHeight * calendarWorkStart,
  );
}
