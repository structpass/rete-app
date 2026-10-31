import type { FileRefResolutionDto } from '@rete/shared';

/**
 * 構造参照（file-ref ノード）の描画時解決（FL+2・docs/files/structural-reference-design.md §2.2 / §2.4）。
 *
 * 説明欄 HTML の中に、挿入時のパス表記つきで実体の id を持つ参照ノードが入る（FL+1）:
 *
 * ```
 * <span data-type="file-ref" data-id="<id>" data-label="<挿入時のパス表記>">挿入時のパス表記</span>
 * ```
 *
 * FL+2 は、描画のたびに id をまとめて解決し（1 本文 1 リクエスト）、**現在のパス表記**を出す。
 * 保存 HTML は書き換えない（移動のたびに本文を書き換えると、本文の版と実体の移動が癒着するため・§2.2）。
 */

/** 参照ノードの data-type 値（FL+1 で挿入側が使う固定値）。 */
export const FILE_REF_NODE_TYPE = 'file-ref';

/** 解決できなかった参照の文言（存在秘匿のため「削除」「権限なし」の語を入れない・§5.1）。 */
export function unresolvedFileRefLabel(label: string): string {
  return `${label}（表示できません）`;
}

/** 本文 HTML 中の参照ノード 1 件（重複は data-id で 1 回に畳む）。 */
export interface FileRefNode {
  id: string;
  /** 挿入時のパス表記（解決できない時の表示に使う）。 */
  label: string;
}

/**
 * 本文 HTML から参照ノードの id と挿入時の表記を重複排除で拾う（出現順）。
 * SSR（DOMParser 不在）・空 HTML は空配列を返す。
 */
export function extractFileRefs(html: string | null | undefined): FileRefNode[] {
  if (!html || typeof DOMParser === 'undefined') return [];
  // 参照を持たない本文（大多数）は parse せずに落とす。
  if (!html.includes(FILE_REF_NODE_TYPE)) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: FileRefNode[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll(`[data-type="${FILE_REF_NODE_TYPE}"]`).forEach((el) => {
    const id = el.getAttribute('data-id');
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: el.getAttribute('data-label') ?? el.textContent ?? '' });
  });
  return out;
}

/** sanitize 済み HTML が参照ノードを 1 つでも含むか（描画時解決の要不要判定）。 */
export function hasFileRefs(cleanHtml: string | null | undefined): boolean {
  return !!cleanHtml && cleanHtml.includes(`data-type="${FILE_REF_NODE_TYPE}"`);
}

/**
 * 参照ノードの中身を解決結果で置き換えた HTML を返す（入力の HTML は変えない）。
 *
 * - 解決できた参照: 本文に現在のパス表記を出す。
 * - 解決できない参照: `＜挿入時のパス表記＞（表示できません）` に置き換える（§5.1）。
 *
 * 置換はテキストノードの設定だけで、解決結果から拾うのはパス等の文字列のみ（HTML として解釈しない）。
 * 参照自身が anchor の場合は span に揃え、独立した URL を除く。ロールと遷移操作は描画側で付与する。
 * **sanitize 済み HTML を受けて返す**。
 */
export function applyFileRefResolutions(
  cleanHtml: string,
  resolved: ReadonlyMap<string, Pick<FileRefResolutionDto, 'path'>>,
): string {
  if (!hasFileRefs(cleanHtml) || typeof DOMParser === 'undefined') return cleanHtml;
  const doc = new DOMParser().parseFromString(cleanHtml, 'text/html');
  // 内側の参照から置き換える。外側から置き換えると、入れ子の参照が外側の textContent で
  // 消えて解決されないまま終わる（入れ子自体は挿入側で作らないが、貼り付けで混ざり得る）。
  const nodes = [...doc.querySelectorAll(`[data-type="${FILE_REF_NODE_TYPE}"]`)];
  for (let el of nodes.reverse()) {
    // data attributes can arrive on an anchor through pasted rich text.
    // Keep the reference identity but discard that anchor's independent URL.
    if (el.tagName === 'A') {
      const span = doc.createElement('span');
      for (const attr of ['data-type', 'data-id', 'data-label']) {
        const value = el.getAttribute(attr);
        if (value !== null) span.setAttribute(attr, value);
      }
      span.textContent = el.textContent;
      el.replaceWith(span);
      el = span;
    }
    const id = el.getAttribute('data-id') ?? '';
    const label = el.getAttribute('data-label') ?? el.textContent ?? '';
    const hit = resolved.get(id);
    // 中身は常に現在の表記に揃える（解決できれば現在パス、できなければ統一文言・§5.1）。
    el.textContent = hit ? hit.path : unresolvedFileRefLabel(label);
  }
  return doc.body.innerHTML;
}
