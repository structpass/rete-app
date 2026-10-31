'use client';

import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';
import { useDiscardConfirm } from '@/hooks/use-discard-confirm';
import { DiscardConfirmDialog } from '@/components/ui/discard-confirm-dialog';
import { hasChildren, isHiddenByCollapse } from '../lib/tree';
import type { SearchResultItem, TreeNode } from '../lib/types';
import type { FolderDraft } from '../hooks/use-folder-create';
import type { UseFileDropResult } from '../hooks/use-file-drop';
import { FolderIcon } from './file-icon';

/** OS ファイル D&D ゾーン制御（fil-0052・shell の useFileDrop をツリー各フォルダへ橋渡し）。 */
export type TreeFileDrop = Pick<UseFileDropResult, 'activeZone' | 'getZoneProps'>;
/** ツリーノードの OS ファイル drop ゾーン id（hook 内の highlight 識別子・@dnd-kit の droppable id とは別名前空間）。 */
function treeDropZoneId(fid: string): string {
  return `tree:${fid}`;
}

/** ツリー先頭に出す「検索結果」フォルダの表示状態（rete-files-0004）。active=false の時は描画しない。 */
export interface TreeSearchSection {
  active: boolean;
  loading: boolean;
  error: boolean;
  results: SearchResultItem[];
  /**
   * 「検索結果」ヘッダの (×) クリックで呼ぶ解除関数（fil-0053）。
   * テキスト検索／タグ絞込のどちらでも左ペイン上段から解除できるように、呼び出し元が該当の解除関数を渡す。
   * 省略時は (×) を描画しない（後方互換）。
   */
  onClear?: () => void;
}

/**
 * 左ペインのロケーション別ツリー（モック renderTree / bindTree 移植）。
 * 各ノードは draggable かつ droppable で、ノード→ノードへの D&D で reparent（@dnd-kit に統一）。
 * 子を持つフォルダは onToggleCollapse があれば折り畳み可能（無ければ装飾）。葉ノードはシェブロンを描画しない（fil-0086）。
 */

function TreeNodeRow({
  node,
  expandable,
  active,
  dndDisabled,
  onSelect,
  fileDrop,
  collapsed,
  onToggleCollapse,
}: {
  node: TreeNode;
  expandable: boolean;
  active: boolean;
  dndDisabled: boolean;
  onSelect: (fid: string) => void;
  /** OS ファイル D&D ゾーン（省略可・未配線時は native drop なし＝後方互換）。 */
  fileDrop?: TreeFileDrop;
  /** このフォルダが現在折り畳み中か（fil-0072・シェブロン向きと判別クリック抑止に使う）。 */
  collapsed?: boolean;
  /** シェブロンクリックで開閉する。省略時はトグル機能なしで chevron は装飾扱い（後方互換）。 */
  onToggleCollapse?: (fid: string) => void;
}) {
  const dropZoneId = treeDropZoneId(node.fid);
  // OS ファイル drop は @dnd-kit の reparent とは別レイヤ（native HTML5 drag）。各フォルダ行を受け口にする。
  // folderId=null を渡すと hook が NOOP_PROPS を返す＝受け口にしない（未選択 / 検索中の右ペインと同じ経路）。
  const fileDropProps = fileDrop?.getZoneProps(dropZoneId, node.fid);
  const isFileDropOver = fileDrop?.activeZone === dropZoneId;
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `tree:${node.fid}`,
    data: { kind: 'tree', fid: node.fid, label: node.name },
    disabled: dndDisabled,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `treedrop:${node.fid}`,
    data: { kind: 'tree', fid: node.fid },
    disabled: dndDisabled,
  });

  const setRef = (el: HTMLElement | null) => {
    setDragRef(el);
    setDropRef(el);
  };

  // 折り畳み可否の最終判定：子を持つフォルダのみ、かつ onToggleCollapse が提供されている時だけトグル可能。
  // 葉ノード（配下にフォルダなし）はシェブロン自体を描かない（fil-0086）。開けない行に開く手掛かりの
  // 記号が付いていると意味を失うため。span（.ftree-chev）は幅 0.75rem 固定で残し、フォルダアイコンの
  // 横位置が子持ち行と揃うようにする（globals.css の .ftree-chev 参照）。
  const canToggle = expandable && !!onToggleCollapse;
  const isCollapsed = canToggle && !!collapsed;

  // シェブロン部分だけ click を吸い上げ、行本体の onSelect（フォルダ遷移）を発火させない（fil-0072 criteria）。
  const handleChevronClick = (e: MouseEvent) => {
    if (!canToggle) return;
    e.stopPropagation();
    onToggleCollapse!(node.fid);
  };

  return (
    <div
      ref={setRef}
      {...attributes}
      {...listeners}
      {...fileDropProps}
      className={cn(
        'ftree-node',
        // mdl-0050: hover 帯スライドの対象行。選択中は板ピル（縞なし一覧のため pill-bg 指定は不要）。
        'sp-row-pillable',
        active && 'sp-row-pill',
        isDragging && 'dragging',
        isOver && 'drag-over',
        isFileDropOver && 'is-file-drop',
      )}
      style={{ '--lvl': node.level } as CSSProperties}
      onClick={() => onSelect(node.fid)}
    >
      <span
        className={cn('ftree-chev', !canToggle && 'ftree-chev-leaf')}
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- シェブロン部分だけ click を分離するため意図的に span で受ける
        onClick={canToggle ? handleChevronClick : undefined}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        aria-label={
          canToggle ? (isCollapsed ? `${node.name} を展開` : `${node.name} を折り畳み`) : undefined
        }
        aria-expanded={canToggle ? !isCollapsed : undefined}
        onKeyDown={
          canToggle
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleCollapse!(node.fid);
                }
              }
            : undefined
        }
      >
        {/* 折り畳み中=右向き・展開中=下向き。配下にフォルダが無い葉は描かない（fil-0086）。 */}
        {/* expandable=true かつ canToggle=false は非対話の下向き表示を維持する後方互換挙動。 */}
        {!expandable ? null : isCollapsed ? (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        )}
      </span>
      <span className="ftree-ico">
        <FolderIcon size={14} />
      </span>
      <span className="ftree-label">{node.name}</span>
    </div>
  );
}

