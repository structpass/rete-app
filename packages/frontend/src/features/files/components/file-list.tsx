'use client';

import { useEffect, useRef, type MutableRefObject } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';
import { kindLabel } from '../lib/format';
import type { FileItem, FileTagView, SortDir, SortKey } from '../lib/types';
import { FileIcon } from './file-icon';
import { TagIcon } from '@/components/tags/tag-icon';
import { useTableColumnWidths } from '@/features/user-table-column-widths';

/** tableId: ファイル一覧固有の論理識別子（backend TABLE_IDS と一致）。 */
export const FILES_TABLE_ID = 'files-list' as const;

/**
 * 手動ダブルクリック検出の閾値（ms）。
 * search-results（fil-0046）と同値。native onDoubleClick は再レンダーで不発になるため使わない（fil-0071）。
 */
const DOUBLE_CLICK_MS = 400;

/**
 * 列キー定義（colgroup / resize-handle 両方で使う）。
 * backend の columnKey 許可文字 /^[A-Za-z0-9_.:-]{1,64}$/ に準拠。
 */
const COL_KEYS = {
  name: 'name',
  tags: 'tags',
  kind: 'kind',
  updatedBy: 'updatedBy',
  versionNo: 'versionNo',
  updatedAt: 'updatedAt',
  size: 'size',
} as const;

/** 各列の最小幅（px）。保存値がこれを下回らないようにクランプする。 */
const MIN_WIDTHS: Record<string, number> = {
  [COL_KEYS.name]: 80,
  [COL_KEYS.tags]: 60,
  [COL_KEYS.kind]: 80,
  [COL_KEYS.updatedBy]: 64,
  [COL_KEYS.versionNo]: 56,
  [COL_KEYS.updatedAt]: 100,
  [COL_KEYS.size]: 60,
};

/** 列のデフォルト幅（px）。未保存時に使用する。 */
const DEFAULT_WIDTHS: Record<string, number> = {
  [COL_KEYS.tags]: 92,
  [COL_KEYS.kind]: 112,
  [COL_KEYS.updatedBy]: 96,
  [COL_KEYS.versionNo]: 72,
  [COL_KEYS.updatedAt]: 136,
};

/** 保存値を優先し、min でクランプして解決した列幅を返す。 */
function resolveWidth(
  key: string,
  saved: Record<string, number>,
  defaultPx?: number,
): number | undefined {
  const saved_ = saved[key];
  const min = MIN_WIDTHS[key] ?? 40;
  if (saved_ !== undefined) return Math.max(saved_, min);
  if (defaultPx !== undefined) return defaultPx;
  return undefined; // flex（幅指定なし）
}

/** ソート可能な列の定義（モック thead の data-sort に対応）。 */
const COLUMNS: { key: SortKey; label: string; colKey: string }[] = [
  { key: 'name', label: '名前', colKey: COL_KEYS.name },
  { key: 'kind', label: '種類', colKey: COL_KEYS.kind },
  { key: 'updatedBy', label: '更新者', colKey: COL_KEYS.updatedBy },
  { key: 'updatedAt', label: '更新日', colKey: COL_KEYS.updatedAt },
];

/** 表示行（ソート/検索後の可視 item と、元 items 配列の参照インデックス）。 */
export interface FileRowVM {
  item: FileItem;
  srcIndex: number;
}

/**
 * 列リサイズハンドル。
 * th の右端に絶対配置し、mousedown → drag → mouseup で列幅を変更する。
 * drag 中は楽観更新（store 即時書き換え）、mouseup 後 300ms で debounce PUT を hook が行う。
 */
