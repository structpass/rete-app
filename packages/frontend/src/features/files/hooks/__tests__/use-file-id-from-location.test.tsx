import { describe, it, expect, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useFileIdFromLocation,
  unlockFileLink,
  FILE_LINK_UNLOCK_EVENT,
} from '../use-file-id-from-location';

// URL の ?fileId= を拾う経路（d560）: 初期表示・popstate・Next の router.push が起こす
// history.pushState / replaceState・同一 fileId の押し直し（UNLOCK 合図）。実 API を差し替えて確認する。
function goToFile(fileId: string | null, method: 'pushState' | 'replaceState' = 'pushState') {
  const url = fileId === null ? '/files' : `/files?fileId=${fileId}`;
  act(() => {
    window.history[method]({}, '', url);
  });
}

describe('useFileIdFromLocation', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/files');
  });

  it('初期表示で URL の fileId を返す', () => {
    window.history.replaceState({}, '', '/files?fileId=f-1');
    const { result } = renderHook(() => useFileIdFromLocation());
    expect(result.current).toBe('f-1');
  });

  it('pushState での URL 変化を拾う（popstate は飛ばない）', () => {
    const { result } = renderHook(() => useFileIdFromLocation());
    expect(result.current).toBeNull();
    goToFile('f-2');
    expect(result.current).toBe('f-2');
  });

  it('replaceState での URL 変化も拾う', () => {
    const { result } = renderHook(() => useFileIdFromLocation());
    goToFile('f-3', 'replaceState');
    expect(result.current).toBe('f-3');
  });

  it('fileId が消えたら null に戻す（呼出元が解決済みを解除できる）', () => {
    window.history.replaceState({}, '', '/files?fileId=f-1');
    const { result } = renderHook(() => useFileIdFromLocation());
    expect(result.current).toBe('f-1');
    goToFile(null);
    expect(result.current).toBeNull();
  });

  it('戻る/進む（popstate）でも更新する', () => {
    const { result } = renderHook(() => useFileIdFromLocation());
    act(() => {
      window.history.pushState({}, '', '/files?fileId=f-4');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current).toBe('f-4');
  });

  it('同じ fileId の押し直し（UNLOCK 合図）でもう一度同じ値を渡す', async () => {
    window.history.replaceState({}, '', '/files?fileId=f-5');
    const seen: (string | null)[] = [];
    renderHook(() => {
      const v = useFileIdFromLocation();
      seen.push(v);
      return v;
    });
    seen.length = 0;
    act(() => {
      unlockFileLink('f-5');
    });
    // 値が変わらないと再描画されないため、null を経て同じ値に戻る（＝呼出元が再解決する）ことを確かめる。
    // 戻すのは遷移（Next の URL 更新）より後・次のフレームなので、そこまで待つ。
    await waitFor(() => expect(seen).toEqual([null, 'f-5']));
  });

  it('URL と食い違う合図は無視する（押し直しは URL が揃っている時だけ扱う）', async () => {
    window.history.replaceState({}, '', '/files?fileId=old');
    const { result } = renderHook(() => useFileIdFromLocation());
    expect(result.current).toBe('old');
    // 古い対象の合図（URL は既に別の対象を示している）。ここで押された側を優先すると
    // URL と表示が食い違ったまま固定される。
    const scheduled = vi.fn();
    const raw = window.requestAnimationFrame.bind(window);
    const spy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((f) => {
      scheduled();
      return raw(f);
    });
    try {
      act(() => {
        unlockFileLink('other');
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(result.current).toBe('old');
      // 古い対象の再解決（null を挟んで戻す）も起きない。
      expect(scheduled).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('同じ URL への遷移が合図の後に重なっても、その対象が残る（予約の取り消し・重複を起こさない）', async () => {
    // 画面が同じ URL を開いている状態で★を押し直す（合図は対象と URL が揃う）→ Next が URL を
    // 同じ値で更新する。URL 読み直しで予約を取り消すと再解決が消え、取り消さないと古い予約が
    // 後から別の値を戻し得る。どちらでも「対象が残り、読み直し後も URL の値と一致する」ことが正しい。
    window.history.replaceState({}, '', '/files?fileId=f-7');
    const { result } = renderHook(() => useFileIdFromLocation());
    expect(result.current).toBe('f-7');
    act(() => {
      unlockFileLink('f-7');
      window.history.pushState({}, '', '/files?fileId=f-7');
    });
    await waitFor(() => expect(result.current).toBe('f-7'));
    // 予約が残って後から別の値へ切り替わらない（待っても同じ値）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBe('f-7');
  });

  it('画面が URL を見ていない時の合図は捨てる（遷移の後に古い対象へ戻さない）', async () => {
    // 押下時点で File 画面はまだ無く、URL は前のお気に入り（old）のまま。遷移で URL が new に確定した
    // 後に、届いていた合図が処理される。ここで押された対象を優先すると URL（new）と表示（old）が食い違う。
    window.history.replaceState({}, '', '/files?fileId=old');
    const { result } = renderHook(() => useFileIdFromLocation());
    expect(result.current).toBe('old');

    act(() => {
      // 合図 → 直後に遷移（Next が URL を更新）→ 合図が画面へ届く。
      window.dispatchEvent(new CustomEvent(FILE_LINK_UNLOCK_EVENT, { detail: { fileId: 'old' } }));
      window.history.pushState({}, '', '/files?fileId=new');
    });
    // 遅れて戻る値が無いので、URL の new がそのまま残る。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBe('new');
  });

  it('URL 遷移の後に別の対象の合図が届いても、URL の値へ戻る（古い対象を固定しない）', async () => {
    window.history.replaceState({}, '', '/files');
    const { result } = renderHook(() => useFileIdFromLocation());

    act(() => {
      // 遷移先の URL が先に確定した後で、前の対象の合図が届く。
      window.history.pushState({}, '', '/files?fileId=y');
    });
    expect(result.current).toBe('y');
    act(() => {
      window.dispatchEvent(new CustomEvent(FILE_LINK_UNLOCK_EVENT, { detail: { fileId: 'x' } }));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBe('y');
  });

  it('外れたら history の API を元に戻す（他画面の遷移を包んだまま残さない）', () => {
    const originalPush = window.history.pushState;
    const { unmount } = renderHook(() => useFileIdFromLocation());
    expect(window.history.pushState).not.toBe(originalPush);
    unmount();
    expect(window.history.pushState).toBe(originalPush);
  });

  it('StrictMode（mount→cleanup→mount）でも購読と復元が破綻しない', async () => {
    const originalPush = window.history.pushState;
    window.history.replaceState({}, '', '/files?fileId=f-8');
    const { result, unmount } = renderHook(() => useFileIdFromLocation(), {
      wrapper: StrictMode,
    });
    expect(result.current).toBe('f-8');
    act(() => {
      unlockFileLink('f-8');
    });
    await waitFor(() => expect(result.current).toBe('f-8'));
    unmount();
    expect(window.history.pushState).toBe(originalPush);
  });
});
