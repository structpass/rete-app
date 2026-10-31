import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormLabel } from '../form';

describe('FormLabel（正本 comp-form-field の必須バッジ）', () => {
  it('required で「* 必須」を label の外に出す（アクセシブル名は不変）', () => {
    render(
      <>
        <FormLabel htmlFor="name" required>
          グループ名
        </FormLabel>
        <input id="name" aria-required="true" />
      </>,
    );
    // label のテキストは変更しない＝読み上げ名に「* 必須」が混ざらない（label 要素の文字列そのものを見る）。
    const label = document.querySelector('label[for="name"]');
    expect(label?.textContent?.trim()).toBe('グループ名');
    expect(screen.getByLabelText('グループ名')).toHaveAttribute('aria-required', 'true');
    const mark = document.querySelector('.sp-required-mark');
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark?.textContent?.replace(/\s+/g, '')).toBe('*必須');
    // マークは label の内側に入れない（読み上げ名が変わってしまう）。
    expect(label?.contains(mark!)).toBe(false);
  });

  it('required 未指定ではマークを出さない', () => {
    render(<FormLabel htmlFor="name">グループ名</FormLabel>);
    expect(document.querySelector('.sp-required-mark')).toBeNull();
  });
});