function ResizeHandle({
  colKey,
  currentWidth,
  setWidth,
}: {
  colKey: string;
  currentWidth: number;
  setWidth: (key: string, width: number) => void;
}) {
  const startXRef = useRef<number | null>(null);
  const startWRef = useRef<number>(currentWidth);
  const min = MIN_WIDTHS[colKey] ?? 40;
  // ドラッグ中に window へ登録したリスナーの解除関数を保持し、ドラッグ途中の
  // アンマウント（タブ切替・ページ遷移）でも確実に解除する（リスナー残留 / GC 阻害の防止・code review HIGH）。
  const detachRef = useRef<(() => void) | null>(null);
  useEffect(() => () => detachRef.current?.(), []);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); // テキスト選択を防ぐ
    e.stopPropagation(); // th のソートクリックを防ぐ
    startXRef.current = e.clientX;
    startWRef.current = currentWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (startXRef.current === null) return;
      const delta = ev.clientX - startXRef.current;
      const newWidth = Math.max(min, startWRef.current + delta);
      setWidth(colKey, newWidth);
    };

    const detach = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      detachRef.current = null;
    };

    const onMouseUp = () => {
      startXRef.current = null;
      detach();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    detachRef.current = detach;
  };

  return <span className="col-resize-handle" onMouseDown={onMouseDown} aria-hidden="true" />;
}

/**
 * 列定義。
 * - page モード（7列）: チェック / 名前 / タグ / 種類 / 更新者 / 更新日 / サイズ。
 *   rete-files-0006 で版数列を廃しタグ列を名前の右へ追加、サイズ列を 72px に詰めた。
 * - picker モード（4列）: 名前 / 種類 / 更新日 / サイズ。選択チェック/タグ/更新者を落とす
 *   （rete-desk-0096/0097/0098・添付ピッカーは従来挙動のまま）。
 */
function ColGroup({
  pickMode,
  savedWidths,
}: {
  pickMode: boolean;
  savedWidths: Record<string, number>;
}) {
  const nameW = resolveWidth(COL_KEYS.name, savedWidths);
  const tagsW = resolveWidth(COL_KEYS.tags, savedWidths, DEFAULT_WIDTHS[COL_KEYS.tags]);
  const kindW = resolveWidth(COL_KEYS.kind, savedWidths, DEFAULT_WIDTHS[COL_KEYS.kind]);
  const updatedByW = resolveWidth(
    COL_KEYS.updatedBy,
    savedWidths,
    DEFAULT_WIDTHS[COL_KEYS.updatedBy],
  );
  const versionNoW = resolveWidth(
    COL_KEYS.versionNo,
    savedWidths,
    DEFAULT_WIDTHS[COL_KEYS.versionNo],
  );
  const updatedAtW = resolveWidth(
    COL_KEYS.updatedAt,
    savedWidths,
    DEFAULT_WIDTHS[COL_KEYS.updatedAt],
  );
  const sizeW = resolveWidth(COL_KEYS.size, savedWidths, pickMode ? 88 : 72);

  return (
    <colgroup>
      {!pickMode && <col style={{ width: '36px' }} />}
      <col style={nameW !== undefined ? { width: `${nameW}px` } : undefined} />
      {/* タグ列はアイコンのみ表示（rete-files-0010/0011）。chip 3 つ（17px×3）+ gap（6px×2）= 63px に
          td 左右 padding（0.75rem×2 = 24px）を足した実効幅を確保する。76px では 3 つ目が欠けていたため
          92px へ拡張（rete-files-0025）。 */}
      {!pickMode && <col style={{ width: `${tagsW}px` }} />}
      <col style={{ width: `${kindW}px` }} />
      {!pickMode && <col style={{ width: `${updatedByW}px` }} />}
      {/* 版数列（fil-0079）。更新者と更新日の間に挿入。folder 行・versionNo 未保存は空欄のため
          数字のみ中央寄せの最小幅で十分。page モードのみ表示（pickMode はファイル選択 UI なので非表示）。 */}
      {!pickMode && <col style={{ width: `${versionNoW}px` }} />}
      <col style={{ width: `${updatedAtW}px` }} />
      <col style={{ width: `${sizeW}px` }} />
    </colgroup>
  );
}

/** 一覧タグ列に並べるチップの最大数（超過は +N に畳む）。 */
const TAG_CHIPS_MAX = 3;

/**
 * 行のタグ列（rete-files-0010/0011）。アイコンのみを色付きで並べ（名前ラベルは出さない）、
 * ホバーで title にタグ名を出す。最大 3 件・超過は +N。folder にもタグを付与できる（rete-files-0033）ため
 * folder/file 共通で描画し、タグ無しは「—」を出す。
 */
