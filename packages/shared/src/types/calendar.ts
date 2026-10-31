import type { TagDto } from './tag';
export interface CalendarEventSummary {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  tags: TagDto[];
  revision: number;
}
export interface CalendarEventDetail extends CalendarEventSummary {
  memo: string;
  createdBy: { id: string; name: string };
  updatedBy: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
}
export interface CalendarEventInput {
  title: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  memo?: string;
  /** Optional calendar tag selection: zero or one ID. */
  tagIds?: string[];
}
export type CalendarEventPatch = Partial<CalendarEventInput> & { revision: number };
