import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { FileList } from '../components/file-list';
import type { FileRowVM } from '../components/file-list';
import type { FileItem } from '../lib/types';

/**
 * fil-0071: 本体一覧（page モード）のフォルダ行ダブルクリックで onNavigateFolder。
 * - シングルクリックの選択トグルは維持。
 * - ダブルクリックは native onDoubleClick ではなく「閾値内の 2 回目クリック」手動検出
 *   （search-results / fil-0046 と同型。再レンダーで native dblclick が不発になる実機バグへの回帰防止）。
 */

// cmn-0142: vi.hoisted 化
const { fnSetWidth, fnResetWidths } = vi.hoisted(() => ({
  fnSetWidth: vi.fn(),
  fnResetWidths: vi.fn(),
}));

vi.mock('@/features/user-table-column-widths', () => ({
  useTableColumnWidths: () => ({
    widths: {},
    setWidth: fnSetWidth,
    resetWidths: fnResetWidths,
  }),
}));

// v2-505 差し戻し: 明細の★列は撤去した。Provider がある状態でも★を描かないことを
// 確かめられるよう、favorites の context を ON/OFF できるようにしておく
// （OFF のときは元から何も描かない）。
const { favoritesAvailableRef } = vi.hoisted(() => ({
  favoritesAvailableRef: { current: false },
}));
vi.mock('@/features/shell/hooks/favorites-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/shell/hooks/favorites-context')>();
  return {
    ...actual,
    useOptionalFavoritesContext: () =>
      favoritesAvailableRef.current
        ? {
            items: [],
            loading: false,
            error: null,
            refetch: vi.fn(),
            add: vi.fn(),
            remove: vi.fn(),
            reorder: vi.fn(),
          }
        : null,
  };
});

const folderItem: FileItem = {
  kind: 'folder',
  name: 'フォルダA',
  id: 'fld-001',
  fid: 'fld-001',
  updatedBy: 'u',
  updatedAt: '2026-01-01',
};

const fileItem: FileItem = {
  kind: 'file',
  name: 'ファイルB.pdf',
  id: 'file-002',
  updatedBy: 'u',
  updatedAt: '2026-01-01',
  size: '1KB',
};

const folderRow: FileRowVM = { item: folderItem, srcIndex: 0 };
const fileRow: FileRowVM = { item: fileItem, srcIndex: 1 };

function renderList(
  rows: FileRowVM[],
  {
    onNavigateFolder,
    onEditFile,
    toggle = vi.fn(),
  }: {
    onNavigateFolder?: (fid: string) => void;
    onEditFile?: (item: FileItem) => void;
    toggle?: (name: string) => void;
  } = {},
) {
  const selection = {
    has: () => false,
    toggle,
  };
  return render(
    <DndContext>
      <FileList
        rows={rows}
        sortKey={null}
        sortDir="asc"
        onToggleSort={vi.fn()}
        selectedCount={0}
        selection={selection}
        dndDisabled
        onToggleAll={vi.fn()}
        onNavigateFolder={onNavigateFolder}
        onEditFile={onEditFile}
      />
    </DndContext>,
  );
}

