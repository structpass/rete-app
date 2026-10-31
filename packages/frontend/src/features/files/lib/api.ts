import apiClient from '@/lib/api-client';
import type {
  ApiResponse,
  BatchAssignResultDto as _BatchAssignResultDto,
  CategoryDto,
  CreatedFolderResponseDto as _CreatedFolderResponseDto,
  FileMetaResponseDto as _FileMetaResponseDto,
  FileRefResolutionDto as _FileRefResolutionDto,
  FileRefResolveResponseDto as _FileRefResolveResponseDto,
  FileRowDto as _FileRowDto,
  FileSettingsResponseDto as _FileSettingsResponseDto,
  FolderContentResponseDto as _FolderContentResponseDto,
  FolderCrumbDto as _FolderCrumbDto,
  FolderTreeNodeDto as _FolderTreeNodeDto,
  FolderTreeResponseDto as _FolderTreeResponseDto,
  SearchResponseDto as _SearchResponseDto,
  SearchResultItemDto as _SearchResultItemDto,
  TagDto,
  TagSearchResponseDto as _TagSearchResponseDto,
} from '@rete/shared';
// 日時整形は全画面共通の lib/utils.ts（閲覧者ローカル時刻）へ寄せる。features 側へ
// 同名の別実装を置かない（cmn-0253）。
import { formatDateTime } from '@/lib/utils';
import { formatBytes } from './format';
import { saveBlobAsFile } from '@/lib/save-blob';
import type { FileItem, FileTagView, FolderContent, SearchResultItem, TreeNode } from './types';

// タグ Response 形は @rete/shared の TagDto を単一ソースとして再公開する（§5 shared 型整合・shape 二重定義を避ける）。
export type { TagDto };

/**
 * File タブの API クライアント + DTO→view アダプタ（architecture-invariants §1 DTO 境界の frontend 側・cmn-0216）。
 *
 * backend Response DTO（契約型）は @rete/shared の `types/files` を単一ソースとし、本ファイルは
 * 既存名を保ったまま「shared 型の別名」として再公開する。呼び出し側（hooks / components / テスト）の
 * import パスは変えない（先例 cmn-0198 / cmn-0211 と同方針）。frontend の view 型（types.ts）は
 * 表示整形済みのため集約対象外で、DTO→view アダプタ境界は維持する（§1）。
 *
 * 送信側（FileSettingsForm）は要求レイヤのため集約対象外。
 * FileSettingsDto（backend FileSettingsResponseDto と同形の旧 frontend 名）も shared の別名として再公開する。
 */

// ===== backend Response DTO（契約型・@rete/shared から再公開・cmn-0216）=====

export type FolderTreeNodeDto = _FolderTreeNodeDto;
export type FolderTreeResponseDto = _FolderTreeResponseDto;
export type FolderCrumbDto = _FolderCrumbDto;
export type FileRowDto = _FileRowDto;
export type FolderContentResponseDto = _FolderContentResponseDto;
export type SearchResultItemDto = _SearchResultItemDto;
export type SearchResponseDto = _SearchResponseDto;
export type TagSearchResponseDto = _TagSearchResponseDto;
export type BatchAssignResultDto = _BatchAssignResultDto;
export type CreatedFolderResponseDto = _CreatedFolderResponseDto;
export type FileMetaResponseDto = _FileMetaResponseDto;
/** 旧 frontend 名（backend FileSettingsResponseDto と同形・shared 集約で 1 本化・cmn-0216）。 */
export type FileSettingsDto = _FileSettingsResponseDto;
/** 構造参照の解決結果 1 件（GET /files/refs・FL+2 の描画時解決）。 */
export type FileRefResolutionDto = _FileRefResolutionDto;
export type FileRefResolveResponseDto = _FileRefResolveResponseDto;

