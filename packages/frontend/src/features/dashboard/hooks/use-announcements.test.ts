import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAnnouncements } from './use-announcements';
import type { AnnouncementSummary } from '../lib/api';

// hom-0073: useAnnouncements に kind 引数を追加。fetch/create/reorder へ kind が渡ることを検証する
// （update/remove は id 単位の操作で kind を必要としない・backend 未受理のため対象外）。
// cmn-0142: vi.hoisted 化
const {
  mockFetchAnnouncements,
  mockCreateAnnouncement,
  mockUpdateAnnouncement,
  mockDeleteAnnouncement,
  mockReorderAnnouncements,
} = vi.hoisted(() => ({
  mockFetchAnnouncements: vi.fn(),
  mockCreateAnnouncement: vi.fn(),
  mockUpdateAnnouncement: vi.fn(),
  mockDeleteAnnouncement: vi.fn(),
  mockReorderAnnouncements: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  fetchAnnouncements: mockFetchAnnouncements,
  createAnnouncement: mockCreateAnnouncement,
  updateAnnouncement: mockUpdateAnnouncement,
  deleteAnnouncement: mockDeleteAnnouncement,
  reorderAnnouncements: mockReorderAnnouncements,
}));

import * as api from '../lib/api';

const items: AnnouncementSummary[] = [
  {
    id: 'a1',
    title: 'お知らせ1',
    publishedAt: '2026-06-01T00:00:00.000Z',
    author: '田中 太郎',
    excerpt: '',
    unread: false,
    tags: [],
  },
];

describe('useAnnouncements — kind スコープ（hom-0073）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchAnnouncements).mockResolvedValue({
      success: true,
      data: items,
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    });
  });

  it('kind 省略時は既定の board を fetch に渡す', async () => {
    renderHook(() => useAnnouncements());
    await act(async () => {});
    expect(api.fetchAnnouncements).toHaveBeenCalledWith({ page: 1, limit: 20, kind: 'board' });
  });

  it('kind を明示すると fetch/create/reorder にそのまま渡す', async () => {
    const { result } = renderHook(() => useAnnouncements('faq'));
    await act(async () => {});
    expect(api.fetchAnnouncements).toHaveBeenCalledWith({ page: 1, limit: 20, kind: 'faq' });

    vi.mocked(api.createAnnouncement).mockResolvedValue({
      id: 'a2',
      title: '新規',
      publishedAt: '2026-06-02T00:00:00.000Z',
      author: '田中 太郎',
      body: '',
      attachments: [],
      tags: [],
    });
    await act(async () => {
      await result.current.create({ title: '新規' });
    });
    expect(api.createAnnouncement).toHaveBeenCalledWith({ title: '新規' }, 'faq');

    vi.mocked(api.reorderAnnouncements).mockResolvedValue(items);
    await act(async () => {
      await result.current.reorder(['a1']);
    });
    expect(api.reorderAnnouncements).toHaveBeenCalledWith(['a1'], 'faq');
  });

  it('同一 kind での再レンダーは load の identity を維持し再フェッチしない', async () => {
    const { rerender } = renderHook(() => useAnnouncements('board'));
    await act(async () => {});
    const callsAfterMount = vi.mocked(api.fetchAnnouncements).mock.calls.length;
    rerender();
    await act(async () => {});
    expect(vi.mocked(api.fetchAnnouncements).mock.calls.length).toBe(callsAfterMount);
  });
});

