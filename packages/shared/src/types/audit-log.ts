/**
 * 操作ログ / 監査（Settings ST-6）の共有型（SSOT）。
 *
 * 本フェーズは「閲覧 / 検索 / CSV 出力」レイヤのみ（build-plan ST-6）。テナント全体の監査ログを
 * フィルタ・ページングして読み、期間指定で CSV 出力する。**記録 infra（全認可下操作を書き込む横断
 * interceptor + retention purge）は hardening H5 の責務**で本フェーズには含めない（ST-3=定義 / H4=
 * enforcement と同じ「定義先行・記録後追い」の分割）。
 *
 * backend の DTO / mapper と frontend の操作ログ画面が本定義を import して使う（§5 shared 型整合）。
 */

import type { PaginatedResponse } from './api-response';

/**
 * 操作種別の識別子（SSOT）。DB enum は採らず String 列 + app 層 @IsIn(AUDIT_ACTION_TYPES) で値域を強制する
 * （FAVORITE_KINDS / RolePermission.resourceType と同方針 — 値域の単一ソースを shared に置く）。
 */
export const AUDIT_ACTION_TYPES = [
  'create',
  'update',
  'delete',
  'read',
  'login',
  'logout',
  'approve',
  'admin',
] as const;

export type AuditActionType = (typeof AUDIT_ACTION_TYPES)[number];

/**
 * 操作種別 → 日本語表示ラベル（SSOT）。frontend のバッジ表示と backend の CSV 出力が同一ラベルを使う
 * （表示色 tone は純粋に視覚要素のため frontend 側に置く）。
 */
export const AUDIT_ACTION_LABELS: Record<AuditActionType, string> = {
  create: '作成',
  update: '更新',
  delete: '削除',
  read: '閲覧',
  login: 'ログイン',
  logout: 'ログアウト',
  approve: '承認',
  admin: '管理操作',
};

/**
 * CSV 出力の期間上限（日数・SSOT）。ログ量が膨大になりうるため出力対象期間に上限を設ける。
 * frontend の期間 UI と backend の検証境界を同一値に固定する（PASSWORD_MIN_LENGTH と同パターン）。
 */
export const AUDIT_EXPORT_MAX_DAYS = 92;

/**
 * 一覧の 1 頁あたりの件数（SSOT）。backend の QueryAuditLogsDto.limit の既定値と、frontend の
 * 操作ログ画面が問い合わせる limit がこの 1 値を読む。片方だけを変えると、最後の頁に残る行数と
 * 前へ／次へで辿る頁の境目が食い違うため、値を 2 か所に置かない。
 */
export const AUDIT_PAGE_SIZE = 20;

/** 操作ログ 1 行（Response）。一覧 / CSV はこの形を授受する。 */
export interface AuditLogDto {
  id: string;
  /** 実行者の表示名（スナップショット。account 削除後も監査として保持する）。 */
  actorName: string;
  /** 実行者のメール（スナップショット。同上）。 */
  actorEmail: string;
  /** 対象システムの表示名（'system-A 商品管理' / '共通操作' 等のスナップショット）。 */
  systemName: string;
  /** 操作種別。 */
  actionType: AuditActionType;
  /** 機能名（'在庫管理' / '認証' 等）。 */
  feature: string;
  /** 内容（人間可読の要約。'SKU-1024 在庫数 120 → 170' 等）。 */
  summary: string;
  /** 実行元 IP（不明は null）。 */
  ipAddress: string | null;
  /** 実行日時（ISO 8601）。 */
  createdAt: string;
}

/**
 * 操作ログ検索クエリ（frontend → API）。すべて任意。サーバー側でフィルタ + ページングする
 * （件数が膨大になりうるためクライアント側全件絞り込みは採らない）。
 */
export interface AuditLogQuery {
  page?: number;
  limit?: number;
  /** ユーザー名 / メールの部分一致（大文字小文字無視）。 */
  search?: string;
  actionType?: AuditActionType;
  /** TenantSystem.id（'SYS-001' 等）。'共通操作'（systemId=null）を指す場合は AUDIT_SYSTEM_COMMON。 */
  systemId?: string;
  /** 期間の開始（ISO 日付 / 含む）。 */
  from?: string;
  /** 期間の終了（ISO 日付 / 含む）。 */
  to?: string;
  /**
   * keyset カーソル（(createdAt, id) を符号化した不透明トークン）。省略時は先頭ページから開始する。
   * page はサーバー側の実クエリには使わず、フロント側のページ番号表示（カウンタ）専用として残す。
   */
  cursor?: string;
  /** カーソル起点からの移動方向。省略時は先頭ページ（First）として扱う。 */
  direction?: 'next' | 'prev' | 'last';
}

/** keyset ページングの継続トークン（前後移動用・両方向とも不透明文字列）。 */
export interface AuditLogCursors {
  /** 次ページ（より古いログ）へ進む時に渡すカーソル。これ以上先が無ければ null。 */
  next: string | null;
  /** 前ページ（より新しいログ）へ戻る時に渡すカーソル。これ以上前が無ければ null。 */
  prev: string | null;
}

/**
 * 操作ログ検索レスポンス（additive）。共有 PaginatedResponse<AuditLogDto> は他モジュール
 * （announcement / chat / base-list.helper 経由の CRUD 一覧）が直接消費するため変更せず、
 * audit_logs 専用に cursors を追加した拡張型として定義する（set-0013 design-reviewer PASS 済方針）。
 */
export interface AuditLogPageResponse extends PaginatedResponse<AuditLogDto> {
  cursors: AuditLogCursors;
}

/**
 * 「共通操作（認証等）」を指すフィルタ用センチネル。実 systemId を持たない横断操作
 * （login / logout 等・DB 上は systemId=null）を絞り込むためのキー。実 TenantSystem.id とは衝突しない。
 */
export const AUDIT_SYSTEM_COMMON = '__common__';
