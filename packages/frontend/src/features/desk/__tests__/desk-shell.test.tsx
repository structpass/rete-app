import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskStatus, ChatThemeStatus } from '@rete/shared';
import type { ChatThemeSummary, ChatThemeDetail, DeskTaskTree } from '../lib/api';
import type { Task, Category } from '@/features/tasks/lib/api';
import type { PromoteDraft, UseChatPromotionResult } from '../hooks/use-chat-promotion';

// ---- desk lib/api（チャット + タスクツリー / 昇格）をモック ----
// cmn-0147: vi.hoisted 化（factory クロージャ参照を構造的に hoist）
const {
  fetchChatThemes,
  fetchChatThemeDetail,
  createChatTheme,
  postChatMessage,
  fetchTaskTree,
  fetchTaskDetail,
  updateTask,
  promoteChatToTask,
  moveTask,
  updateChatTheme,
  deleteChatTheme,
  toggleMessageReaction,
  toggleThemeReaction,
  fetchDeskPreference,
  saveDeskPreference,
} = vi.hoisted(() => ({
  fetchChatThemes: vi.fn(),
  fetchChatThemeDetail: vi.fn(),
  createChatTheme: vi.fn(),
  postChatMessage: vi.fn(),
  fetchTaskTree: vi.fn(),
  fetchTaskDetail: vi.fn(),
  updateTask: vi.fn(),
  promoteChatToTask: vi.fn(),
  moveTask: vi.fn(),
  updateChatTheme: vi.fn(),
  deleteChatTheme: vi.fn(),
  toggleMessageReaction: vi.fn(),
  toggleThemeReaction: vi.fn(),
  fetchDeskPreference: vi.fn(),
  saveDeskPreference: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  fetchChatThemes: (...a: unknown[]) => fetchChatThemes(...a),
  fetchChatThemeDetail: (...a: unknown[]) => fetchChatThemeDetail(...a),
  createChatTheme: (...a: unknown[]) => createChatTheme(...a),
  postChatMessage: (...a: unknown[]) => postChatMessage(...a),
  updateChatTheme: (...a: unknown[]) => updateChatTheme(...a),
  deleteChatTheme: (...a: unknown[]) => deleteChatTheme(...a),
  toggleMessageReaction: (...a: unknown[]) => toggleMessageReaction(...a),
  toggleThemeReaction: (...a: unknown[]) => toggleThemeReaction(...a),
  fetchTaskTree: (...a: unknown[]) => fetchTaskTree(...a),
  fetchTaskDetail: (...a: unknown[]) => fetchTaskDetail(...a),
  updateTask: (...a: unknown[]) => updateTask(...a),
  promoteChatToTask: (...a: unknown[]) => promoteChatToTask(...a),
  moveTask: (...a: unknown[]) => moveTask(...a),
  fetchDeskPreference: (...a: unknown[]) => fetchDeskPreference(...a),
  saveDeskPreference: (...a: unknown[]) => saveDeskPreference(...a),
}));

// ---- tasks lib/api（categories のみ実 fetch される）----
const { fetchCategories, fetchAccounts } = vi.hoisted(() => ({
  fetchCategories: vi.fn(),
  fetchAccounts: vi.fn(),
}));
vi.mock('@/features/tasks/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/tasks/lib/api')>();
  return {
    ...actual,
    fetchCategories: (...a: unknown[]) => fetchCategories(...a),
    fetchAccounts: (...a: unknown[]) => fetchAccounts(...a),
  };
});

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

// useSession は SessionProvider 配下でしか動かない（context 不在で throw）。本テストは session 配線の
// 検証対象外（DeskShell の D&D / オーバーレイ遷移が主旨）のため、ログイン中ユーザーをスタブで固定する
// （currentUserId はチャット詳細の起点カード所有判定にだけ使う / rete-desk-0083）。
vi.mock('@/features/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth')>();
  return {
    ...actual,
    useSession: () => ({
      user: {
        id: 'u1',
        email: 'sakuma@example.com',
        name: '佐久間',
        role: 'MEMBER',
      },
      loading: false,
    }),
  };
});

