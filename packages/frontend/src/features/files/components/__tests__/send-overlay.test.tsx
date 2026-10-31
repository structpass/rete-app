import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * d754: 共有（FL）の生成・設定の取得で運ぶ側が遭った理由を、画面が一律の文言に
 * 置き換えて捨てていた。理由をそのまま出すことを固定する。
 *
 * 本体（SendOverlayBody）だけを描く。枠（OverlayDialog）は focus trap などの振る舞いを持ち、
 * ここで確かめたいのは文言の出し分けなので、破棄確認の判定は外から渡す。
 */
const useFileShare = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/use-file-share', () => ({ useFileShare }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));

// 説明欄の RichTextEditor（Tiptap）はここでの対象外なので、素の textarea に置き換える。
vi.mock('@/features/desk/components/rich-text-editor', () => ({
  RichTextEditor: () => <textarea aria-label="説明" />,
}));

// 枠（OverlayDialog）の閉じる操作（OverlayCloseButton）は枠の中でしか動かないため、
// 本体だけを描けるよう素のボタンに置き換える（押した時の振る舞いは枠側の担当）。
vi.mock('@/components/ui/overlay-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/overlay-dialog')>();
  return {
    ...actual,
    OverlayCloseButton: ({ children, ...rest }: { children?: React.ReactNode }) => (
      <button type="button" {...rest}>
        {children}
      </button>
    ),
  };
});

import { SendOverlayBody } from '../send-overlay';

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    categories: [],
    categoriesLoading: false,
    categoriesError: false,
    categoriesErrorReason: '',
    submitting: false,
    submit: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

const renderBody = () =>
  render(
    <SendOverlayBody
      target="chat"
      links={[{ kind: 'file', path: '/a/b.txt', label: 'ファイル' }]}
      overflow={0}
      onClose={() => {}}
      dirty={false}
      submitting={false}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  useFileShare.mockReturnValue(makeShare());
});

describe('共有の作成に失敗した時（d754）', () => {
  it('サーバーが返した理由をそのまま出す（一律の「作成に失敗しました」に置き換えない）', async () => {
    useFileShare.mockReturnValue(
      makeShare({
        submit: vi
          .fn()
          .mockResolvedValue({ ok: false, reason: 'チャットテーマを作成する権限がありません' }),
      }),
    );
    const user = userEvent.setup();
    renderBody();

    await user.type(screen.getByLabelText(/タイトル/), '見積');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('チャットテーマを作成する権限がありません'),
    );
    expect(toast.error).not.toHaveBeenCalledWith('作成に失敗しました');
  });

  it('成功した時は成功を知らせ、失敗の知らせは出さない', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <SendOverlayBody
        target="chat"
        links={[]}
        overflow={0}
        onClose={onClose}
        dirty={false}
        submitting={false}
      />,
    );

    await user.type(screen.getByLabelText(/タイトル/), '見積');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('カテゴリの取得に失敗した時（d754）', () => {
  it('取得の理由を出したうえで、共有できないことを伝える', () => {
    useFileShare.mockReturnValue(
      makeShare({
        categoriesError: true,
        categoriesErrorReason: '機能領域分類の参照権限がありません',
      }),
    );
    render(
      <SendOverlayBody
        target="task"
        links={[]}
        overflow={0}
        onClose={() => {}}
        dirty={false}
        submitting={false}
      />,
    );

    expect(
      screen.getByText('機能領域分類の参照権限がありません。タスクで共有できません。'),
    ).toBeInTheDocument();
  });
});