function TagCell({ tags }: { tags: FileTagView[] }) {
  if (tags.length === 0) return <span className="file-tags-empty">—</span>;
  const shown = tags.slice(0, TAG_CHIPS_MAX);
  const overflow = tags.length - shown.length;
  return (
    <div className="file-tags-cell">
      {shown.map((t) => (
        <span key={t.id} className="file-tag-chip" title={t.name}>
          <TagIcon name={t.icon} size={16} color={t.color} />
        </span>
      ))}
      {overflow > 0 && <span className="file-tag-more">+{overflow}</span>}
    </div>
  );
}

function SortIndicator({ state }: { state: 'asc' | 'desc' | null }) {
  return (
    <span className="sort-ind">
      {state === 'asc' ? (
        <ArrowUp className="h-3 w-3" aria-hidden="true" />
      ) : state === 'desc' ? (
        <ArrowDown className="h-3 w-3" aria-hidden="true" />
      ) : (
        <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
      )}
    </span>
  );
}

function SortHeader({
  col,
  sortKey,
  sortDir,
  onToggleSort,
  savedWidths,
  setWidth,
}: {
  col: { key: SortKey; label: string; colKey: string };
  sortKey: SortKey | null;
  sortDir: SortDir;
  onToggleSort: (key: SortKey) => void;
  savedWidths: Record<string, number>;
  setWidth: (colKey: string, width: number) => void;
}) {
  const sorted = sortKey === col.key;
  const currentWidth =
    resolveWidth(col.colKey, savedWidths, DEFAULT_WIDTHS[col.colKey]) ??
    MIN_WIDTHS[col.colKey] ??
    100;
  return (
    <th className={cn('sortable', sorted && 'is-sorted')} onClick={() => onToggleSort(col.key)}>
      {col.label}
      <SortIndicator state={sorted ? sortDir : null} />
      <ResizeHandle colKey={col.colKey} currentWidth={currentWidth} setWidth={setWidth} />
    </th>
  );
}

