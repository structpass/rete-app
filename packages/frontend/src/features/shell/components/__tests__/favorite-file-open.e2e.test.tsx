import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { FavoriteDto } from '@rete/shared';
import type { UseFileBrowserResult } from '@/features/files/hooks/use-file-browser';

// d560 の端から端: Home のサイドバーで★を押した時、File 画面（本物の URL 読み取りと編集導線）が
// 編集画面を開くか。同じ URL への押し直しは Next が遷移を取り消す（URL も履歴も変わらない）ため、
// URL の変化だけでは伝わらず、押された対象を直接受け取る経路が効いていることを確かめる。
// 画面とサイドバーを同居させ、本物の合図・本物の URL 監視を通す（個別の部品はモックしない）。
const { push, fetchFileMeta, openEdit, selectFolder, fetchTenantInfo } = vi.hoisted(() => ({
  push: vi.fn(),
  fetchFileMeta: vi.fn(),
  openEdit: vi.fn(),
  selectFolder: vi.fn(),
  // テナント情報（画面上部のバッジ）は本題に無関係。実 API を叩かないよう失敗で固定する。
  fetchTenantInfo: vi.fn(),
}));
vi.mock('@/features/settings/lib/api', () => ({
  fetchTenantInfo: (...a: unknown[]) => fetchTenantInfo(...a),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/hub',
}));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/features/auth', () => ({
  useSessionContext: () => ({ user: { role: 'USER' }, menuItems: [] }),
}));
vi.mock('@/features/files/lib/api', () => ({
  fetchFileMeta: (...a: unknown[]) => fetchFileMeta(...a),
}));
vi.mock('@/features/files/hooks/use-file-overlays', () => ({
  useFileOverlays: () => ({
    overlay: null,
    openSettings: vi.fn(),
    openTagMaster: vi.fn(),
    openEdit,
  }),
}));
vi.mock('@/features/files/hooks/use-file-browser', () => ({
  useFileBrowser: () =>
    ({
      spaceId: 'space-1',
      currentFolderId: null,
      currentTree: [],
      currentFolder: null,
      treeLoading: false,
      treeError: false,
      treeErrorStatus: null,
      folderLoading: false,
      folderError: false,
      dndDisabled: false,
      selectFolder,
      refreshFolder: vi.fn(),
      moveFolderTo: vi.fn(),
      moveFileTo: vi.fn(),
      reloadAll: vi.fn(),
    }) satisfies UseFileBrowserResult,
}));
vi.mock('@/features/files/components/files-shell', () => ({ FilesShell: () => null }));
vi.mock('@/features/files/components/files-sidebar', () => ({ FilesSidebar: () => null }));

