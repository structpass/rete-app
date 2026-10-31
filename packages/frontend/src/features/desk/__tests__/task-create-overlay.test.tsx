import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskStatus } from '@rete/shared';
import { TaskCreateOverlay } from '../components/task-create-overlay';
import type { Category } from '@/features/tasks/lib/api';

// cmn-0142: vi.hoisted 化
const { mockUsePendingAttachments } = vi.hoisted(() => ({
  mockUsePendingAttachments: vi.fn(),
}));

vi.mock('../hooks/use-pending-attachments', () => ({
  usePendingAttachments: mockUsePendingAttachments,
}));

import { usePendingAttachments } from '../hooks/use-pending-attachments';

const mockUsePending = vi.mocked(usePendingAttachments);

function mockPending(
  pending: { fileId: string; fileName: string; source: 'repo' | 'local' }[] = [],
) {
  mockUsePending.mockReturnValue({
    pending,
    add: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    count: pending.length,
  });
}

const categories: Category[] = [
  {
    id: 1,
    name: '入荷',
    sortOrder: 0,
    archived: false,
    spaceId: 's1',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 2,
    name: '出荷',
    sortOrder: 1,
    archived: false,
    spaceId: 's1',
    createdAt: '',
    updatedAt: '',
  },
];

// cmn-0225: mockPending([]) をファイル直下の beforeEach へ引き上げ、promote describe にも効かせる。
// 設定側で mockReset/restoreMocks が効くため、describe 内の戻り値仕込みは毎回白紙化される。
beforeEach(() => {
  mockPending([]);
});

function renderCreate(overrides: Partial<React.ComponentProps<typeof TaskCreateOverlay>> = {}) {
  return render(
    <TaskCreateOverlay
      variant="create"
      categories={categories}
      saving={false}
      error={null}
      onClose={vi.fn()}
      onSubmit={vi.fn()}
      {...overrides}
    />,
  );
}

