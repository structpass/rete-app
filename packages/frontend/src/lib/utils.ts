import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * ISO 8601 文字列（または null）を `YYYY/MM/DD` 形式に整形する。
 * 日付のみ表示（タスクの期日・通知の公開日時・招待日／有効期限 等）用。
 * 時刻まで意味を持つタイムスタンプ（作成/更新日時・履歴行・スレッド日時）は formatDateTime を使う。
 *
 * 縮退表示は '—' で統一（cmn-0278）。
 * 画面側（dashboard / members / invites）で同名・別実装の local formatDate が並存していた
 * 状態を @/lib/utils へ一本化したうえで、不正値・欠損時の表示を '—' へ揃える。
 * タスク行の期日（task-tree.tsx）等、他画面でも同縮退がそのまま効く。
 */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${mo}/${day}`;
}

/**
 * ISO 8601 文字列（または null）を `YYYY/MM/DD HH:mm`（分まで・ローカル時刻）に整形する。
 * 時刻まで意味を持つタイムスタンプ（作成/更新日時・履歴行・スレッド日時）用。日付のみ表示は formatDate を使う。
 * スレッド系日時（チャット詳細の発話/起点カード・タスクコメント）も本フォーマッタに統一（dsk-0243）。
 *
 * 使い分け（set-0146）: 分まで＝スレッド系日時の正本はこちら。**秒まで意味を持つ監査ログ系
 * （操作ログ画面など「いつ起きたか」を秒単位で追う画面）は formatDateTimeWithSeconds を使う**。
 * 秒付き整形の置き場は本ファイル 1 箇所に限る（画面ファイル側へ自前実装しない）。
 */
export function formatDateTime(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${mo}/${day} ${hh}:${mi}`;
}

/**
 * Date を `YYYY-MM-DD`（閲覧者のローカル時刻の年月日）に組み立てる。input[type=date] の値・期間の判定用。
 *
 * `toISOString().slice(0, 10)` は UTC の年月日になるため、日付がまたぐ時刻帯（例: JST の朝 8 時前）で
 * 1 日ずれる。画面の壁時計（getFullYear/getMonth/getDate）で組む。日付を組む実装は本ファイル 1 箇所に限る
 * （画面ファイル側へ自前実装しない・d755）。
 */
export function toLocalYmd(date: Date): string {
  const p = (n: number) => `${n}`.padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * ISO 8601 文字列（または null）を `YYYY/MM/DD HH:mm:ss`（秒まで・ローカル時刻）に整形する。
 * 秒が意味を持つ監査ログ系（操作ログ画面＝ST-6）用。秒精度は当該画面の意図した仕様で、
 * 分までの formatDateTime へ寄せると機能後退になるため統合しない（set-0146 の裁定）。
 *
 * 秒あり/なしをフラグ 1 本の関数へ畳まないのは、呼び出し側で `formatDateTime(x, true)` の
 * 真偽値の意味が読めなくなるため（捨て案）。不正値・未指定は formatDateTime と揃えて '—' を返す（cmn-0296）。
 */
export function formatDateTimeWithSeconds(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
