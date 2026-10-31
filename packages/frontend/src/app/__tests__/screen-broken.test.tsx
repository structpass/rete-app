import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ErrorScreen from '../error';
import GlobalError from '../global-error';

/**
 * 壊れた画面の表示（d785）。
 *
 * 実測 2026-10-25: 画面が本文ほぼ空のまま残り、利用者には「まだ読み込み中」と見分けが付かない状態が
 * 見逃された。ここでは「壊れていると分かる」「もう一度表示する手段が在る」「原因を後から辿れる」
 * の 3 点を、画面の組み立て中の受け皿（error.tsx）と最後の受け皿（global-error.tsx）の両方で固定する。
 */
const BROKEN = new Error('描画できませんでした') as Error & { digest?: string };

/** Next.js が渡す形（digest 付きの例外）を、その場で作る（Error は拡張不可のことがある）。 */
function errorWithDigest(message: string, digest: string): Error & { digest?: string } {
  return { name: 'Error', message, digest } as Error & { digest?: string };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('壊れた画面の表示（d785）', () => {
  it('組み立て中の受け皿は「壊れている」と示し、押し直しで作り直す', async () => {
    const reset = vi.fn();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorScreen error={BROKEN} reset={reset} />);

    expect(screen.getByRole('alert')).toHaveAttribute('data-screen-broken', 'true');
    expect(screen.getByRole('heading', { name: 'この画面は壊れています' })).toBeInTheDocument();
    // 例外の内容（内部の情報）は本文に出さない
    expect(screen.queryByText(/描画できませんでした/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'もう一度表示する' }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
  });

  it('識別子（digest）が在る時だけ、原因を照合できるよう本文へ出す', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const withDigest = errorWithDigest('x', 'abc123');
    const { rerender } = render(<ErrorScreen error={BROKEN} reset={() => undefined} />);
    expect(document.querySelector('[data-screen-broken-digest]')).toBeNull();

    rerender(<ErrorScreen error={withDigest} reset={() => undefined} />);
    expect(document.querySelector('[data-screen-broken-digest]')).toHaveTextContent('abc123');
  });

  it('記録は、画面の道筋と例外の中身を 1 組でコンソールへ残す', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const withDigest = errorWithDigest('落ちた理由', 'zzz');
    render(<ErrorScreen error={withDigest} reset={() => undefined} />);

    const [label, detail] = logged.mock.calls[0] as [string, Record<string, string>];
    expect(label).toBe('[画面が壊れました]');
    expect(detail).toMatchObject({ message: '落ちた理由', digest: 'zzz' });
    expect(detail.path).toBe(window.location.pathname);
  });

  it('最後の受け皿（根の表示が落ちた時）も同じ見た目と文言で、骨組みから描き直す', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(<GlobalError error={BROKEN} reset={() => undefined} />);
    const alert = container.querySelector('[data-screen-broken="true"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent('この画面は壊れています');
    // 骨組みごと描き直す（描き上がりには html・body が在る。html はブラウザの骨組みが既に在るため
    // 容器の子にはならない＝React が既存の html へ当てる）。通常の画面と違い画面側の枠（app-shell）を
    // 通らないため、壊れた表示だけが残る。
    expect(document.documentElement).not.toBeNull();
    expect(container.querySelector('.app-shell')).toBeNull();
  });
});
