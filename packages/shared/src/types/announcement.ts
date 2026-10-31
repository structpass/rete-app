import type { AttachmentDto } from './attachment';
import type { TagDto } from './tag';

/**
 * お知らせ種別の SSOT（hom-0072 / cmn-0084）。
 *
 * backend の DTO バリデーション（@IsIn(ANNOUNCEMENT_KINDS)）と frontend の型定義が
 * 本定義を import して使う（FAVORITE_KINDS と同方針・§5 shared 型整合）。
 */

/** お知らせ種別の許可集合（backend が @IsIn で強制し frontend が同集合で型付けする SSOT）。 */
export const ANNOUNCEMENT_KINDS = ['board', 'faq'] as const;

/** お知らせ種別のリテラル union（ANNOUNCEMENT_KINDS の要素型）。'board'=掲示板 / 'faq'=FAQ。 */
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

/**
 * お知らせタグの種別の許可集合（ホームのカレンダーが付ける 'calendar' を含む・d743）。
 * お知らせ本体は `ANNOUNCEMENT_KINDS` の 2 種だけだが、タグは予定にも付くため種別が 1 つ多い。
 * DB 側の CHECK 制約（`announcement_tags_kind_check`）と一致させ、手書き CHECK との照合
 * （`scripts/check-constraint-drift`）のコード側正本にする。
 */
export const ANNOUNCEMENT_TAG_KINDS = ['board', 'calendar', 'faq'] as const;

/** お知らせタグ種別のリテラル union（ANNOUNCEMENT_TAG_KINDS の要素型）。 */
export type AnnouncementTagKindValue = (typeof ANNOUNCEMENT_TAG_KINDS)[number];

/**
 * お知らせに付与されたタグの Response 形（rete-home-0043）。形状は TagDto と同一だが、
 * 別マスタ（GET /announcement-tags）という意味づけのためドメイン名だけを分ける。
 */
export type AnnouncementTagDto = TagDto;

/**
 * 掲示板（通知）の一覧 1 行（左ペイン）。本文 body は含まない（詳細取得で個別に引く）。
 * backend の AnnouncementSummaryDto（modules/announcement/dto/announcement-response.dto.ts）と同形。
 * important/isNew は hom-0054 で廃止（タグで代替）。
 */
export interface AnnouncementSummaryDto {
  id: string;
  title: string;
  /** 掲出日時 ISO 8601。 */
  publishedAt: string;
  author: string;
  /** 一覧 2 行目の概要（backend mapper 導出・タグ除去済テキスト）。 */
  excerpt: string;
  /** 未読フラグ（HM-3・ADR 0029）。閲覧者が未読なら true。 */
  unread: boolean;
  /** 付与されたお知らせタグ（name 昇順 / rete-home-0043）。未付与は空配列。 */
  tags: AnnouncementTagDto[];
}

/**
 * 掲示板（通知）の詳細（右ペイン）。本文 body（sanitize 済 HTML）と添付一覧を含む。
 * backend の AnnouncementDetailDto と同形。important/isNew は hom-0054 で廃止。
 */
export interface AnnouncementDetailDto {
  id: string;
  title: string;
  publishedAt: string;
  author: string;
  body: string;
  /** 添付ファイル（H0022・添付日時昇順）。添付なしは空配列。 */
  attachments: AttachmentDto[];
  /** 付与されたお知らせタグ（name 昇順 / rete-home-0043）。未付与は空配列。 */
  tags: AnnouncementTagDto[];
}
