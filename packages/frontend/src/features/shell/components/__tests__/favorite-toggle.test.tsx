import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import toast from 'react-hot-toast';
import type { FavoriteDto } from '@rete/shared';

// 共有 state（FavoritesContext）はモックし、★トグル単体の判定/トグル/多重送信ガードを検証する。
// cmn-0143: vi.hoisted 化（factory クロージャ参照を構造的に hoist）
// ※ `let items` はテストごとに書き換える mutable なため hoisted 対象外（残置）。
const { add, remove } = vi.hoisted(() => ({
  add: vi.fn(),
  remove: vi.fn(),
}));
// v2-505: Provider 有無の切替（既定は ON＝従来どおり描画する）。
const { providerAvailableRef } = vi.hoisted(() => ({ providerAvailableRef: { current: true } }));
let items: FavoriteDto[] = [];

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }));

vi.mock('../../hooks/favorites-context', () => ({
  // v2-505: 本体は useOptionalFavoritesContext（Provider 外で null）を使う。
  // テストごとに ON/OFF できるよう ref 経由で切り替える。
  useOptionalFavoritesContext: () =>
    providerAvailableRef.current
      ? {
          items,
          loading: false,
          error: null,
          refetch: vi.fn(),
          add,
          remove,
          reorder: vi.fn(),
        }
      : null,
}));

import { FavoriteToggle } from '../favorite-toggle';

const fileTarget = { kind: 'file' as const, targetRef: 'fid-1', label: '資料' };

beforeEach(() => {
  vi.clearAllMocks();
  items = [];
  providerAvailableRef.current = true;
  add.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);
});

describe('FavoriteToggle', () => {
  it('未登録なら aria-pressed=false で、押すと target で add する', async () => {
    render(<FavoriteToggle target={fileTarget} />);
    const btn = screen.getByRole('button', { name: 'ファイル「資料」をお気に入りに追加' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({ kind: 'file', targetRef: 'fid-1', label: '資料' }),
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('登録済みなら aria-pressed=true で、押すと該当 id を remove する', async () => {
    items = [{ id: 'x1', kind: 'file', targetRef: 'fid-1', label: '資料' }];
    render(<FavoriteToggle target={fileTarget} />);
    const btn = screen.getByRole('button', { name: 'ファイル「資料」をお気に入りから削除' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    await waitFor(() => expect(remove).toHaveBeenCalledWith('x1'));
    expect(add).not.toHaveBeenCalled();
  });

  it('targetRef が一致しても kind が異なれば未登録扱い（精密一致）', () => {
    items = [{ id: 'c1', kind: 'chat', targetRef: 'fid-1', label: '別物' }];
    render(<FavoriteToggle target={fileTarget} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
  });

  // v2-505: kind は 8 種ある。file 以外を一律「フォルダ」と呼ぶと space/project 等が誤表示になるため、
  // 種別ごとの表記を accessible name で固定する。
  it.each([
    ['space', 'スペース'],
    ['project', 'プロジェクト'],
    ['folder', 'フォルダ'],
    ['file', 'ファイル'],
    ['organization', '組織'],
    ['chat', 'チャット'],
    ['task', 'タスク'],
    ['system', 'システム'],
  ] as const)('kind=%s は「%s」として読み上げる', (kind, label) => {
    render(<FavoriteToggle target={{ kind, targetRef: 'r1', label: '対象A' } as never} />);
    expect(screen.getByRole('button')).toHaveAccessibleName(`${label}「対象A」をお気に入りに追加`);
  });

  it('処理中は disabled で二重送信しない', async () => {
    let resolveAdd: () => void = () => {};
    add.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolveAdd = r;
        }),
    );
    render(<FavoriteToggle target={fileTarget} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    fireEvent.click(btn); // 2 回目は busy ガードで無視
    expect(add).toHaveBeenCalledTimes(1);
    resolveAdd();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it('add 失敗時はトーストでエラーを表示し busy を解除する', async () => {
    add.mockRejectedValue(new Error('boom'));
    render(<FavoriteToggle target={fileTarget} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  // v2-505: 一覧の単体描画のように Provider が無い文脈でも壊れない（★を出さないだけ）。
  it('FavoritesProvider が無い時は何も描かない（throw しない）', () => {
    providerAvailableRef.current = false;
    expect(() => render(<FavoriteToggle target={fileTarget} />)).not.toThrow();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
