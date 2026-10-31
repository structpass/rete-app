import type { CalendarHoliday as CalendarHolidayRow } from '@prisma/client';
import type { CalendarHoliday as CalendarHolidayResponse } from '@rete/shared';

/** 祝日の行（Repository が渡す生の行）。日付は Date のまま受け、文字列化は mapper が行う。 */
export type CalendarHolidaySource = Pick<CalendarHolidayRow, 'date' | 'name'>;

/**
 * 日付だけの入力（YYYY-MM-DD）→ 保存する日付。日付には時刻も時間帯も無いため、
 * UTC の 0 時として持つ（予定の日時とは別の扱い）。
 */
export function toCalendarHolidayDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * Entity → 応答 DTO（§1 DTO 境界・純粋関数）。
 * 保存している日付を、時刻を落とした YYYY-MM-DD へ戻す（表示の形は画面側が決める）。
 */
export function toCalendarHolidayResponse(row: CalendarHolidaySource): CalendarHolidayResponse {
  return {
    date: row.date.toISOString().slice(0, 10),
    name: row.name,
  };
}
