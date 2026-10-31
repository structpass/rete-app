import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AxiosError } from 'axios';
import { useTagMaster, type TagLike, type UseTagMasterOptions } from './use-tag-master';

const mockTags: TagLike[] = [
  { id: 't1', name: 'タグA', icon: 'Star', color: 'blue' },
  { id: 't2', name: 'タグB', icon: 'Tag', color: 'red' },
];

/** 型付きテスト用 API モックを生成する（beforeEach でリセット可能にするために毎回生成）。 */
function makeMockApi(): UseTagMasterOptions {
  return {
    fetch: vi.fn<() => Promise<TagLike[]>>().mockResolvedValue([...mockTags]),
    create: vi.fn<(name: string, icon: string, color: string) => Promise<TagLike>>(),
    update:
      vi.fn<
        (id: string, patch: { name?: string; icon?: string; color?: string }) => Promise<TagLike>
      >(),
    remove: vi.fn<(id: string) => Promise<void>>(),
  };
}

describe('useTagMaster — 汎用タグマスタ hook（rete-home-0043 / rete-files-0006 共有化）', () => {
  let api: UseTagMasterOptions;

  beforeEach(() => {
    api = makeMockApi();
  });

  it('マウント時に fetch を呼んでタグ一覧を取得する', async () => {
    const { result } = renderHook(() => useTagMaster(api));
    expect(result.current.loading).toBe(true);
    await act(async () => {});
    expect(result.current.loading).toBe(false);
    expect(result.current.tags).toEqual(mockTags);
    expect(result.current.error).toBe(false);
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it('fetch エラー時に error=true になりタグは空配列', async () => {
    vi.mocked(api.fetch).mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});
    expect(result.current.error).toBe(true);
    expect(result.current.tags).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('create 成功時に true を返し、一覧を再取得する（reload が 2 回呼ばれる）', async () => {
    const newTag: TagLike = { id: 't3', name: '新規', icon: 'Bell', color: 'green' };
    vi.mocked(api.create).mockResolvedValue(newTag);
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.create('新規', 'Bell', 'green');
    });

    expect(ok).toBe(true);
    expect(api.create).toHaveBeenCalledWith('新規', 'Bell', 'green');
    // 初回ロード + create 成功後の reload = 2 回。
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  it('create 失敗時に false を返す（API エラー）', async () => {
    vi.mocked(api.create).mockRejectedValue(new Error('409 Conflict'));
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.create('重複タグ', 'Tag', 'slate');
    });

    expect(ok).toBe(false);
  });

  it('create 失敗時、サーバの具体メッセージがあれば lastError へ格納する（hom-0103）', async () => {
    const axiosErr = new AxiosError('Request failed');
    axiosErr.response = {
      data: {
        success: false,
        error: {
          code: 'CONFLICT',
          message: 'タグ名「重要」はアーカイブ済みのタグと同名です（復元するか別名にしてください）',
        },
      },
      status: 409,
      statusText: 'Conflict',
      headers: {},
      config: axiosErr.config as never,
    };
    vi.mocked(api.create).mockRejectedValue(axiosErr);
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    await act(async () => {
      await result.current.create('重要', 'Tag', 'slate');
    });

    expect(result.current.lastError).toBe(
      'タグ名「重要」はアーカイブ済みのタグと同名です（復元するか別名にしてください）',
    );
  });

  it('create 失敗時、サーバメッセージが無ければ lastError は null のまま', async () => {
    vi.mocked(api.create).mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    await act(async () => {
      await result.current.create('重複タグ', 'Tag', 'slate');
    });

    expect(result.current.lastError).toBeNull();
  });

  it('update の理由も共通形式から取り出し、長文は従来どおり200文字までにする', async () => {
    vi.mocked(api.update).mockRejectedValue({
      response: { data: { error: { message: 'あ'.repeat(201) } } },
    });
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});
    await act(async () => {
      await result.current.update('t1', { name: '重複' });
    });
    expect(result.current.lastError).toBe('あ'.repeat(200));
    vi.mocked(api.update).mockRejectedValue(new Error('network'));
    await act(async () => {
      await result.current.update('t1', { name: '再試行' });
    });
    expect(result.current.lastError).toBeNull();
  });

  it('create 中は mutating=true、完了後は false になる', async () => {
    let resolve!: (v: TagLike) => void;
    vi.mocked(api.create).mockImplementation(
      () =>
        new Promise<TagLike>((res) => {
          resolve = res;
        }),
    );
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    // create を開始（await しない）。
    act(() => {
      void result.current.create('テスト', 'Star', 'red');
    });
    expect(result.current.mutating).toBe(true);

    // resolve して完了を待つ。
    await act(async () => {
      resolve({ id: 't-new', name: 'テスト', icon: 'Star', color: 'red' });
    });
    expect(result.current.mutating).toBe(false);
  });

  it('update 成功時に true を返し、指定フィールドで update API を呼ぶ', async () => {
    const updated: TagLike = { id: 't1', name: '更新後', icon: 'Star', color: 'blue' };
    vi.mocked(api.update).mockResolvedValue(updated);
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.update('t1', { name: '更新後' });
    });

    expect(ok).toBe(true);
    expect(api.update).toHaveBeenCalledWith('t1', { name: '更新後' });
  });

  it('update 失敗時に false を返す', async () => {
    vi.mocked(api.update).mockRejectedValue(new Error('404 Not Found'));
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.update('ghost-id', { name: '存在しない' });
    });

    expect(ok).toBe(false);
  });

  it('remove 成功時に true を返し、一覧を再取得する', async () => {
    vi.mocked(api.remove).mockResolvedValue(undefined);
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.remove('t1');
    });

    expect(ok).toBe(true);
    expect(api.remove).toHaveBeenCalledWith('t1');
    // 初回ロード + remove 成功後の reload = 2 回。
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  it('remove 失敗時に false を返す', async () => {
    vi.mocked(api.remove).mockRejectedValue(new Error('403 Forbidden'));
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.remove('t1');
    });

    expect(ok).toBe(false);
  });

  it('reload 連打で古い応答が後から解決しても新しい応答を上書きしない（generationRef 世代ガード・hom-0092）', async () => {
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});
    expect(result.current.tags).toEqual(mockTags);

    // 2 回の reload を await せず連続発火し、fetch の解決を手元で制御する。
    const staleTags: TagLike[] = [{ id: 'stale', name: '古い応答', icon: 'Tag', color: 'slate' }];
    const freshTags: TagLike[] = [
      { id: 'fresh', name: '新しい応答', icon: 'Star', color: 'green' },
    ];
    let resolveStale!: (v: TagLike[]) => void;
    let resolveFresh!: (v: TagLike[]) => void;
    vi.mocked(api.fetch)
      .mockImplementationOnce(
        () =>
          new Promise<TagLike[]>((res) => {
            resolveStale = res;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<TagLike[]>((res) => {
            resolveFresh = res;
          }),
      );

    act(() => {
      void result.current.reload(); // 1回目（古い世代）
      void result.current.reload(); // 2回目（最新世代）
    });

    // 逆順解決: 新しい世代の応答が先に返り、古い世代の応答が後から返る。
    await act(async () => {
      resolveFresh(freshTags);
    });
    expect(result.current.tags).toEqual(freshTags);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveStale(staleTags);
    });
    // 古い応答は世代ガードで破棄され、最新の結果が維持される。
    expect(result.current.tags).toEqual(freshTags);
    expect(result.current.loading).toBe(false);
  });

  it('reload で一覧を手動再取得できる', async () => {
    const { result } = renderHook(() => useTagMaster(api));
    await act(async () => {});

    const refreshed: TagLike[] = [{ id: 't3', name: '最新タグ', icon: 'Tag', color: 'green' }];
    vi.mocked(api.fetch).mockResolvedValue(refreshed);
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.tags).toEqual(refreshed);
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });
});
