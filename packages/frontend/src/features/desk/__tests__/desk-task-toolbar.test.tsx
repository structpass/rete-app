import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeskTaskToolbar } from '../components/desk-task-toolbar';

const renderToolbar = (props: Partial<Parameters<typeof DeskTaskToolbar>[0]> = {}) =>
  render(<DeskTaskToolbar onCreate={vi.fn()} onOpenCategorySettings={vi.fn()} {...props} />);

// タスク明細の新規登録ツールバー。C-新規（ticket 0031）で onCreate に配線済み。
describe('DeskTaskToolbar', () => {
  it('新規登録ボタンは操作可能（aria-disabled なし）であること', () => {
    renderToolbar();
    const btn = screen.getByRole('button', { name: '新規登録' });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn).not.toHaveAttribute('tabindex', '-1');
  });

  it('新規登録ボタン押下で onCreate を呼ぶこと', () => {
    const onCreate = vi.fn();
    renderToolbar({ onCreate });
    fireEvent.click(screen.getByRole('button', { name: '新規登録' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  // 分類設定ボタン（rete-desk-0140）。新規登録の左隣に置き、分類マスタ設定モーダルを開く。
  it('分類設定ボタン押下で onOpenCategorySettings を呼ぶこと', () => {
    const onOpenCategorySettings = vi.fn();
    renderToolbar({ onOpenCategorySettings });
    fireEvent.click(screen.getByRole('button', { name: '分類設定' }));
    expect(onOpenCategorySettings).toHaveBeenCalledTimes(1);
  });

  it('分類設定ボタンは新規登録ボタンの左（DOM 順で前）にあること', () => {
    renderToolbar();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['分類設定', '新規登録']);
  });

  // d1273: 行とボタンは一覧共通部品。Desk だけ別寸法（1.75rem / 0.75rem / 600）だったのを
  // File・Home と同じ透明系の共通寸法（.sp-action-btn）へ揃えた。
  it('表直上のアクション行として共通クラスで組む（d1273・Desk と他の一覧で寸法を揃える）', () => {
    const { container } = renderToolbar();
    const row = container.querySelector('.sp-list-action-row');
    expect(row).not.toBeNull();
    // 右寄せグループの中にボタンが 2 つ入る＝行の外へはみ出さない。
    const group = row!.querySelector('.sp-list-action-row-actions');
    expect(group).not.toBeNull();
    expect(group!.querySelectorAll('button')).toHaveLength(2);
    for (const btn of screen.getAllByRole('button')) {
      expect(btn).toHaveClass('sp-action-btn');
      // 旧 .desk-task-new-btn の独自寸法（1.75rem / weight 600）を復活させない。
      expect(btn.className).not.toContain('desk-task-new-btn');
    }
  });
});
