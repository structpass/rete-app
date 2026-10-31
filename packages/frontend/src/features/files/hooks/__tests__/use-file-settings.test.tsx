import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// hook が依存する api アダプタだけをモックし、フォーム状態・正規化・保存の往復を検証する
// （画面側は use-file-settings をモックしているため、hook 自身の振る舞いはここで固定する）。
const fetchFileSettings = vi.hoisted(() => vi.fn());
const updateFileSettings = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, fetchFileSettings, updateFileSettings };
});

import { useFileSettings } from '../use-file-settings';

const loaded = {
  maxSizeMb: 10,
  allowedExtensions: ['.pdf'],
  fixedRejectedExtensions: ['.exe', '.dll', '.msi', '.scr', '.com'],
  rejectedExtensions: ['.ps1', '.sh'],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchFileSettings.mockResolvedValue(loaded);
  updateFileSettings.mockResolvedValue(loaded);
});

describe('useFileSettings — 拡張子を1件ずつ扱う（v2-203）', () => {
  it('取得値を配列のまま保持する（カンマ区切りのテキストへ潰さない）', async () => {
    const { result } = renderHook(() => useFileSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.allowedExtensions).toEqual(['.pdf']);
    expect(result.current.rejectedExtensions).toEqual(['.ps1', '.sh']);
    expect(result.current.fixedRejectedExtensions).toEqual([
      '.exe',
      '.dll',
      '.msi',
      '.scr',
      '.com',
    ]);
    expect(result.current.dirty).toBe(false);
  });

  it('入力が「xxxx」でも「.xxxx」として足す（要求コメントのドット付与）', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res: ReturnType<typeof result.current.addAllowedExtension> | undefined;
    act(() => {
      res = result.current.addAllowedExtension('csv');
    });

    expect(res).toBe('added');
    expect(result.current.allowedExtensions).toEqual(['.pdf', '.csv']);
    expect(result.current.dirty).toBe(true);
  });

  it('大文字は小文字化して足す', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addRejectedExtension('.ZIP');
    });

    expect(result.current.rejectedExtensions).toEqual(['.ps1', '.sh', '.zip']);
  });

  it('既にある拡張子は足さず duplicate を返す（大文字小文字を問わない）', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res: ReturnType<typeof result.current.addAllowedExtension> | undefined;
    act(() => {
      res = result.current.addAllowedExtension('.PDF');
    });

    expect(res).toBe('duplicate');
    expect(result.current.allowedExtensions).toEqual(['.pdf']);
    expect(result.current.dirty).toBe(false);
  });

  it('空文字は足さず invalid を返す', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res: ReturnType<typeof result.current.addAllowedExtension> | undefined;
    act(() => {
      res = result.current.addAllowedExtension('   ');
    });

    expect(res).toBe('invalid');
    expect(result.current.allowedExtensions).toEqual(['.pdf']);
  });

  it('貼り付けたカンマ区切りは1件ずつに分けて足す（取りこぼさない）', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addAllowedExtension('.csv, .txt');
    });

    expect(result.current.allowedExtensions).toEqual(['.pdf', '.csv', '.txt']);
  });

  it('✕ の解除は指定した1件だけを外す（他は残る）', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.removeRejectedExtension('.ps1');
    });

    expect(result.current.rejectedExtensions).toEqual(['.sh']);
    expect(result.current.dirty).toBe(true);
  });

  it('追加した順に並べる（並びは操作の結果として決まる）', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addAllowedExtension('.md');
    });
    act(() => {
      result.current.addAllowedExtension('.csv');
    });

    expect(result.current.allowedExtensions).toEqual(['.pdf', '.md', '.csv']);
  });
});

