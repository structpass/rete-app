import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';

// 呼び出し元は tabs を渡すだけで型名を取り込まない（公開面に使われない型を出さない・d611）。
interface PageTabDef {
  key: string;
  label: ReactNode;
  /** タブ右肩のカウントバッジ。null/undefined なら非表示。 */
  badge?: ReactNode;
  icon?: ReactNode;
}

/**
 * ページ内タブ（下線型・制御コンポーネント）。モック settings/ の sp-page-tabs を React 化。
 * 状態は呼び出し側で持ち、active なパネルだけ描画する（モックの data-page-tab JS の置き換え）。
 */
export function PageTabs({
  tabs,
  activeKey,
  onChange,
  ariaLabel,
}: {
  tabs: PageTabDef[];
  activeKey: string;
  onChange: (key: string) => void;
  ariaLabel?: string;
}) {
  const { listRef, onMouseOver, onMouseLeave, bandStyle } = useRowHoverBand<HTMLDivElement>(
    '.sp-page-tab',
    'horizontal',
  );

  return (
    <div
      className="sp-page-tabs"
      role="tablist"
      aria-label={ariaLabel}
      ref={listRef}
      onMouseOver={onMouseOver}
      onMouseLeave={onMouseLeave}
    >
      {bandStyle ? (
        <div aria-hidden="true" className="sp-page-tab-hoverband" style={bandStyle} />
      ) : null}
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={cn('sp-page-tab', active && 'active')}
            onClick={() => onChange(tab.key)}
          >
            {tab.icon}
            {tab.label}
            {tab.badge != null && <span className="sp-page-tab-badge">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
