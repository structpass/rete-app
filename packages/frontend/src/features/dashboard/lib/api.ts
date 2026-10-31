import type { HomeTagKind } from '@rete/shared';
import apiClient from '@/lib/api-client';
import {
  ApiResponse,
  PaginatedResponse,
  type AttachmentDto,
  type AnnouncementKind,
  type AnnouncementTagDto,
  type AnnouncementSummaryDto,
  type AnnouncementDetailDto,
} from '@rete/shared';

/**
 * 掲示板（通知）の API クライアント。backend announcement モジュールの Response DTO と同形で、
 * shape の正本は @rete/shared（AnnouncementSummaryDto / AnnouncementDetailDto）。
 * 変更系（作成/編集/削除）は backend 側で ADMIN 限定のため、非 ADMIN が呼ぶと 403 が throw される。
 * 通知先（targetRoles / targetBusinessRoles）は hom-0143 で機能ごと撤去（ADR 0036 superseded）。
 */

/**
 * お知らせタグ DTO（rete-home-0043）。形状の正本は @rete/shared の AnnouncementTagDto
 * （= TagDto。別マスタ＝GET /announcement-tags という意味づけのためドメイン名だけを分ける）。
 */
export type { AnnouncementTagDto };

/** 一覧 1 行（左ペイン）。本文 body は含まない。重要度フラグは hom-0054 で廃止。 */
export type AnnouncementSummary = AnnouncementSummaryDto;

/**
 * 通知の添付ファイル（H0022）。shape の正本は @rete/shared AttachmentDto（cmn-0015・backend AttachmentResponseDto と同形）。
 * 添付は「添付時点の版」を固定して指す（versionNo / byteSize / mimeType は固定版由来）。
 * fileId は最新版 DL（files の download エンドポイント）に使う。
 */
export type AnnouncementAttachment = AttachmentDto;

/** 詳細（右ペイン）。本文 body（sanitize 済 HTML）と添付一覧を含む。 */
export type AnnouncementDetail = AnnouncementDetailDto;

/** 作成 / 編集の入力。編集は全フィールド任意（部分更新）。important/isNew は hom-0054 で廃止。 */
export interface AnnouncementInput {
  title: string;
  body?: string;
  /**
   * タグ付与 ID（rete-home-0043・フォーム→エディタ hook 間の受け渡し専用）。
   * backend の create/update body には含めない（エディタ hook が取り出して PUT /announcements/:id/tags へ送る）。
   */
  tagIds?: string[];
}
export type AnnouncementPatch = Partial<AnnouncementInput>;

export interface AnnouncementListParams {
  page?: number;
  limit?: number;
  /** 種別（hom-0072/hom-0073）。'board'=掲示板 / 'faq'=FAQ。省略時は backend 既定の 'board'。 */
  kind?: AnnouncementTagKind;
}

export async function fetchAnnouncements(
  params: AnnouncementListParams = {},
): Promise<PaginatedResponse<AnnouncementSummary>> {
  const res = await apiClient.get<PaginatedResponse<AnnouncementSummary>>('/announcements', {
    params,
  });
  return res.data;
}

export async function fetchAnnouncementDetail(id: string): Promise<AnnouncementDetail> {
  const res = await apiClient.get<ApiResponse<AnnouncementDetail>>(`/announcements/${id}`);
  return res.data.data;
}

/** 自分の未読通知数（サイドバー「通知管理」バッジ用・kind でスコープ / HM-3・ADR 0029・hom-0073）。 */
export async function fetchAnnouncementUnreadCount(
  kind: AnnouncementTagKind = 'board',
): Promise<number> {
  const res = await apiClient.get<ApiResponse<{ count: number }>>('/announcements/unread-count', {
    params: { kind },
  });
  return res.data.data.count;
}

// tagIds は backend の create/update body に含めない hook 専用フィールドのため、API 関数の引数型から除外する
// （誤って tagIds 付きで呼んでも backend へ漏れない型レベルのガード / code-review HIGH・rete-home-0043）。
export async function createAnnouncement(
  input: Omit<AnnouncementInput, 'tagIds'>,
  kind: AnnouncementTagKind = 'board',
): Promise<AnnouncementDetail> {
  const res = await apiClient.post<ApiResponse<AnnouncementDetail>>('/announcements', {
    ...input,
    kind,
  });
  return res.data.data;
}