describe('useFileSettings — 保存と破棄（v2-203）', () => {
  it('保存で配列のまま送る（テキスト→配列の再変換を挟まない）', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addAllowedExtension('.csv');
    });
    act(() => {
      result.current.removeRejectedExtension('.ps1');
    });
    await act(async () => {
      await result.current.save();
    });

    expect(updateFileSettings).toHaveBeenCalledWith({
      maxSizeMb: 10,
      allowedExtensions: ['.pdf', '.csv'],
      fixedRejectedExtensions: ['.exe', '.dll', '.msi', '.scr', '.com'],
      rejectedExtensions: ['.sh'],
    });
  });

  it('保存後は正規化済みの保存値を基準にし、dirty が false へ戻る', async () => {
    updateFileSettings.mockResolvedValue({
      ...loaded,
      allowedExtensions: ['.pdf', '.csv'],
      rejectedExtensions: ['.sh'],
    });
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addAllowedExtension('.csv');
    });
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.allowedExtensions).toEqual(['.pdf', '.csv']);
    expect(result.current.rejectedExtensions).toEqual(['.sh']);
    expect(result.current.dirty).toBe(false);
  });

  it('キャンセル（reset）は保存せず、追加・解除した分を取得値へ戻す（要求の 5）', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addAllowedExtension('.csv');
    });
    act(() => {
      result.current.removeRejectedExtension('.ps1');
    });
    expect(result.current.dirty).toBe(true);

    act(() => result.current.reset());

    expect(result.current.allowedExtensions).toEqual(['.pdf']);
    expect(result.current.rejectedExtensions).toEqual(['.ps1', '.sh']);
    expect(result.current.dirty).toBe(false);
    // 破棄は API を叩かない（保存ボタンを押すまで確定しない、という要求の 4）。
    expect(updateFileSettings).not.toHaveBeenCalled();
  });

  it('保存失敗時は値を捨てず、理由を返す（v2-198 の理由も維持）', async () => {
    updateFileSettings.mockRejectedValue({
      response: {
        data: {
          error: {
            message: 'Validation failed',
            details: { validationErrors: ['拡張子は ".pdf" の形式で指定してください'] },
          },
        },
      },
    });
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.addAllowedExtension('.csv');
    });
    let res: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      res = await result.current.save();
    });

    expect(res).toEqual({ ok: false, reason: '拡張子は ".pdf" の形式で指定してください' });
    // 失敗しても入力は残す（やり直せる）。
    expect(result.current.allowedExtensions).toEqual(['.pdf', '.csv']);
    expect(result.current.dirty).toBe(true);
  });
});

describe('useFileSettings — 保存失敗の理由（v2-198）', () => {
  it('成功時は { ok: true } を返す', async () => {
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      res = await result.current.save();
    });

    expect(res).toEqual({ ok: true });
  });

  it('検証エラー（details.validationErrors）の日本語理由を返す', async () => {
    updateFileSettings.mockRejectedValue({
      response: {
        data: {
          error: {
            message: 'Validation failed',
            details: { validationErrors: ['拡張子は ".pdf" の形式で指定してください'] },
          },
        },
      },
    });
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      res = await result.current.save();
    });

    expect(res).toEqual({ ok: false, reason: '拡張子は ".pdf" の形式で指定してください' });
  });

  it('理由を取れない失敗は固定文言へ縮退する（空の reason を返さない）', async () => {
    updateFileSettings.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useFileSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      res = await result.current.save();
    });

    expect(res).toEqual({ ok: false, reason: '設定の保存に失敗しました' });
  });
});

describe('useFileSettings — 読み込み失敗の理由（d754）', () => {
  it('取得に失敗した時はサーバーが返した理由を loadErrorReason に載せる', async () => {
    fetchFileSettings.mockRejectedValue({
      response: { data: { error: { message: '設定の参照権限がありません' } } },
    });
    const { result } = renderHook(() => useFileSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.loadErrorReason).toBe('設定の参照権限がありません');
  });

  it('理由を取れない失敗は固定文言へ縮退する（空の文言を出さない）', async () => {
    fetchFileSettings.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useFileSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadErrorReason).toBe('設定の読み込みに失敗しました');
  });
});
