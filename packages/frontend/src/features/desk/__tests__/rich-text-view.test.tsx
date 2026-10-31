import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { RichTextView } from '../components/rich-text-view';

const { push, setSpace } = vi.hoisted(() => ({ push: vi.fn(), setSpace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('../hooks/desk-space-context', () => ({
  useDeskSpace: () => ({ setSelectedSpaceId: setSpace }),
}));
const fetchFileRefs = vi.fn();
vi.mock('@/features/files/lib/api', () => ({
  fetchFileRefs: (ids: string[]) => fetchFileRefs(ids),
}));

const REF = (id: string, label: string) =>
  `<span data-type="file-ref" data-id="${id}" data-label="${label}">${label}</span>`;

beforeEach(() => {
  fetchFileRefs.mockReset();
  fetchFileRefs.mockResolvedValue([]);
});

describe('RichTextView 参照の再描画', () => {
  it('DOMParserのないSSRからhydrateしても初期HTMLが食い違わない', async () => {
    const html = `<p>${REF('missing', '元の資料')}</p>`;
    const parser = globalThis.DOMParser;
    let serverHtml: string;
    try {
      vi.stubGlobal('DOMParser', undefined);
      serverHtml = renderToString(<RichTextView html={html} />);
    } finally {
      vi.stubGlobal('DOMParser', parser);
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = document.createElement('div');
    host.innerHTML = serverHtml;
    document.body.append(host);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(host, <RichTextView html={html} />);
      });
      expect(host.textContent).toBe('元の資料（表示できません）');
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/hydration|hydrated|didn't match/i);
    } finally {
      await act(async () => root?.unmount());
      host.remove();
      errors.mockRestore();
    }
  });

  it('検索語を変更・解除しても現在のパスと非可視参照の文言を維持する', async () => {
    fetchFileRefs.mockResolvedValue([{ id: 'f1', path: '現在 ＞ a.md' }]);
    const html = `<p>本文 ${REF('f1', '旧 ＞ a.md')} ${REF('f2', '非可視')}</p>`;
    const view = render(<RichTextView html={html} />);
    await waitFor(() =>
      expect(view.container.querySelector('[data-id="f1"]')?.textContent).toBe('現在 ＞ a.md'),
    );
    for (const highlight of ['本文', '旧', '']) {
      view.rerender(<RichTextView html={html} highlight={highlight} />);
      expect(view.container.querySelector('[data-id="f1"]')?.textContent).toBe('現在 ＞ a.md');
      expect(view.container.querySelector('[data-id="f2"]')?.textContent).toBe(
        '非可視（表示できません）',
      );
    }
    expect(fetchFileRefs).toHaveBeenCalledTimes(1);
  });

  it('StrictModeでeffectを再実行しても解決結果を表示する', async () => {
    fetchFileRefs.mockResolvedValue([{ id: 'f1', path: '現在 ＞ a.md' }]);
    const view = render(
      <StrictMode>
        <RichTextView html={`<p>${REF('f1', '旧 ＞ a.md')}</p>`} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(view.container.querySelector('[data-id="f1"]')?.textContent).toBe('現在 ＞ a.md'),
    );
  });

  it('本文切替中に前の解決結果や取消した応答を使わない', async () => {
    let resolveOld!: (items: { id: string; path: string }[]) => void;
    fetchFileRefs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    fetchFileRefs.mockResolvedValueOnce([]);
    const view = render(<RichTextView html={`<p>前 ${REF('f1', '旧')}</p>`} />);
    view.rerender(<RichTextView html={`<p>後 ${REF('f1', '後')}</p>`} />);
    await waitFor(() => expect(fetchFileRefs).toHaveBeenCalledTimes(2));
    resolveOld([{ id: 'f1', path: '前の解決結果' }]);
    await waitFor(() =>
      expect(view.container.querySelector('[data-id="f1"]')?.textContent).toBe(
        '後（表示できません）',
      ),
    );
  });

  it('一度離れた本文へ戻っても取得済みの古いパスを再利用しない', async () => {
    fetchFileRefs.mockResolvedValueOnce([{ id: 'f1', path: '失効前のパス' }]);
    const html = `<p>${REF('f1', '挿入時')}</p>`;
    const view = render(<RichTextView html={html} />);
    await waitFor(() => expect(view.container.textContent).toBe('失効前のパス'));
    view.rerender(<RichTextView html="<p>参照なし</p>" />);
    let resolveNew!: (items: { id: string; path: string }[]) => void;
    fetchFileRefs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    );
    view.rerender(<RichTextView html={html} />);
    expect(view.container.textContent).toBe('挿入時（表示できません）');
    resolveNew([]);
    await waitFor(() => expect(view.container.textContent).toBe('挿入時（表示できません）'));
  });
});