export async function updateAnnouncement(
  id: string,
  patch: Omit<AnnouncementPatch, 'tagIds'>,
): Promise<AnnouncementDetail> {
  const res = await apiClient.patch<ApiResponse<AnnouncementDetail>>(`/announcements/${id}`, patch);
  return res.data.data;
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await apiClient.delete(`/announcements/${id}`);
}

/**
 * 並び替えの永続化（H0021・ADMIN 限定）。orderedIds は「対象 kind の現存通知全件の id」を新しい順序で渡す
 * （部分集合は backend が set-mismatch で 400 を返す）。反映後の一覧 summary（閲覧者視点の未読込み）を返す。
 */
export async function reorderAnnouncements(
  orderedIds: string[],
  kind: AnnouncementTagKind = 'board',
): Promise<AnnouncementSummary[]> {
  const res = await apiClient.patch<ApiResponse<AnnouncementSummary[]>>('/announcements/reorder', {
    orderedIds,
    kind,
  });
  return res.data.data;
}

/**
 * 通知へファイルを添付（H0022・ADMIN 限定）。既存ファイルへのリンク（版固定）で、ここではアップロードしない。
 * 通知専用エンドポイント（汎用 attachments を経由しない）で、非 ADMIN の通知添付 bypass を防ぐ（backend 側 enforce）。
 */
export async function addAnnouncementAttachment(
  announcementId: string,
  fileId: string,
): Promise<AnnouncementAttachment> {
  const res = await apiClient.post<ApiResponse<AnnouncementAttachment>>(
    `/announcements/${announcementId}/attachments`,
    { fileId },
  );
  return res.data.data;
}

/** 通知の添付を解除（H0022・ADMIN 限定）。実体ファイルは削除しない（リンクのみ解除）。 */
export async function removeAnnouncementAttachment(
  announcementId: string,
  attachmentId: string,
): Promise<void> {
  await apiClient.delete(`/announcements/${announcementId}/attachments/${attachmentId}`);
}

// ===== お知らせタグマスタ（rete-home-0043）=====

/** お知らせタグの種別（hom-0072）。@rete/shared AnnouncementKind の別名（cmn-0084・SSOT結線）。 */
export type AnnouncementTagKind = AnnouncementKind;

/**
 * お知らせタグ一覧取得（GET /announcement-tags・name 昇順・kind でスコープ・hom-0074）。
 * File タグ（GET /tags）とは独立した別マスタ。kind 省略時は backend 既定の 'board'。
 * includeArchived: true でアーカイブ済みタグも含めて返す（既定は除外・hom-0083・タグ管理画面専用）。
 */
export async function fetchAnnouncementTags(
  kind: HomeTagKind = 'board',
  includeArchived?: boolean,
): Promise<AnnouncementTagDto[]> {
  const res = await apiClient.get<ApiResponse<AnnouncementTagDto[]>>('/announcement-tags', {
    params: { kind, includeArchived },
  });
  return res.data.data;
}

/** お知らせタグ作成（POST /announcement-tags・ADMIN 限定・kind でスコープ・hom-0074）→ 作成された AnnouncementTagDto。 */
export async function createAnnouncementTag(
  kind: HomeTagKind,
  name: string,
  icon: string,
  color: string,
): Promise<AnnouncementTagDto> {
  const res = await apiClient.post<ApiResponse<AnnouncementTagDto>>('/announcement-tags', {
    kind,
    name,
    icon,
    color,
  });
  return res.data.data;
}

/**
 * お知らせタグ更新（PATCH /announcement-tags/:id・ADMIN 限定・部分更新）→ 更新後の AnnouncementTagDto。
 * archived はアーカイブ切替（hom-0083・Category と同方針）。
 */
export async function updateAnnouncementTag(
  id: string,
  patch: { name?: string; icon?: string; color?: string; archived?: boolean },
): Promise<AnnouncementTagDto> {
  const res = await apiClient.patch<ApiResponse<AnnouncementTagDto>>(
    `/announcement-tags/${id}`,
    patch,
  );
  return res.data.data;
}

/** お知らせタグ削除（DELETE /announcement-tags/:id・ADMIN 限定）。付与は backend 側で連鎖削除される。 */
export async function deleteAnnouncementTag(id: string): Promise<void> {
  await apiClient.delete(`/announcement-tags/${id}`);
}

/**
 * 通知へのタグ付与（PUT /announcements/:id/tags・ADMIN 限定・全置換）。
 * tagIds は付与後の完全な集合（空配列で全解除）。
 */
export async function setAnnouncementTags(announcementId: string, tagIds: string[]): Promise<void> {
  await apiClient.put(`/announcements/${announcementId}/tags`, { tagIds });
}