/** 設定オーバーレイのフォーム表示型（サイズは MB 単位で扱う・編集 UX 優先）。 */
export interface FileSettingsForm {
  maxSizeMb: number;
  allowedExtensions: string[];
  /** 常に拒否する拡張子（v2-197 要求版2）。コード固定・読み取り専用で、フォームでは編集しない。 */
  fixedRejectedExtensions: string[];
  /** 追加で拒否する拡張子（v2-197）。空配列 = 追加の拒否なし。こちらだけが編集対象。 */
  rejectedExtensions: string[];
}

// ===== 純関数アダプタ（DTO → view 型）=====

/**
 * ネストツリー DTO を level 付きフラットリストへ前順（preorder）展開する。
 * level = 階層の深さ（root=0）。サイドバーツリー（TreeNode[]）が期待する形。
 */
export function flattenTree(dto: FolderTreeResponseDto): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: FolderTreeNodeDto[], level: number) => {
    for (const n of nodes) {
      out.push({ fid: n.id, level, name: n.name });
      if (n.children.length) walk(n.children, level + 1);
    }
  };
  walk(dto.roots, 0);
  return out;
}

/** タグ Response DTO → view の FileTagView（§1 DTO 境界として明示変換）。 */
export function toFileTagView(dto: TagDto): FileTagView {
  return { id: dto.id, name: dto.name, icon: dto.icon, color: dto.color };
}

/** 一覧行 DTO → view の FileItem（folder は fid=id、file は id 保持で fid 無し・サイズ/日時を整形・タグを写す）。 */
export function toFileItem(row: FileRowDto): FileItem {
  return {
    kind: row.kind,
    id: row.id,
    fid: row.kind === 'folder' ? row.id : undefined,
    name: row.name,
    versionNo: row.versionNo ?? undefined,
    updatedBy: row.updatedBy ?? '',
    updatedAt: formatDateTime(row.updatedAt),
    size: row.byteSize != null ? formatBytes(row.byteSize) : undefined,
    tags: (row.tags ?? []).map(toFileTagView),
  };
}

/** 検索ヒット DTO → view の SearchResultItem（shape は同形だが §1 DTO 境界として明示変換する）。 */
export function toSearchResultItem(dto: SearchResultItemDto): SearchResultItem {
  return { kind: dto.kind, id: dto.id, name: dto.name, parentFolderId: dto.parentFolderId };
}

/** フォルダ内容 DTO → view の FolderContent（crumb は id 付きのまま保持し祖先遷移に使う）。 */
export function toFolderContent(dto: FolderContentResponseDto): FolderContent {
  return {
    name: dto.name,
    crumb: dto.crumb.map((c) => ({ id: c.id, name: c.name })),
    items: dto.items.map(toFileItem),
  };
}

const BYTES_PER_MB = 1024 * 1024;
/** UI 上の最大サイズ上限（MB）。backend の hard cap（100 MiB）に対応し、保存前に frontend でも丸める。 */
const MAX_SIZE_MB = 100;

/** 入力値（小数 / NaN / 範囲外）を 1〜100 の整数 MB へ丸める（保存前の防御・0 や NaN 送信を防ぐ）。 */
export function clampSizeMb(mb: number): number {
  if (!Number.isFinite(mb)) return 1;
  return Math.min(MAX_SIZE_MB, Math.max(1, Math.floor(mb)));
}

/** 設定 DTO → フォーム型。bytes→MB は切り上げ（端数を 0MB に潰さず最低 1MB を保つ）。 */
export function toFileSettingsForm(dto: FileSettingsDto): FileSettingsForm {
  return {
    maxSizeMb: Math.ceil(dto.maxSizeBytes / BYTES_PER_MB),
    allowedExtensions: dto.allowedExtensions,
    fixedRejectedExtensions: dto.fixedRejectedExtensions,
    rejectedExtensions: dto.rejectedExtensions,
  };
}

/**
 * フォーム型 → PATCH ボディ（MB→bytes）。拡張子は parseExtensions で正規化済みを渡す前提。
 * 固定分（fixedRejectedExtensions）は送らない＝読み取り専用の値を書き戻さない（backend も保存時に除く）。
 */
