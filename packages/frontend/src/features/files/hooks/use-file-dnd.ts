'use client';

import { useCallback, useState } from 'react';
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';

/** D&D ペイロード（active/over の data.current）。kind で ツリー reparent / 行移動 / 検索結果移動 を分岐。 */
export interface FileDragData {
  kind: 'tree' | 'row' | 'search';
  /** kind==='tree' のフォルダ id。 */
  fid?: string;
  /** kind==='row' の元 items 配列インデックス（表示順ではなくソース順）。 */
  index?: number;
  /** kind==='row' の掴んだ項目の種別と id（ツリーのフォルダへ落とす移動に使う）。 */
  rowKind?: 'folder' | 'file';
  rowId?: string;
  /**
   * kind==='row' が今どのフォルダの中身か（掴んだ行の一覧の現在地・root は null）。
   * ツリーのフォルダへ落として移す時の、同一親への無駄移動の判定に使う。
   */
  rowParentFolderId?: string | null;
  /** kind==='search' のヒット種別（folder/file で移動 API を分岐）。 */
  searchKind?: 'folder' | 'file';
  /** kind==='search' の entity id（folder id / file id）。 */
  searchId?: string;
  /** kind==='search' の現在の親フォルダ id（同一親への無駄移動を弾く判定に使う・root は null）。 */
  searchParentFolderId?: string | null;
  label: string;
}

interface UseFileDndArgs {
  onReparent: (nodeFid: string, targetFid: string) => void;
  onMoveRow: (fromIndex: number, targetIndex: number) => void;
  /**
   * 一覧の行（一覧の現在地にある folder/file）をツリーのフォルダ（targetFid）へ移動する。
   * parentFolderId は掴んだ行があった一覧のフォルダ（同一親ドロップの no-op 判定用・root は null）。
   */
  onMoveRowToFolder: (
    kind: 'folder' | 'file',
    id: string,
    targetFid: string,
    parentFolderId: string | null,
  ) => void;
  /**
   * 検索結果フォルダ内の項目（kind）をツリーのフォルダ（targetFid）へ移動する（rete-files-0004）。
   * parentFolderId は移動元の現在の親（同一親ドロップの no-op 判定用・root は null）。
   */
  onMoveFromSearch: (
    kind: 'folder' | 'file',
    id: string,
    targetFid: string,
    parentFolderId: string | null,
  ) => void;
}

/**
 * File タブの D&D 制御（Desk と同じ `@dnd-kit` 基盤に統一）。
 * 1 つの DndContext で「ツリーの reparent」と「一覧行の移動」を data.kind で分岐する
 * （desk-shell の昇格/移動の kind 分岐と同型）。クリック誤爆を避けるため 8px 移動まで click 扱い。
 */
export function useFileDnd({
  onReparent,
  onMoveRow,
  onMoveRowToFolder,
  onMoveFromSearch,
}: UseFileDndArgs) {
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const onDragStart = useCallback((e: DragStartEvent) => {
    const d = e.active.data.current as FileDragData | undefined;
    setActiveLabel(d?.label ?? null);
  }, []);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveLabel(null);
      const a = e.active.data.current as FileDragData | undefined;
      const o = e.over?.data.current as FileDragData | undefined;
      if (!a || !o) return;
      if (a.kind === 'tree' && o.kind === 'tree' && a.fid && o.fid) {
        onReparent(a.fid, o.fid);
      } else if (a.kind === 'row' && o.kind === 'row' && a.index != null && o.index != null) {
        onMoveRow(a.index, o.index);
      } else if (a.kind === 'row' && o.kind === 'tree' && a.rowKind && a.rowId && o.fid) {
        // 一覧の行をツリーのフォルダへ落とす → 移し先のフォルダへ移動（S-FILE-04-開発エージェント）。
        onMoveRowToFolder(a.rowKind, a.rowId, o.fid, a.rowParentFolderId ?? null);
      } else if (a.kind === 'search' && o.kind === 'tree' && a.searchKind && a.searchId && o.fid) {
        // 検索結果フォルダ内の項目をツリーのフォルダへドロップ → 実フォルダへ移動（rete-files-0004）。
        onMoveFromSearch(a.searchKind, a.searchId, o.fid, a.searchParentFolderId ?? null);
      }
    },
    [onReparent, onMoveRow, onMoveRowToFolder, onMoveFromSearch],
  );

  return { sensors, onDragStart, onDragEnd, activeLabel };
}