describe('RichTextView', () => {
  it('sanitize した HTML を描画する（script は除去）', () => {
    const { container } = render(
      <RichTextView html="<p><strong>hi</strong></p><script>alert(1)</script>" />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('strong')).not.toBeNull();
    expect(container.textContent).toContain('hi');
  });

  it('空 / null は何も描画しない', () => {
    const { container } = render(<RichTextView html={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('className を反映する', () => {
    const { container } = render(
      <RichTextView html="<p>x</p>" className="desk-thread-head-body" />,
    );
    expect((container.firstChild as HTMLElement)?.className).toContain('desk-thread-head-body');
  });

  it('highlight 指定時に本文の一致箇所を mark.sp-search-hl で包む（rete-desk-0048）', () => {
    const { container } = render(<RichTextView html="<p>在庫の確認</p>" highlight="在庫" />);
    const mark = container.querySelector('mark.sp-search-hl');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('在庫');
    expect(container.textContent).toBe('在庫の確認'); // テキスト全体は不変
  });

  it('highlight 未指定なら mark を挿入しない', () => {
    const { container } = render(<RichTextView html="<p>在庫の確認</p>" />);
    expect(container.querySelector('mark.sp-search-hl')).toBeNull();
  });

  it('描き直し（再マウント）のたびに引き直す（失効した参照が古いパス表示のまま残らない・§5.4）', async () => {
    fetchFileRefs.mockResolvedValueOnce([{ id: 'f1', path: '見える ＞ a.md' }]);
    const html = `<p>${REF('f1', '旧 ＞ a.md')}</p>`;
    const { container, unmount } = render(<RichTextView html={html} />);
    await waitFor(() =>
      expect(container.querySelector('[data-id="f1"]')?.textContent).toBe('見える ＞ a.md'),
    );
    unmount();

    // 参照先が非可視 Space へ移った（失効）＝解決 API から返らなくなる。開き直すと引き直す。
    fetchFileRefs.mockResolvedValueOnce([]);
    const second = render(<RichTextView html={html} />);
    await waitFor(() => expect(fetchFileRefs).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(second.container.querySelector('[data-id="f1"]')?.textContent).toBe(
        '旧 ＞ a.md（表示できません）',
      ),
    );
  });

  it('参照を含まない本文は解決 API を呼ばない（FL+2）', () => {
    render(<RichTextView html="<p>ただの本文</p>" />);
    expect(fetchFileRefs).not.toHaveBeenCalled();
  });

  it('参照を 1 本文 1 リクエストで解決し、現在のパス表記を出す（FL+2）', async () => {
    fetchFileRefs.mockResolvedValue([{ id: 'f1', path: '新フォルダ ＞ a.md' }]);
    const { container } = render(
      <RichTextView
        html={`<p>資料 ${REF('f1', '旧 ＞ a.md')} と ${REF('d1', '旧フォルダ')}</p>`}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-id="f1"]')?.textContent).toBe('新フォルダ ＞ a.md'),
    );
    expect(fetchFileRefs).toHaveBeenCalledTimes(1);
    expect(fetchFileRefs).toHaveBeenCalledWith(['f1', 'd1']);
    // 解決できなかった参照は統一文言（§5.1）。
    expect(container.querySelector('[data-id="d1"]')?.textContent).toBe(
      '旧フォルダ（表示できません）',
    );
    // 参照ノード自体（data-type / data-id）は残り、遷移や別要素は足していない。
    expect(container.querySelector('[data-id="f1"]')?.getAttribute('data-type')).toBe('file-ref');
  });

  it('highlight 指定時も参照の置換が勝手に消えない（描画後に置換する）', async () => {
    fetchFileRefs.mockResolvedValue([{ id: 'f1', path: '在庫フォルダ ＞ a.md' }]);
    const { container } = render(
      <RichTextView html={`<p>在庫 ${REF('f1', '旧 ＞ a.md')}</p>`} highlight="在庫" />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-id="f1"]')?.textContent).toBe('在庫フォルダ ＞ a.md'),
    );
    expect(container.querySelector('mark.sp-search-hl')).not.toBeNull();
  });

  it('解決 API が失敗しても本文を壊さず、参照は（表示できません）で残す', async () => {
    fetchFileRefs.mockRejectedValue(new Error('network'));
    const { container } = render(<RichTextView html={`<p>${REF('f1', '旧 ＞ a.md')}</p>`} />);
    await waitFor(() =>
      expect(container.querySelector('[data-id="f1"]')?.textContent).toBe(
        '旧 ＞ a.md（表示できません）',
      ),
    );
  });
});

const SPACE = '00000000-0000-4000-b000-000000000013';
describe('RichTextView 構造参照の遷移', () => {
  it.each(['click', 'Enter'])('%s で対象 Space を先に選び、ファイルを開く', async (action) => {
    fetchFileRefs.mockResolvedValue([
      { id: 'f1', kind: 'file', path: '現在 ＞ a.md', parentFolderId: 'parent', spaceId: SPACE },
    ]);
    const view = render(<RichTextView html={REF('f1', '旧')} />);
    const link = await view.findByRole('link', { name: '現在 ＞ a.md' });
    expect(link.tabIndex).toBe(0);
    if (action === 'click') fireEvent.click(link);
    else fireEvent.keyDown(link, { key: 'Enter' });
    expect(setSpace).toHaveBeenCalledWith(SPACE);
    expect(push).toHaveBeenCalledWith(`/files?folderId=parent&fileId=f1&spaceId=${SPACE}`);
    expect(setSpace.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
  });

  it('フォルダは自身の id を渡し、fileId を付けずに開く', async () => {
    fetchFileRefs.mockResolvedValue([
      { id: 'd1', kind: 'folder', path: '資料', parentFolderId: null, spaceId: SPACE },
    ]);
    const view = render(<RichTextView html={REF('d1', '旧')} />);
    const link = await view.findByRole('link');
    fireEvent.keyDown(link, { key: ' ' });
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(push).toHaveBeenCalledWith(`/files?folderId=d1&spaceId=${SPACE}`);
  });

  it('未解決・取得中はロールもフォーカスも遷移も与えず、貼付けの親リンクを解除する', async () => {
    const view = render(
      <RichTextView html={`<a href="https://example.com">${REF('missing', '元の資料')}</a>`} />,
    );
    await waitFor(() => expect(view.container.textContent).toBe('元の資料（表示できません）'));
    const node = view.container.querySelector('[data-id="missing"]')!;
    expect(view.queryByRole('link')).toBeNull();
    expect(node.hasAttribute('tabindex')).toBe(false);
    expect(view.container.querySelector('a')).toBeNull();
    fireEvent.click(node);
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(push).not.toHaveBeenCalled();
    expect(setSpace).not.toHaveBeenCalled();
  });

  it('未解決参照を同じ本文で再描画しても貼付けリンクや元の表記へ戻さない', async () => {
    fetchFileRefs.mockRejectedValue(new Error('取得失敗'));
    const html = `<a href="https://example.com">${REF('missing', '元の資料')}</a>`;
    const view = render(<RichTextView html={html} />);
    await waitFor(() => expect(fetchFileRefs).toHaveBeenCalledTimes(1));
    for (const highlight of [undefined, '資料', undefined]) {
      view.rerender(<RichTextView html={html} highlight={highlight} />);
      expect(view.container.textContent).toBe('元の資料（表示できません）');
      expect(view.container.querySelector('a, [role="link"], [tabindex]')).toBeNull();
    }
    expect(fetchFileRefs).toHaveBeenCalledTimes(1);
  });

  it('参照自身が a 要素でも元の URL ではなく解決先へ遷移する', async () => {
    fetchFileRefs.mockResolvedValue([
      { id: 'f1', kind: 'file', path: '現在', parentFolderId: 'parent', spaceId: SPACE },
    ]);
    const view = render(
      <RichTextView html='<a data-type="file-ref" data-id="f1" data-label="旧" href="https://example.com">旧</a>' />,
    );
    fireEvent.click(await view.findByRole('link', { name: '現在' }));
    expect(view.container.querySelector('a')).toBeNull();
    expect(push).toHaveBeenCalledWith(`/files?folderId=parent&fileId=f1&spaceId=${SPACE}`);
  });

  it('本文変更で失効した参照のクリック状態を捨てる', async () => {
    fetchFileRefs.mockResolvedValueOnce([
      { id: 'f1', kind: 'file', path: '現在', parentFolderId: 'parent', spaceId: SPACE },
    ]);
    const view = render(<RichTextView html={REF('f1', '旧')} />);
    await view.findByRole('link');
    view.rerender(<RichTextView html={`<p>変更 ${REF('f1', '旧')}</p>`} />);
    expect(view.queryByRole('link')).toBeNull();
    fireEvent.click(view.container.querySelector('[data-id="f1"]')!);
    expect(push).not.toHaveBeenCalled();
  });
});