export function toUpdateSettingsBody(
  form: FileSettingsForm,
): Omit<FileSettingsDto, 'fixedRejectedExtensions'> {
  return {
    maxSizeBytes: form.maxSizeMb * BYTES_PER_MB,
    allowedExtensions: form.allowedExtensions,
    rejectedExtensions: form.rejectedExtensions,
  };
}

/**
 * 拡張子1件を正規化する（先頭ドット付与・小文字化）。空文字は空文字を返す。
 * v2-203: 入力欄へ「xxxx」と書いても表示は「.xxxx」にする、という要求の実体。
 * 一覧へ足す前の1件判定と、チップの表示文字列の両方で同じ関数を使う。
 */
export function normalizeExtension(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t) return '';
  return t.startsWith('.') ? t : `.${t}`;
}

/**
 * 入力テキスト → 拡張子配列。カンマ/空白/改行区切りを分割し、先頭ドット付与・小文字化・重複排除する
 * （backend も正規化するが、保存前にフォーム表示を整え誤入力を吸収する）。
 * v2-203: 画面は1件ずつの追加だが、貼り付けた「.pdf, .md」を1回で受け取れるよう分割は残す。
 */
export function parseExtensions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const ext = normalizeExtension(raw);
    if (!ext || seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out;
}

/**
 * 拡張子配列 → カンマ + 空白連結の文字列。
 * v2-203 で画面の入力欄は廃止したが、配列を1行で読みたい箇所（検証記録・テストの期待値）で使う。
 */
export function formatExtensions(extensions: string[]): string {
  return extensions.join(', ');
}

// ===== I/O ラッパ（薄い・変換は上の純関数に委譲）=====

/** フォルダツリー取得（GET /files/tree?spaceId=・器スコープ / ADR 0063）→ フラット TreeNode[]。 */
export async function fetchFileTree(spaceId: string): Promise<TreeNode[]> {
  const res = await apiClient.get<ApiResponse<FolderTreeResponseDto>>('/files/tree', {
    params: { spaceId },
  });
  return flattenTree(res.data.data);
}

/** フォルダ内容取得（GET /files/folders/:id）→ FolderContent。 */
export async function fetchFolderContent(folderId: string): Promise<FolderContent> {
  const res = await apiClient.get<ApiResponse<FolderContentResponseDto>>(
    `/files/folders/${folderId}`,
  );
  return toFolderContent(res.data.data);
}

/**
 * 横断検索（GET /files/search?q=）→ 検索ヒット配列（フォルダ → ファイルの順）。
 * 空クエリは backend が空配列を返す。呼び出し側で trim 済の非空クエリを渡す前提だが、防御的に q をそのまま送る。
 */
export async function searchFiles(q: string): Promise<SearchResultItem[]> {
  const res = await apiClient.get<ApiResponse<SearchResponseDto>>('/files/search', {
    params: { q },
  });
  return res.data.data.items.map(toSearchResultItem);
}

/**
 * 構造参照の解決（GET /files/refs?ids=a,b・FL+1 / 設計 §2.3）。
 *
 * 返るのは**可視かつ存在する対象だけ**で、不在・非可視・削除済み・失効は配列に現れない（存在秘匿）。
 * 呼び出し側は「返らなかった id ＝ 表示できない参照」として扱う（設計 §5.1）。
 * 本文 1 本あたりの参照は 10 件上限だが、多くても 1 リクエストにまとめる（設計 §2.2）。
 */
export async function fetchFileRefs(ids: string[]): Promise<FileRefResolutionDto[]> {
  const unique = [...new Set(ids.filter((id) => id !== ''))];
  if (unique.length === 0) return [];
  const res = await apiClient.get<ApiResponse<FileRefResolveResponseDto>>('/files/refs', {
    params: { ids: unique.join(',') },
  });
  return res.data.data.items;
}

/**
 * ファイルアップロード（POST /files/folders/:id/files・multipart）→ 追加された行（FileItem）。
 * 送り方は uploadForm（下）に任せる。Content-Type をこちらで外すと、サーバーが中身を読めなくなる。
 */