/**
 * ツリー先頭の「検索結果」仮想フォルダ（rete-files-0004）。
 * fil-0045: ヘッダ（「検索結果（N）」）と区切り線のみ描画。ヒット行は右ペインへ移設。
 * fil-0053: onClear が渡れば (×) ボタンを出し、テキスト検索／タグ絞込を左ペイン上段から解除できる
 * （両モードで同型のヘッダを使うことで左ペインの見た目を揃える）。
 * 仮想フォルダ自体は選択も移動先にもならない。
 */
function SearchSection({ search }: { search: TreeSearchSection }) {
  const count = !search.loading && !search.error ? `（${search.results.length}）` : '';
  return (
    <>
      <div className="ftree-node ftree-search-head" style={{ '--lvl': 0 } as CSSProperties}>
        <span className="ftree-chev">
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </span>
        <span className="ftree-ico ftree-search-ico">
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="ftree-label">検索結果{count}</span>
        {search.onClear && (
          <button
            type="button"
            className="ftree-search-clear"
            aria-label="検索結果を解除"
            title="検索結果を解除"
            onClick={search.onClear}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="ftree-search-sep" aria-hidden="true" />
    </>
  );
}

/**
 * インライン新規フォルダ入力行（draggable/droppable ではない非 D&D 行）。
 * Enter で確定 / Esc で取消。送信中は入力を無効化して二重コミットを防ぐ。
 * フォーカスを失った（外側クリック等）ら取消するが、送信中の disable 由来 blur では取消しない。
 * 入力がある間の取消（Esc / blur）は破棄確認を挟む（mdl-0034 規約②）。
 */
function DraftRow({
  level,
  name,
  submitting,
  onChange,
  onCommit,
  onCancel,
}: {
  level: number;
  name: string;
  submitting: boolean;
  onChange: (name: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const discard = useDiscardConfirm();
  const requestCancel = () => discard.request(name.trim() !== '', onCancel);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // IME 変換中の Esc は変換の取り消しであってフォーム取消ではない（mdl-0034 規約⑤と同方針）。
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      requestCancel();
    }
  };

  return (
    <div className="ftree-node ftree-node-draft" style={{ '--lvl': level } as CSSProperties}>
      <span className="ftree-chev" aria-hidden="true" />
      <span className="ftree-ico">
        <FolderIcon size={14} />
      </span>
      <input
        className="ftree-draft-input"
        // eslint-disable-next-line jsx-a11y/no-autofocus -- 新規行は即時入力させるため意図的にフォーカス
        autoFocus
        value={name}
        disabled={submitting}
        placeholder="フォルダ名"
        aria-label="新規フォルダ名"
        aria-required="true"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // 破棄確認ダイアログが開く時の blur（フォーカス移動）で二重に取消要求しない。
          if (!submitting && !discard.open) requestCancel();
        }}
      />
      <DiscardConfirmDialog
        open={discard.open}
        onConfirm={discard.onConfirm}
        onCancel={discard.onCancel}
      />
    </div>
  );
}

