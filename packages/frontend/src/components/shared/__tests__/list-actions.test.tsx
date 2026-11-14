import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActionButton, ListActionRow } from '../list-actions';

/**
 * 表右上アクションの共通部品（d1273）。
 * 設定タブの primitives から移した部品で、Desk・File・Home の表右上もこれを使う。
 * 見た目（透明地・寸法・4px）は CSS（.sp-action-btn / .sp-list-action-row）が持ち、
 * ここでは「どのクラスで組むか」と「ボタンが 0 個でも行が残る」ことを固定する。
 */
describe('ListActionRow / ActionButton（表右上アクションの共通部品・d1273）', () => {
  it('行は共通クラスで組み、右寄せグループを内側に持つ（レイアウト値をコードへ書かない）', () => {
    const { container } = render(
      <ListActionRow>
        <ActionButton ariaLabel="新規登録">新規登録</ActionButton>
      </ListActionRow>,
    );
    const row = container.querySelector('.sp-list-action-row');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.sp-list-action-row-actions')).not.toBeNull();
    // 高さ・右寄せ・間隔は CSS 側（globals.css の .sp-list-action-row）。style 属性で持ち込まない。
    expect(row!.getAttribute('style')).toBeNull();
  });

  it('ボタンが 0 個でも行は描画する（権限でボタンが消えても表の開始位置を動かさない）', () => {
    const { container } = render(<ListActionRow>{null}</ListActionRow>);
    expect(container.querySelector('.sp-list-action-row')).not.toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('ボタンは sp-action-btn（透明系の共通寸法）で組む＝画面ごとに寸法を書き分けない', () => {
    render(<ActionButton ariaLabel="新規登録">新規登録</ActionButton>);
    const btn = screen.getByRole('button', { name: '新規登録' });
    expect(btn).toHaveClass('sp-action-btn');
    // 高さ・文字サイズ・太さは共通クラスが持つ。呼び出し側のクラスで上書きしない。
    expect(btn.className).not.toMatch(/h-\d|text-\[|font-(bold|semibold)/);
  });

  it('危険操作は is-danger、icon-only は正方形化のクラスを足す', () => {
    const { rerender } = render(
      <ActionButton ariaLabel="解除" danger>
        解除
      </ActionButton>,
    );
    expect(screen.getByRole('button', { name: '解除' })).toHaveClass('is-danger');
    rerender(
      <ActionButton ariaLabel="解除" iconOnly danger>
        解除
      </ActionButton>,
    );
    expect(screen.getByRole('button', { name: '解除' })).toHaveClass('sp-action-btn--icon-only');
  });

  it('loading 中はスピナーを前置し押下を抑止する（二重送信防止）', () => {
    const onClick = vi.fn();
    render(
      <ActionButton ariaLabel="保存" loading onClick={onClick}>
        保存
      </ActionButton>,
    );
    const btn = screen.getByRole('button', { name: '保存' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
