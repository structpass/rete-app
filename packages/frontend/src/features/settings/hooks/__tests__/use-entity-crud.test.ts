import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useEntityCrud } from '../use-entity-crud';

interface Row {
  id: string;
  name: string;
}

/** 解決タイミングを外から制御できる Promise（後着順を固定するため）。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

describe('useEntityCrud', () => {
  it('fetchFn 参照が変わって取得が並走した時、最後に投げた取得の結果だけを採用する（set-0150）', async () => {
    // アーカイブ絞り込みチップの高速往復＝fetchFn 参照が続けて変わる状況を、解決順を逆にして再現する。
    const first = deferred<Row[]>();
    const second = deferred<Row[]>();
    const fetchA = vi.fn(() => first.promise);
    const fetchB = vi.fn(() => second.promise);
    const createFn = vi.fn();
    const updateFn = vi.fn();

    const { result, rerender } = renderHook(
      ({ fetchFn }: { fetchFn: () => Promise<Row[]> }) =>
        useEntityCrud<Row>({ fetchFn, createFn, updateFn }),
      { initialProps: { fetchFn: fetchA } },
    );

    // 1 回目の取得が未解決のまま 2 回目（最新）を投げる。
    rerender({ fetchFn: fetchB });
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);

    // 最新（2 回目）が先に解決し、そのあと古い 1 回目が後着する。
    await act(async () => {
      second.resolve([{ id: 'b', name: '最新' }]);
      await second.promise;
    });
    await waitFor(() => expect(result.current.items).toEqual([{ id: 'b', name: '最新' }]));

    await act(async () => {
      first.resolve([{ id: 'a', name: '古い' }]);
      await first.promise;
    });

    // 後着した古い結果で上書きされない。
    expect(result.current.items).toEqual([{ id: 'b', name: '最新' }]);
    expect(result.current.isLoading).toBe(false);
  });

  it('古い取得が後着しても、走っている最新取得の読み込み表示を消さない（set-0150）', async () => {
    const first = deferred<Row[]>();
    const second = deferred<Row[]>();
    const fetchA = vi.fn(() => first.promise);
    const fetchB = vi.fn(() => second.promise);

    const { result, rerender } = renderHook(
      ({ fetchFn }: { fetchFn: () => Promise<Row[]> }) =>
        useEntityCrud<Row>({ fetchFn, createFn: vi.fn(), updateFn: vi.fn() }),
      { initialProps: { fetchFn: fetchA } },
    );

    rerender({ fetchFn: fetchB });
    expect(result.current.isLoading).toBe(true);

    // 最新がまだ走っている間に古いほうが解決する。
    await act(async () => {
      first.resolve([{ id: 'a', name: '古い' }]);
      await first.promise;
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.items).toEqual([]);

    await act(async () => {
      second.resolve([{ id: 'b', name: '最新' }]);
      await second.promise;
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toEqual([{ id: 'b', name: '最新' }]);
  });

  it('単発の取得は通常どおり一覧へ反映する（世代カウンタが素の経路を壊していないこと）', async () => {
    const fetchFn = vi.fn(async () => [{ id: 'a', name: '組織A' }]);
    const { result } = renderHook(() =>
      useEntityCrud<Row>({ fetchFn, createFn: vi.fn(), updateFn: vi.fn() }),
    );
    await waitFor(() => expect(result.current.items).toEqual([{ id: 'a', name: '組織A' }]));
    expect(result.current.isLoading).toBe(false);
  });

  // ── v2-410: 取得失敗を error として呼び出し側へ渡す（領域内 role="alert" の受け口）──

  it('初回の取得失敗を error として残す（items は空・isLoading は下りる・v2-410）', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() =>
      useEntityCrud<Row>({ fetchFn, createFn: vi.fn(), updateFn: vi.fn() }),
    );

    await waitFor(() => expect(result.current.error).toBe('一覧の取得に失敗しました'));
    expect(result.current.items).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('呼び出し側の画面固有文言を error に入れる（loadErrorMessage・v2-410）', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() =>
      useEntityCrud<Row>({
        fetchFn,
        createFn: vi.fn(),
        updateFn: vi.fn(),
        loadErrorMessage: '組織の取得に失敗しました',
      }),
    );

    await waitFor(() => expect(result.current.error).toBe('組織の取得に失敗しました'));
  });

  it('再取得が成功すると error を消す（v2-410）', async () => {
    const fetchFn = vi
      .fn<() => Promise<Row[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ id: 'a', name: 'A' }]);
    const { result } = renderHook(() =>
      useEntityCrud<Row>({ fetchFn, createFn: vi.fn(), updateFn: vi.fn() }),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());

    await act(async () => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.items).toEqual([{ id: 'a', name: 'A' }]));
    expect(result.current.error).toBeNull();
  });

  it('取得成功の後に失敗したら、旧一覧を残したまま error を立てる（v2-410）', async () => {
    const fetchFn = vi
      .fn<() => Promise<Row[]>>()
      .mockResolvedValueOnce([{ id: 'a', name: 'A' }])
      .mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() =>
      useEntityCrud<Row>({ fetchFn, createFn: vi.fn(), updateFn: vi.fn() }),
    );
    await waitFor(() => expect(result.current.items).toEqual([{ id: 'a', name: 'A' }]));

    await act(async () => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.error).toBe('一覧の取得に失敗しました'));
    // 旧一覧は消さない（表示中の一覧の下に失敗を残す）
    expect(result.current.items).toEqual([{ id: 'a', name: 'A' }]);
  });

  it('古い取得の失敗が後着しても、最新の成功を error で上書きしない（v2-410）', async () => {
    const first = deferred<Row[]>();
    const second = deferred<Row[]>();
    const fetchA = vi.fn(() => first.promise);
    const fetchB = vi.fn(() => second.promise);

    const { result, rerender } = renderHook(
      ({ fetchFn }: { fetchFn: () => Promise<Row[]> }) =>
        useEntityCrud<Row>({ fetchFn, createFn: vi.fn(), updateFn: vi.fn() }),
      { initialProps: { fetchFn: fetchA } },
    );
    rerender({ fetchFn: fetchB });

    // 最新（2 回目）が先に成功し、そのあと古い 1 回目が失敗して後着する。
    await act(async () => {
      second.resolve([{ id: 'b', name: '最新' }]);
      await second.promise;
    });
    await waitFor(() => expect(result.current.items).toEqual([{ id: 'b', name: '最新' }]));

    await act(async () => {
      first.reject(new Error('古い失敗'));
      await first.promise.catch(() => {});
    });

    expect(result.current.error).toBeNull();
    expect(result.current.items).toEqual([{ id: 'b', name: '最新' }]);
  });

  it('最新の失敗は、古い成功が後着しても消えない（v2-410）', async () => {
    const first = deferred<Row[]>();
    const second = deferred<Row[]>();
    const fetchA = vi.fn(() => first.promise);
    const fetchB = vi.fn(() => second.promise);

    const { result, rerender } = renderHook(
      ({ fetchFn }: { fetchFn: () => Promise<Row[]> }) =>
        useEntityCrud<Row>({ fetchFn, createFn: vi.fn(), updateFn: vi.fn() }),
      { initialProps: { fetchFn: fetchA } },
    );
    rerender({ fetchFn: fetchB });

    // 最新（2 回目）が失敗し、そのあと古い 1 回目が成功して後着する。
    await act(async () => {
      second.reject(new Error('boom'));
      await second.promise.catch(() => {});
    });
    await waitFor(() => expect(result.current.error).toBe('一覧の取得に失敗しました'));

    await act(async () => {
      first.resolve([{ id: 'a', name: '古い' }]);
      await first.promise;
    });

    expect(result.current.error).toBe('一覧の取得に失敗しました');
    expect(result.current.items).toEqual([]);
  });
});
