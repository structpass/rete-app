import type {
  ApiResponse,
  CalendarEventSummary,
  CalendarEventDetail,
  CalendarEventInput,
  CalendarEventPatch,
} from '@rete/shared';
import apiClient from '@/lib/api-client';
export async function fetchCalendarEvents(from: string, to: string, q: string, tagIds: string[]) {
  return (
    await apiClient.get<ApiResponse<CalendarEventSummary[]>>('/calendar-events', {
      params: { from, to, q, tagIds: tagIds.length ? tagIds.join(',') : undefined },
    })
  ).data.data;
}
export async function fetchCalendarEvent(id: string) {
  return (await apiClient.get<ApiResponse<CalendarEventDetail>>(`/calendar-events/${id}`)).data
    .data;
}
export async function saveCalendarEvent(
  input: CalendarEventInput | CalendarEventPatch,
  id?: string,
) {
  return (
    await (id
      ? apiClient.patch<ApiResponse<CalendarEventDetail>>(`/calendar-events/${id}`, input)
      : apiClient.post<ApiResponse<CalendarEventDetail>>('/calendar-events', input))
  ).data.data;
}
export async function deleteCalendarEvent(id: string, revision: number) {
  await apiClient.delete(`/calendar-events/${id}`, { params: { revision } });
}
