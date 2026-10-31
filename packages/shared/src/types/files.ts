/**
 * File タブの Response DTO（契約形・cmn-0216）。
 *
 * backend の `packages/backend/src/modules/files/dto/files-response.dto.ts` および
 * `files-settings.dto.ts`（FileSettingsResponseDto）、frontend の
 * `packages/frontend/src/features/files/lib/api.ts` に二重定義されていた応答型を本ファイルへ集約する。
 *
 * §5 shared 型整合: ここに置いた型を backend / frontend の両側が import して使い、
 * それぞれは型名を保ったまま「shared 型の別名」として再公開する。
 * 呼び出し側（mapper / アダプタ関数 / 既存テスト）の import は変えない（先例 cmn-0198 / cmn-0211 と同方針）。
 *
 * 設定タブの入力 DTO（UpdateFileSettingsDto・class-validator / @nestjs/swagger の装飾付き）は
 * backend 固有で shared には置かない（外部依存ゼロの shared に class-validator を持ち込まない）。
 * frontend の view 型（features/files/lib/types.ts の FileItem / FolderContent 等）は表示整形済みで
 * DTO→view アダプタ境界を保つため集約対象外（§1 DTO 境界）。
 */

import type { TagDto } from './tag';

/** フォルダツリーの 1 ノード（ネスト構造。children は同 sortOrder 昇順）。 */
export interface FolderTreeNodeDto {
  id: string;
  name: string;
  children: FolderTreeNodeDto[];
}

/** GET /files/tree のレスポンス本体（ルート直下フォルダ群を起点としたネストツリー）。 */
export interface FolderTreeResponseDto {
  roots: FolderTreeNodeDto[];
}

/** パンくずの 1 セグメント（ルート→対象フォルダの順）。 */
export interface FolderCrumbDto {
  id: string;
  name: string;
}

/**
 * フォルダ内容の一覧 1 行（サブフォルダ または ファイル）。
 * - folder: ver / updatedBy / byteSize は null・tags は空配列
 * - file: 最新版（FileVersion）の版番号・アップロード者名・サイズ＋付与タグを載せる
 */
export interface FileRowDto {
  kind: 'folder' | 'file';
  id: string;
  name: string;
  /** ファイル最新版の版番号（folder は null）。 */
  versionNo: number | null;
  /** ファイル最新版のアップロード者表示名（folder は null）。 */
  updatedBy: string | null;
  /** 更新日時 ISO 8601（file は最新版 createdAt、folder は folder.updatedAt）。 */
  updatedAt: string;
  /** ファイル最新版のバイト数（folder は null）。フロントで整形する。 */
  byteSize: number | null;
  /** 付与タグ（rete-files-0006・folder は常に空配列）。一覧のタグ列でアイコン表示する。 */
  tags: TagDto[];
}

/** GET /files/folders/:id のレスポンス本体（パンくず + 直下の項目）。 */
export interface FolderContentResponseDto {
  id: string;
  name: string;
  /** ルートから対象フォルダまでのパンくず（対象自身を末尾に含む）。 */
  crumb: FolderCrumbDto[];
  /** 直下の項目（サブフォルダ → ファイルの順＝フォルダ優先）。 */
  items: FileRowDto[];
}

/**
 * 横断検索ヒット 1 件（rete-files-0004）。ファイル または フォルダを name 部分一致で拾う。
 * 表示用パス（所属フォルダ名の連鎖）は frontend が取得済みの全フォルダツリーから導出するため、
 * 本 DTO は移動に必要な最小情報（種別 / id / 名前 / 現在の所属）のみを返す。
 */
export interface SearchResultItemDto {
  kind: 'folder' | 'file';
  id: string;
  name: string;
  /**
   * 現在の所属（D&D 移動の「移動元の親」）。file=所属フォルダ id、folder=親フォルダ id
   * （ルート直下フォルダは null）。同一フォルダへのドロップを no-op 判定するのに使う。
   */
  parentFolderId: string | null;
}

/** GET /files/search のレスポンス本体（フォルダ → ファイルの順 / rete-files-0004）。 */
export interface SearchResponseDto {
  /** 実際に検索に使ったクエリ（trim 済）。 */
  query: string;
  items: SearchResultItemDto[];
}

/**
 * タグ横断検索（GET /files/tags/search）のレスポンス本体（rete-files-0032）。
 * 指定タグ集合のいずれかが付くファイル / フォルダを全階層から拾い、フォルダ → ファイルの順で返す。
 * 表示パスは frontend が取得済みの全フォルダツリーから parentFolderId を辿って導出する（name 検索と同方針）。
 */
export interface TagSearchResponseDto {
  /** 実際に検索に使ったタグ ID 集合（重複排除済）。 */
  tagIds: string[];
  items: SearchResultItemDto[];
  /**
   * フォルダまたはファイルのいずれかが SEARCH_RESULT_LIMIT（200件）に達した場合 true。
   * true のとき、backend は各 200件に切り詰めて返しており超過分は表示されない。
   * frontend はバナーで「上限超過」を告知する（fil-0043）。
   */
  truncated: boolean;
}

