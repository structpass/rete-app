import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * d754: 共有（FL）の生成で運ぶ側が遭った理由を、画面が一律の「作成に失敗しました」に
 * 置き換えて捨てていた。理由をそのまま返すこと（取れなければ固定文言へ縮退）を固定する。
 */
const createChatThreadFromFiles = vi.hoisted(() => vi.fn());
const createTaskFromFiles = vi.hoisted(() => vi.fn());
const fetchCategories = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, createChatThreadFromFiles, createTaskFromFiles, fetchCategories };
});

import { useFileShare } from '../use-file-share';

const serverError = (message: string) => ({
  response: { data: { error: { code: 'CONFLICT', message } } },
});

beforeEach(() => {
  vi.clearAllMocks();
  createChatThreadFromFiles.mockResolvedValue({ id: 'thread-1' });
  createTaskFromFiles.mockResolvedValue({ id: 'task-1' });
  fetchCategories.mockResolvedValue([{ id: 1, name: '一般' }]);
});

describe('useFileShare — 作成できなかった理由（d754）', () => {
  it('チャット共有が失敗した時はサーバーが返した理由を返す', async () => {
    createChatThreadFromFiles.mockRejectedValue(
      serverError('チャットテーマを作成する権限がありません'),
    );
    const { result } = renderHook(() => useFileShare('chat'));

    let res: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      res = await result.current.submit({ title: '見積', description: '' });
    });

    expect(res).toEqual({ ok: false, reason: 'チャットテーマを作成する権限がありません' });
    expect(result.current.submitting).toBe(false);
  });

  it('タスク共有が失敗した時も理由を返す', async () => {
    createTaskFromFiles.mockRejectedValue(serverError('タスクの上限に達しています'));
    const { result } = renderHook(() => useFileShare('task'));
    await waitFor(() => expect(result.current.categoriesLoading).toBe(false));

    let res: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      res = await result.current.submit({ title: '見積', description: '', categoryId: 1 });
    });

    expect(res).toEqual({ ok: false, reason: 'タスクの上限に達しています' });
  });

  it('理由を取れない失敗は固定文言へ縮退する', async () => {
    createChatThreadFromFiles.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useFileShare('chat'));

    let res: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      res = await result.current.submit({ title: '見積', description: '' });
    });

    expect(res).toEqual({ ok: false, reason: '作成に失敗しました' });
  });

  it('カテゴリ未選択でも黙って失敗せず理由を返す', async () => {
    const { result } = renderHook(() => useFileShare('task'));
    await waitFor(() => expect(result.current.categoriesLoading).toBe(false));

    let res: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      res = await result.current.submit({ title: '見積', description: '' });
    });

    expect(res).toEqual({ ok: false, reason: 'カテゴリを選択してください' });
    expect(createTaskFromFiles).not.toHaveBeenCalled();
  });

  it('成功時は { ok: true } を返す', async () => {
    const { result } = renderHook(() => useFileShare('chat'));

    let res: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      res = await result.current.submit({ title: '見積', description: '' });
    });

    expect(res).toEqual({ ok: true });
  });
});

describe('useFileShare — カテゴリ取得失敗の理由（d754）', () => {
  it('取得に失敗した時は理由を categoriesErrorReason に載せる', async () => {
    fetchCategories.mockRejectedValue(serverError('機能領域分類の参照権限がありません'));
    const { result } = renderHook(() => useFileShare('task'));

    await waitFor(() => expect(result.current.categoriesLoading).toBe(false));
    expect(result.current.categoriesError).toBe(true);
    expect(result.current.categoriesErrorReason).toBe('機能領域分類の参照権限がありません');
  });

  it('理由を取れない失敗は固定文言へ縮退する', async () => {
    fetchCategories.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useFileShare('task'));

    await waitFor(() => expect(result.current.categoriesLoading).toBe(false));
    expect(result.current.categoriesErrorReason).toBe('カテゴリの取得に失敗しました');
  });
});