describe('TaskCreateOverlay — 新規登録（variant=create / mock .is-creating）', () => {
  it('添付だけの変更も報告し、添付を外すと未編集へ戻る', () => {
    const onDirtyChange = vi.fn();
    const { rerender } = renderCreate({ onDirtyChange });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    mockPending([{ fileId: 'f1', fileName: 'spec.txt', source: 'repo' }]);
    rerender(
      <TaskCreateOverlay
        variant="create"
        categories={categories}
        saving={false}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    mockPending([]);
    rerender(
      <TaskCreateOverlay
        variant="create"
        categories={categories}
        saving={false}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it('題名入力欄・説明欄・保存ボタンを表示すること', () => {
    renderCreate();
    // 題名はチャット明細（ThemeComposer）と同型で placeholder="タイトル"（dsk-0347）。
    const title = screen.getByLabelText('題名');
    expect(title).toBeInTheDocument();
    expect(title).toHaveAttribute('placeholder', 'タイトル');
    expect(screen.getByLabelText('説明')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
  });

  // dsk-0349: 説明欄コンポーザフッタにも「ファイル添付」が出る（右列と同一 pending 共有）。
  it('説明欄コンポーザのフッタに「ファイル添付」ボタンを表示すること（dsk-0349）', () => {
    const { container } = renderCreate();
    const composer = container.querySelector('.desk-global-input-composer');
    expect(composer).not.toBeNull();
    const footerBtns = Array.from(
      composer!.querySelectorAll('.desk-global-input-footer button'),
    ).map((b) => b.textContent?.replace(/\s+/g, '') ?? '');
    expect(footerBtns.some((t) => t.includes('ファイル添付'))).toBe(true);
    // 右列「ファイル」欄の添付トリガも残る（二重入口・同一 hook 共有）。
    expect(
      Array.from(container.querySelectorAll('button')).filter((b) =>
        (b.textContent ?? '').includes('ファイル添付'),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * dsk-0379: 右列「ファイル」ラベル直下の保留チップは is-flush（border-top 無し）。
   * 左コンポーザのチップ行は本文との境を示すため flush しない。
   */
  it('右列ファイル欄の保留チップは is-flush、左コンポーザは非 flush（dsk-0379）', () => {
    mockPending([{ fileId: 'f1', fileName: 'spec.txt', source: 'repo' }]);
    const { container } = renderCreate();
    const rightField = Array.from(container.querySelectorAll('.desk-detail-info-field')).find(
      (el) => (el.querySelector('.desk-detail-info-label')?.textContent || '').includes('ファイル'),
    );
    expect(rightField).toBeTruthy();
    const rightChips = rightField!.querySelector('.desk-pending-chips');
    expect(rightChips).not.toBeNull();
    expect(rightChips).toHaveClass('is-flush');

    const leftChips = container.querySelector('.desk-global-input-composer .desk-pending-chips');
    expect(leftChips).not.toBeNull();
    expect(leftChips).not.toHaveClass('is-flush');
  });

  it('スレッドタブのみ表示し、顛末 / 履歴タブは出さないこと', () => {
    renderCreate();
    expect(screen.getByRole('tab', { name: 'スレッド' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '顛末' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '履歴' })).not.toBeInTheDocument();
  });

  it('分類 / ステータスに ※必須 を表示しないこと（分類は任意・ステータスは初期値付き / rete-desk-0184・0185）', () => {
    renderCreate();
    expect(screen.queryByText('※必須')).not.toBeInTheDocument();
  });

  it('題名はサーバが空を拒否するため必須として出すこと（正本 comp-form-field の「* 必須」）', () => {
    renderCreate();
    // 必須マークは題名欄の近くに出し、入力は aria-required で読み上げにも必須を伝える。
    const mark = document.querySelector('.desk-ticket-required');
    expect(mark?.textContent?.replace(/\s+/g, '')).toBe('*必須');
    expect(screen.getByLabelText('題名')).toHaveAttribute('aria-required', 'true');
  });

  it('is-creating の detail ビューとして描画すること（A1 ルーティング）', () => {
    const { container } = renderCreate();
    const view = container.querySelector('[data-left-view="detail"]');
    expect(view).not.toBeNull();
    expect(view).toHaveClass('is-creating');
  });

  it('コメント返信 composer は表示しないこと', () => {
    renderCreate();
    expect(screen.queryByPlaceholderText(/スレッドに返信/)).not.toBeInTheDocument();
  });

  it('題名と分類を満たして submit すると onSubmit に正規化値が渡ること', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderCreate({ onSubmit });

    await userEvent.type(screen.getByLabelText('題名'), '新しいタスク');
    // 共通 Select（mdl-0030: native <select> → Select 移行）の操作系に置換。
    await userEvent.click(screen.getByLabelText('分類', { exact: false }));
    await userEvent.click(screen.getByRole('option', { name: '入荷' }));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const data = onSubmit.mock.calls[0][0];
    expect(data.title).toBe('新しいタスク');
    expect(data.categoryId).toBe('1');
    expect(data.status).toBe(TaskStatus.TODO);
  });

  it('分類 select に「未分類」(空 value) + 渡された分類のみを並べること（rete-desk-0158）', async () => {
    renderCreate();
    // 共通 Select（mdl-0030）: トリガー（button）の textContent が「（未分類）」= 未選択状態であることを検証。
    const trigger = screen.getByLabelText('分類', { exact: false });
    expect(trigger).toHaveTextContent('（未分類）');
    // 選択肢は trigger クリックで開いてから option role で列挙する。
    await userEvent.click(trigger);
    const optionTexts = screen.getAllByRole('option').map((o) => o.textContent);
    // 先頭の「未分類」(空 value) + 選択中 Space の分類のみ。
    expect(optionTexts).toEqual(['（未分類）', '入荷', '出荷']);
    // 値（空 value）の存在確認は option role のテキスト内容で判定（共通 Select の SelectItem は
    // 内部 value を data 属性で公開しないため、テキストが「（未分類）」の option が空 value 項目）。
    expect(screen.getByRole('option', { name: '（未分類）' })).toBeInTheDocument();
  });

  it('分類を未選択（未分類）のまま submit すると categoryId が空文字で渡ること（rete-desk-0158）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderCreate({ onSubmit });

    await userEvent.type(screen.getByLabelText('題名'), '未分類タスク');
    // 分類は未選択（既定の「未分類」= 空 value）のまま送る。
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].categoryId).toBe('');
  });

  it('題名未入力では検証エラーを出し onSubmit を呼ばないこと', async () => {
    const onSubmit = vi.fn();
    renderCreate({ onSubmit });

    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('タイトルは必須です')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('dsk-0239: 親コード該当なし状態で新規登録すると onSubmit を呼ばずインラインエラーを表示すること', async () => {
    const onSubmit = vi.fn();
    renderCreate({ onSubmit, parentTasks: [{ id: 10, title: '親A', categoryId: 1 }] });

    await userEvent.type(screen.getByLabelText('題名'), 'チケット');
    // 候補に存在しない親 No（画面上は「該当なし」）。
    await userEvent.type(screen.getByLabelText('親タスクのチケットNo'), '999');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('親タスクが存在しません')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('dsk-0239: 正しい親コードなら従来通り onSubmit が呼ばれること', async () => {
    const onSubmit = vi.fn().mockResolvedValue(1);
    renderCreate({ onSubmit, parentTasks: [{ id: 10, title: '親A', categoryId: 1 }] });

    await userEvent.type(screen.getByLabelText('題名'), 'チケット');
    await userEvent.type(screen.getByLabelText('親タスクのチケットNo'), '10');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('閉じる × で onClose を呼ぶこと', () => {
    const onClose = vi.fn();
    renderCreate({ onClose });
    fireEvent.click(screen.getByLabelText('閉じる'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('TaskCreateOverlay — 昇格（variant=promote / detail 編集モードに整合）', () => {
  function renderPromote(overrides: Partial<React.ComponentProps<typeof TaskCreateOverlay>> = {}) {
    return render(
      <TaskCreateOverlay
        variant="promote"
        categories={categories}
        saving={false}
        error={null}
        defaultValues={{ title: '元テーマ題名', description: '元の説明', categoryId: '2' }}
        parentLabel="子タスクとして挿入"
        sourceThemeTitle="元になった会話"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        {...overrides}
      />,
    );
  }

  it('promote の data-left-view は "promote"（A1 状態機械のルーティング）', () => {
    const { container } = renderPromote();
    expect(container.querySelector('[data-left-view="promote"]')).not.toBeNull();
  });

  it('テーマ題名 / 説明 / 分類をプリフィルすること', () => {
    renderPromote();
    expect(screen.getByDisplayValue('元テーマ題名')).toBeInTheDocument();
    // 説明はリッチエディタ（contenteditable）。getByDisplayValue は効かないため本文 textContent で検証。
    expect(screen.getByLabelText('説明')).toHaveTextContent('元の説明');
    // 共通 Select（mdl-0030）: 選択中ラベル（出荷）が出ているかで初期値を検証。
    expect(screen.getByLabelText('分類')).toHaveTextContent('出荷');
  });

  it('挿入位置ラベルと元チャット題名を読み取り表示すること', () => {
    renderPromote();
    expect(screen.getByText('子タスクとして挿入')).toBeInTheDocument();
    expect(screen.getByText('元になった会話')).toBeInTheDocument();
  });

  it('※必須 は出さない（detail 編集モード相当）', () => {
    renderPromote();
    expect(screen.queryByText('※必須')).not.toBeInTheDocument();
  });

  it('submit で onSubmit にフォーム値が渡ること（保存ボタン）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderPromote({ onSubmit });

    // 昇格の確定ボタンも「保存」に統一（rete-desk-0176）。
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].title).toBe('元テーマ題名');
  });
});