describe('useAnnouncements — 応答の競合', () => {
  type Response = Awaited<ReturnType<typeof api.fetchAnnouncements>>;
  function deferred() {
    let resolve!: (value: Response) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<Response>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  function response(
    page: number,
    total = 60,
    data = [{ ...items[0], id: `page${page}` }],
  ): Response {
    return {
      success: true,
      data,
      meta: { page, total, limit: 20, totalPages: Math.ceil(total / 20) },
    };
  }
  let requests: ReturnType<typeof deferred>[];
  beforeEach(() => {
    vi.resetAllMocks();
    requests = [];
    mockFetchAnnouncements.mockImplementation(() => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    });
  });
  async function mount() {
    const hook = renderHook(({ kind }: { kind: 'board' | 'faq' }) => useAnnouncements(kind), {
      initialProps: { kind: 'board' as 'board' | 'faq' },
    });
    await act(async () => {
      requests[0].resolve(response(1));
    });
    return hook;
  }
  it('2→3ページの逆順成功でも3ページの一覧と件数を保つ', async () => {
    const { result } = await mount();
    act(() => result.current.setPage(2));
    act(() => result.current.setPage(3));
    await act(async () => requests[2].resolve(response(3, 59)));
    await act(async () => requests[1].resolve(response(2, 60)));
    expect(result.current).toMatchObject({ page: 3, total: 59, loading: false, error: null });
    expect(result.current.items[0].id).toBe('page3');
  });
  it('旧失敗の後着が最新成功をエラーへ変えない', async () => {
    const { result } = await mount();
    act(() => result.current.setPage(2));
    act(() => result.current.setPage(3));
    await act(async () => requests[2].resolve(response(3)));
    await act(async () => requests[1].reject(new Error('old')));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.items[0].id).toBe('page3');
  });
  it('旧応答で最新取得中のloadingを解除せず、最新失敗は表示する', async () => {
    const { result } = await mount();
    act(() => result.current.setPage(2));
    act(() => result.current.setPage(3));
    await act(async () => requests[1].resolve(response(2)));
    expect(result.current.loading).toBe(true);
    await act(async () => requests[2].reject(new Error('latest')));
    expect(result.current.error).toBe('通知の取得に失敗しました');
    expect(result.current.loading).toBe(false);
  });
  it('旧空ページが現在ページを補正しない', async () => {
    const { result } = await mount();
    act(() => result.current.setPage(2));
    act(() => result.current.setPage(3));
    await act(async () => requests[2].resolve(response(3)));
    await act(async () => requests[1].resolve(response(2, 0, [])));
    expect(result.current.page).toBe(3);
    expect(result.current.total).toBe(60);
  });
  it('最新空ページは実在する最終ページへ戻して再取得する', async () => {
    const { result } = await mount();
    act(() => result.current.setPage(3));
    await act(async () => requests[1].resolve(response(3, 21, [])));
    expect(result.current.page).toBe(2);
    expect(mockFetchAnnouncements).toHaveBeenLastCalledWith({ page: 2, limit: 20, kind: 'board' });
    await act(async () => requests[2].resolve(response(2, 21)));
    expect(result.current.items[0].id).toBe('page2');
  });
  it('kind切替後の旧応答を無視する', async () => {
    const { result, rerender } = await mount();
    act(() => result.current.setPage(2));
    rerender({ kind: 'faq' });
    await act(async () => requests[2].resolve(response(2, 22, [{ ...items[0], id: 'faq' }])));
    await act(async () => requests[1].resolve(response(2)));
    expect(result.current.items[0].id).toBe('faq');
    expect(result.current.total).toBe(22);
  });
  it('同じページのrefetchも最新応答だけを採用する', async () => {
    const { result } = await mount();
    let first!: Promise<void>, second!: Promise<void>;
    act(() => {
      first = result.current.refetch();
      second = result.current.refetch();
    });
    await act(async () => {
      requests[2].resolve(response(1, 7));
      await second;
    });
    await act(async () => {
      requests[1].resolve(response(1, 9));
      await first;
    });
    expect(result.current.total).toBe(7);
  });
  it('unmount後の旧応答は再mountの状態へ影響しない', async () => {
    const first = await mount();
    act(() => first.result.current.setPage(2));
    first.unmount();
    const second = renderHook(() => useAnnouncements('faq'));
    await act(async () => requests[2].resolve(response(1, 5, [{ ...items[0], id: 'new' }])));
    await act(async () => requests[1].resolve(response(2)));
    expect(second.result.current.items[0].id).toBe('new');
    expect(second.result.current.total).toBe(5);
  });
});