export async function uploadFile(folderId: string, file: File): Promise<FileItem> {
  return toFileItem(await uploadForm<FileRowDto>(`/files/folders/${folderId}/files`, file));
}

/**
 * ファイルを 1 件 multipart で送り、返った行を返す（アップロードと新版のアップロードで共通）。
 *
 * 送り方はブラウザに任せる: Content-Type を指定しなければ、ブラウザが boundary 付きの multipart を付ける
 * （サーバーはその boundary で中身を切り分ける）。指定すると中身と食い違い、サーバーは中身を読めない。
 * axios 1.20 は POST のたびに「空なら application/x-www-form-urlencoded を補う」ため、指定しない指定
 * （`undefined`）では埋められてしまう（実測 2026-10-26: 画面のアップロードが 400 で全件失敗）。そこで
 * multipart を明示して、boundary だけをブラウザに足させる。
 */
async function uploadForm<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiClient.post<ApiResponse<T>>(path, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data.data;
}

/**
 * ファイルメタ取得（GET /files/files/:id）→ メタ DTO（名前 / 所属フォルダ / 最新版番号）。
 * Home のお気に入りファイル★（/files?fileId=）から、所属フォルダへの遷移 + 編集オーバーレイ起動に使う（FF）。
 */
export async function fetchFileMeta(fileId: string): Promise<FileMetaResponseDto> {
  const res = await apiClient.get<ApiResponse<FileMetaResponseDto>>(`/files/files/${fileId}`);
  return res.data.data;
}

/**
 * 既存ファイルへの新版アップロード（POST /files/files/:id/versions・multipart）→ 追加された行（FileItem）。
 * 同名一致でなくファイル id を着地点にするため、ローカル編集時に OS がリネームしても（"report (1).docx" 等）
 * 別ファイルを誤生成せず、FB-2 版管理の新版として積む（FF お気に入り編集の「DL→編集→再アップ」着地点）。
 * 送り方は uploadForm と同じ（boundary はブラウザが足す）。
 */
export async function uploadFileVersion(fileId: string, file: File): Promise<FileItem> {
  return toFileItem(await uploadForm<FileRowDto>(`/files/files/${fileId}/versions`, file));
}

/**
 * フォルダ移動（PATCH /files/folders/:id/move）。親フォルダを付け替える。
 * parentFolderId=null でルート直下へ移す。frontend は移動後にツリー/フォルダを再取得するため戻り値は使わない。
 */
export async function moveFolder(folderId: string, parentFolderId: string | null): Promise<void> {
  await apiClient.patch(`/files/folders/${folderId}/move`, { parentFolderId });
}

/** ファイル移動（PATCH /files/files/:id/move）。所属フォルダを変更する。 */
export async function moveFile(fileId: string, folderId: string): Promise<void> {
  await apiClient.patch(`/files/files/${fileId}/move`, { folderId });
}

/**
 * フォルダ作成（POST /files/folders）。parentFolderId=null でルート直下に作る。
 * ルート直下は帰属器の指定が必須（ADR 0063・fil-0137）。親あり作成は親の器を継承するため
 * spaceId は送らない（backend は親と異なる指定を 400 で弾く）。
 * frontend は作成後にツリー/フォルダを再取得するが、作成された id/name を呼び出し側が参照できるよう DTO を返す。
 */
export async function createFolder(
  parentFolderId: string | null,
  name: string,
  spaceId?: string,
): Promise<CreatedFolderResponseDto> {
  const res = await apiClient.post<ApiResponse<CreatedFolderResponseDto>>('/files/folders', {
    parentFolderId,
    name,
    ...(parentFolderId === null && spaceId ? { spaceId } : {}),
  });
  return res.data.data;
}

/**
 * ファイル削除（DELETE /files/files/:id）。全版 + 実体を削除する。
 * frontend は削除後にツリー/フォルダを再取得するため戻り値は使わない。
 */
export async function deleteFile(fileId: string): Promise<void> {
  await apiClient.delete(`/files/files/${fileId}`);
}

