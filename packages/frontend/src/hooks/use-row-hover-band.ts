'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';

// 型は外へ出さない（呼び出し元は 'vertical' | 'horizontal' のリテラルを直接渡しており、公開面に使われていない・d611）。
type HoverBandAxis = 'vertical' | 'horizontal';

/**
 * 明細一覧の hover 帯スライド追従（mdl-0050・正本=モデルタブ「マウスホバー表現」）。
 *
 * 行ごとの :hover 背景ではなく「絶対配置の単一帯要素を測位して transform で滑らせる」方式
 * （ナビ .nav-pill / サイドバー .sidebar-hoverband と同語彙）。hover 先が移るとき前の行から
 * 滑って追従する。掲示板 hom-0123 の実装を共通 hook へ抽出したもの。
 *
 * 使い方:
 * - 一覧コンテナ（行の offsetParent になる position:relative な要素）に listRef と
 *   onMouseOver / onMouseLeave を張る。
 * - コンテナ末尾に装飾専用の帯要素（.sp-row-hoverband・aria-hidden）を bandStyle が
 *   非 null の時だけ描く。行側には .sp-row-pillable を付け z-index を確保する。
 * - rowSelector は帯対象行の CSS セレクタ（例: 'li.sp-row-pillable'）。帯要素自身が
 *   マッチしないセレクタにすること（pointer-events:none のため通常は問題にならない）。
 *
 * 注意: 測位は offsetTop/offsetHeight（縦）または offsetLeft/offsetWidth（横）
 * （offsetParent 基準）。テーブル行（tr）で使う場合はコンテナ（wrapper）とテーブルの間に
 * 余白やキャプションを挟まないこと（ズレの原因になる）。
 *
 * axis（dsk-0386・既定 'vertical'）: 'horizontal' はナビ/タブ strip 用。帯要素の
 * height/top は CSS 側（100%/0）に任せ、JS は width と横方向の transform だけを返す
 * （.nav-hoverband・.desk-ticket-tab-hoverband と同型）。既存呼び出し元は axis 省略で
 * 挙動不変（後方互換）。
 *
 * leaveOnNoMatch（rete-top-0004・既定 false）: true の時、rowSelector に非一致 or
 * コンテナに非包含の要素へ hover が移った瞬間に onMouseLeave 相当（帯を消す）を自動で行う。
 * サイドバー（行以外の要素＝セクション見出し・余白が混在する一覧）向け。省略時は従来通り
 * 非一致を無視して最後の位置を保持する（他の呼び出し元は行だけの一覧なので挙動不変）。
 */
export function useRowHoverBand<E extends HTMLElement = HTMLElement>(
  rowSelector: string,
  axis: HoverBandAxis = 'vertical',
  leaveOnNoMatch = false,
) {
  const listRef = useRef<E | null>(null);
  const [rect, setRect] = useState<{ start: number; size: number } | null>(null);
  // 一覧の外から入ってきた最初の 1 回はスライドさせず即時に置く。true になって以降のみ追従アニメ。
  const shown = useRef(false);

  const measureRow = useCallback(
    (row: HTMLElement) => {
      if (!listRef.current?.contains(row)) return;
      setRect((prev) => {
        const next =
          axis === 'horizontal'
            ? { start: row.offsetLeft, size: row.offsetWidth }
            : { start: row.offsetTop, size: row.offsetHeight };
        return prev && prev.start === next.start && prev.size === next.size ? prev : next;
      });
    },
    [axis],
  );

  const onMouseLeave = useCallback(() => {
    shown.current = false;
    setRect(null);
  }, []);

  const onMouseOver = useCallback(
    (e: ReactMouseEvent<E>) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(rowSelector);
      if (!row || !listRef.current?.contains(row)) {
        if (leaveOnNoMatch) onMouseLeave();
        return;
      }
      measureRow(row);
    },
    [rowSelector, measureRow, leaveOnNoMatch, onMouseLeave],
  );

  useEffect(() => {
    if (rect) shown.current = true;
  }, [rect]);

  const bandStyle: CSSProperties | null = rect
    ? axis === 'horizontal'
      ? {
          width: rect.size,
          transform: `translate3d(${rect.start}px, 0, 0)`,
          transition: shown.current ? undefined : 'none',
        }
      : {
          height: rect.size,
          transform: `translate3d(0, ${rect.start}px, 0)`,
          transition: shown.current ? undefined : 'none',
        }
    : null;

  return { listRef, onMouseOver, onMouseLeave, bandStyle, measureRow };
}
