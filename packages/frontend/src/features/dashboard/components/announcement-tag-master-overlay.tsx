'use client';

import { useState } from 'react';
import { TagMasterOverlay } from '@/components/tags/tag-master-overlay';
import { useAnnouncementTagMasterContext } from '../hooks/announcement-tag-master-context';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';
import type { HomeTagKind } from '@rete/shared';

/**
 * お知らせタグ管理オーバーレイ（掲示板/FAQ 2タブ・hom-0074）。
 *
 * 共有コンポーネント TagMasterOverlay（File タグ管理とも共有）にはタブ切替ロジック（kind 選択）を
 * 持ち込まず、本コンポーネントが選択中タブに応じた master（board/faq）を切り替えて渡すだけのラッパーに
 * 徹する。タブ UI 自体は TagMasterOverlay が公開する headTabs スロット（見出し「タグ管理」の代替枠）へ
 * 差し込み、focus trap（OverlayDialog が担当・cmn-0355 で useFocusTrap 言及を是正）の対象内に収める
 * （外側に浮かせるとキーボード操作でタブへ到達できない・code-reviewer HIGH指摘の反映）。
 *
 * board/faq インスタンスは AnnouncementTagMasterProvider（Context・app-shell.tsx 配下で mount）から
 * 取得するため、本オーバーレイ自身の中では単一インスタンスとして共有される。DashboardView 側も
 * hom-0073 完了により同 Context（dashboard-view.tsx の useAnnouncementTagMasterContext）を直接消費して
 * おり、タブでの変更がダッシュボード画面へ即時反映される不変条件は成立済み。
 */
export function AnnouncementTagMasterOverlay({ onClose }: { onClose: () => void }) {
  const { board, faq, calendar, archiveOnly, setArchiveOnly } = useAnnouncementTagMasterContext();
  const [tab, setTab] = useState<HomeTagKind>('board');
  const activeMaster = { board, faq, calendar }[tab];
  const {
    listRef: tagMasterTabsRef,
    onMouseOver: onTagMasterTabMouseOver,
    onMouseLeave: onTagMasterTabMouseLeave,
    bandStyle: tagMasterTabHoverBandStyle,
  } = useRowHoverBand<HTMLDivElement>('.file-overlay-tab', 'horizontal');

  // hom-0080: archiveOnly が ON のまま閉じると、以後アーカイブ込みの fetch 結果が board/faq に
  // 残り続け、TagFilterDropdown やタグ付与ピッカー（dashboard-view.tsx）にアーカイブ済みタグが
  // 漏れ出す。閉じる時に必ず false へ戻し、他画面には常に非アーカイブのみを見せる。
  const handleClose = () => {
    setArchiveOnly(false);
    onClose();
  };

  // hom-0084: タブ意匠を分類設定（category-settings-dialog）と揃えるため file-overlay-tab の
  // 見た目を tag-master-tabs スコープで上書きする（file-picker-overlay.tsx と共有する基底クラスは
  // 変更しない・globals.css の .tag-master-tabs .file-overlay-tab 系ルールを参照）。ARIA は
  // role="radiogroup"/radio のまま据え置き（ticket grounding：ARIA 統一は対象外）。
  const tabs = (
    <div
      className="file-overlay-tabs tag-master-tabs"
      role="radiogroup"
      aria-label="タグ管理対象"
      ref={tagMasterTabsRef}
      onMouseOver={onTagMasterTabMouseOver}
      onMouseLeave={onTagMasterTabMouseLeave}
    >
      {tagMasterTabHoverBandStyle ? (
        <div
          aria-hidden="true"
          className="file-overlay-tab-hoverband"
          style={tagMasterTabHoverBandStyle}
        />
      ) : null}
      <button
        type="button"
        role="radio"
        aria-checked={tab === 'board'}
        className={`file-overlay-tab${tab === 'board' ? ' is-active' : ''}`}
        onClick={() => setTab('board')}
      >
        掲示板
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={tab === 'calendar'}
        className={`file-overlay-tab${tab === 'calendar' ? ' is-active' : ''}`}
        onClick={() => setTab('calendar')}
      >
        カレンダー
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={tab === 'faq'}
        className={`file-overlay-tab${tab === 'faq' ? ' is-active' : ''}`}
        onClick={() => setTab('faq')}
      >
        FAQ
      </button>
    </div>
  );

  return (
    <TagMasterOverlay
      master={activeMaster}
      onClose={handleClose}
      headTabs={tabs}
      archiveFilter={{ value: archiveOnly, onChange: setArchiveOnly }}
    />
  );
}