// RichTextEditor は Tiptap（jsdom 非対応の measure 系）を含むため textarea スタブへ差し替える
// （チャット詳細のテーマ編集フォーム等が RTE を mount する。chat-thread.test と同方針）。
vi.mock('../components/rich-text-editor', () => ({
  RichTextEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (html: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

// ---- useChatPromotion を制御可能なスタブに差し替え（drag を介さず promoteDraft を立てる）----
let promotionState: Partial<UseChatPromotionResult>;
// cmn-0147: vi.hoisted 化（factory クロージャ参照を構造的に hoist）
const { savePromotion, cancelPromotion } = vi.hoisted(() => ({
  savePromotion: vi.fn(),
  cancelPromotion: vi.fn(),
}));
vi.mock('../hooks/use-chat-promotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-chat-promotion')>();
  return {
    ...actual,
    useChatPromotion: () => ({
      activeTheme: null,
      indicator: null,
      provisionalRow: null,
      promoteDraft: null,
      saving: false,
      saveError: null,
      onDragStart: vi.fn(),
      onDragMove: vi.fn(),
      onDragEnd: vi.fn(),
      savePromotion,
      cancelPromotion,
      ...promotionState,
    }),
  };
});

import { DeskShell } from '../components/desk-shell';
import { clearAllReplyDrafts } from '../lib/reply-drafts';

const themes: ChatThemeSummary[] = [
  {
    id: 'theme-1',
    title: '入荷の話',
    status: ChatThemeStatus.OPEN,
    archived: false,
    hasTenmatsu: false,
    hasMentionToMe: false,
    hasUnread: false,
    author: { id: 'u1', name: '山田' },
    messageCount: 0,
    lastMessageAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
  },
];

const themeDetail: ChatThemeDetail = {
  id: 'theme-1',
  title: '入荷の話',
  description: '本文',
  tenmatsu: null,
  status: ChatThemeStatus.OPEN,
  archived: false,
  author: { id: 'u1', name: '山田' },
  messages: [],
  reactions: [],
  attachments: [],
  lastMessageAt: '2026-06-01T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

const taskWithSource: Task = {
  id: 10,
  title: '昇格済タスク',
  description: null,
  status: TaskStatus.TODO,
  tenmatsu: null,
  categoryId: 1,
  parentTaskId: null,
  sortOrder: 0,
  sourceThemeId: 'theme-1',
  sourceTheme: { id: 'theme-1', title: '入荷の話' },
  assignee: null,
  ownerId: null,
  owner: null,
  assigneeName: null,
  startDate: null,
  dueDate: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  hasMentionToMe: false,
  reactions: [],
};

const tree: DeskTaskTree = {
  categories: [
    { id: 1, name: '入荷管理', sortOrder: 0, tasks: [{ ...taskWithSource, children: [] }] },
  ],
};

const categories: Category[] = [
  {
    id: 1,
    name: '入荷管理',
    sortOrder: 0,
    archived: false,
    spaceId: 's1',
    createdAt: '',
    updatedAt: '',
  },
];

const draft: PromoteDraft = {
  theme: { id: 'theme-1', title: '入荷の話', description: '本文' },
  target: { parentTaskId: null, afterTaskId: null, categoryId: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  // 書きかけの返信本文はモジュールスコープでテーマごとに保持される（d737）。前のテストの書きかけが
  // 次のテストの開き直しに復元されないよう、テストごとに捨てる。
  clearAllReplyDrafts();
  promotionState = {};
  fetchChatThemes.mockResolvedValue({
    data: themes,
    meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
  });
  fetchChatThemeDetail.mockResolvedValue(themeDetail);
  fetchTaskTree.mockResolvedValue(tree);
  fetchTaskDetail.mockResolvedValue(taskWithSource);
  fetchCategories.mockResolvedValue(categories);
  fetchAccounts.mockResolvedValue([{ id: 'acc-1', name: '田中' }]);
  promoteChatToTask.mockResolvedValue(taskWithSource);
  fetchDeskPreference.mockResolvedValue(null);
  saveDeskPreference.mockResolvedValue({ leftPaneRatio: 0.5 });
});

describe('DeskShell — 昇格フォーム結合', () => {
  // ツリー取得の配線が生きているかを確認する expect(fetchTaskTree) は「待ちではなく配線の smoke」＝
  // dsk-0409 の見張り。以下の `// 配線 smoke（dsk-0409）` はこの意味の短縮形（dsk-0432 L2）。
  it('promoteDraft が立つと昇格フォーム（data-left-view="promote"）を描画すること', async () => {
    promotionState = {
      promoteDraft: draft,
      provisionalRow: { title: '入荷の話', gapIndex: 0, depth: 0 },
    };
    const { container } = render(<DeskShell />);
    // 待つ対象は「fetch が呼ばれた」ではなく検証したい DOM（querySelector は findBy が無いので waitFor 内で見る）。
    await waitFor(() =>
      expect(container.querySelector('[data-left-view="promote"]')).not.toBeNull(),
    );
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
  });

  it('昇格フォームの保存で savePromotion を呼ぶこと', async () => {
    savePromotion.mockResolvedValue(undefined);
    promotionState = {
      promoteDraft: draft,
      provisionalRow: { title: '入荷の話', gapIndex: 0, depth: 0 },
    };
    render(<DeskShell />);

    // 昇格の確定ボタンは「保存」に統一（rete-desk-0176）。
    fireEvent.click(await screen.findByRole('button', { name: '保存' }));
    await waitFor(() => expect(savePromotion).toHaveBeenCalledTimes(1));
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
  });

  it('二重オーバーレイ禁止: promoteDraft があるとタスク詳細を出さないこと', async () => {
    promotionState = { promoteDraft: draft };
    const { container } = render(<DeskShell />);

    // タスク行をクリックしてもタスク詳細（detail）は出ず、promote が優先される。
    fireEvent.click(await screen.findByText('昇格済タスク'));
    await waitFor(() =>
      expect(container.querySelector('[data-left-view="promote"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-left-view="detail"]')).toBeNull();
  });
});

describe('DeskShell — モック挙動パリティ（A1）', () => {
  // ツリー取得の配線が生きているかを確認する expect(fetchTaskTree) は「待ちではなく配線の smoke」＝
  // dsk-0409 の見張り。以下の `// 配線 smoke（dsk-0409）` はこの意味の短縮形（dsk-0432 L2）。
  it('チャットカードを開くとスレッドが出てグローバル入力欄が退避する（is-evacuated）', async () => {
    const { container } = render(<DeskShell />);

    fireEvent.click(await screen.findByRole('button', { name: /入荷の話/ }));
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    expect(await screen.findByLabelText('チャット詳細')).toBeInTheDocument();
    expect(container.querySelector('.desk-global-input.is-evacuated')).not.toBeNull();
  });

  it('同じチャットカードを再クリックするとスレッドが閉じる（トグル）', async () => {
    const { container } = render(<DeskShell />);

    const card = await screen.findByRole('button', { name: /入荷の話/ });
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    fireEvent.click(card);
    expect(await screen.findByLabelText('チャット詳細')).toBeInTheDocument();

    fireEvent.click(card);
    await waitFor(() => expect(container.querySelector('[data-right-view="thread"]')).toBeNull());
  });

  it('Esc でスレッドを閉じても行フォーカスは残し、目印属性で枠のみ抑止する（dsk-0389→dsk-0390）', async () => {
    const { container } = render(<DeskShell />);

    const card = await screen.findByRole('button', { name: /入荷の話/ });
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    fireEvent.click(card);
    card.focus(); // 実ブラウザではクリックで行 button にフォーカスが残る
    expect(await screen.findByLabelText('チャット詳細')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('[data-right-view="thread"]')).toBeNull());
    // Esc（キーボード操作）が行を :focus-visible に昇格させ teal 枠が残留するため、目印属性で
    // CSS が枠を抑止する。フォーカス自体は行に残し ↑↓ 行移動を継続可能に保つ（dsk-0390）。
    expect(document.activeElement).toBe(card);
    expect(card.hasAttribute('data-quiet-focus')).toBe(true);
    // 破棄確認ダイアログへの focus 移動（relatedTarget=alertdialog 内）では目印を維持する。
    // ダイアログ閉時に Radix が行へフォーカスを戻すため、ここで落とすと枠が再発する（HIGH 指摘）。
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    document.body.appendChild(dialog);
    fireEvent.focusOut(card, { relatedTarget: dialog });
    expect(card.hasAttribute('data-quiet-focus')).toBe(true);
    dialog.remove();
    // 実際に行を離れたら目印は除去され、Tab 再到達時は通常の枠に戻る。
    fireEvent.focusOut(card);
    expect(card.hasAttribute('data-quiet-focus')).toBe(false);
  });

  it('選択中の行の再作動（Space/Enter トグル閉じ）でも目印属性で枠を抑止する（dsk-0391）', async () => {
    const { container } = render(<DeskShell />);

    const card = await screen.findByRole('button', { name: /入荷の話/ });
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    fireEvent.click(card);
    card.focus(); // 実ブラウザではクリックで行 button にフォーカスが残る
    expect(await screen.findByLabelText('チャット詳細')).toBeInTheDocument();

    // Space/Enter は focus 中の button を再作動させ click として届く（トグル閉じ）。
    // キーボード作動は行を :focus-visible に昇格させるため、Esc 経路と同じ目印で抑止する。
    fireEvent.click(card);
    await waitFor(() => expect(container.querySelector('[data-right-view="thread"]')).toBeNull());
    expect(card.hasAttribute('data-quiet-focus')).toBe(true);
    fireEvent.focusOut(card);
    expect(card.hasAttribute('data-quiet-focus')).toBe(false);
  });

  it('スレッドを開くと右ペインがオーバーレイ状態（is-overlaid-right）になる', async () => {
    const { container } = render(<DeskShell />);

    fireEvent.click(await screen.findByRole('button', { name: /入荷の話/ }));
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    await screen.findByLabelText('チャット詳細');
    expect(container.querySelector('.desk-pane.is-overlaid-right')).not.toBeNull();
  });
});

describe('DeskShell — スレッド削除の結合（rete-desk-0095 / ラベルは dsk-0248 で「スレッドを削除」へ改名）', () => {
  // ツリー取得の配線が生きているかを確認する expect(fetchTaskTree) は「待ちではなく配線の smoke」＝
  // dsk-0409 の見張り。以下の `// 配線 smoke（dsk-0409）` はこの意味の短縮形（dsk-0432 L2）。
  it('その他 > スレッドを削除 → OK で DELETE を呼び、詳細を閉じて一覧を取り直す', async () => {
    deleteChatTheme.mockResolvedValue(undefined);
    const { container } = render(<DeskShell />);

    fireEvent.click(await screen.findByRole('button', { name: /入荷の話/ }));
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    const thread = await screen.findByLabelText('チャット詳細');
    await waitFor(() => expect(within(thread).getByRole('heading')).toBeInTheDocument());
    const themesCallsBefore = fetchChatThemes.mock.calls.length;

    fireEvent.click(within(thread).getByRole('button', { name: 'その他' }));
    fireEvent.click(within(thread).getByRole('menuitem', { name: 'スレッドを削除' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(deleteChatTheme).toHaveBeenCalledWith('theme-1'));
    // 削除成功 → 詳細クローズ（A1: closeRight）+ チャット明細の再取得。
    await waitFor(() => expect(container.querySelector('[data-right-view="thread"]')).toBeNull());
    await waitFor(() =>
      expect(fetchChatThemes.mock.calls.length).toBeGreaterThan(themesCallsBefore),
    );
  });
});

describe('DeskShell — ペイン幅の個人設定（rete-desk-0142）', () => {
  it('保存済み比率を取得して desk-shell の列幅に反映する', async () => {
    fetchDeskPreference.mockResolvedValue({ leftPaneRatio: 0.6 });
    const { container } = render(<DeskShell />);
    await waitFor(() => expect(fetchDeskPreference).toHaveBeenCalledTimes(1));

    const shell = container.querySelector<HTMLElement>('.desk-shell')!;
    await waitFor(() => expect(shell.style.gridTemplateColumns).toBe('0.6fr 6px 0.4fr'));
  });

  it('未保存（null）なら既定比率で描画し、divider は separator として存在する', async () => {
    const { container } = render(<DeskShell />);
    await waitFor(() => expect(fetchDeskPreference).toHaveBeenCalledTimes(1));

    const shell = container.querySelector<HTMLElement>('.desk-shell')!;
    expect(shell.style.gridTemplateColumns).toBe('0.45fr 6px 0.55fr');
    expect(screen.getByRole('separator', { name: 'ペイン幅の調整' })).toBeInTheDocument();
  });
});

describe('DeskShell — 編集破棄確認（C-編集・DBT-7）', () => {
  async function openDirtyDetail() {
    const utils = render(<DeskShell />);
    fireEvent.click(await screen.findByText('昇格済タスク'));
    const detail = await screen.findByLabelText('タスク詳細');
    // 属性（担当者 select）を編集して dirty にする（同名ラベルがフィルタ側にもあるため詳細内に絞る）。
    // 共通 Select（mdl-0030: native <select> → Select 移行）の操作系に置換。
    const assigneeTrigger = within(detail).getByLabelText('担当者');
    await userEvent.click(assigneeTrigger);
    await userEvent.click(screen.getByRole('option', { name: '田中' }));
    return utils;
  }

  it('編集中に余白クリックすると破棄ダイアログが出て、キャンセルなら閉じない（rete-desk-0102）', async () => {
    const { container } = await openDirtyDetail();

    fireEvent.click(container.querySelector('.desk-modal-backdrop')!);
    // 旧 window.confirm ではなく Rete ダイアログが開く。
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(screen.queryByLabelText('タスク詳細')).not.toBeNull(); // ブロックされ閉じない
    // 取り消した後も、書き換えた内容（担当者の選択）が残っている（取り消し＝編集内容を捨てない）。
    expect(within(screen.getByLabelText('タスク詳細')).getByLabelText('担当者')).toHaveTextContent(
      '田中',
    );
  });

  it('編集中に余白クリック → OK で閉じる（rete-desk-0102）', async () => {
    const { container } = await openDirtyDetail();

    fireEvent.click(container.querySelector('.desk-modal-backdrop')!);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByLabelText('タスク詳細')).toBeNull());
  });

  it('未編集なら確認なしで閉じる（誤爆しない / rete-desk-0102）', async () => {
    const { container } = render(<DeskShell />);
    fireEvent.click(await screen.findByText('昇格済タスク'));
    await screen.findByLabelText('タスク詳細');

    fireEvent.click(container.querySelector('.desk-modal-backdrop')!);
    await waitFor(() => expect(screen.queryByLabelText('タスク詳細')).toBeNull());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('DeskShell — ESC 1段化（rete-desk-0120 / 0113）', () => {
  // ツリー取得の配線が生きているかを確認する expect(fetchTaskTree) は「待ちではなく配線の smoke」＝
  // dsk-0409 の見張り。以下の `// 配線 smoke（dsk-0409）` はこの意味の短縮形（dsk-0432 L2）。
  it('入力欄フォーカス中でも（未編集）ESC 1回でオーバーレイを閉じる（blur 先行を廃止 / rete-desk-0120・0113）', async () => {
    render(<DeskShell />);
    fireEvent.click(await screen.findByText('昇格済タスク'));
    const detail = await screen.findByLabelText('タスク詳細');
    const assignee = within(detail).getByLabelText('担当者') as HTMLInputElement;
    assignee.focus();
    expect(document.activeElement).toBe(assignee);

    fireEvent.keyDown(assignee, { key: 'Escape' });

    // 旧仕様（1回目=blur のみ・2回目で閉じる）を廃止: 未編集なら 1 回の ESC で閉じる（損失なし）。
    await waitFor(() => expect(screen.queryByLabelText('タスク詳細')).toBeNull());
  });

  it('入力欄フォーカス中で差分ありなら ESC 1回で破棄確認を出す（誤操作で消失しない / rete-desk-0120・0113）', async () => {
    render(<DeskShell />);
    fireEvent.click(await screen.findByText('昇格済タスク'));
    const detail = await screen.findByLabelText('タスク詳細');
    // 共通 Select（mdl-0030）の操作系に置換。
    const assignee = within(detail).getByLabelText('担当者');
    await userEvent.click(assignee);
    await userEvent.click(screen.getByRole('option', { name: '田中' }));
    assignee.focus();

    fireEvent.keyDown(assignee, { key: 'Escape' });

    // 差分時は closeAllGuarded の破棄確認が緩衝になり、いきなり消えない。
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(screen.queryByLabelText('タスク詳細')).not.toBeNull();
  });

  it('IME 変換確定中（isComposing）の ESC はオーバーレイを閉じない（OS の変換取消に委ねる / rete-desk-0113）', async () => {
    render(<DeskShell />);
    fireEvent.click(await screen.findByText('昇格済タスク'));
    const detail = await screen.findByLabelText('タスク詳細');
    // 共通 Select（mdl-0030）: trigger は button。要素型は cast し直さない。
    const assignee = within(detail).getByLabelText('担当者') as HTMLElement;
    assignee.focus();

    fireEvent.keyDown(assignee, { key: 'Escape', isComposing: true });

    // 変換中の 1 回目 ESC は変換取消に消費される（標準挙動）。アプリ側で潰さない。
    expect(screen.queryByLabelText('タスク詳細')).not.toBeNull();
  });

  it('入力欄外（フォーカスなし）の ESC はオーバーレイを閉じる', async () => {
    render(<DeskShell />);
    fireEvent.click(await screen.findByText('昇格済タスク'));
    await screen.findByLabelText('タスク詳細');

    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByLabelText('タスク詳細')).toBeNull());
  });

  it('入力欄外の ESC で dirty フォームなら破棄ダイアログを経由する（guardDiscard×ESC / rete-desk-0102）', async () => {
    render(<DeskShell />);
    fireEvent.click(await screen.findByText('昇格済タスク'));
    const detail = await screen.findByLabelText('タスク詳細');
    // 共通 Select（mdl-0030）の操作系に置換。
    const assignee = within(detail).getByLabelText('担当者');
    await userEvent.click(assignee);
    await userEvent.click(screen.getByRole('option', { name: '田中' }));

    // フォーカスを入力欄外（body）へ移してから ESC → closeAll 経路 → 破棄ダイアログが走る。
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(screen.queryByLabelText('タスク詳細')).not.toBeNull(); // キャンセルで閉じない
  });

  it('検索ボックスの ESC はキーワードをクリアする', async () => {
    render(<DeskShell />);
    const search = (await screen.findByLabelText('チャットを検索')) as HTMLInputElement;
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    fireEvent.change(search, { target: { value: '入荷' } });
    expect(search.value).toBe('入荷');

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.value).toBe('');
  });

  it('オーバーレイ表示中に検索ボックスで ESC してもオーバーレイは閉じない', async () => {
    render(<DeskShell />);
    fireEvent.click(await screen.findByText('昇格済タスク'));
    await screen.findByLabelText('タスク詳細');
    const search = screen.getByLabelText('チャットを検索') as HTMLInputElement;
    search.focus();
    fireEvent.change(search, { target: { value: '入荷' } });

    fireEvent.keyDown(search, { key: 'Escape' });

    expect(search.value).toBe(''); // 値はクリア
    expect(screen.queryByLabelText('タスク詳細')).not.toBeNull(); // オーバーレイは閉じない
  });
});

describe('DeskShell — 統合検索/フィルタ（C-検索）', () => {
  const multiThemes: ChatThemeSummary[] = [
    { ...themes[0] },
    {
      id: 'theme-2',
      title: '出荷の確認',
      status: ChatThemeStatus.OPEN,
      archived: false,
      hasTenmatsu: false,
      hasMentionToMe: false,
      hasUnread: false,
      author: { id: 'u1', name: '山田' },
      messageCount: 0,
      lastMessageAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z',
    },
  ];

  // ツリー取得の配線が生きているかを確認する expect(fetchTaskTree) は「待ちではなく配線の smoke」＝
  // dsk-0409 の見張り。以下の `// 配線 smoke（dsk-0409）` はこの意味の短縮形（dsk-0432 L2）。

  // server 絞り込み（A案）を模す: params.search に応じて返す集合を変える mock。
  function mockServerSearch() {
    fetchChatThemes.mockImplementation((params?: { search?: string }) => {
      const kw = params?.search ?? '';
      const data = kw ? multiThemes.filter((t) => t.title.includes(kw)) : multiThemes;
      return Promise.resolve({
        data,
        meta: { page: 1, limit: 20, total: data.length, totalPages: 1 },
      });
    });
  }

  it('チャット検索キーワードで server 絞り込みパラメータを送り明細が更新される（A案）', async () => {
    mockServerSearch();
    render(<DeskShell />);
    expect(await screen.findByText('入荷の話')).toBeInTheDocument();
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    expect(screen.getByText('出荷の確認')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('チャットを検索'), { target: { value: '入荷' } });
    // デバウンス後に search 付きで再取得され、出荷の確認が消える（絞り込みは server）。
    await waitFor(() =>
      expect(fetchChatThemes).toHaveBeenLastCalledWith(expect.objectContaining({ search: '入荷' })),
    );
    await waitFor(() => expect(screen.queryByText('出荷の確認')).toBeNull());
    // 検索一致でカード題名は <mark>（薄い黄色ハイライト）に分割されるため、単一テキストノード前提の
    // getByText('入荷の話') ではなく題名 span の textContent で存在を確認する（rete-desk-0048）。
    expect(
      screen.getByText(
        // mdl-0050 で sp-row-title が併設されたため contains 判定。
        (_, el) =>
          !!el?.classList.contains('desk-chat-card-title') && el?.textContent === '入荷の話',
      ),
    ).toBeInTheDocument();
    // 一致部分「入荷」がハイライト <mark class="sp-search-hl"> として描画される。
    const mark = document.querySelector('.sp-search-hl');
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe('入荷');
  });

  it('チャット検索で 0 件なら「チャットがありません」を出す（server が空集合を返す）', async () => {
    mockServerSearch();
    render(<DeskShell />);
    // 検索欄はシェルの常設 chrome なので、それを待つだけでは「非空だった一覧が空へ遷移した」前提が立たない。
    // 先に一覧が描画されたことを待ってから検索する（空→空でも緑になるのを防ぐ）。
    await screen.findByText('出荷の確認');
    fireEvent.change(screen.getByLabelText('チャットを検索'), { target: { value: 'zzz該当なし' } });
    await waitFor(() => expect(screen.getByText('チャットがありません')).toBeInTheDocument());
  });

  it('タスク検索キーワードで一致しない行が is-hidden になる', async () => {
    render(<DeskShell />);
    const row = (await screen.findByText('昇格済タスク')).closest('.desk-task-row')!;
    expect(row.classList.contains('is-hidden')).toBe(false);

    // aria-label は dsk-0339 で「タスクを検索（タイトル/説明/顛末/チケット番号）」へ拡張。プレフィックス一致で取得する。
    fireEvent.change(screen.getByLabelText(/^タスクを検索/), {
      target: { value: '存在しない名前' },
    });
    expect(row.classList.contains('is-hidden')).toBe(true);

    // タイトル一致に戻すと再表示
    fireEvent.change(screen.getByLabelText(/^タスクを検索/), { target: { value: '昇格' } });
    expect(row.classList.contains('is-hidden')).toBe(false);
  });

  it('# 番号でタスクを絞り込める', async () => {
    render(<DeskShell />);
    const row = (await screen.findByText('昇格済タスク')).closest('.desk-task-row')!;

    fireEvent.change(screen.getByLabelText(/^タスクを検索/), { target: { value: '#10' } });
    expect(row.classList.contains('is-hidden')).toBe(false);

    fireEvent.change(screen.getByLabelText(/^タスクを検索/), { target: { value: '#999' } });
    expect(row.classList.contains('is-hidden')).toBe(true);
  });

  it('期日範囲フィルタで期日なしタスクが除外される', async () => {
    render(<DeskShell />);
    // taskWithSource は dueDate=null。範囲指定すると期日なしは除外される。
    const row = (await screen.findByText('昇格済タスク')).closest('.desk-task-row')!;
    expect(row.classList.contains('is-hidden')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '期日範囲' }));
    fireEvent.change(screen.getByLabelText('From 日付'), { target: { value: '2026-06-01' } });
    expect(row.classList.contains('is-hidden')).toBe(true);
  });
});

describe('DeskShell — 右ペイン（チャット詳細）編集の破棄ガード（H3 対称配線）', () => {
  // ツリー取得の配線が生きているかを確認する expect(fetchTaskTree) は「待ちではなく配線の smoke」＝
  // dsk-0409 の見張り。以下の `// 配線 smoke（dsk-0409）` はこの意味の短縮形（dsk-0432 L2）。
  // スレッドを開き、テーマ編集モードで題名を変更して dirty にする。
  async function openDirtyThread() {
    const utils = render(<DeskShell />);
    fireEvent.click(await screen.findByRole('button', { name: /入荷の話/ }));
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    const thread = await screen.findByLabelText('チャット詳細');
    // 編集モードへ → 題名を変更 → dirty 化（ChatThread→onDirtyChange→rightDirtyRef）。
    // 初回 load 完了を待ってから編集モードへ（theme?.id 変化のリセット effect が click 後に
    // 走って editing を巻き戻すのを防ぐ）。
    await waitFor(() => expect(within(thread).getByRole('heading')).toBeInTheDocument());
    fireEvent.click(within(thread).getByRole('button', { name: '編集' }));
    const titleInput = await within(thread).findByLabelText('テーマ題名');
    fireEvent.change(titleInput, { target: { value: '入荷の話（改）' } });
    return utils;
  }

  // dsk-0431 criteria 4: 破棄ダイアログは「存在を仮定した同期取得（getByRole）」で扱わず、
  // 出現を待つ findByRole で取る（本チケットの落ち口と同じ「描画待ちの取りこぼし」型の予備軍潰し）。
  it('右ペイン編集中に余白クリックすると破棄ダイアログが出て、キャンセルなら閉じない（rete-desk-0102）', async () => {
    const { container } = await openDirtyThread();

    fireEvent.click(container.querySelector('.desk-modal-backdrop')!);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByLabelText('チャット詳細')).not.toBeNull(); // ブロックされ閉じない
  });

  it('右ペイン編集中に余白クリック → OK で閉じる（rete-desk-0102）', async () => {
    const { container } = await openDirtyThread();

    fireEvent.click(container.querySelector('.desk-modal-backdrop')!);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByLabelText('チャット詳細')).toBeNull());
  });

  it('右ペイン編集中に（入力欄外）ESC で破棄ダイアログを経由する（rete-desk-0102）', async () => {
    await openDirtyThread();

    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByLabelText('チャット詳細')).not.toBeNull(); // キャンセルで閉じない
  });

  it('右ペインが dirty でなければ確認なしで余白クリックで閉じる（誤爆しない / rete-desk-0102）', async () => {
    const { container } = render(<DeskShell />);
    fireEvent.click(await screen.findByRole('button', { name: /入荷の話/ }));
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    await screen.findByLabelText('チャット詳細');

    fireEvent.click(container.querySelector('.desk-modal-backdrop')!);
    await waitFor(() => expect(screen.queryByLabelText('チャット詳細')).toBeNull());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('DeskShell — 返信ドラフトの破棄ガード（rete-desk-0120）', () => {
  // ツリー取得の配線が生きているかを確認する expect(fetchTaskTree) は「待ちではなく配線の smoke」＝
  // dsk-0409 の見張り。以下の `// 配線 smoke（dsk-0409）` はこの意味の短縮形（dsk-0432 L2）。
  // スレッドを開き、返信欄に入力して dirty にする（ReplyComposer→ChatThread→rightDirtyRef）。
  async function openDirtyReply() {
    const utils = render(<DeskShell />);
    fireEvent.click(await screen.findByRole('button', { name: /入荷の話/ }));
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    const thread = await screen.findByLabelText('チャット詳細');
    await waitFor(() => expect(within(thread).getByLabelText('返信')).toBeInTheDocument());
    fireEvent.change(within(thread).getByLabelText('返信'), { target: { value: '了解です' } });
    return utils;
  }

  it('返信を書きかけで × 閉じると破棄確認が出る（従来は無確認で消えていた）', async () => {
    await openDirtyReply();
    const thread = screen.getByLabelText('チャット詳細');
    fireEvent.click(within(thread).getByRole('button', { name: '閉じる' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(screen.queryByLabelText('チャット詳細')).not.toBeNull();
  });

  it('返信を書きかけで余白クリックすると破棄確認が出る', async () => {
    const { container } = await openDirtyReply();
    fireEvent.click(container.querySelector('.desk-modal-backdrop')!);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByLabelText('チャット詳細')).toBeNull());
  });

  it('返信を書きかけ（返信欄フォーカス）で ESC 1回すると破棄確認が出る（1段 / rete-desk-0120・0113）', async () => {
    await openDirtyReply();
    const reply = within(screen.getByLabelText('チャット詳細')).getByLabelText(
      '返信',
    ) as HTMLTextAreaElement;
    reply.focus();
    fireEvent.keyDown(reply, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('返信が空なら × 閉じで確認を出さない（誤爆しない）', async () => {
    render(<DeskShell />);
    fireEvent.click(await screen.findByRole('button', { name: /入荷の話/ }));
    // 配線 smoke（dsk-0409）
    expect(fetchTaskTree).toHaveBeenCalled();
    const thread = await screen.findByLabelText('チャット詳細');
    fireEvent.click(within(thread).getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByLabelText('チャット詳細')).toBeNull());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('画面移動（別テーマを開いて戻る）しても書きかけの返信が戻る（d737）', async () => {
    render(<DeskShell />);
    fireEvent.click(await screen.findByRole('button', { name: /入荷の話/ }));
    let thread = await screen.findByLabelText('チャット詳細');
    await waitFor(() => expect(within(thread).getByLabelText('返信')).toBeInTheDocument());
    fireEvent.change(within(thread).getByLabelText('返信'), {
      target: { value: '<p>画面を移っても残る書きかけ</p>' },
    });

    // 右ペインの表示先が別物（タスク詳細）になり、スレッドは unount される＝画面移動。
    fireEvent.click(await screen.findByText('昇格済タスク'));
    await screen.findByLabelText('タスク詳細');
    expect(screen.queryByLabelText('チャット詳細')).toBeNull();

    // スレッドへ戻ると、書きかけが続きから書ける形で戻っている。
    fireEvent.click(screen.getByRole('button', { name: /入荷の話/ }));
    thread = await screen.findByLabelText('チャット詳細');
    await waitFor(() =>
      expect((within(thread).getByLabelText('返信') as HTMLTextAreaElement).value).toBe(
        '<p>画面を移っても残る書きかけ</p>',
      ),
    );
  });

  it('送信に成功すると書きかけを捨て、同じテーマを開き直しても残らない（d737）', async () => {
    postChatMessage.mockResolvedValue({});
    render(<DeskShell />);
    fireEvent.click(await screen.findByRole('button', { name: /入荷の話/ }));
    let thread = await screen.findByLabelText('チャット詳細');
    await waitFor(() => expect(within(thread).getByLabelText('返信')).toBeInTheDocument());
    fireEvent.change(within(thread).getByLabelText('返信'), {
      target: { value: '<p>送る返信</p>' },
    });
    fireEvent.click(within(thread).getByRole('button', { name: '送信' }));
    await waitFor(() => expect(postChatMessage).toHaveBeenCalled());
    // 送信成功で本文が空になり dirty が降りるまで待つ（降りる前に閉じると破棄確認が挟まり閉じない）。
    await waitFor(() =>
      expect(within(thread).getByRole('button', { name: 'キャンセル' })).toBeDisabled(),
    );

    // 閉じる（dirty でなければ確認なし）→ 開き直す。
    fireEvent.click(within(thread).getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByLabelText('チャット詳細')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /入荷の話/ }));
    thread = await screen.findByLabelText('チャット詳細');
    await waitFor(() => expect(within(thread).getByLabelText('返信')).toBeInTheDocument());
    expect((within(thread).getByLabelText('返信') as HTMLTextAreaElement).value).toBe('');
  });
});
