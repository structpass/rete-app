import type { AnnouncementTag } from '@prisma/client';

/** お知らせタグの Response DTO（§1 DTO 境界）。TagDto と同形状だが別マスタ。 */
export interface AnnouncementTagDto {
  id: string;
  name: string;
  icon: string;
  color: string;
  /** archivedAt 非 null を畳んだ計算値（hom-0083・Category と同方針）。生の archivedAt は公開しない。 */
  archived: boolean;
}

/**
 * 変換に要る列。Entity そのものの他、列を絞って read した行（予定カレンダーの一覧など）も
 * この正本変換を通せるように、使う列だけを受け取る（d814）。
 */
export type AnnouncementTagSource = Pick<
  AnnouncementTag,
  'id' | 'name' | 'icon' | 'color' | 'archivedAt'
>;

/**
 * AnnouncementTag Entity → AnnouncementTagDto（§1 DTO 境界・純粋関数 / rete-home-0043）。
 * File の toTagDto と同型の変換で、createdAt / updatedAt は DTO に載せない。
 */
export function toAnnouncementTagDto(tag: AnnouncementTagSource): AnnouncementTagDto {
  return {
    id: tag.id,
    name: tag.name,
    icon: tag.icon,
    color: tag.color,
    archived: tag.archivedAt != null,
  };
}
