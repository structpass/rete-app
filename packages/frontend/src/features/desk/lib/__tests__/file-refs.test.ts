import { describe, it, expect } from 'vitest';
import {
  extractFileRefs,
  hasFileRefs,
  applyFileRefResolutions,
  unresolvedFileRefLabel,
} from '../file-refs';

const REF = (id: string, label: string) =>
  `<span data-type="file-ref" data-id="${id}" data-label="${label}">${label}</span>`;

describe('file-refs（FL+2 描画時解決の純関数）', () => {
  it('参照ノードの id と挿入時の表記を出現順・重複なしで拾う', () => {
    const html =
      '<p>a</p>' +
      REF('f1', '見積 &gt; a.md') +
      '<p>b</p>' +
      REF('d1', '見積') +
      REF('f1', '見積 &gt; a.md');
    expect(extractFileRefs(html)).toEqual([
      { id: 'f1', label: '見積 > a.md' },
      { id: 'd1', label: '見積' },
    ]);
  });

  it('参照を含まない本文は parse せず空を返す（大多数の本文で呼び出しコストを持たない）', () => {
    expect(extractFileRefs('<p>ただの本文</p>')).toEqual([]);
    expect(extractFileRefs(null)).toEqual([]);
    expect(extractFileRefs('')).toEqual([]);
  });

  it('参照を含むかどうかを HTML 文字列から判定できる', () => {
    expect(hasFileRefs(`<p>${REF('f1', 'x')}</p>`)).toBe(true);
    expect(hasFileRefs('<p>ただの本文</p>')).toBe(false);
    expect(hasFileRefs(null)).toBe(false);
  });

  it('解決できた参照は現在のパス表記に差し替わる（移動・改名に追従）', () => {
    const html = `<p>資料 ${REF('f1', '旧 &gt; 見積 &gt; a.md')} です</p>`;
    // 解決結果の path はプレーンテキスト（DTO の文字列）。HTML として扱わず textContent にだけ入る。
    const out = applyFileRefResolutions(html, new Map([['f1', { path: '新 ＞ a.md' }]]));
    const doc = new DOMParser().parseFromString(out, 'text/html');
    expect(doc.body.textContent).toBe('資料 新 ＞ a.md です');
    expect(doc.querySelector('[data-id="f1"]')?.textContent).toBe('新 ＞ a.md');
    // 元の HTML は書き換えない（保存 HTML は動かさない・設計 §2.2）。
    expect(html).toContain('旧 &gt; 見積 &gt; a.md');
  });

  it('解決できない参照は「挿入時の表記（表示できません）」になる（削除・権限の語を出さない）', () => {
    const html = `<p>${REF('gone', '見積 &gt; 消えた.md')}</p>`;
    const out = applyFileRefResolutions(html, new Map());
    expect(out).toContain('見積 &gt; 消えた.md（表示できません）');
    expect(out).not.toContain('削除');
    expect(out).not.toContain('権限');
    expect(unresolvedFileRefLabel('x')).toBe('x（表示できません）');
  });

  it('解決結果の文字列は HTML として解釈しない（参照の中身としてのみ入る）', () => {
    const html = `<p>${REF('f1', 'x')}</p>`;
    const out = applyFileRefResolutions(html, new Map([['f1', { path: '<img src=x onerror=1>' }]]));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=1&gt;');
  });

  it('参照を含まない本文はそのまま返す', () => {
    const html = '<p>ただの本文</p>';
    expect(applyFileRefResolutions(html, new Map([['f1', { path: 'p' }]]))).toBe(html);
  });
});