function FileRow({
  vm,
  selected,
  dndDisabled,
  onToggle,
  pickMode = false,
  onPick,
  onNavigateFolder,
  onEditFile,
  lastRowClickRef,
  versionFlashId,
  parentFolderId = null,
}: {
  vm: FileRowVM;
  selected: boolean;
  dndDisabled: boolean;
  /** page モードの一覧が今表示しているフォルダの id（掴んだ行の移動元・root は null）。 */
  parentFolderId?: string | null;
  onToggle: (name: string) => void;
  /** ピッカー（添付）モード: 行クリックでファイル=添付 / フォルダ=潜る。チェックボックス列は空にする。 */
  pickMode?: boolean;
  onPick?: (item: FileItem) => void;
  onNavigateFolder?: (fid: string) => void;
  /** page モードのファイル行ダブルクリック＝ローカル編集セッション起動（fil-0075）。 */
  onEditFile?: (item: FileItem) => void;
  /**
   * page モードの行ダブルクリック検出用（fil-0071 フォルダ / fil-0075 ファイル）。
   * FileList が所有する ref。key は `folder:<fid>` / `file:<id>` で、別行クリックや
   * rows 切替で破棄され、誤検出を防ぐ。
   */
  lastRowClickRef?: MutableRefObject<{ key: string; t: number } | null>;
  /** fil-0082: 監視停止クローズ直後にフラッシュ対象とするファイル id。該当行の td のみ赤字太字化する。 */
  versionFlashId?: string | null;
}) {
  const { item, srcIndex } = vm;
  const isFolder = item.kind === 'folder';

  // ピッカーモードの行クリック: フォルダは潜る、ファイルは添付確定（チェック選択は使わない）。
  const handlePickClick = () => {
    if (isFolder) {
      if (item.fid) onNavigateFolder?.(item.fid);
    } else {
      onPick?.(item);
    }
  };

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `row:${srcIndex}`,
    data: {
      kind: 'row',
      index: srcIndex,
      label: item.name,
      // ツリーのフォルダへ落とした時の移動に使う（一覧の行 → ツリーのフォルダ・S-FILE-04-C2）。
      // folder は移動 API がフォルダ id、file はファイル id を受ける。
      rowKind: item.kind,
      rowId: isFolder ? item.fid : item.id,
      rowParentFolderId: parentFolderId,
    },
    disabled: dndDisabled,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `rowdrop:${srcIndex}`,
    data: { kind: 'row', index: srcIndex },
    disabled: dndDisabled || !isFolder,
  });

  const setRef = (el: HTMLTableRowElement | null) => {
    setDragRef(el);
    if (isFolder) setDropRef(el);
  };

  return (
    <tr
      ref={setRef}
      {...attributes}
      {...listeners}
      className={cn(
        'file-row',
        // mdl-0050: hover 帯スライドの対象行（td 内容を帯より前面へ持ち上げる）。選択視覚は
        // チェックボックスが担うため板ピルは使わない（is-selected は従来どおり視覚なし）。
        'sp-row-pillable',
        pickMode && 'is-pick',
        selected && 'is-selected',
        isDragging && 'row-dragging',
        isFolder && isOver && 'row-drop-target',
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('input, a')) return;
        if (pickMode) {
          handlePickClick();
          return;
        }
        // page モード: 閾値内 2 回目クリック＝フォルダは中へ開く（fil-0071）/ ファイルは
        // ローカル編集セッション起動（fil-0075）。search-results と同型の手動検出。
        // 1 回目は従来どおり選択トグル。2 回目はアクションのみ（トグルしない）。
        if (isFolder && item.fid && onNavigateFolder && lastRowClickRef) {
          const key = `folder:${item.fid}`;
          const now = Date.now();
          const last = lastRowClickRef.current;
          if (last && last.key === key && now - last.t < DOUBLE_CLICK_MS) {
            lastRowClickRef.current = null;
            onNavigateFolder(item.fid);
            return;
          }
          lastRowClickRef.current = { key, t: now };
        } else if (!isFolder && item.id && onEditFile && lastRowClickRef) {
          const key = `file:${item.id}`;
          const now = Date.now();
          const last = lastRowClickRef.current;
          if (last && last.key === key && now - last.t < DOUBLE_CLICK_MS) {
            lastRowClickRef.current = null;
            onEditFile(item);
            return;
          }
          lastRowClickRef.current = { key, t: now };
        } else if (lastRowClickRef) {
          // 対象外の行: 直近クリック追跡を破棄（行またぎの誤検出防止）。
          lastRowClickRef.current = null;
        }
        onToggle(item.name);
      }}
    >
      {/* picker モードは選択チェック列を出さない（rete-desk-0097 空白列の除去）。 */}
      {!pickMode && (
        <td>
          <input
            type="checkbox"
            className="file-check"
            checked={selected}
            onChange={() => onToggle(item.name)}
            aria-label={`${item.name} を選択`}
          />
        </td>
      )}
      <td className="col-name">
        <div className="file-name-cell">
          <FileIcon item={item} />
          {/* 名前は列幅で省略（…）されるため、ホバーで全文をツールチップ表示する（rete-desk-0106）。
              タグチップ（TagCell）と同じ title 方式に揃える。 */}
          <span title={item.name}>{item.name}</span>
        </div>
      </td>
      {/* タグ列（rete-files-0006・page モードのみ）。folder にもタグを付与可（rete-files-0033）のため
          folder/file 共通で描画する。未付与は TagCell が「—」を出す。 */}
      {!pickMode && (
        <td className="col-tags">
          <TagCell tags={item.tags ?? []} />
        </td>
      )}
      <td className="col-kind">{kindLabel(item)}</td>
      {/* 更新者列は picker モードでは不要（rete-desk-0098）。 */}
      {!pickMode && <td>{item.updatedBy ?? ''}</td>}
      {/* fil-0079: 版数列（page モードのみ・更新者と更新日の間）。folder 行・versionNo 未保存は空欄。
          fil-0082: 監視停止クローズ直後だけ対象行に is-version-flash を付与し 10 秒間赤字太字にする。 */}
      {!pickMode && (
        <td
          className={cn(
            'col-version',
            !isFolder && versionFlashId === item.id && 'is-version-flash',
          )}
          style={{ textAlign: 'center' }}
        >
          {isFolder ? '' : (item.versionNo ?? '')}
        </td>
      )}
      <td>{item.updatedAt ?? ''}</td>
      <td style={{ textAlign: 'right' }}>{isFolder ? '' : (item.size ?? '')}</td>
    </tr>
  );
}

