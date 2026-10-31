import apiClient from '@/lib/api-client';
import type { ApiResponse, CalendarHoliday } from '@rete/shared';
export type { CalendarHoliday } from '@rete/shared';

export async function fetchCalendarHolidays(): Promise<CalendarHoliday[]> {
  return (await apiClient.get<ApiResponse<CalendarHoliday[]>>('/calendar-holidays')).data.data;
}
export async function saveCalendarHoliday(
  value: CalendarHoliday,
  original?: string,
): Promise<CalendarHoliday> {
  return original
    ? (await apiClient.patch<ApiResponse<CalendarHoliday>>(`/calendar-holidays/${original}`, value))
        .data.data
    : (await apiClient.post<ApiResponse<CalendarHoliday>>('/calendar-holidays', value)).data.data;
}
export async function deleteCalendarHoliday(date: string): Promise<void> {
  await apiClient.delete(`/calendar-holidays/${date}`);
}
