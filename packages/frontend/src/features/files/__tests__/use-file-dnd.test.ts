import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { DragEndEvent } from '@dnd-kit/core';
import { useFileDnd, type FileDragData } from '../hooks/use-file-dnd';

/** active/over の data.current だけを持つ最小の DragEndEvent を組む（dnd-kit の他フィールドは未使用）。 */
function dragEnd(active: FileDragData, over: FileDragData | null): DragEndEvent {
  return {
    active: { data: { current: active } },
    over: over ? { data: { current: over } } : null,
  } as unknown as DragEndEvent;
}

function setup() {
  const onReparent = vi.fn();
  const onMoveRow = vi.fn();
  const onMoveRowToFolder = vi.fn();
  const onMoveFromSearch = vi.fn();
  const { result } = renderHook(() =>
    useFileDnd({ onReparent, onMoveRow, onMoveRowToFolder, onMoveFromSearch }),
  );
  return { result, onReparent, onMoveRow, onMoveRowToFolder, onMoveFromSearch };
}

describe('useFileDnd — kind 別ディスパッチ', () => {
  it('tree → tree は onReparent(nodeFid, targetFid)', () => {
    const { result, onReparent, onMoveFromSearch } = setup();
    result.current.onDragEnd(
      dragEnd({ kind: 'tree', fid: 'a', label: 'A' }, { kind: 'tree', fid: 'b', label: 'B' }),
    );
    expect(onReparent).toHaveBeenCalledWith('a', 'b');
    expect(onMoveFromSearch).not.toHaveBeenCalled();
  });

  it('row → row は onMoveRow(fromIndex, targetIndex)', () => {
    const { result, onMoveRow } = setup();
    result.current.onDragEnd(
      dragEnd({ kind: 'row', index: 0, label: 'x' }, { kind: 'row', index: 2, label: 'y' }),
    );
    expect(onMoveRow).toHaveBeenCalledWith(0, 2);
  });

  // 一覧の行 → ツリーのフォルダ（S-FILE-04-C2）。一覧の行を落としても、行どうしの移動（並べ替え・同一階層）とは分けて扱う。
  it('row(folder) → tree は onMoveRowToFolder("folder", fid, targetFid, parentFolderId)', () => {
    const { result, onMoveRowToFolder, onMoveRow } = setup();
    result.current.onDragEnd(
      dragEnd(
        {
          kind: 'row',
          index: 1,
          label: 'A',
          rowKind: 'folder',
          rowId: 'a1',
          rowParentFolderId: 'cur',
        },
        { kind: 'tree', fid: 'dest', label: 'Dest' },
      ),
    );
    expect(onMoveRowToFolder).toHaveBeenCalledWith('folder', 'a1', 'dest', 'cur');
    expect(onMoveRow).not.toHaveBeenCalled();
  });

  it('row(file) → tree は onMoveRowToFolder("file", fileId, targetFid, parentFolderId)', () => {
    const { result, onMoveRowToFolder } = setup();
    result.current.onDragEnd(
      dragEnd(
        {
          kind: 'row',
          index: 0,
          label: 'doc',
          rowKind: 'file',
          rowId: 'file9',
          rowParentFolderId: 'cur',
        },
        { kind: 'tree', fid: 'dest', label: 'Dest' },
      ),
    );
    expect(onMoveRowToFolder).toHaveBeenCalledWith('file', 'file9', 'dest', 'cur');
  });

  it('row の移動元が root（parentFolderId 未指定）は null として渡る', () => {
    const { result, onMoveRowToFolder } = setup();
    result.current.onDragEnd(
      dragEnd(
        { kind: 'row', index: 0, label: 'A', rowKind: 'folder', rowId: 'a1' },
        { kind: 'tree', fid: 'dest', label: 'Dest' },
      ),
    );
    expect(onMoveRowToFolder).toHaveBeenCalledWith('folder', 'a1', 'dest', null);
  });

  it('row を tree 以外（row）へ落とした時は onMoveRowToFolder を呼ばない', () => {
    const { result, onMoveRow, onMoveRowToFolder } = setup();
    result.current.onDragEnd(
      dragEnd(
        { kind: 'row', index: 0, label: 'A', rowKind: 'folder', rowId: 'a1' },
        { kind: 'row', index: 2, label: 'y' },
      ),
    );
    expect(onMoveRow).toHaveBeenCalledWith(0, 2);
    expect(onMoveRowToFolder).not.toHaveBeenCalled();
  });

  it('search(folder) → tree は onMoveFromSearch("folder", id, targetFid, parentFolderId)', () => {
    const { result, onMoveFromSearch } = setup();
    result.current.onDragEnd(
      dragEnd(
        {
          kind: 'search',
          searchKind: 'folder',
          searchId: 'f1',
          searchParentFolderId: 'p1',
          label: 'F',
        },
        { kind: 'tree', fid: 'dest', label: 'Dest' },
      ),
    );
    expect(onMoveFromSearch).toHaveBeenCalledWith('folder', 'f1', 'dest', 'p1');
  });

  it('search(file) → tree は onMoveFromSearch("file", id, targetFid, parentFolderId)', () => {
    const { result, onMoveFromSearch } = setup();
    result.current.onDragEnd(
      dragEnd(
        {
          kind: 'search',
          searchKind: 'file',
          searchId: 'file9',
          searchParentFolderId: 'f9',
          label: 'doc',
        },
        { kind: 'tree', fid: 'dest', label: 'Dest' },
      ),
    );
    expect(onMoveFromSearch).toHaveBeenCalledWith('file', 'file9', 'dest', 'f9');
  });

  it('search の parentFolderId 未指定（root 由来）は null として渡る', () => {
    const { result, onMoveFromSearch } = setup();
    result.current.onDragEnd(
      dragEnd(
        { kind: 'search', searchKind: 'folder', searchId: 'r1', label: 'R' },
        { kind: 'tree', fid: 'dest', label: 'Dest' },
      ),
    );
    expect(onMoveFromSearch).toHaveBeenCalledWith('folder', 'r1', 'dest', null);
  });

  it('search を tree 以外（row）へ落としても何も起きない', () => {
    const { result, onMoveFromSearch, onMoveRow } = setup();
    result.current.onDragEnd(
      dragEnd(
        { kind: 'search', searchKind: 'file', searchId: 'file9', label: 'doc' },
        { kind: 'row', index: 1, label: 'r' },
      ),
    );
    expect(onMoveFromSearch).not.toHaveBeenCalled();
    expect(onMoveRow).not.toHaveBeenCalled();
  });

  it('over が無い（ドロップ先なし）なら何も起きない', () => {
    const { result, onReparent, onMoveRow, onMoveFromSearch } = setup();
    result.current.onDragEnd(dragEnd({ kind: 'tree', fid: 'a', label: 'A' }, null));
    expect(onReparent).not.toHaveBeenCalled();
    expect(onMoveRow).not.toHaveBeenCalled();
    expect(onMoveFromSearch).not.toHaveBeenCalled();
  });
});