export function FilesTree({
  tree,
  currentFolderId,
  dndDisabled,
  onSelect,
  search = null,
  draft = null,
  draftSubmitting = false,
  onDraftChange,
  onDraftCommit,
  onDraftCancel,
  fileDrop,
  collapsedIds,
  onToggleCollapse,
}: {
  tree: TreeNode[];
  currentFolderId: string | null;
  dndDisabled: boolean;
  onSelect: (fid: string) => void;
  /** 横断検索の結果フォルダ（rete-files-0004・null/active=false で非表示）。ツリー先頭に描く。 */
  search?: TreeSearchSection | null;
  /** インライン新規作成中の draft（null=非作成中）。 */
  draft?: FolderDraft | null;
  draftSubmitting?: boolean;
  onDraftChange?: (name: string) => void;
  onDraftCommit?: () => void;
  onDraftCancel?: () => void;
  /** OS ファイル D&D アップロードのゾーン制御（fil-0052・省略可）。 */
  fileDrop?: TreeFileDrop;
  /**
   * 折り畳み中のフォルダ ID 一覧（fil-0072/fil-0073）。省略時は折り畳み機能なしで全展開（後方互換）。
   * シェブロン向きと行の可視判定の両方に使う。
   */
  collapsedIds?: ReadonlySet<string>;
  /** シェブロンクリックで開閉する。省略時はトグル機能なし（後方互換）。 */
  onToggleCollapse?: (fid: string) => void;
}) {
  // 親ノードの level を引く（ルート直下=null は level 0 相当）。draft 行はこの level+1 に描く。
  const parentLevel =
    draft && draft.parentFolderId !== null
      ? tree.find((n) => n.fid === draft.parentFolderId)?.level
      : -1;
  const draftRow =
    draft && onDraftChange && onDraftCommit && onDraftCancel ? (
      <DraftRow
        key="__folder_draft__"
        level={(parentLevel ?? -1) + 1}
        name={draft.name}
        submitting={draftSubmitting}
        onChange={onDraftChange}
        onCommit={onDraftCommit}
        onCancel={onDraftCancel}
      />
    ) : null;

  // mdl-0050: フォルダ行の hover は単一の薄グレー帯（.sp-row-hoverband）のスライド追従。
  // 検索結果ヘッダ・draft 行は帯対象外（sp-row-pillable を付けない）。
  const { listRef, onMouseOver, onMouseLeave, bandStyle } =
    useRowHoverBand<HTMLDivElement>('.sp-row-pillable');

  const rows: ReactNode[] = [];
  // ルート直下作成（parentFolderId=null）は先頭に draft 行を出す。
  if (draftRow && draft && draft.parentFolderId === null) {
    rows.push(draftRow);
  }
  tree.forEach((node, i) => {
    // 折り畳まれた祖先のサブツリー内なら行を描画しない（fil-0072 criteria: 折り畳み中は子孫すべて隠れる）。
    if (collapsedIds && isHiddenByCollapse(tree, i, collapsedIds)) return;
    rows.push(
      <TreeNodeRow
        key={node.fid}
        node={node}
        expandable={hasChildren(tree, i)}
        active={node.fid === currentFolderId}
        dndDisabled={dndDisabled}
        onSelect={onSelect}
        fileDrop={fileDrop}
        collapsed={collapsedIds?.has(node.fid) ?? false}
        onToggleCollapse={onToggleCollapse}
      />,
    );
    // 作成先フォルダの直後（最初の子）に draft 行を差し込む。
    // 折り畳み中で親が隠れている時は draft も隠す（draft は子の先頭に置く運用）。
    if (draftRow && draft && draft.parentFolderId === node.fid && !collapsedIds?.has(node.fid)) {
      rows.push(draftRow);
    }
  });

  return (
    <div
      ref={listRef}
      className="file-tree-scroll relative"
      onMouseOver={onMouseOver}
      onMouseLeave={onMouseLeave}
    >
      {search?.active && <SearchSection search={search} />}
      {rows}
      {/* hover 帯（装飾専用）。bandStyle 非 null の時だけ末尾に描く。 */}
      {bandStyle ? <div aria-hidden className="sp-row-hoverband" style={bandStyle} /> : null}
    </div>
  );
}
