import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SearchResults, type SearchSelection } from '../components/search-results';
import type { SearchResultItem, TreeNode } from '../lib/types';

/**
 * fil-0051: 横断検索ペインのファイル行に通常表示と同型のチェック選択を持たせる。
 * - selection を渡すとファイル行にチェックボックスが出る／フォルダ行には出ない（フォルダは選択対象外）。
 * - ファイル行クリック=選択トグル（ナビゲートしない）／フォルダ行クリック=ナビゲート。
 * - 選択は id 基点（別フォルダ同名ファイルが衝突しない）。
 * - 全選択チェックはファイル id のみを setMany する。
 */

const tree: TreeNode[] = [];

const folder: SearchResultItem = {
  kind: 'folder',
  id: 'fld-1',
  name: 'フォルダA',
  parentFolderId: null,
};
const fileA: SearchResultItem = {
  kind: 'file',
  id: 'file-1',
  name: 'a.pdf',
  parentFolderId: 'fld-1',
};
// 別フォルダの同名ファイル（id 基点選択の衝突しないことを検証する）。
const dup1: SearchResultItem = {
  kind: 'file',
  id: 'file-dup-1',
  name: 'dup.pdf',
  parentFolderId: 'fld-1',
};
const dup2: SearchResultItem = {
  kind: 'file',
  id: 'file-dup-2',
  name: 'dup.pdf',
  parentFolderId: 'fld-2',
};

function makeSelection(selected = new Set<string>()): SearchSelection & {
  toggle: Mock<SearchSelection['toggle']>;
  setMany: Mock<SearchSelection['setMany']>;
} {
  return {
    has: (id: string) => selected.has(id),
    toggle: vi.fn<SearchSelection['toggle']>(),
    setMany: vi.fn<SearchSelection['setMany']>(),
  };
}

function renderComp(
  results: SearchResultItem[],
  selection?: SearchSelection,
  onNavigate = vi.fn(),
) {
  return render(
    <SearchResults
      results={results}
      tree={tree}
      loading={false}
      error={false}
      errorText="err"
      emptyText="empty"
      onNavigate={onNavigate}
      selection={selection}
    />,
  );
}

describe('SearchResults — selection (fil-0051)', () => {
  it.each([false, true])('0件でも列見出しと本文の骨格を保持する（選択列=%s）', (selectable) => {
    const { container, rerender } = renderComp([fileA], selectable ? makeSelection() : undefined);
    const body = container.querySelector('tbody');
    rerender(
      <SearchResults
        results={[]}
        tree={tree}
        loading={false}
        error={false}
        errorText="err"
        emptyText="empty"
        onNavigate={vi.fn()}
        selection={selectable ? makeSelection() : undefined}
      />,
    );
    expect(container.querySelector('tbody')).toBe(body);
    expect(screen.getByRole('columnheader', { name: '名前' })).toBeInTheDocument();
    expect(screen.getByText('empty').closest('td')).toHaveAttribute(
      'colspan',
      selectable ? '4' : '3',
    );
    expect(screen.getByText('0 件ヒット')).toBeInTheDocument();
    if (selectable) expect(screen.getByRole('checkbox', { name: 'すべて選択' })).toBeDisabled();
    rerender(
      <SearchResults
        results={[]}
        tree={tree}
        loading
        error={false}
        errorText="err"
        emptyText="empty"
        onNavigate={vi.fn()}
        selection={selectable ? makeSelection() : undefined}
      />,
    );
    expect(container.querySelector('tbody')).toBe(body);
    expect(screen.getByText('検索中…')).toBeInTheDocument();
    expect(screen.queryByText('empty')).not.toBeInTheDocument();
  });

  it('selection 未指定なら選択列を出さず、ファイル行クリックは onNavigate（従来挙動）', () => {
    const onNavigate = vi.fn();
    const { container } = renderComp([fileA], undefined, onNavigate);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    fireEvent.click(screen.getByText('a.pdf').closest('tr')!);
    expect(onNavigate).toHaveBeenCalledWith('fld-1');
  });

  it('selection 指定でファイル行にチェックボックスが出る／フォルダ行には出ない', () => {
    renderComp([folder, fileA], makeSelection());
    const folderRow = screen.getByText('フォルダA').closest('tr')!;
    const fileRow = screen.getByText('a.pdf').closest('tr')!;
    expect(within(folderRow).queryByRole('checkbox')).toBeNull();
    expect(within(fileRow).getByRole('checkbox')).toBeTruthy();
  });

  it('ファイル行クリックで selection.toggle(id) が呼ばれ onNavigate は呼ばれない', () => {
    const selection = makeSelection();
    const onNavigate = vi.fn();
    renderComp([fileA], selection, onNavigate);
    // 行クリック（チェックボックス以外）でトグル。
    fireEvent.click(screen.getByText('a.pdf'));
    expect(selection.toggle).toHaveBeenCalledWith('file-1');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('フォルダ行クリックは selection 指定下でも onNavigate（フォルダは選択対象外）', () => {
    const selection = makeSelection();
    const onNavigate = vi.fn();
    renderComp([folder], selection, onNavigate);
    fireEvent.click(screen.getByText('フォルダA').closest('tr')!);
    expect(onNavigate).toHaveBeenCalledWith('fld-1');
    expect(selection.toggle).not.toHaveBeenCalled();
  });

  it('別フォルダの同名ファイルは id 基点で独立に選択できる', () => {
    const selection = makeSelection();
    const { container } = renderComp([dup1, dup2], selection);
    const checks = container.querySelectorAll('tbody input[type="checkbox"]');
    expect(checks.length).toBe(2);
    fireEvent.click(checks[0]);
    fireEvent.click(checks[1]);
    expect(selection.toggle).toHaveBeenNthCalledWith(1, 'file-dup-1');
    expect(selection.toggle).toHaveBeenNthCalledWith(2, 'file-dup-2');
  });

  it('全選択チェックはファイル id のみを setMany する（フォルダ id を含めない）', () => {
    const selection = makeSelection();
    renderComp([folder, fileA, dup1], selection);
    const selectAll = screen.getByLabelText('すべて選択') as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(selection.setMany).toHaveBeenCalledWith(['file-1', 'file-dup-1'], true);
  });
});