/** フォルダ削除（DELETE /files/folders/:id）。空フォルダのみ（非空は backend が 409）。 */
export async function deleteFolder(folderId: string): Promise<void> {
  await apiClient.delete(`/files/folders/${folderId}`);
}

// ===== ファイル→Desk 共有（FL・既存 Desk API 再利用）=====

/** カテゴリ選択肢（タスク共有時の categoryId 解決用・最小フィールド）。 */
export interface ShareCategory {
  id: number;
  name: string;
}

// カテゴリ Response 形は @rete/shared の CategoryDto を SSOT とする（§5 整合）。
// 以前はここに archived 欠落のローカル CategoryDto を持っていたが、ドリフト防止のため共通型へ寄せた。

/** カテゴリ一覧取得（GET /categories）→ 選択肢。タスク共有の categoryId（必須）に使う。 */
export async function fetchCategories(): Promise<ShareCategory[]> {
  const res = await apiClient.get<ApiResponse<CategoryDto[]>>('/categories');
  return res.data.data.map((c) => ({ id: c.id, name: c.name }));
}

/** ファイル共有 → Desk に新規チャットスレッド（テーマ）を実生成（POST /chat/themes）。 */
export async function createChatThreadFromFiles(title: string, description: string): Promise<void> {
  await apiClient.post('/chat/themes', { title, description });
}

/** ファイル共有 → Desk に新規タスクを実生成（POST /tasks・categoryId 必須）。 */
export async function createTaskFromFiles(input: {
  title: string;
  categoryId: number;
  description: string;
}): Promise<void> {
  await apiClient.post('/tasks', input);
}

/** ファイル設定取得（GET /files/settings）→ フォーム型。 */
export async function fetchFileSettings(): Promise<FileSettingsForm> {
  const res = await apiClient.get<ApiResponse<FileSettingsDto>>('/files/settings');
  return toFileSettingsForm(res.data.data);
}

/** ファイル設定更新（PATCH /files/settings）→ 反映後のフォーム型。 */
export async function updateFileSettings(form: FileSettingsForm): Promise<FileSettingsForm> {
  const res = await apiClient.patch<ApiResponse<FileSettingsDto>>(
    '/files/settings',
    toUpdateSettingsBody(form),
  );
  return toFileSettingsForm(res.data.data);
}

/** 保存ファイル名のサニタイズ。パス区切り・予約記号・制御文字を `_` に置換する（防御的）。 */
export function sanitizeDownloadName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim() || 'download';
}

/**
 * ファイル実体の blob 取得（GET /files/files/:id/download）。認証は cookie(withCredentials) のため
 * apiClient 経由。anchor 保存を起動する downloadFile と、ローカル編集セッション（fil-0075）が
 * File System Access API のハンドルへ直接書き込む用途の両方から使う共通取得口。
 */
export async function fetchFileBlob(fileId: string): Promise<Blob> {
  const res = await apiClient.get(`/files/files/${fileId}/download`, { responseType: 'blob' });
  return res.data as Blob;
}

/**
 * ファイルダウンロード（GET /files/files/:id/download）。blob で受けてブラウザ保存を起動する。
 * 表示名はサニタイズして download 属性に渡す。
 * revoke は click 直後だと一部ブラウザで DL が中断するため、わずかに遅延させてから解放する。
 */
export async function downloadFile(fileId: string, fileName: string): Promise<void> {
  const blob = await fetchFileBlob(fileId);
  // 保存名はサニタイズ済み（fil-0076）。revoke は click 直後だと一部ブラウザで DL が中断するため、
  // 従来どおり 1000ms 遅らせて解放する（v2-234・共有 saveBlobAsFile の第3引数）。
  saveBlobAsFile(blob, sanitizeDownloadName(fileName), 1000);
}

// ===== タグマスタ / ファイル付与（rete-files-0006）=====

/**
 * タグ一覧取得（GET /tags）→ TagDto[]（name 昇順）。マスタ UI / 付与ピッカー / フィルタが共有する。
 * includeArchived: true でアーカイブ済みタグも含めて返す（既定は除外・fil-0094・タグ管理画面専用＝ADMIN のみ）。
 */
