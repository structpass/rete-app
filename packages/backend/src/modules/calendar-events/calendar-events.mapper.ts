import type { CalendarEventDetail, CalendarEventSummary, TagDto } from '@rete/shared';
import {
  toAnnouncementTagDto,
  type AnnouncementTagSource,
} from '../announcement-tags/announcement-tags.mapper';

/**
 * 予定に付いたタグを読み出すときの列（Prisma の select）。一覧・詳細ともこの形で read し、
 * 生の archivedAt を archived へ畳む計算は mapper の持ち場にする（d814）。
 */
export const calendarTagSelect = {
  id: true,
  name: true,
  icon: true,
  color: true,
  archivedAt: true,
} as const;
export type CalendarTagSource = AnnouncementTagSource;

/** 付与されたタグ（付与行のまま受け取る）。 */
export interface CalendarTagAssignment {
  tag: CalendarTagSource;
}

/**
 * 一覧の行（Repository が渡す生の行）。日時は Date のまま受け、文字列化は mapper が行う。
 * タグは付与行（tagAssignments[].tag）のまま受け取り、配列への畳み込みもここで行う
 * （Repository が応答の形を組まない・d814）。
 */
export interface CalendarSummarySource {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  revision: number;
  tagAssignments: readonly CalendarTagAssignment[];
}

/**
 * 詳細の行（一覧の行にメモ・作成/更新者・作成/更新日時が加わったもの）。
 * 終日の印は一覧・詳細ともに持ち、表示する領域を判定できるようにする。
 */
export interface CalendarDetailSource extends CalendarSummarySource {
  memo: string;
  createdBy: { id: string; name: string };
  updatedBy: { id: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 予定のタグ → TagDto[]（§1 DTO 境界・純粋関数）。
 * 予定のタグはお知らせタグと同じマスタなので、形づくりは正本 toAnnouncementTagDto に委ねる
 * （列が増減しても DTO 形状が 1 箇所で決まる・d814）。出力は name 昇順に揃える
 * （並びの正はここ。一覧・詳細とも同じ順で返す・announcement.mapper.toTagDtos と同方針）。
 * 付与が無い予定は空配列（null を返さない）。
 */
function toCalendarTags(assignments: readonly CalendarTagAssignment[]): TagDto[] {
  return assignments
    .map(({ tag }) => toAnnouncementTagDto(tag))
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/**
 * Entity → 一覧の行 DTO（§1 DTO 境界・純粋関数）。
 * 日時はインスタント（UTC）の ISO 文字列へ変換する（表示の形は画面側が決める）。
 * 載せる列はここで決める（行が詳細用の列を運んできても応答へ漏らさない）。
 */
export function toCalendarEventSummary(row: CalendarSummarySource): CalendarEventSummary {
  return {
    id: row.id,
    title: row.title,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    allDay: row.allDay,
    revision: row.revision,
    tags: toCalendarTags(row.tagAssignments),
  };
}

/**
 * Entity → 詳細 DTO（§1 DTO 境界・純粋関数）。一覧の行にメモ・作成/更新者・作成/更新日時を足す。
 * タグは付与タグをすべて載せる（予定に付くのは 1 つまでだが、ここでは絞らない）。
 */
export function toCalendarEventDetail(row: CalendarDetailSource): CalendarEventDetail {
  return {
    ...toCalendarEventSummary(row),
    memo: row.memo,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
