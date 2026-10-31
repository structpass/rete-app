'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';
import type { ManifestGroup } from '../lib/manifest';

/**
 * モデルタブ専用サイドバー（AppShell の sidebar slot に差し込む）。
 * buildManifest が返すカテゴリ→テーマの2階層を描画し、選択中テーマを active 表示する。
 * cmn-0128→rete-top-0004: hover グレー帯のスライド追従（app-sidebar/settings-sidebar と同じ
 * useRowHoverBand・leaveOnNoMatch=true で非対象領域へ移った時に帯を自動で消す）。
 * カテゴリ開閉ヘッダ（.sidebar-section-label）もテーマ項目（.sidebar-link）と同一の帯グループで
 * 追従させるため rowSelector をカンマ区切りで両対応にし、個別 Tailwind hover は撤去する。
 */
export function ModelSidebar({
  groups,
  selectedId,
  onSelect,
}: {
  groups: ManifestGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // カテゴリ群の折り畳み状態（key→collapsed）。既定は全展開（空＝どれも collapsed でない）。
  // session 内ローカル保持で十分なため永続化しない（rete-model-0002 Phase1）。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const { listRef, onMouseOver, onMouseLeave, bandStyle } = useRowHoverBand<HTMLDivElement>(
    // cmn-0133: active 行は帯の対象外（選択ピルが半透明の白＝下に帯が入ると透けて二重に見える）。
    '.sidebar-link:not(.active), .sidebar-section-label',
    'vertical',
    true,
  );

  return (
    <aside className="app-sidebar">
      <div className="app-sidebar-header">
        <h1>Model</h1>
      </div>

      <div
        className="app-sidebar-scroll"
        ref={listRef}
        onMouseOver={onMouseOver}
        onMouseLeave={onMouseLeave}
      >
        {groups.map((group) => {
          const isCollapsed = collapsed[group.category.key] ?? false;
          return (
            <div key={group.category.key} className="mt-2 first:mt-0">
              <button
                type="button"
                className="sidebar-section-label cursor-pointer rounded-[0.1875rem]"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(group.category.key)}
              >
                <span>{group.category.label}</span>
                <span aria-hidden className="text-[0.6875rem] text-[var(--sp-text-warm-mute)]">
                  {isCollapsed ? '▸' : '▾'}
                </span>
              </button>
              {!isCollapsed &&
                group.themes.map((theme) => {
                  const active = theme.id === selectedId;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      className={cn('sidebar-link', active && 'active')}
                      onClick={() => onSelect(theme.id)}
                    >
                      <span className="flex-1 text-left">{theme.navLabel ?? theme.title}</span>
                    </button>
                  );
                })}
            </div>
          );
        })}
        {bandStyle ? <div aria-hidden className="app-sidebar-hoverband" style={bandStyle} /> : null}
      </div>
    </aside>
  );
}
