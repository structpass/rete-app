export const DAY = 86400000;
export const dateKey = (date: Date) => date.toISOString().slice(0, 10);
export const calendarDate = (key: string) => new Date(`${key}T00:00:00Z`);
export const todayKey = () => dateKey(new Date(Date.now() + 9 * 3600000));
export const addDays = (key: string, count: number) =>
  dateKey(new Date(+calendarDate(key) + count * DAY));
export const monthStart = (key: string) => `${key.slice(0, 7)}-01`;
export function shiftMonth(key: string, count: number) {
  const date = calendarDate(key);
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return dateKey(
    new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date.getUTCDate(), last)),
    ),
  );
}
export const weekStart = (key: string) => addDays(key, -((calendarDate(key).getUTCDay() + 6) % 7));
export function monthDays(month: string) {
  const first = weekStart(monthStart(month));
  const next = shiftMonth(monthStart(month), 1);
  const end = weekStart(next) === next ? next : addDays(weekStart(next), 7);
  return Array.from(
    { length: Math.round((+calendarDate(end) - +calendarDate(first)) / DAY) },
    (_, i) => addDays(first, i),
  );
}
export const toInstant = (key: string) => new Date(`${key}:00+09:00`).toISOString();
export const dayInstant = (key: string) => toInstant(`${key}T00:00`);
export const localInput = (iso: string) =>
  new Date(+new Date(iso) + 9 * 3600000).toISOString().slice(0, 16);
export const overlaps = (event: { startAt: string; endAt: string }, from: string, to: string) =>
  event.startAt < dayInstant(to) && event.endAt > dayInstant(from);
export const monthLabel = (key: string) =>
  `${Number(key.slice(0, 4))}年${Number(key.slice(5, 7))}月`;