/**
 * 一括タグ付与/解除結果（POST /files/tags/assign・rete-files-0034 / fil-0048）。
 * 何件の対象へ何タグを追加/解除したかの件数のみ返す（行 shape は一覧再取得で反映）。
 */
export interface BatchAssignResultDto {
  /** 付与対象としたファイル件数（実在検証後）。 */
  fileCount: number;
  /** 付与対象としたフォルダ件数（実在検証後）。 */
  folderCount: number;
  /** 追加付与したタグ件数（重複排除後）。 */
  addCount: number;
  /** 解除したタグ件数（重複排除後）。 */
  removeCount: number;
}

/**
 * フォルダ移動結果（PATCH /files/folders/:id/move）。frontend は移動後にツリー/フォルダを再取得する
 * ため最小情報のみ返す（移動先の親 id を含め、呼び出し側が結果を検証できるようにする）。
 */
export interface MovedFolderResponseDto {
  id: string;
  name: string;
  /** 移動後の親フォルダ id（ルート直下は null）。 */
  parentFolderId: string | null;
}

/** ファイル移動結果（PATCH /files/files/:id/move）。最小情報のみ（移動後の所属フォルダ id を含む）。 */
export interface MovedFileResponseDto {
  id: string;
  name: string;
  /** 移動後の所属フォルダ id。 */
  folderId: string;
}

/**
 * フォルダ作成結果（POST /files/folders）。frontend は作成後にツリー/フォルダを再取得するため
 * 最小情報のみ返す（作成された id・名前・親 id）。
 */
export interface CreatedFolderResponseDto {
  id: string;
  name: string;
  /** 作成先の親フォルダ id（ルート直下は null）。 */
  parentFolderId: string | null;
}

/**
 * ファイルメタ（GET /files/files/:id・お気に入り編集 FF）。
 * Home お気に入りのファイル★クリックは targetRef にファイル id しか持たないため、編集オーバーレイ表示と
 * 再アップ後のフォルダ整合に必要な最小情報（名前 / 所属フォルダ / 現在の最新版番号）を解決して返す。
 */
export interface FileMetaResponseDto {
  id: string;
  name: string;
  /** 所属フォルダ id（再アップ後に当該フォルダ一覧を再取得して新版を反映するのに使う）。 */
  folderId: string;
  /** 現在の最新版番号（版が無い異常データは null）。 */
  versionNo: number | null;
}

/**
 * 構造参照の解決結果 1 件（GET /files/refs・FL+1）。参照ノード（data-id）の解決に使う。
 * 返すのは**可視かつ存在する対象だけ**（不在・非可視・削除済み・失効は配列に現れない・設計 §2.3）。
 */
export interface FileRefResolutionDto {
  id: string;
  kind: 'file' | 'folder';
  /** ルートからの全パンくずを `＞` で連結した現在のパス表記（移動・改名に追従する）。 */
  path: string;
  /** 遷移に使う親フォルダ id（ファイルは所属フォルダ・フォルダは自身の親。ルート直下は null）。 */
  parentFolderId: string | null;
  /** 帰属 Space（参照先 Space への切替に使う・設計 §5.2）。 */
  spaceId: string;
}

/** GET /files/refs のレスポンス本体（可視の対象だけ・設計 §2.3）。 */
export interface FileRefResolveResponseDto {
  items: FileRefResolutionDto[];
}

/**
 * 設定タブの Response DTO（cmn-0216 で集約）。BigInt（maxSizeBytes）は mapper で Number 化して載せる。
 * 未設定時は app 既定（DEFAULT_MAX_SIZE_BYTES / 全許可 / 固定の拒否拡張子 / 既定の追加拒否拡張子）を返す。
 * backend は同名 `FileSettingsResponseDto` を shared 型の別名として再公開する（cmn-0198 / cmn-0211 と同方針）。
 */
export interface FileSettingsResponseDto {
  /** 業務上の最大アップロードサイズ（bytes）。 */
  maxSizeBytes: number;
  /** 許可拡張子（`.pdf` 形式・小文字）。空配列 = 全許可。 */
  allowedExtensions: string[];
  /**
   * 常に拒否する拡張子（`.pdf` 形式・小文字・v2-197 要求版2）。**コード固定で、設定からは変更できない**。
   * 実行形式として扱う形式（.exe / .dll / .msi / .scr / .com）を名前でも止める層。画面はこの値を読み取り専用で
   * 表示し、編集は rejectedExtensions（追加で拒否する拡張子）だけを受け付ける。
   */
  fixedRejectedExtensions: string[];
  /**
   * 追加で拒否する拡張子（`.pdf` 形式・小文字・v2-197）。空配列 = 追加の拒否なし。
   * 中身がテキストのスクリプト（.bat / .cmd / .ps1 / .sh）は内容署名の検査を素通りするため、この一覧が名前で
   * 止める唯一の層になる。fixedRejectedExtensions に載る拡張子は保存時にここから除かれる。
   */
  rejectedExtensions: string[];
}
