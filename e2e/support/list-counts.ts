/**
 * 一覧の件数と行の並び（2026-10-25・ホームトラック S-HOME-15 / 16）。
 *
 * 「配列の何番目が何」「配列は全件か」を feature から確かめるための判定だけを置く。
 * 通信・後始末の配線は steps/home-track.steps.ts が持ち、この file は依存を持たない
 * （support/fixtures と steps の相互 import を避けるため・deferred-teardown.ts と同じ作法）。
 */

/** 一覧レスポンスの要素配列（素の配列 / {items} / {roots} のいずれでも受ける）。 */
export function listOf(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    const o = data as { items?: unknown; roots?: unknown };
    if (Array.isArray(o.items)) return o.items as Array<Record<string, unknown>>;
    if (Array.isArray(o.roots)) return o.roots as Array<Record<string, unknown>>;
  }
  return [];
}

/** 一覧に 1 件も無い応答のとき、どこを見てそう判断したかを残すための中身の抜き出し。 */
export function describeListShape(data: unknown): string {
  if (Array.isArray(data)) return `配列 ${data.length} 件`;
  if (data && typeof data === 'object') {
    const o = data as { items?: unknown; roots?: unknown };
    if (Array.isArray(o.items)) return `{items} ${o.items.length} 件`;
    if (Array.isArray(o.roots)) return `{roots} ${o.roots.length} 件`;
    return `一覧でない（キー: ${Object.keys(o).slice(0, 8).join(', ')}）`;
  }
  return `一覧でない（${data === null ? 'null' : typeof data}）`;
}

/**
 * 指定した値が一覧の何番目にあるかを返す（0 始まり・見つからなければ -1）。
 * 比較は文字列へ揃える（id が数値の一覧と文字列の一覧が混在するため）。
 */
export function indexOfValue(
  rows: Array<Record<string, unknown>>,
  field: string,
  value: string,
): number {
  return rows.findIndex((row) => String(row[field]) === value);
}

/**
 * 新しい順で先に来ているかを返す。
 *
 * `ahead` が `behind` より手前にあれば true。どちらかが見つからなければ null
 * （見つからないことと順序の違反を混ぜないため、呼び出し側で別の文言にする）。
 */
export function isAhead(
  rows: Array<Record<string, unknown>>,
  field: string,
  ahead: string,
  behind: string,
): boolean | null {
  const i = indexOfValue(rows, field, ahead);
  const j = indexOfValue(rows, field, behind);
  if (i < 0 || j < 0) return null;
  return i < j;
}
