'use client';

import { useEffect, useMemo, useRef, type SyntheticEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useDeskSpace } from '../hooks/desk-space-context';
import { sanitizeRichText, highlightRichText } from '../lib/rich-text';
import { applyFileRefResolutions, hasFileRefs } from '../lib/file-refs';
import { useFileRefPaths } from '../hooks/use-file-ref-paths';

interface RichTextViewProps {
  /** 保存済みリッチテキスト HTML（plain text も可）。null/空は何も描画しない。 */
  html: string | null | undefined;
  className?: string;
  /**
   * 検索語ハイライト（rete-desk-0048）。指定時、本文中の一致箇所を `<mark class="sp-search-hl">`（薄い黄色）で包む。
   * **sanitize 後**に適用するため XSS 多層防御は維持される（空/未指定でハイライトなし）。
   */
  highlight?: string;
}

/**
 * 保存済みリッチテキスト HTML を sanitize して描画する（ADR 0019 多層防御の client 描画層）。
 * `dangerouslySetInnerHTML` を使う唯一の経路に sanitize を強制集約し、本文表示箇所はすべて本コンポーネント
 * を経由させる（タスク説明 / チャットテーマ説明 / メッセージ本文）。highlight 指定時は sanitize 済み HTML の
 * テキストノードだけに検索語ハイライトを差し込む（タグ・属性は壊さない / rete-desk-0048）。
 *
 * 構造参照（file-ref・FL+2）を含む本文では、参照を現在のパス表記へ解決して出す。解決できない参照は
 * `＜挿入時の表記＞（表示できません）` になる（設計 §2.2 / §5.1）。保存 HTML は書き換えない。
 * 置換は sanitize 済み HTML を DOM で組み替えるだけ（解決結果から拾うのはパス等の文字列のみ）で、
 * XSS 多層防御は変わらない。
 */
export function RichTextView({ html, className, highlight }: RichTextViewProps) {
  const clean = sanitizeRichText(html);
  if (!clean) return null;
  if (!hasFileRefs(clean)) {
    return (
      <div
        className={className}
        dangerouslySetInnerHTML={{ __html: highlightRichText(clean, highlight) }}
      />
    );
  }
  return <FileReferenceView clean={clean} className={className} highlight={highlight} />;
}

function FileReferenceView({
  clean,
  className,
  highlight,
}: Omit<RichTextViewProps, 'html'> & { clean: string }) {
  const router = useRouter();
  const { setSelectedSpaceId } = useDeskSpace();
  const hostRef = useRef<HTMLDivElement>(null);
  const paths = useFileRefPaths(hasFileRefs(clean) ? clean : null);

  // React はこのオブジェクトが変わると同じ文字列でも innerHTML を再代入する。
  // パス解決だけの再描画でeffectの変更を戻さず、SSRと初回描画は同じHTMLを保つ。
  const rendered = useMemo(
    () => ({ __html: highlightRichText(clean, highlight) }),
    [clean, highlight],
  );

  // 描画（sanitize → highlight）の後に、参照ノードの内容だけを現在のパスへ差し替える。
  useEffect(() => {
    const root = hostRef.current;
    if (!root || !hasFileRefs(clean)) return;
    const next = applyFileRefResolutions(root.innerHTML, paths);
    if (next !== root.innerHTML) root.innerHTML = next;
    root.querySelectorAll<HTMLElement>('[data-type="file-ref"]').forEach((node) => {
      // Saved HTML never grants activation; only the current resolution does.
      node.removeAttribute('role');
      node.removeAttribute('tabindex');
      node.style.removeProperty('cursor');
      node.style.removeProperty('text-decoration');
      if (paths.has(node.dataset.id ?? '')) {
        node.setAttribute('role', 'link');
        node.tabIndex = 0;
        node.style.cursor = 'pointer';
        node.style.textDecoration = 'underline';
      }
      // Pasted references may be wrapped by ordinary rich-text anchors.
      let anchor = node.closest('a');
      while (anchor && root.contains(anchor)) {
        anchor.replaceWith(...anchor.childNodes);
        anchor = node.closest('a');
      }
    });
  }, [clean, paths, highlight]);

  function activate(event: SyntheticEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;
    const node = event.target.closest<HTMLElement>('[data-type="file-ref"]');
    if (!node || !event.currentTarget.contains(node)) return;
    event.preventDefault();
    event.stopPropagation();
    const hit = paths.get(node.dataset.id ?? '');
    if (!hit) return;
    const query = new URLSearchParams();
    query.set('folderId', hit.kind === 'folder' ? hit.id : (hit.parentFolderId ?? ''));
    if (hit.kind === 'file') query.set('fileId', hit.id);
    query.set('spaceId', hit.spaceId);
    setSelectedSpaceId(hit.spaceId);
    router.push(`/files?${query}`);
  }

  if (!clean) return null;
  return (
    <div
      ref={hostRef}
      className={className}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter') activate(event);
      }}
      dangerouslySetInnerHTML={rendered}
    />
  );
}