describe('FileList — page mode folder dblclick (fil-0071)', () => {
  it('フォルダ行をシングルクリックすると選択トグルのみで onNavigateFolder は呼ばれない', () => {
    const onNavigateFolder = vi.fn();
    const toggle = vi.fn();
    renderList([folderRow], { onNavigateFolder, toggle });

    const row = screen.getByText('フォルダA').closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(toggle).toHaveBeenCalledWith('フォルダA');
    expect(onNavigateFolder).not.toHaveBeenCalled();
  });

  it('フォルダ行を連続 2 回クリックすると 2 回目で onNavigateFolder が呼ばれる', () => {
    const onNavigateFolder = vi.fn();
    const toggle = vi.fn();
    renderList([folderRow], { onNavigateFolder, toggle });

    const row = screen.getByText('フォルダA').closest('tr');
    fireEvent.click(row!);
    fireEvent.click(row!);

    expect(onNavigateFolder).toHaveBeenCalledWith('fld-001');
    // 1 回目だけトグル。2 回目は navigate のみ（search-results と同型）。
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledWith('フォルダA');
  });

  it('ファイル行を 2 回クリックしても onNavigateFolder は呼ばれない', () => {
    const onNavigateFolder = vi.fn();
    const toggle = vi.fn();
    renderList([fileRow], { onNavigateFolder, toggle });

    const row = screen.getByText('ファイルB.pdf').closest('tr');
    fireEvent.click(row!);
    fireEvent.click(row!);

    expect(onNavigateFolder).not.toHaveBeenCalled();
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it('フォルダ→ファイル→同フォルダの連打では onNavigateFolder を呼ばない（誤検出防止）', () => {
    const onNavigateFolder = vi.fn();
    renderList([folderRow, fileRow], { onNavigateFolder });

    const folderEl = screen.getByText('フォルダA').closest('tr');
    const fileEl = screen.getByText('ファイルB.pdf').closest('tr');
    fireEvent.click(folderEl!);
    fireEvent.click(fileEl!);
    fireEvent.click(folderEl!);

    expect(onNavigateFolder).not.toHaveBeenCalled();
  });

  it('合成 dblclick 単発では onNavigateFolder を呼ばない（native onDoubleClick 非依存）', () => {
    const onNavigateFolder = vi.fn();
    renderList([folderRow], { onNavigateFolder });

    const row = screen.getByText('フォルダA').closest('tr');
    fireEvent.dblClick(row!);

    expect(onNavigateFolder).not.toHaveBeenCalled();
  });

  it('チェックボックス上のクリックでは遷移しない', () => {
    const onNavigateFolder = vi.fn();
    const toggle = vi.fn();
    renderList([folderRow], { onNavigateFolder, toggle });

    const checkbox = screen.getByLabelText('フォルダA を選択');
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);

    expect(onNavigateFolder).not.toHaveBeenCalled();
  });

  it('onNavigateFolder 未指定でも 2 回クリックでエラーにならない', () => {
    const toggle = vi.fn();
    renderList([folderRow], { toggle });

    const row = screen.getByText('フォルダA').closest('tr');
    expect(() => {
      fireEvent.click(row!);
      fireEvent.click(row!);
    }).not.toThrow();
    // 配線なし時は両クリックともトグル（従来どおり）。
    expect(toggle).toHaveBeenCalledTimes(2);
  });
});

/**
 * fil-0075/fil-0076: ファイル行ダブルクリックで onEditFile（ローカル編集セッション起動）。
 * フォルダ側（fil-0071）と対称の component テスト。
 */
describe('FileList — page mode file dblclick (fil-0075)', () => {
  it('ファイル行をシングルクリックすると選択トグルのみで onEditFile は呼ばれない', () => {
    const onEditFile = vi.fn();
    const toggle = vi.fn();
    renderList([fileRow], { onEditFile, toggle });

    const row = screen.getByText('ファイルB.pdf').closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(toggle).toHaveBeenCalledWith('ファイルB.pdf');
    expect(onEditFile).not.toHaveBeenCalled();
  });

  it('ファイル行を連続 2 回クリックすると 2 回目で onEditFile が対象 FileItem で呼ばれる', () => {
    const onEditFile = vi.fn();
    const toggle = vi.fn();
    renderList([fileRow], { onEditFile, toggle });

    const row = screen.getByText('ファイルB.pdf').closest('tr');
    fireEvent.click(row!);
    fireEvent.click(row!);

    expect(onEditFile).toHaveBeenCalledWith(fileItem);
    // 1 回目だけトグル。2 回目は編集起動のみ（フォルダ側と同型）。
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledWith('ファイルB.pdf');
  });

  it('フォルダ行を 2 回クリックしても onEditFile は呼ばれない', () => {
    const onEditFile = vi.fn();
    const onNavigateFolder = vi.fn();
    renderList([folderRow], { onEditFile, onNavigateFolder });

    const row = screen.getByText('フォルダA').closest('tr');
    fireEvent.click(row!);
    fireEvent.click(row!);

    expect(onEditFile).not.toHaveBeenCalled();
    expect(onNavigateFolder).toHaveBeenCalledWith('fld-001');
  });

  it('ファイル→フォルダ→同ファイルの連打では onEditFile を呼ばない（誤検出防止）', () => {
    const onEditFile = vi.fn();
    renderList([folderRow, fileRow], { onEditFile });

    const folderEl = screen.getByText('フォルダA').closest('tr');
    const fileEl = screen.getByText('ファイルB.pdf').closest('tr');
    fireEvent.click(fileEl!);
    fireEvent.click(folderEl!);
    fireEvent.click(fileEl!);

    expect(onEditFile).not.toHaveBeenCalled();
  });

  it('onEditFile 未指定でも 2 回クリックでエラーにならない', () => {
    const toggle = vi.fn();
    renderList([fileRow], { toggle });

    const row = screen.getByText('ファイルB.pdf').closest('tr');
    expect(() => {
      fireEvent.click(row!);
      fireEvent.click(row!);
    }).not.toThrow();
    // 配線なし時は両クリックともトグル（従来どおり）。
    expect(toggle).toHaveBeenCalledTimes(2);
  });
});

/**
 * v2-505 差し戻し: 明細の★列は撤去した。
 * お気に入り登録はトップバーの★（現在フォルダ）が担い、明細の file/folder を個別に登録する
 * 必要は無かった（開発統括判断）。rete-files-0030 の「★登録は Home 側導線へ一本化」に戻す。
 */
describe('FileList — 明細に★列を出さない（v2-505 差し戻し）', () => {
  beforeEach(() => {
    // Provider があっても★を描かないことを確かめる（配下でも出ない）。
    favoritesAvailableRef.current = true;
  });
  afterEach(() => {
    favoritesAvailableRef.current = false;
  });

  it('ファイル行・フォルダ行のどちらにも★ボタンを描かない', () => {
    renderList([fileRow, folderRow], {});
    expect(screen.queryByRole('button', { name: /お気に入り/ })).toBeNull();
  });

  it('★列の見出しセルも無い', () => {
    const { container } = renderList([fileRow], {});
    expect(container.querySelector('th.col-favorite')).toBeNull();
    expect(container.querySelector('td.col-favorite')).toBeNull();
  });
});