export function FileList({
  rows,
  sortKey,
  sortDir,
  onToggleSort,
  selectedCount,
  selection,
  dndDisabled,
  onToggleAll,
  pickMode = false,
  onPick,
  onNavigateFolder,
  onEditFile,
  versionFlashId,
  parentFolderId = null,
}: {
  rows: FileRowVM[];
  sortKey: SortKey | null;
  sortDir: SortDir;
  onToggleSort: (key: SortKey) => void;
  selectedCount: number;
  selection: { has: (name: string) => boolean; toggle: (name: string) => void };
  dndDisabled: boolean;
  onToggleAll: (checked: boolean) => void;
  /** page モードの一覧が今表示しているフォルダの id（行をツリーのフォルダへ移す時の移動元・root は null）。 */
  parentFolderId?: string | null;
  /**
   * ピッカー（添付）モード: チェックボックス列を空にし、行クリックで添付（ファイル）/ フォルダ遷移する。
   * 既定 false で Files ページ本体の挙動は不変（architecture-invariants 回帰防止）。
   */
  pickMode?: boolean;
  onPick?: (item: FileItem) => void;
  onNavigateFolder?: (fid: string) => void;
  /** page モードのファイル行ダブルクリック＝ローカル編集セッション起動（fil-0075）。 */
  onEditFile?: (item: FileItem) => void;
  /** fil-0082: 監視停止クローズ直後にフラッシュ対象とするファイル id を FileRow まで橋渡しする。 */
  versionFlashId?: string | null;
}) {
  const allRef = useRef<HTMLInputElement>(null);
  const total = rows.length;
  const allChecked = total > 0 && selectedCount === total;
  const indeterminate = selectedCount > 0 && selectedCount < total;

  // page モードの行ダブルクリック検出（fil-0071 フォルダ / fil-0075 ファイル）。rows 切替で直近クリックを破棄する。
  const lastRowClickRef = useRef<{ key: string; t: number } | null>(null);
  useEffect(() => {
    lastRowClickRef.current = null;
  }, [rows]);

  // 列幅永続化（fil-0047）: tableId='files-list' でユーザー毎・テーブル単位に保存。
  const { widths: savedWidths, setWidth } = useTableColumnWidths(FILES_TABLE_ID);

  // mdl-0050: 明細行 hover は単一の薄グレー帯（.sp-row-hoverband）のスライド追従。
  // wrapper（.file-list-scroll）とテーブルの間に余白を挟まないこと（tr の offsetParent=table 基準の
  // 測位と帯の絶対配置基準がズレる）。
  const { listRef, onMouseOver, onMouseLeave, bandStyle } =
    useRowHoverBand<HTMLDivElement>('tr.file-row');

  // タグ列ヘッダのリサイズ用現在幅
  const tagsCurrentWidth =
    resolveWidth(COL_KEYS.tags, savedWidths, DEFAULT_WIDTHS[COL_KEYS.tags]) ??
    DEFAULT_WIDTHS[COL_KEYS.tags]!;
  // 版数列ヘッダのリサイズ用現在幅（fil-0079）。page モードのみなので pickMode 時は使わない。
  const versionNoCurrentWidth =
    resolveWidth(COL_KEYS.versionNo, savedWidths, DEFAULT_WIDTHS[COL_KEYS.versionNo]) ??
    DEFAULT_WIDTHS[COL_KEYS.versionNo]!;
  const sizeCurrentWidth =
    resolveWidth(COL_KEYS.size, savedWidths, pickMode ? 88 : 72) ?? (pickMode ? 88 : 72);

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <section className="sp-card file-list-card">
      <div className="file-list-head">
        <table className="sp-table file-table">
          <ColGroup pickMode={pickMode} savedWidths={savedWidths} />
          <thead>
            <tr>
              {/* picker モードは選択チェック列ヘッダを出さない（rete-desk-0097）。 */}
              {!pickMode && (
                <th className="col-check">
                  <input
                    ref={allRef}
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => onToggleAll(e.target.checked)}
                    aria-label="すべて選択"
                  />
                </th>
              )}
              {/* 列順: 名前 / タグ(非ソート) / 種類 / 更新者 / 版数 / 更新日 / サイズ(非ソート)。
                  picker モードはタグ・更新者・版数を省く（rete-files-0006 / rete-desk-0098）。
                  お気に入り登録はトップバーの★（現在フォルダ）が担うため、明細には★列を置かない
                  （v2-505 差し戻し・rete-files-0030 の「★登録は Home 側導線へ一本化」に戻す）。 */}
              <SortHeader
                col={COLUMNS[0]}
                sortKey={sortKey}
                sortDir={sortDir}
                onToggleSort={onToggleSort}
                savedWidths={savedWidths}
                setWidth={setWidth}
              />
              {!pickMode && (
                <th>
                  タグ
                  <ResizeHandle
                    colKey={COL_KEYS.tags}
                    currentWidth={tagsCurrentWidth}
                    setWidth={setWidth}
                  />
                </th>
              )}
              <SortHeader
                col={COLUMNS[1]}
                sortKey={sortKey}
                sortDir={sortDir}
                onToggleSort={onToggleSort}
                savedWidths={savedWidths}
                setWidth={setWidth}
              />
              {!pickMode && (
                <SortHeader
                  col={COLUMNS[2]}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggleSort={onToggleSort}
                  savedWidths={savedWidths}
                  setWidth={setWidth}
                />
              )}
              {/* fil-0079: 版数列（page モードのみ・タグ列・更新者列と同型の非ソート列）。
                  数字のみ・最小幅で足りるためリサイズハンドルで対応（仕様確定）。 */}
              {!pickMode && (
                <th>
                  版数
                  <ResizeHandle
                    colKey={COL_KEYS.versionNo}
                    currentWidth={versionNoCurrentWidth}
                    setWidth={setWidth}
                  />
                </th>
              )}
              <SortHeader
                col={COLUMNS[3]}
                sortKey={sortKey}
                sortDir={sortDir}
                onToggleSort={onToggleSort}
                savedWidths={savedWidths}
                setWidth={setWidth}
              />
              <th>
                サイズ
                <ResizeHandle
                  colKey={COL_KEYS.size}
                  currentWidth={sizeCurrentWidth}
                  setWidth={setWidth}
                />
              </th>
            </tr>
          </thead>
        </table>
      </div>
      <div
        ref={listRef}
        className="file-list-scroll relative"
        onMouseOver={onMouseOver}
        onMouseLeave={onMouseLeave}
      >
        <table className="sp-table file-table sp-table--hoverband">
          <ColGroup pickMode={pickMode} savedWidths={savedWidths} />
          <tbody>
            {/* 空フォルダのプレースホルダ（ラベル/未保存領域）は出さない（rete-files-0007/0008）。
                項目があるときだけ行を描画し、空時は tbody を空のままにする。 */}
            {total === 0
              ? null
              : rows.map((vm) => (
                  <FileRow
                    key={vm.item.id ?? vm.item.name}
                    vm={vm}
                    selected={selection.has(vm.item.name)}
                    dndDisabled={dndDisabled}
                    onToggle={selection.toggle}
                    pickMode={pickMode}
                    onPick={onPick}
                    onNavigateFolder={onNavigateFolder}
                    onEditFile={pickMode ? undefined : onEditFile}
                    lastRowClickRef={pickMode ? undefined : lastRowClickRef}
                    versionFlashId={versionFlashId}
                    parentFolderId={parentFolderId}
                  />
                ))}
          </tbody>
        </table>
        {/* hover 帯（装飾専用）。テーブルの後に置き、bandStyle 非 null の時だけ描く。 */}
        {bandStyle ? <div aria-hidden className="sp-row-hoverband" style={bandStyle} /> : null}
      </div>
      {/* picker モードは複数選択しないためフッタ（選択件数）を出さない（rete-desk-0100）。 */}
      {!pickMode && (
        <div className="file-list-foot">
          <span>
            {total} アイテム — {selectedCount} 件選択中
          </span>
        </div>
      )}
    </section>
  );
}
