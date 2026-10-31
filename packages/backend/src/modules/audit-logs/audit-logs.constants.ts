/**
 * 操作ログ / 監査（Settings ST-6・H5）の定数。期間上限・検索長・エクスポート安全上限・記録定数を集約する。
 * 期間上限（日数）と一覧の 1 頁の件数は frontend と共有するため @rete/shared の
 * AUDIT_EXPORT_MAX_DAYS / AUDIT_PAGE_SIZE を SSOT とする。
 */

/**
 * rete 内部操作（認証 / 横断 interceptor）の systemName スナップショット。
 * TenantSystem.id を持たない横断操作（systemId=null）に付与する表示名（H5 記録側 SSOT）。
 */
// set-0079: 「システム共通」は実システム名に誤読されるため、横断操作カテゴリと分かる呼称へ。
export const AUDIT_RETE_SYSTEM_NAME = '共通操作';

/** 検索フリーワード（ユーザー名 / メール部分一致）の最大長（過大入力の早期 reject）。 */
export const AUDIT_SEARCH_MAX_LENGTH = 100;

/** 一覧の最大ページサイズ。既定は共有定数（frontend の画面と同じ 1 値・AUDIT_PAGE_SIZE）を各所で直接指す。 */
export const AUDIT_MAX_LIMIT = 100;

/**
 * CSV エクスポートの安全行数上限。期間上限（AUDIT_EXPORT_MAX_DAYS）で実質バウンドされるが、
 * 大量行を一度に文字列展開して OOM するのを防ぐためのハード上限。到達時は service が件数を添えて
 * truncated を示す（no silent caps）。
 */
export const AUDIT_EXPORT_ROW_CAP = 100_000;
