import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { FavoriteDto } from '@rete/shared';

// d560: Home のサイドバーでお気に入りファイル★を押した時、対象ファイルを File 画面へ直接伝えるかを
// 検証する（同じ URL への押し直しは Next が遷移を取り消すため、URL の変化だけでは伝わらない）。
const { push, dispatchSpy, route } = vi.hoisted(() => ({
  push: vi.fn(),
  dispatchSpy: vi.fn(),
  route: { pathname: '/hub' },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => route.pathname,
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));
vi.mock('@/features/auth', () => ({
  useSessionContext: () => ({ user: { role: 'USER' }, menuItems: [] }),
}));
vi.mock('@/features/dashboard', () => ({
  useAnnouncementUnread: () => ({ unreadCount: 0 }),
}));
vi.mock('@/features/files', () => ({
  unlockFileLink: (fileId: string) => dispatchSpy(fileId),
}));
vi.mock('../../hooks/reference-reachable-context', () => ({
  useReferenceReachableValue: () => undefined,
}));
vi.mock('../../hooks/use-reference-object-types', () => ({
  useReferenceObjectTypes: () => [],
}));

let items: FavoriteDto[] = [];
vi.mock('../../hooks/favorites-context', () => ({
  useFavoritesContext: () => ({
    items,
    loading: false,
    error: null,
    refetch: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
  }),
}));
vi.mock('../favorites-manage-overlay', () => ({ FavoritesManageOverlay: () => null }));

import { AppSidebar } from '../app-sidebar';

function fav(kind: FavoriteDto['kind'], targetRef: string, label: string): FavoriteDto {
  return { id: `${kind}-${targetRef}`, kind, targetRef, label, sortOrder: 0 } as FavoriteDto;
}

beforeEach(() => {
  push.mockReset();
  dispatchSpy.mockReset();
  items = [];
  route.pathname = '/hub';
});

describe('AppSidebar — お気に入りの押下（d560）', () => {
  // d880: カレンダーの導線が b2fe0726 の戻しで落ちていた。並び・遷移先・選択状態を固定する。
  it('カレンダーを掲示板と FAQ の間に置き、そのルートでは選択状態にする', () => {
    route.pathname = '/hub/calendar';
    render(<AppSidebar onOpenTagMaster={vi.fn()} />);
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      '掲示板',
      'カレンダー',
      'FAQ',
    ]);
    const calendar = screen.getByRole('link', { name: 'カレンダー' });
    expect(calendar).toHaveAttribute('href', '/hub/calendar');
    expect(calendar).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'FAQ' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'タグ管理' })).toBeVisible();
  });

  it('カレンダー以外の画面では、カレンダーを選択状態にしない', () => {
    render(<AppSidebar />);
    const calendar = screen.getByRole('link', { name: 'カレンダー' });
    expect(calendar).toHaveAttribute('href', '/hub/calendar');
    expect(calendar).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: '掲示板' })).toHaveAttribute('aria-current', 'page');
  });

  it('ファイルの★を押すと、対象 fileId を File 画面へ伝えてから遷移する', () => {
    items = [fav('file', 'file-1', '資料A')];
    render(<AppSidebar />);
    fireEvent.click(screen.getByText('資料A'));

    expect(dispatchSpy).toHaveBeenCalledWith('file-1');
    expect(push).toHaveBeenCalledWith('/files?fileId=file-1');
    // 遷移の指示より先に伝える（遷移が取り消されても伝わるように）。
    expect(dispatchSpy.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]!);
  });

  it('% や / を含む fileId でも、decode 済みのまま伝える（URL 側の読み取りと揃える）', () => {
    items = [fav('file', 'a b/c', '資料B')];
    render(<AppSidebar />);
    fireEvent.click(screen.getByText('資料B'));

    expect(dispatchSpy).toHaveBeenCalledWith('a b/c');
    expect(push).toHaveBeenCalledWith('/files?fileId=a%20b%2Fc');
  });

  it('ファイル以外（フォルダ・器など）の★では伝えない', () => {
    items = [fav('folder', 'folder-1', 'フォルダA'), fav('space', 'space-1', '器A')];
    render(<AppSidebar />);
    fireEvent.click(screen.getByText('フォルダA'));
    fireEvent.click(screen.getByText('器A'));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(2);
  });
});

describe('AppSidebar — 準備中の行（S-HOME-09）', () => {
  it('遷移先が未接続の行は押せず、押しても遷移しない（何も起きない）', () => {
    // system のお気に入りは reference 未接続（menuItems 空）なので遷移先が解決しない。
    items = [fav('system', 'product', '商品マスタ')];
    render(<AppSidebar />);

    const row = screen.getByRole('button', { name: /商品マスタ/ });
    expect(row).toBeDisabled();
    fireEvent.click(row);

    expect(push).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('準備中の行がある時だけ、押せない理由を文字で出す（無反応にしない）', () => {
    items = [fav('system', 'product', '商品マスタ')];
    render(<AppSidebar />);

    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('準備中のため開けません');
    expect(note).toHaveTextContent('商品マスタ');
    // 行と案内を結び、読み上げでも同じ理由が伝わる。
    expect(screen.getByRole('button', { name: /商品マスタ/ })).toHaveAttribute(
      'aria-describedby',
      note.id,
    );
  });

  it('準備中の行が無ければ案内は出さない', () => {
    items = [fav('folder', 'folder-1', 'フォルダA')];
    render(<AppSidebar />);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
