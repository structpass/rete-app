import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { add, remove } = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }));
let items: { id: string; kind: string; targetRef: string; label: string }[] = [];

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }));
vi.mock('@/features/shell/hooks/favorites-context', () => ({
  useOptionalFavoritesContext: () => ({
    items,
    loading: false,
    error: null,
    refetch: vi.fn(),
    add,
    remove,
    reorder: vi.fn(),
  }),
}));

import { FavoriteToggle } from '@/features/shell/components/favorite-toggle';
import { FileTopbar } from '../file-topbar';

const folder = { kind: 'folder' as const, targetRef: 'f-1', label: 'CSV仕様書' };

beforeEach(() => {
  vi.clearAllMocks();
  items = [];
  add.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);
});

// d524: パンくずの現在フォルダは「名前＋ハート」の 1 ボタン。名前とアイコンが別物だと
// お気に入りが何に係っているか読み取れない、という指摘への対応を固定する。
describe('FavoriteToggle — 名前を並べる形（d524）', () => {
  it('showLabel で対象名をボタン内に出し、名前はボタンの読み上げ名に含まれる', () => {
    render(<FavoriteToggle target={folder} showLabel />);
    const btn = screen.getByRole('button', { name: 'フォルダ「CSV仕様書」をお気に入りに追加' });
    // 名前はボタンの子（＝クリック対象の内側）にあり、外側の別要素ではない。
    expect(btn).toHaveTextContent('CSV仕様書');
    expect(btn.className).toContain('with-label');
  });

  it('showLabel 省略時はアイコンのみ（名前を出さない）', () => {
    const { container } = render(<FavoriteToggle target={folder} />);
    const btn = screen.getByRole('button');
    expect(container.querySelector('.fav-toggle-label')).toBeNull();
    expect(btn).toHaveTextContent('');
  });

  it('未登録はハート＋、登録済みは塗りハートになる（★ではない）', () => {
    const { container, rerender } = render(<FavoriteToggle target={folder} showLabel />);
    // HeartPlus は heart-plus、Heart は heart のクラスを持つ（lucide のアイコン識別子）。
    expect(container.querySelector('svg.lucide-heart-plus')).not.toBeNull();
    expect(container.querySelector('svg.lucide-star')).toBeNull();

    items = [{ id: 'x1', kind: 'folder', targetRef: 'f-1', label: 'CSV仕様書' }];
    rerender(<FavoriteToggle target={folder} showLabel />);
    const filled = container.querySelector('svg.lucide-heart');
    expect(filled).not.toBeNull();
    expect(filled?.getAttribute('fill')).toBe('currentColor');
  });

  it('名前の部分を押しても登録できる（名前とアイコンが 1 つの操作対象）', async () => {
    render(<FavoriteToggle target={folder} showLabel />);
    fireEvent.click(screen.getByText('CSV仕様書'));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({ kind: 'folder', targetRef: 'f-1', label: 'CSV仕様書' }),
    );
  });
});

describe('FileTopbar — パンくずの現在フォルダ（d524）', () => {
  const crumb = [
    { id: 'root', name: '入荷' },
    { id: 'f-1', name: 'CSV仕様書' },
  ];

  function renderTopbar(favorite?: typeof folder) {
    return render(
      <FileTopbar
        crumb={crumb}
        search=""
        onSearchChange={vi.fn()}
        onNavigate={vi.fn()}
        favorite={favorite}
      />,
    );
  }

  it('現在フォルダ名はお気に入りボタンの内側に 1 回だけ出る（パンくず側と二重にしない）', () => {
    const { container } = renderTopbar(folder);
    expect(screen.getAllByText('CSV仕様書')).toHaveLength(1);
    const btn = screen.getByRole('button', { name: 'フォルダ「CSV仕様書」をお気に入りに追加' });
    expect(btn).toHaveTextContent('CSV仕様書');
    // パンくず側（tc-current）には現在フォルダ名を残さない。
    expect(container.querySelector('.tc-current')).toBeNull();
    // 祖先のパンくず（入荷）は従来どおり辿れる。
    expect(screen.getByRole('button', { name: '入荷' })).toBeInTheDocument();
  });

  it('お気に入り対象が無い時は従来どおりパンくずに名前を出す', () => {
    const { container } = renderTopbar(undefined);
    expect(container.querySelector('.tc-current')).toHaveTextContent('CSV仕様書');
    expect(screen.queryByRole('button', { name: /お気に入り/ })).toBeNull();
  });

  // d524: パンくず先頭のフォルダアイコンは不要（開発統括指示）。区切りの「＞」は祖先との関係を
  // 示すため残す。行頭に飾りアイコンが戻ると、また「何のアイコンか」を読むことになる。
  it('パンくず先頭にフォルダアイコンを置かず、区切りの＞だけを残す', () => {
    const { container } = renderTopbar(folder);
    const path = container.querySelector('.tc-path');
    expect(path?.querySelector('svg.lucide-folder')).toBeNull();
    // 祖先と現在の間の 1 個だけが残る（2 セグメント＝区切り 1 個）。
    expect(path?.querySelectorAll('svg.lucide-chevron-right')).toHaveLength(1);
  });
});
