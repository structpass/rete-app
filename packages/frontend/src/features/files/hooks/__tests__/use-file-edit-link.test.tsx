import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderHook, waitFor } from '@testing-library/react';

// メタ取得 API・toast をモックし、deep link（fileId）→ フォルダ遷移 + 編集オーバーレイ起動を検証する。
// cmn-0147: vi.hoisted 化（factory クロージャ参照を構造的に hoist）
// 旧 level（VIEW）による openEdit 抑止は ADR 0063（fil-0139）で撤廃＝可視 space なら常に編集可。
const { fetchFileMeta, toastError } = vi.hoisted(() => ({
  fetchFileMeta: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  fetchFileMeta: (...a: unknown[]) => fetchFileMeta(...a),
}));
vi.mock('react-hot-toast', () => ({
  default: { error: (...a: unknown[]) => toastError(...a) },
}));

import { useFileEditLink } from '../use-file-edit-link';

beforeEach(() => {
  fetchFileMeta.mockReset();
  toastError.mockReset();
});

describe('useFileEditLink', () => {
  it('fileId=null では何もしない（メタ取得を呼ばない）', () => {
    const selectFolder = vi.fn();
    const openEdit = vi.fn();
    renderHook(() => useFileEditLink(null, selectFolder, openEdit));
    expect(fetchFileMeta).not.toHaveBeenCalled();
    expect(openEdit).not.toHaveBeenCalled();
  });

  it('fileId が来たらメタ解決 → 所属フォルダ遷移 → 編集オーバーレイ起動する', async () => {
    fetchFileMeta.mockResolvedValue({
      id: 'file-9',
      name: 'report.docx',
      folderId: 'folder-3',
      versionNo: 2,
    });
    const selectFolder = vi.fn();
    const openEdit = vi.fn();
    renderHook(() => useFileEditLink('file-9', selectFolder, openEdit));

    await waitFor(() => expect(openEdit).toHaveBeenCalled());
    expect(fetchFileMeta).toHaveBeenCalledWith('file-9');
    expect(selectFolder).toHaveBeenCalledWith('folder-3');
    expect(openEdit).toHaveBeenCalledWith({ id: 'file-9', name: 'report.docx', versionNo: 2 });
  });

  it('同一 fileId の再レンダーでは二重に解決しない（ref で抑止）', async () => {
    fetchFileMeta.mockResolvedValue({ id: 'file-9', name: 'a', folderId: 'f', versionNo: 1 });
    const selectFolder = vi.fn();
    const openEdit = vi.fn();
    const { rerender } = renderHook(() => useFileEditLink('file-9', selectFolder, openEdit));
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    expect(fetchFileMeta).toHaveBeenCalledTimes(1);
  });

  it('メタ取得失敗時は toast.error を出しオーバーレイを開かない', async () => {
    fetchFileMeta.mockRejectedValue(new Error('not found'));
    const selectFolder = vi.fn();
    const openEdit = vi.fn();
    renderHook(() => useFileEditLink('file-x', selectFolder, openEdit));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(openEdit).not.toHaveBeenCalled();
  });

  // v2-505: 遷移直後は器（space）が未確定で、開いても直後に作り直されて消える。
  // ready=false の間は解決を保留し、ready になったら解決する。
  it('ready=false の間は解決せず、ready になったら解決する（器の確定待ち）', async () => {
    fetchFileMeta.mockResolvedValue({
      id: 'file-9',
      name: 'report.docx',
      folderId: 'folder-3',
      versionNo: 2,
    });
    const selectFolder = vi.fn();
    const openEdit = vi.fn();
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useFileEditLink('file-9', selectFolder, openEdit, ready),
      { initialProps: { ready: false } },
    );
    // 器が未確定の間は API も叩かない。
    expect(fetchFileMeta).not.toHaveBeenCalled();
    expect(openEdit).not.toHaveBeenCalled();

    rerender({ ready: true });
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(1));
    expect(fetchFileMeta).toHaveBeenCalledWith('file-9');
    expect(selectFolder).toHaveBeenCalledWith('folder-3');
  });

  // d564: 「同じファイルを開き直したら再解決する」の約束（実装コメントの 2 つの落とし穴の 1 つ目を
  // 引き起こしていた経路）を、解決が起きる 2 つの場面で確かめる。既存の試験は「二重発火しない」
  // 「1 回だけ開く」を見るもので、再解決そのものが止まっていても緑のままだった。
  it('同じ★を開き直すと、続けて押しても画面を作り直しても再解決する', async () => {
    fetchFileMeta.mockResolvedValue({ id: 'file-9', name: 'a', folderId: 'f', versionNo: 1 });
    const selectFolder = vi.fn();
    const openEdit = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => useFileEditLink(id, selectFolder, openEdit),
      { initialProps: { id: 'file-9' as string | null } },
    );
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(1));

    // 1) 別画面へ移って同じ★を押し直す（fileId は一度 null を経て同じ値へ戻る）。
    rerender({ id: null });
    rerender({ id: 'file-9' });
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(2));
    expect(fetchFileMeta).toHaveBeenCalledTimes(2);
    expect(selectFolder).toHaveBeenCalledTimes(2);

    // 2) 同じ画面を離れずにもう一度 ★ を押す（URL の更新と押下が重なる経路）。
    rerender({ id: null });
    rerender({ id: 'file-9' });
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(3));
    expect(fetchFileMeta).toHaveBeenCalledTimes(3);
    expect(openEdit).toHaveBeenLastCalledWith({ id: 'file-9', name: 'a', versionNo: 1 });
  });

  // d560: 解決済みの印は「URL から fileId が消えたら」外れる。別の画面へ行って戻った同じ★を
  // 続けて押しても開き直せることを、印の解除→同じ fileId の再指示で確認する。
  it('fileId が null に戻ると印を外し、同じ fileId で再び解決する', async () => {
    fetchFileMeta.mockResolvedValue({ id: 'file-9', name: 'a', folderId: 'f', versionNo: 1 });
    const selectFolder = vi.fn();
    const openEdit = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => useFileEditLink(id, selectFolder, openEdit),
      { initialProps: { id: 'file-9' as string | null } },
    );
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(1));

    // URL から fileId が消えた（別画面へ移った）。
    rerender({ id: null });
    expect(fetchFileMeta).toHaveBeenCalledTimes(1);

    // 同じ★を押し直した。
    rerender({ id: 'file-9' });
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(2));
    expect(fetchFileMeta).toHaveBeenCalledTimes(2);
  });

  // 取得の途中で fileId が消えても、戻した時にやり直した1回だけが開く（重複・取りこぼしを残さない）。
  it('取得の途中で fileId が消えて戻っても、開くのは1回だけ', async () => {
    let resolveMeta: (v: unknown) => void = () => {};
    fetchFileMeta.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve;
        }),
    );
    const selectFolder = vi.fn();
    const openEdit = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => useFileEditLink(id, selectFolder, openEdit),
      { initialProps: { id: 'file-9' as string | null } },
    );
    expect(fetchFileMeta).toHaveBeenCalledTimes(1);

    // 応答前に URL から消え、すぐ同じ★が押された（合図で undefined の一瞬を挟む）。
    rerender({ id: null });
    rerender({ id: 'file-9' });
    await waitFor(() => expect(fetchFileMeta).toHaveBeenCalledTimes(2));

    // 先に走った（取り消された）応答が後から届いても開かない。
    resolveMeta({ id: 'file-9', name: 'a', folderId: 'f', versionNo: 1 });
    await waitFor(() => expect(openEdit).toHaveBeenCalledTimes(1));
  });
});
