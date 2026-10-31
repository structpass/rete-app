/**
 * 横断お気に入り（HOME サイドバー / HM-1）の共有型・SSOT。
 *
 * backend の DTO / バリデーション（@IsIn(FAVORITE_KINDS)）と frontend のサイドバー描画・バッジ表示が
 * 本定義を import して使う（§5 shared 型整合）。Prisma の enum ではなく文字列 union として持つ
 * （role.ts の RESOURCE_TYPES と同方針 / DB enum migration churn を避け、frontend の既存 lower-case 値を維持）。
 *
 * kind は「お気に入りが指すサブシステム / リソース種別」を表す:
 *   - system : 連携外部システム（reference）の画面。reference OIDC 連携が有効な時のみ遷移可。
 *   - chat   : Desk のチャット（テーマ）。
 *   - task   : Desk のタスク。
 *   - file   : ファイルタブのファイル（HM-1-4: クリック時の DL＆編集モードは files Phase FF・現状は遷移先準備中）。
 *   - folder : ファイルタブのフォルダ（HM-1-4: targetRef=フォルダ id で /files の該当フォルダへ精密ジャンプ）。
 *   - organization : 管理対象＝組織エントリ（CM-2 / ADR 0037・targetRef=Organization.id）。
 *   - project      : 管理対象＝プロジェクト（CM-2・targetRef=Project.id）。
 *   - space        : 管理対象＝器（チャネル/グループ/個人。CM-2・targetRef=Space.id）。
 *
 * deep link の精密化（targetRef による個別リソースへのフォーカス）は HM-1-4 で folder から着手。
 * file / chat / task / system は kind ごとに対応サブシステムのルートへ寄せる（Desk の A1 状態機械や
 * reference 側に手を入れない範囲に閉じる）。
 */

/** お気に入り種別の許可集合（backend が @IsIn で強制し frontend が同集合でバッジ/アイコンを出し分ける SSOT）。 */
export const FAVORITE_KINDS = [
  'system',
  'chat',
  'task',
  'file',
  'folder',
  'organization',
  'project',
  'space',
] as const;

/** お気に入り種別のリテラル union（FAVORITE_KINDS の要素型）。 */
export type FavoriteKind = (typeof FAVORITE_KINDS)[number];

/** サイドバーの種別バッジ表記（モック index.html の SYS/CHAT/TASK/FILE を踏襲）。 */
export const FAVORITE_KIND_BADGE_LABELS: Record<FavoriteKind, string> = {
  system: 'SYS',
  chat: 'CHAT',
  task: 'TASK',
  file: 'FILE',
  folder: 'DIR',
  organization: 'ORG',
  project: 'PRJ',
  space: 'SPC',
};

/**
 * ★トグルの読み上げ・ツールチップに出す対象種別の日本語表記（v2-505）。
 * kind は 8 種あるため、file 以外を一律「フォルダ」と呼ぶと space/project 等が誤表示になる。
 * バッジ表記（FAVORITE_KIND_BADGE_LABELS）と同じく全 kind を網羅する Record で持つ。
 */
export const FAVORITE_KIND_LABELS: Record<FavoriteKind, string> = {
  system: 'システム',
  chat: 'チャット',
  task: 'タスク',
  file: 'ファイル',
  folder: 'フォルダ',
  organization: '組織',
  project: 'プロジェクト',
  space: 'スペース',
};

/** ラベルの最大長（サイドバー 1 行が破綻しない範囲）。 */
export const FAVORITE_LABEL_MAX_LEN = 80;

/** targetRef の最大長（リソース id / パス想定の緩い上限）。 */
export const FAVORITE_TARGET_REF_MAX_LEN = 200;

/**
 * お気に入り 1 件の Response 形（サイドバー描画で使う最小集合）。
 * 表示順は API が sortOrder 昇順で返した配列順で表現するため、sortOrder 自体は公開しない。
 */
export interface FavoriteDto {
  id: string;
  /** 種別（'system' | 'chat' | 'task' | 'file'）。 */
  kind: FavoriteKind;
  /** 対象リソースの参照キー（kind により意味が変わる。manual 追加時は合成 id）。 */
  targetRef: string;
  /** サイドバー表示ラベル。 */
  label: string;
}

/**
 * reference（struct-pass-reference）の業務オブジェクト種別の要約（hom-0067）。
 * rete backend の proxy API（/integration/object-types）が reference の
 * `GET /api/v1/integration/object-types`（ref-0095・共有 credential 受口）から取得し、
 * rete 側に種別リストの手書きを持たない（二重管理を避ける）。
 */
export interface ReferenceObjectTypeSummary {
  key: string;
  name: string;
  icon: string | null;
  isPreset: boolean;
}