export async function fetchTags(includeArchived?: boolean): Promise<TagDto[]> {
  const res = await apiClient.get<ApiResponse<TagDto[]>>('/tags', {
    params: { includeArchived },
  });
  return res.data.data;
}

/** タグ作成（POST /tags）→ 作成された TagDto。 */
export async function createTag(name: string, icon: string, color: string): Promise<TagDto> {
  const res = await apiClient.post<ApiResponse<TagDto>>('/tags', { name, icon, color });
  return res.data.data;
}

/**
 * タグ更新（PATCH /tags/:id・name / icon / color / archived 部分更新）→ 更新後の TagDto。
 * archived はアーカイブ切替（fil-0094・hom-0083 と同方針）。
 */
export async function updateTag(
  id: string,
  patch: { name?: string; icon?: string; color?: string; archived?: boolean },
): Promise<TagDto> {
  const res = await apiClient.patch<ApiResponse<TagDto>>(`/tags/${id}`, patch);
  return res.data.data;
}

/** タグ削除（DELETE /tags/:id）。付与は backend 側で連鎖削除される。 */
export async function deleteTag(id: string): Promise<void> {
  await apiClient.delete(`/tags/${id}`);
}

/**
 * ファイルのタグ付与集合を置換（PUT /files/files/:id/tags・全置換）→ 更新後の行（FileItem）。
 * tagIds は付与後の完全な集合（空配列で全解除）。呼び出し側は一覧を再取得して反映する。
 */
export async function setFileTags(fileId: string, tagIds: string[]): Promise<FileItem> {
  const res = await apiClient.put<ApiResponse<FileRowDto>>(`/files/files/${fileId}/tags`, {
    tagIds,
  });
  return toFileItem(res.data.data);
}

/**
 * フォルダのタグ付与集合を置換（PUT /files/folders/:id/tags・全置換 / rete-files-0033）→ 更新後の行（FileItem）。
 * ファイルの setFileTags と対称。tagIds は付与後の完全な集合（空配列で全解除）。呼び出し側は一覧を再取得して反映する。
 */
export async function setFolderTags(folderId: string, tagIds: string[]): Promise<FileItem> {
  const res = await apiClient.put<ApiResponse<FileRowDto>>(`/files/folders/${folderId}/tags`, {
    tagIds,
  });
  return toFileItem(res.data.data);
}

/**
 * 複数ファイル/フォルダへのタグ一括追加 / 解除（POST /files/tags/assign・fil-0048 add+remove 1tx 対応）。
 * addTagIds = 追加付与するタグ（省略または空＝追加なし）、removeTagIds = 解除するタグ（省略または空＝解除なし）。
 * 1 リクエストで 1 トランザクションとして原子的に反映される。付与/解除した対象/タグ件数を返す。
 */
export async function assignTagsBatch(input: {
  fileIds?: string[];
  folderIds?: string[];
  addTagIds?: string[];
  removeTagIds?: string[];
}): Promise<BatchAssignResultDto> {
  const res = await apiClient.post<ApiResponse<BatchAssignResultDto>>('/files/tags/assign', input);
  return res.data.data;
}

/**
 * タグ横断検索（GET /files/tags/search?tagIds=・rete-files-0032）→ ヒット配列 + 上限超過フラグ。
 * 指定タグのいずれかを持つ項目を全ツリーから探す（OR 条件）。tagIds はカンマ連結で送る（backend が分割）。
 * 空集合は backend が空配列を返す。truncated=true のとき 200件に切り詰められており、それ以上は表示されない（fil-0043）。
 */
export async function searchByTags(
  tagIds: string[],
): Promise<{ items: SearchResultItem[]; truncated: boolean }> {
  const res = await apiClient.get<ApiResponse<TagSearchResponseDto>>('/files/tags/search', {
    params: { tagIds: tagIds.join(',') },
  });
  const dto = res.data.data;
  return {
    items: dto.items.map(toSearchResultItem),
    truncated: dto.truncated ?? false,
  };
}
