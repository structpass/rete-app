import { sanitizeRichText } from './sanitize';

/**
 * 保存時 sanitize（ADR 0019・多層防御の保存側）。XSS ベクタが DB に入らないこと、
 * 許可書式が保たれること、リンクが安全化されることを検証する。
 */
describe('sanitizeRichText', () => {
  it('discarded iframe fallback is bounded while ordinary rich text remains intact', () => {
    expect(() => sanitizeRichText('<iframe>'.repeat(2500))).not.toThrow();
    expect(sanitizeRichText('<p><strong>本文</strong></p>')).toBe('<p><strong>本文</strong></p>');
  });
  it('null / undefined / 空はそのまま素通しする', () => {
    expect(sanitizeRichText(null)).toBeNull();
    expect(sanitizeRichText(undefined)).toBeUndefined();
    expect(sanitizeRichText('')).toBe('');
  });

  it('<script> を除去する', () => {
    const out = sanitizeRichText('<p>hi</p><script>alert(1)</script>');
    expect(out).toContain('<p>hi</p>');
    expect(out).not.toContain('<script>');
  });

  it('on* イベントハンドラ属性を除去する', () => {
    const out = sanitizeRichText('<p onclick="alert(1)">x</p>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('x');
  });

  it('許可書式（strong / em / ul / a）は保持する', () => {
    const out = sanitizeRichText('<p><strong>b</strong> <em>i</em></p><ul><li>x</li></ul>');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<em>i</em>');
    expect(out).toContain('<li>x</li>');
  });

  it('リンクの javascript: スキームを剥がし rel/target を強制する', () => {
    const out = sanitizeRichText('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it('安全な http リンクは href を保持しつつ rel/target を付与する', () => {
    const out = sanitizeRichText('<a href="https://example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('img タグ（許可外）を除去する', () => {
    const out = sanitizeRichText('<p>x</p><img src="x" onerror="alert(1)">');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror');
  });

  it('style 値の危険プロパティ（background:url / expression / behavior）を除去する', () => {
    const out = sanitizeRichText(
      '<span style="background:url(javascript:alert(1));color:#fff;behavior:url(x.htc)">x</span>',
    );
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('background');
    expect(out).not.toContain('behavior');
    // 安全な color は保持される
    expect(out).toContain('color:#fff');
  });

  it('Tiptap Color / Highlight が出力する color / background-color は保持する', () => {
    const out = sanitizeRichText(
      '<span style="color:#1a9c8b">x</span><mark style="background-color:rgb(255, 235, 0)">y</mark>',
    );
    expect(out).toContain('color:#1a9c8b');
    expect(out).toContain('background-color:rgb(255, 235, 0)');
  });
});
