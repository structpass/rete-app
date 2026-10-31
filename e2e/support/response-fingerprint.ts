/**
 * rete E2E — 応答の指紋（形の比べ方の正本）
 *
 * 「他人の器」と「存在しない器」を叩いた時に、応答が同じかどうかを**形**で比べる。
 * 比べる対象は**状態コードと本文の形（JSON の骨組み）**で、次の 2 つは含めない。
 *
 *   - **コードと message（エラーの文言）**。文言は画面がそのまま出す入力の案内で、
 *     プライバシー境界の観点では、応答の**形**がそろうこと（＝状態・本文の骨組みが同じで、
 *     中身の有無を読み分けられないこと）を固定すれば足りる。文言まで比べると、一覧の語をそろえる
 *     改修（例: `/chat/themes` の一覧 404 の語）でここが赤くなり、**どの改修で赤になったか読めなくなる**。
 *   - **可変の値**（id・時刻・件数・鍵の名前）。id は応答ごとに変わるので、生値の有無で比べると
 *     常に「違う」になる。この代わりに、**叩いた id が本文へそのまま写っていないこと**を別に確かめる
 *     （`echoesExternalId`）。写っていれば存在を読み分けられる。
 *
 * 状態コードは含める（404 と 200 空では、何も知らせていない度合いが違う）。
 * 骨組みは鍵を名前順に並べたものにする（並びの違いは形の違いにしない）。
 */

/** 存在の有無を読み分けさせる手掛かりとして、本文は持ち込まない欄（形だけを見る）。 */
const MESSAGE_KEYS = new Set(['message']);

/** 形を取る時に、値の代わりに置く印。 */
const VALUE = 'v';
/** 配列の要素として置く印（要素の数は形ではない）。 */
const ITEM = '[]';

function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return ITEM;
    // 要素が多い応答で形が割れないよう、同じ骨組みに畳む（並び順は形にしない）。
    return `[${[...new Set(value.map((v) => shapeOf(v)))].sort().join('|')}]`;
  }
  switch (typeof value) {
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !MESSAGE_KEYS.has(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => `${key}:${shapeOf(v)}`);
      return `{${entries.join(',')}}`;
    }
    case 'string':
      return VALUE;
    default:
      return typeof value;
  }
}

/**
 * 応答を「状態コード + 本文の形」の指紋にする。
 * JSON でない本文（HTML の 404 など）は、本文の長さと先頭の型で表す（本文そのものは持ち込まない）。
 */
export function responseFingerprint(status: number, rawText: string): string {
  const text = rawText.trim();
  if (text === '') return `${status}:`;
  try {
    return `${status}:${shapeOf(JSON.parse(text))}`;
  } catch {
    return `${status}:non-json(${text.length})`;
  }
}

/**
 * 本文に、叩いた id（外部から入れた値）がそのまま写っているか。
 * 写っていれば、その id は存在するものとして扱われたと読み分けられる。
 */
export function echoesExternalId(rawText: string, externalIds: readonly string[]): string | null {
  for (const id of externalIds) {
    if (id && rawText.includes(id)) return id;
  }
  return null;
}

/**
 * 叩いた先の URL に入っていた id（UUID の生値）を拾う。
 * 外部から入れた値は URL だけで決まる（控えの持ち主や本文の値で決めない）。
 */
export function tappedIdsOf(url: string): string[] {
  const ids = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  // 控える値は小文字に揃える（照合は本文の生値のまま行う）。
  return ids.map((id) => id.toLowerCase());
}
