'use client';

import { forwardRef, useEffect, useImperativeHandle, useState, type Ref } from 'react';
import { ReactRenderer } from '@tiptap/react';
import type {
  SuggestionKeyDownProps,
  SuggestionOptions,
  SuggestionProps,
} from '@tiptap/suggestion';
import { cn } from '@/lib/utils';
import { computeFlipPosition } from '../lib/compute-flip-position';

/** @ メンション候補 1 件（id=accountId / label=表示名 / rete-desk-0080）。 */
export interface MentionItem {
  id: string;
  label: string;
}

/** 1 度に出す候補件数の上限（rete-desk-0141: 最大 5 件・超過分はラベル昇順の上から 5 件）。 */
const MENTION_LIMIT = 5;

interface MentionListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

/**
 * @ サジェストのポップアップ本体（↑↓ で移動・Enter/クリックで確定）。
 * Tiptap suggestion から ReactRenderer 経由で描画され、キー操作は親（suggestion.onKeyDown）から委譲される。
 */
const MentionList = forwardRef(function MentionList(
  { items, command }: SuggestionProps<MentionItem>,
  ref: Ref<MentionListHandle>,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => setSelectedIndex(0), [items]);

  const select = (index: number) => {
    const item = items[index];
    // command が node 属性（id/label）を Mention ノードへ挿入する。
    if (item) command({ id: item.id, label: item.label });
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (items.length === 0) return false;
      if (event.key === 'ArrowUp') {
        setSelectedIndex((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        select(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="desk-mention-popup">
        <div className="desk-mention-empty">該当なし</div>
      </div>
    );
  }

  // キーボード操作は suggestion.onKeyDown 経由でエディタ側が処理するため、各 option は focus を受けない
  // 純粋な視覚要素。implicit button role との競合を避けるため <div role="option"> で表現する。
  return (
    <div className="desk-mention-popup" role="listbox" aria-label="メンション候補">
      {items.map((item, index) => (
        <div
          key={item.id}
          role="option"
          aria-selected={index === selectedIndex}
          className={cn('desk-mention-option', index === selectedIndex && 'is-active')}
          // mousedown でエディタの blur 前に確定する（click だと選択前に suggestion が閉じうる）。
          onMouseDown={(e) => {
            e.preventDefault();
            select(index);
          }}
        >
          @{item.label}
        </div>
      ))}
    </div>
  );
});

/**
 * Mention 拡張へ渡す suggestion 設定を生成する（rete-desk-0080）。
 * 候補は getItems()（最新の account リスト）を query で前方/部分一致フィルタし上限件数で切る。
 * 描画は tippy を使わず、body 直下に固定配置した anchor へ ReactRenderer をぶら下げる軽量実装。
 */
export function createMentionSuggestion(
  getItems: () => MentionItem[],
): Omit<SuggestionOptions<MentionItem>, 'editor'> {
  return {
    items: ({ query }) => {
      const q = query.toLowerCase();
      // ラベル文字列の昇順で安定ソートしてから上限件数で切る（rete-desk-0141: 該当が上限を超える場合は
      // 昇順の上から 5 件を表示する仕様）。
      return getItems()
        .filter((i) => i.label.toLowerCase().includes(q))
        .sort((a, b) => a.label.localeCompare(b.label, 'ja'))
        .slice(0, MENTION_LIMIT);
    },
    render: () => {
      let component: ReactRenderer<MentionListHandle> | null = null;
      let anchor: HTMLDivElement | null = null;
      let currentRect: SuggestionProps<MentionItem>['clientRect'];
      const reposition = () => position(currentRect);
      // 縦方向の優先表示位置（rete-desk-0151）: @ のみ / @ + 文字（ヒット有無を問わず）いずれも
      // キャレットの「上」に出す（候補一覧を入力中テキストへ被せず常に上方へ）。上に収まらない時だけ
      // position() が下へフリップする。常時上のため query 依存の出し分けは行わない。
      const preferAbove = true;

      // ポップアップをビューポート内へ収める余白（端からの最小マージン）。
      const MARGIN = 8;
      // キャレットとポップアップの間隔。
      const GAP = 4;
      // 実寸が測れない（ReactRenderer の commit 前で offset=0）時のフォールバック寸法。
      // CSS の max-height 14rem(224px)+padding/border ≒ 240、min-width 10rem(160px) を上限見積りに使い、
      // 「下に収まらなければ上へフリップ」判定が初回 onStart でも確実に成立するようにする（rete-desk-0111）。
      const FALLBACK_H = 240;
      const FALLBACK_W = 240;
      const position = (clientRect: (() => DOMRect | null) | null | undefined) => {
        if (!anchor || !clientRect) return;
        const rect = clientRect();
        if (!rect) return;
        // anchor は body 直下・position:fixed。コンポーザ（チャット詳細）は画面下部にあり、キャレット直下へ
        // 出すと下端からはみ出す（rete-desk-0080/0111）。実寸 0（commit 前）の時はフォールバック寸法で
        // フリップ/クランプを判定し、rAF 再配置で実寸へ微調整する。
        // 縦は preferAbove（@ のみ / rete-desk-0151）でキャレット上を優先。フリップ/クランプの算法は
        // computeFlipPosition へ集約（dsk-0369）。
        const pw = anchor.offsetWidth || FALLBACK_W;
        const ph = anchor.offsetHeight || FALLBACK_H;
        const { left, top } = computeFlipPosition(
          rect,
          { width: pw, height: ph },
          { preferAbove, margin: MARGIN, gap: GAP },
        );
        anchor.style.left = `${left}px`;
        anchor.style.top = `${top}px`;
      };

      return {
        onStart: (props) => {
          currentRect = props.clientRect;
          // 候補は常にキャレットの上に出す（rete-desk-0151）。preferAbove は固定 true。
          component = new ReactRenderer(MentionList, { props, editor: props.editor });
          anchor = document.createElement('div');
          anchor.className = 'desk-mention-popup-anchor';
          anchor.appendChild(component.element);
          document.body.appendChild(anchor);
          window.addEventListener('scroll', reposition, true);
          window.addEventListener('resize', reposition);
          position(props.clientRect);
          // 初回は ReactRenderer の commit 前で実寸（offsetWidth/Height）が 0 になりうるため、
          // 次フレーム（保険でさらにもう 1 フレーム）で再配置し、フリップ/クランプ判定を実寸で行う。
          // 実寸 0 のままだとフォールバック寸法（最大高 240px）で「上へフリップ」と誤判定し、
          // 「該当なし」等の低いポップアップがキャレットから大きく離れて出る（rete-desk-0135）。
          requestAnimationFrame(() => {
            position(props.clientRect);
            requestAnimationFrame(() => position(props.clientRect));
          });
        },
        onUpdate: (props) => {
          currentRect = props.clientRect;
          // 候補は常に上に出す（rete-desk-0151）。位置の優先側は固定なので query での更新は不要。
          component?.updateProps(props);
          if (anchor) anchor.style.display = '';
          position(props.clientRect);
          // 候補件数の増減（5件⇔該当なし等）で実寸が変わるため、commit 後にもう一度実寸で再配置する
          // （rete-desk-0135: 該当なしへ切り替わった瞬間の位置ズレ防止）。
          requestAnimationFrame(() => position(props.clientRect));
        },
        onKeyDown: (props) => {
          if (props.event.key === 'Escape') {
            if (anchor) anchor.style.display = 'none';
            return true;
          }
          return component?.ref?.onKeyDown(props) ?? false;
        },
        onExit: () => {
          window.removeEventListener('scroll', reposition, true);
          window.removeEventListener('resize', reposition);
          currentRect = undefined;
          anchor?.remove();
          anchor = null;
          component?.destroy();
          component = null;
        },
      };
    },
  };
}