let items: FavoriteDto[] = [];
vi.mock('@/features/shell/hooks/favorites-context', async (importOriginal) => {
  // Provider は本物のまま（配下の部品が本物の Provider を要求する）。中身の取得結果だけ固定する。
  const actual = await importOriginal<typeof import('@/features/shell/hooks/favorites-context')>();
  const favorites = () => ({
    items,
    loading: false,
    error: null,
    refetch: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
  });
  return {
    ...actual,
    useFavoritesContext: favorites,
    useOptionalFavoritesContext: favorites,
  };
});
// Provider の内部で使う取得そのものを固定する（実ネットワークを叩かない・実画面と同じ配線で確かめる）。
vi.mock('@/features/shell/hooks/use-favorites', () => ({
  useFavorites: () => ({
    items,
    loading: false,
    error: null,
    refetch: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
  }),
}));
// 通知系（未読カウント・タグマスタ・テナント）の Provider は本題に無関係なため素通しにする。
vi.mock('@/features/dashboard/hooks/announcement-unread-context', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/dashboard/hooks/announcement-unread-context')>();
  const passthrough = ({ children }: { children: React.ReactNode }) => children;
  return {
    ...actual,
    AnnouncementUnreadProvider: passthrough,
    useAnnouncementUnread: () => ({ unreadCount: 0 }),
  };
});
vi.mock('@/features/dashboard/hooks/announcement-tag-master-context', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/features/dashboard/hooks/announcement-tag-master-context')
    >();
  return {
    ...actual,
    AnnouncementTagMasterProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('@/features/shell/hooks/reference-reachable-context', async (importOriginal) => {
  // 本物の Provider はそのまま（画面上部の到達確認を動かし続ける）。値だけ「未確認」に固定する。
  const actual =
    await importOriginal<typeof import('@/features/shell/hooks/reference-reachable-context')>();
  return { ...actual, useReferenceReachableValue: () => undefined };
});
vi.mock('@/features/shell/hooks/use-reference-object-types', () => ({
  useReferenceObjectTypes: () => [],
}));
vi.mock('@/features/shell/components/favorites-manage-overlay', () => ({
  FavoritesManageOverlay: () => null,
}));

import { AppSidebar } from '@/features/shell/components/app-sidebar';
import { FilesView } from '@/features/files';
import { ReferenceReachableProvider } from '@/features/shell/hooks/reference-reachable-context';
import { FavoritesProvider } from '@/features/shell/hooks/favorites-context';

// 実画面の AppShell と同じ Provider 構成（到達確認・お気に入り）で、サイドバーと File 画面を同居させる。
// 通知系（未読カウント・タグマスタ・テナント）は本題に無関係なため provider は張らず、外側の部品も
// mount しない（この試験が見るのは★押下 → File 画面の編集導線まで）。
function renderBoth() {
  return render(
    <ReferenceReachableProvider value={true}>
      <FavoritesProvider>
        <AppSidebar />
        <FilesView initialFolderId={null} initialFileId={null} />
      </FavoritesProvider>
    </ReferenceReachableProvider>,
  );
}

function fileFav(id: string, label: string): FavoriteDto {
  return { id: `fav-${id}`, kind: 'file', targetRef: id, label, sortOrder: 0 } as FavoriteDto;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  push.mockReset();
  fetchFileMeta.mockReset();
  openEdit.mockReset();
  selectFolder.mockReset();
  fetchFileMeta.mockImplementation(async (id: string) => ({
    id,
    name: `${id}.docx`,
    folderId: 'folder-1',
    versionNo: 1,
  }));
  items = [];
  window.history.replaceState({}, '', '/hub');
  fetchTenantInfo.mockReset();
  fetchTenantInfo.mockRejectedValue(new Error('not mocked'));
});

describe('お気に入り★ → File 画面の編集導線（d560 端から端）', () => {
  it('★を押すと編集画面が開く（初回）', async () => {
    items = [fileFav('file-a', '資料A')];
    renderBoth();
    fireEvent.click(screen.getByText('資料A'));
    // 押下時点では File 画面がまだ遷移先の URL を見ていない（画面が無い時間）ため、
    // この合図は捨て、遷移先の URL から解決する（実画面と同じ順序）。
    expect(fetchFileMeta).not.toHaveBeenCalled();
    act(() => {
      window.history.pushState({}, '', '/files?fileId=file-a');
    });
    await waitFor(() =>
      expect(openEdit).toHaveBeenCalledWith({ id: 'file-a', name: 'file-a.docx', versionNo: 1 }),
    );
    expect(push).toHaveBeenCalledWith('/files?fileId=file-a');
  });

  it('同じ★を続けて押し直すと、URL が変わらなくても編集画面がもう一度開く', async () => {
    items = [fileFav('file-a', '資料A')];
    renderBoth();
    fireEvent.click(screen.getByText('資料A'));
    act(() => {
      window.history.pushState({}, '', '/files?fileId=file-a');
    });
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(1));
    await wait(20);

    // 編集画面を閉じ、同じ★を押し直す。Next は同じ URL へのpushを取り消す＝URL は変わらない。
    openEdit.mockClear();
    fireEvent.click(screen.getByText('資料A'));
    expect(window.location.search).toBe('?fileId=file-a');
    // 押された対象を直接受け取る経路で、同じ fileId をもう一度解決する。
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(fetchFileMeta).toHaveBeenCalledTimes(2);
  });

  it('A の★の後に B の★を押すと、B が開く（古い A が勝たない）', async () => {
    items = [fileFav('file-a', '資料A'), fileFav('file-b', '資料B')];
    renderBoth();
    fireEvent.click(screen.getByText('資料A'));
    act(() => {
      window.history.pushState({}, '', '/files?fileId=file-a');
    });
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(1));
    await wait(20);

    openEdit.mockClear();
    fireEvent.click(screen.getByText('資料B'));
    act(() => {
      window.history.pushState({}, '', '/files?fileId=file-b');
    });
    await waitFor(() =>
      expect(openEdit).toHaveBeenCalledWith({ id: 'file-b', name: 'file-b.docx', versionNo: 1 }),
    );
    const openedIds = openEdit.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(openedIds.at(-1)).toBe('file-b');
  });
});
