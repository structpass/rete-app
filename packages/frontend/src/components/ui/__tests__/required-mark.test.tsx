import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { RequiredMark } from '../required-mark';

describe('RequiredMark（必須マークの共通部品・d687）', () => {
  it('「* 必須」を装飾として出す（読み上げの対象にしない）', () => {
    render(
      <label>
        タイトル
        <RequiredMark />
      </label>,
    );
    const mark = document.querySelector('.sp-required-mark');
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark?.textContent?.replace(/\s+/g, '')).toBe('*必須');
    expect(mark?.querySelector('.sp-required-star')).not.toBeNull();
  });

  it('ラベルの外に置けば、入力の読み上げ名を変えない', () => {
    const { container } = render(
      <div className="fo-field">
        <span className="fo-label">
          タイトル
          <RequiredMark />
        </span>
        <input type="text" aria-label="タイトル" aria-required="true" />
      </div>,
    );
    // 入力の名前は「タイトル」のまま（マークは aria-hidden なので混ざらない）
    expect(screen.getByLabelText('タイトル')).toHaveAttribute('aria-required', 'true');
    expect(container.querySelector('input')?.getAttribute('aria-label')).toBe('タイトル');
  });

  it('ファイルの共有・アップロード設定の画面は、手組みの複製ではなく共通部品を使う', () => {
    // __dirname は src/components/ui/__tests__ → 3 つ上が src
    const root = join(__dirname, '../../../features/files/components');
    for (const name of ['send-overlay.tsx', 'settings-overlay.tsx']) {
      const src = readFileSync(join(root, name), 'utf8');
      expect(src, `${name} は RequiredMark を使う`).toContain('<RequiredMark />');
      // class 名の手組みが残ると、見た目の正本が 2 つに割れる
      expect(src, `${name} に手組みの複製を残さない`).not.toContain('sp-required-star');
    }
  });
});
