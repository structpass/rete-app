import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { FavoriteDto } from '@rete/shared';

// favorites-api をモックし、フックの取得/追加/削除/楽観並び替えの挙動を検証する。
// cmn-0143: vi.hoisted 化（factory クロージャ参照を構造的に hoist）
const { fetchFavorites, addFavorite, removeFavorite, reorderFavorites } = vi.hoisted(() => ({
  fetchFavorites: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
}));

vi.mock('../../lib/favorites-api', () => ({
  fetchFavorites: (...a: unknown[]) => fetchFavorites(...a),
  addFavorite: (...a: unknown[]) => addFavorite(...a),
  removeFavorite: (...a: unknown[]) => removeFavorite(...a),
  reorderFavorites: (...a: unknown[]) => reorderFavorites(...a),
}));

import { useFavorites } from '../use-favorites';

function fav(id: string, label = id): FavoriteDto {
  return { id, kind: 'chat', targetRef: `ref-${id}`, label };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchFavorites.mockResolvedValue([fav('a'), fav('b')]);
});

describe('useFavorites', () => {
  it('マウント時に一覧を取得し loading を解除する', async () => {
    const { result } = renderHook(() => useFavorites());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((f) => f.id)).toEqual(['a', 'b']);
    expect(result.current.error).toBeNull();
  });

  it('取得失敗時は error をセットする', async () => {
    fetchFavorites.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useFavorites());
    await waitFor(() => expect(result.current.error).toBe('お気に入りの取得に失敗しました'));
  });

  it('add は API 呼び出し後に一覧を再取得する', async () => {
    const { result } = renderHook(() => useFavorites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    addFavorite.mockResolvedValue(fav('c'));
    fetchFavorites.mockResolvedValueOnce([fav('a'), fav('b'), fav('c')]);
    await act(async () => {
      await result.current.add({ kind: 'chat', label: '新規' });
    });

    expect(addFavorite).toHaveBeenCalledWith({ kind: 'chat', label: '新規' });
    expect(result.current.items.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('remove は API 呼び出し後に一覧を再取得する', async () => {
    const { result } = renderHook(() => useFavorites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    removeFavorite.mockResolvedValue(undefined);
    fetchFavorites.mockResolvedValueOnce([fav('b')]);
    await act(async () => {
      await result.current.remove('a');
    });

    expect(removeFavorite).toHaveBeenCalledWith('a');
    expect(result.current.items.map((f) => f.id)).toEqual(['b']);
  });

  it('reorder は楽観的に即並び替え、確定データで上書きする', async () => {
    const { result } = renderHook(() => useFavorites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    reorderFavorites.mockResolvedValue([fav('b'), fav('a')]);
    await act(async () => {
      await result.current.reorder(['b', 'a']);
    });

    expect(reorderFavorites).toHaveBeenCalledWith(['b', 'a']);
    expect(result.current.items.map((f) => f.id)).toEqual(['b', 'a']);
  });

  it('reorder 失敗時は元の並びへロールバックし error をセットする', async () => {
    const { result } = renderHook(() => useFavorites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    reorderFavorites.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await result.current.reorder(['b', 'a']);
    });

    expect(result.current.items.map((f) => f.id)).toEqual(['a', 'b']);
    expect(result.current.error).toBe('並び替えに失敗しました');
  });

  it('連続した取得で古い応答が後から返っても新しい一覧を上書きしない（d561）', async () => {
    const { result } = renderHook(() => useFavorites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // 2 回の取得を await せず連続発火し、応答の解決順を手元で制御する。
    let resolveStale!: (v: FavoriteDto[]) => void;
    let resolveFresh!: (v: FavoriteDto[]) => void;
    fetchFavorites
      .mockImplementationOnce(
        () =>
          new Promise<FavoriteDto[]>((res) => {
            resolveStale = res;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<FavoriteDto[]>((res) => {
            resolveFresh = res;
          }),
      );

    act(() => {
      void result.current.refetch(); // 1 回目（古い世代）
      void result.current.refetch(); // 2 回目（最新世代）
    });

    // 逆順解決: 新しい応答が先に返り、古い応答が後から返る。
    await act(async () => {
      resolveFresh([fav('a'), fav('b'), fav('c')]);
    });
    expect(result.current.items.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveStale([fav('a')]);
    });
    // 古い応答は世代ガードで破棄され、登録後の一覧が維持される。
    expect(result.current.items.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('並び替えの失敗で巻き戻しても、待っている間に成功した登録を消さない（d561）', async () => {
    const { result } = renderHook(() => useFavorites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let rejectReorder!: (e: Error) => void;
    reorderFavorites.mockImplementationOnce(
      () =>
        new Promise<FavoriteDto[]>((_, rej) => {
          rejectReorder = rej;
        }),
    );

    // 並び替えを発火し、応答を待つ間に登録（と再取得）を成功させる。
    act(() => {
      void result.current.reorder(['b', 'a']);
    });
    addFavorite.mockResolvedValue(fav('c'));
    fetchFavorites.mockResolvedValueOnce([fav('b'), fav('a'), fav('c')]);
    await act(async () => {
      await result.current.add({ kind: 'chat', label: '新規' });
    });
    expect(result.current.items.map((f) => f.id)).toEqual(['b', 'a', 'c']);

    await act(async () => {
      rejectReorder(new Error('boom'));
    });
    // 巻き戻しは登録前のスナップショットへ戻さず、追加された c を残したまま順序だけ戻す。
    // 並び順は backend の sortOrder が正のため、失敗時は呼び出し前の順序（a, b）へ戻す。
    expect(result.current.items.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.error).toBe('並び替えに失敗しました');
  });
});
