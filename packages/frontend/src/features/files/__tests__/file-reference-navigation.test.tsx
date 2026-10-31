import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useDeskSpace } from '@/features/desk/hooks/desk-space-context';

const { browser } = vi.hoisted(() => ({ browser: vi.fn() }));
vi.mock('../components/files-shell', () => ({
  FilesShell: () => <output>{useDeskSpace().selectedSpaceId}</output>,
}));
vi.mock('../components/files-sidebar', () => ({ FilesSidebar: () => null }));
vi.mock('@/features/shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../hooks/use-file-browser', () => ({
  useFileBrowser: (...args: unknown[]) => {
    browser(...args);
    return {};
  },
}));
vi.mock('../hooks/use-file-edit-link', () => ({ useFileEditLink: vi.fn() }));
vi.mock('../hooks/use-file-id-from-location', () => ({ useFileIdFromLocation: () => null }));
import Page from '@/app/files/page';

const SPACE = '00000000-0000-4000-b000-000000000013';
beforeEach(() => window.localStorage.clear());
describe('構造参照の Files 遷移先', () => {
  it('保存領域なしでも指定 Space とフォルダを別 Provider へ引き継ぐ', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    const view = render(
      await Page({
        searchParams: Promise.resolve({ spaceId: SPACE, folderId: 'folder', fileId: 'file' }),
      }),
    );
    await waitFor(() => expect(view.container.textContent).toBe(SPACE));
    expect(browser).toHaveBeenLastCalledWith(SPACE, 'folder');
  });

  it('同じ Files 画面の別フォルダ遷移で状態を作り直す', async () => {
    const first = await Page({
      searchParams: Promise.resolve({ spaceId: SPACE, folderId: 'first' }),
    });
    const view = render(first);
    const second = await Page({
      searchParams: Promise.resolve({ spaceId: SPACE, folderId: 'second' }),
    });
    expect(second.key).not.toBe(first.key);
    browser.mockClear();
    view.rerender(second);
    expect(browser).toHaveBeenCalledWith(null, 'second');
    await waitFor(() => expect(browser).toHaveBeenLastCalledWith(SPACE, 'second'));
  });

  it('不正な Space の入力を一覧へ渡さない', async () => {
    render(
      await Page({ searchParams: Promise.resolve({ spaceId: 'invalid', folderId: 'folder' }) }),
    );
    await waitFor(() => expect(browser).toHaveBeenCalled());
    expect(browser.mock.calls.some(([space]) => space === 'invalid')).toBe(false);
  });
});
