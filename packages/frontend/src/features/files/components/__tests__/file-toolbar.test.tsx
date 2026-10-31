import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileToolbar } from '../file-toolbar';

/**
 * 正本 comp-toolbar: 一覧に対する主要アクションは右端の分離グループへ置き、破壊操作はその末尾。
 * 左側は選択対象への操作（アップロード・ダウンロード・タグ付け・共有）に限る。
 */
function renderToolbar() {
  return render(
    <FileToolbar
      selectionCount={1}
      canTagAssign
      uploading={false}
      deleting={false}
      onUpload={vi.fn()}
      onDownload={vi.fn()}
      onNewFolder={vi.fn()}
      onShareChat={vi.fn()}
      onShareClip={vi.fn()}
      onTagAssign={vi.fn()}
      onReset={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe('FileToolbar（正本 comp-toolbar の配置）', () => {
  it('右端グループは リセット → 新規フォルダ → 削除 の順で、主要アクションは右端側に寄る', () => {
    const { container } = renderToolbar();
    const spacer = container.querySelector('.file-tb-spacer');
    expect(spacer).not.toBeNull();

    const kids = Array.from(spacer!.parentElement!.children);
    const spacerIndex = kids.indexOf(spacer!);
    const btnText = (el: Element) => el.textContent?.trim();
    const rightGroup = kids
      .slice(spacerIndex + 1)
      .filter((el) => el.classList.contains('file-tb-btn'))
      .map(btnText);
    expect(rightGroup).toEqual(['リセット', '新規フォルダ', '削除']);

    // 左側（分離スペーサより前）に主要アクションを残さない。
    const leftGroup = kids
      .slice(0, spacerIndex)
      .filter((el) => el.classList.contains('file-tb-btn'))
      .map(btnText);
    expect(leftGroup).toEqual([
      'アップロード',
      'ダウンロード',
      'タグ付け',
      'チャット共有',
      'パスをコピー',
    ]);
  });

  it('選択項目のコピーは中身が分かる文言で、ファイルの複製と読める語を使わない（d735）', () => {
    renderToolbar();
    // 行のチェック＝選ぶ、フォルダへドラッグ＝移す、クリップボード＝パスをコピー。同じ「コピー」でも
    // 対象（パス）を文言に含め、ファイル複製（コピー元→コピー先）と取り違えない。
    const clip = screen.getByRole('button', { name: 'パスをコピー' });
    expect(clip).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'クリップボード' })).toBeNull();
    expect(screen.queryByRole('button', { name: /コピー元|コピー先|ここへコピー/ })).toBeNull();
  });

  it('削除は破壊操作の見た目（右端グループの末尾）', () => {
    renderToolbar();
    const del = screen.getByRole('button', { name: '削除' });
    expect(del).toHaveClass('file-tb-btn-danger');
  });
});
