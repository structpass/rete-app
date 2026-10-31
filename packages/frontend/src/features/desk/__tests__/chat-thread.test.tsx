import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useLayoutEffect } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { flush } from '@/test-utils/flush';

/** click 由来の async ハンドラ（toggle / save）が settle するまで待つ（act 警告回避）。 */
// ChatThread はテーマ添付（FL-3b）・発話添付（dsk-0250）取得のため useDeskAttachments を内部で呼ぶ。
// network を伴う hook を空状態スタブへ差し替えつつ、vi.fn() スパイにして「編集時に正しい対象
// （chatMessage・そのメッセージ id）で呼ばれているか」を検証可能にする（dsk-0262。戻り値の形は
// 空状態 controller のままなので既存テストの挙動は変わらない）。
const { useDeskAttachmentsMock, useDeferredAttachmentsMock } = vi.hoisted(() => ({
  useDeskAttachmentsMock: vi.fn(),
  useDeferredAttachmentsMock: vi.fn(),
}));
vi.mock('../hooks/use-desk-attachments', () => ({
  useDeskAttachments: useDeskAttachmentsMock,
}));
// 発話編集の添付は dsk-0265 で保留（deferred）方式の useDeferredAttachments に差し替わったため、
// こちらも同様にスタブ化して「正しい対象で呼ばれているか」「保存 commit / キャンセル discard の配線」を検証する
// （保留ロジック自体の検証は use-deferred-attachments.test.tsx が担う）。
vi.mock('../hooks/use-deferred-attachments', () => ({
  useDeferredAttachments: useDeferredAttachmentsMock,
  // task-attachments（チップ表示）が保留判定に使う実装同等のスタブ（保留チップの合成 shape 判定）。
  isPendingAttachment: (att: { id: string; versionNo: number }) =>
    att.versionNo === 0 && att.id.startsWith('pending-'),
}));
const emptyAttachmentsController = () => ({
  attachments: [],
  loading: false,
  error: null,
  mutating: false,
  add: vi.fn().mockResolvedValue(true),
  remove: vi.fn().mockResolvedValue(undefined),
  reload: vi.fn().mockResolvedValue(undefined),
});
const emptyDeferredController = () => ({
  ...emptyAttachmentsController(),
  dirty: false,
  commit: vi.fn().mockResolvedValue(true),
  discard: vi.fn(),
});
beforeEach(() => {
  useDeskAttachmentsMock.mockReset();
  useDeskAttachmentsMock.mockImplementation(emptyAttachmentsController);
  useDeferredAttachmentsMock.mockReset();
  useDeferredAttachmentsMock.mockImplementation(emptyDeferredController);
});

import { ChatThread } from '../components/chat-thread';
import { clearAllReplyDrafts } from '../lib/reply-drafts';
import type { ChatThemeDetail } from '../lib/api';
import { ChatThemeStatus } from '@rete/shared';

// RichTextEditor は Tiptap（jsdom 非対応の measure 系）を含むため、編集フォームのテストを
// 軽量化する目的でテキストエリアの最小スタブに差し替える（onChange だけ通せれば dirty/save は検証可能）。
vi.mock('../components/rich-text-editor', () => ({
  RichTextEditor: ({
    value,
    onChange,
    ariaLabel,
    placeholder,
  }: {
    value: string;
    onChange: (html: string) => void;
    ariaLabel?: string;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const theme: ChatThemeDetail = {
  id: 't1',
  title: '入荷予定 CSV 文字コード',
  description: '<p>UTF-8 で統一したい</p>',
  tenmatsu: null,
  status: ChatThemeStatus.OPEN,
  archived: false,
  author: { id: 'u1', name: '佐久間' },
  reactions: [
    { emoji: '👍', count: 2, reactedByMe: true },
    { emoji: '🎉', count: 1, reactedByMe: false },
  ],
  attachments: [],
  messages: [
    {
      id: 'm1',
      themeId: 't1',
      body: '<p>了解です</p>',
      author: { id: 'u2', name: '中島' },
      createdAt: '2026-06-01T00:00:00.000Z',
      reactions: [{ emoji: '❤️', count: 1, reactedByMe: false }],
      attachments: [],
      mentions: [],
    },
  ],
  lastMessageAt: '2026-06-01T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

const noop = () => Promise.resolve();

// props だけ組み立てる版（dsk-0431 の競合再現テストが ChatThread を sibling 付きで自前 render するため分離）。
function renderThreadProps(
  overrides: Partial<React.ComponentProps<typeof ChatThread>> = {},
): React.ComponentProps<typeof ChatThread> {
  return {
    theme,
    loading: false,
    error: null,
    onClose: vi.fn(),
    onReply: noop,
    onUpdateMessage: vi.fn().mockResolvedValue(undefined),
    accounts: [],
    onUpdateTheme: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn().mockResolvedValue(undefined),
    onDeleteTheme: vi.fn().mockResolvedValue(undefined),
    onDeleteMessage: vi.fn().mockResolvedValue(undefined),
    onToggleMessageReaction: vi.fn().mockResolvedValue(undefined),
    onToggleThemeReaction: vi.fn().mockResolvedValue(undefined),
    // 既定は投稿者本人（theme.author.id='u1'）でログイン中＝編集/その他が出る（rete-desk-0083）。
    // 他人ケースは override で currentUserId を変える／外す。
    currentUserId: 'u1',
    ...overrides,
  };
}

function renderThread(overrides: Partial<React.ComponentProps<typeof ChatThread>> = {}) {
  const props = renderThreadProps(overrides);
  return { props, ...render(<ChatThread {...props} />) };
}

// dsk-0431: コミット直後（layout effect＝passive effect より前）に「編集」を押すテスト部品。
// CI 低速環境で観測された「クリック時点で [theme?.id] リセット effect が未消化」の競合窓を、
// React の実行順序保証（layout effect → passive effect）で決定的に再現する。sibling として
// ChatThread の後に置く（layout effect は tree 順に走るため ChatThread の DOM 生成後に発火する）。
function ClickEditOnCommit() {
  useLayoutEffect(() => {
    const btn = document.querySelector<HTMLButtonElement>('button[aria-label="編集"]');
    if (!btn) throw new Error('編集ボタンが見つからない（再現部品の前提崩れ）');
    btn.click();
  }, []);
  return null;
}

describe('ChatThread — スレッド/顛末 タブ strip（rete-desk-0039/0040 退行回帰）', () => {
  it('題名をスクロール領域の外に置く', () => {
    const { container } = renderThread();
    const title = screen.getByRole('heading', { name: theme.title });
    expect(title.closest('.desk-pane-body')).toBeNull();
    expect(container.querySelector('.desk-pane-body')).toBeInTheDocument();
  });
  it('過去を読んでいる間は新着で飛ばず、最下部へ戻ると追従する', () => {
    const props = renderThreadProps();
    const { container, rerender } = render(<ChatThread {...props} />);
    const body = container.querySelector<HTMLElement>('.desk-pane-body')!;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 400 });
    body.scrollTop = 100;
    fireEvent.scroll(body);
    const messages = [...theme.messages, { ...theme.messages[0], id: 'new1' }];
    rerender(<ChatThread {...props} theme={{ ...theme, messages }} />);
    expect(body.scrollTop).toBe(100);
    body.scrollTop = 800;
    fireEvent.scroll(body);
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1300 });
    rerender(
      <ChatThread
        {...props}
        theme={{ ...theme, messages: [...messages, { ...messages[0], id: 'new2' }] }}
      />,
    );
    expect(body.scrollTop).toBe(1300);
  });
  it('スレッド / 顛末 タブを両方描画する', () => {
    renderThread();
    const strip = screen.getByRole('tablist', { name: 'スレッド表示タブ' });
    expect(within(strip).getByRole('tab', { name: 'スレッド' })).toBeInTheDocument();
    expect(within(strip).getByRole('tab', { name: '顛末' })).toBeInTheDocument();
  });

  it('タブ strip はスレッドオーバーレイ section の先頭要素（ペイン上辺でクリップされない位置）', () => {
    const { container } = renderThread();
    const section = container.querySelector('section[data-right-view="thread"]');
    expect(section).not.toBeNull();
    expect(section!.firstElementChild).toHaveClass('desk-ticket-tabs');
  });

  it('スレッドタブが初期アクティブで、顛末タブクリックで切替わる', () => {
    renderThread();
    const threadTab = screen.getByRole('tab', { name: 'スレッド' });
    const tenmatsuTab = screen.getByRole('tab', { name: '顛末' });
    expect(threadTab).toHaveAttribute('aria-selected', 'true');
    expect(tenmatsuTab).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(tenmatsuTab);
    expect(tenmatsuTab).toHaveAttribute('aria-selected', 'true');
    expect(threadTab).toHaveAttribute('aria-selected', 'false');
    // 顛末タブは他入力欄と同じ RTE（aria-label 顛末）を描画する（rete-desk-0092 / 0091 で RTE 化）。
    expect(screen.getByLabelText('顛末')).toBeInTheDocument();
  });
});

describe('ChatThread — 顛末タブの入力配線（rete-desk-0092 / 0091 RTE 化）', () => {
  it('顛末タブは RTE（書式バー付き・aria-label 顛末）+ プレースホルダーで表示する', () => {
    renderThread();
    fireEvent.click(screen.getByRole('tab', { name: '顛末' }));
    const input = screen.getByLabelText('顛末');
    expect(input).toHaveAttribute('placeholder', 'このスレッドの顛末を記録します');
  });

  it('未入力（baseline と同値）の間は保存ボタンが無効', () => {
    renderThread();
    fireEvent.click(screen.getByRole('tab', { name: '顛末' }));
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('顛末を入力して保存すると onUpdateTheme を {tenmatsu} 付きで呼ぶ', async () => {
    const onUpdateTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ onUpdateTheme });
    fireEvent.click(screen.getByRole('tab', { name: '顛末' }));
    fireEvent.change(screen.getByLabelText('顛末'), { target: { value: 'CSV は UTF-8 で確定' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // 顛末面の @ メンション宛先を同時送信（rete-desk-0116 Phase B）。平文なので宛先は空配列。
    expect(onUpdateTheme).toHaveBeenCalledWith({
      tenmatsu: 'CSV は UTF-8 で確定',
      tenmatsuMentionAccountIds: [],
    });
    await flush();
  });

  it('既存顛末を空にして保存すると tenmatsu: null でクリアする', async () => {
    const onUpdateTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ theme: { ...theme, tenmatsu: '既存の結論' }, onUpdateTheme });
    fireEvent.click(screen.getByRole('tab', { name: '顛末' }));
    const textarea = screen.getByLabelText('顛末');
    expect(textarea).toHaveValue('既存の結論');
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // 空クリア時は顛末面の宛先も空配列で送って消す（rete-desk-0116 Phase B）。
    expect(onUpdateTheme).toHaveBeenCalledWith({ tenmatsu: null, tenmatsuMentionAccountIds: [] });
    await flush();
  });
});

describe('ChatThread — 顛末タブは誰でも編集可（rete-desk-0122 / 旧 0119 所有ゲートを撤去）', () => {
  it('非所有者でも顛末タブで RTE エディタ・保存ボタンを出す（決着を記すのは投稿者本人とは限らない）', () => {
    renderThread({ theme: { ...theme, tenmatsu: '<p>確定事項</p>' }, currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('tab', { name: '顛末' }));
    expect(screen.getByLabelText('顛末')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
  });

  it('非所有者にも記録済み顛末をエディタ初期値として見せる', () => {
    renderThread({ theme: { ...theme, tenmatsu: '<p>確定事項</p>' }, currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('tab', { name: '顛末' }));
    expect(screen.getByLabelText('顛末')).toHaveValue('<p>確定事項</p>');
  });

  it('ロード中（theme=null）は顛末タブでエディタを出さない（rete-desk-0119 review）', () => {
    renderThread({ theme: null, loading: true });
    fireEvent.click(screen.getByRole('tab', { name: '顛末' }));
    expect(screen.queryByLabelText('顛末')).not.toBeInTheDocument();
  });

  it('閉じる × は右端固定（非所有テーマ＝アーカイブ非表示時も ml-auto で右寄せ / rete-desk-0118）', () => {
    renderThread({ currentUserId: 'u2' });
    expect(screen.getByRole('button', { name: '閉じる' })).toHaveClass('ml-auto');
  });

  it('所有テーマでは × は ml-auto を持たず、アーカイブボタン（ml-auto）が右寄せを担う（rete-desk-0118）', () => {
    renderThread({ currentUserId: 'u1' });
    expect(screen.getByRole('button', { name: '閉じる' })).not.toHaveClass('ml-auto');
    expect(screen.getByRole('button', { name: 'アーカイブ' })).toHaveClass('ml-auto');
  });
});

describe('ChatThread — アーカイブ（rete-desk-0058/0077）', () => {
  it('アーカイブボタンはタブ strip 内・閉じる × の左隣に置く（0058）', () => {
    const { container } = renderThread();
    const strip = screen.getByRole('tablist', { name: 'スレッド表示タブ' });
    const archive = within(strip).getByRole('button', { name: 'アーカイブ' });
    expect(archive).toHaveClass('desk-chat-archive-btn', 'is-thread-archive');
    // DOM 順で アーカイブ → 閉じる × の並び（× の左隣）。
    const close = within(strip).getByRole('button', { name: '閉じる' });
    expect(archive.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it('未アーカイブ時のクリックで onArchive(true) を呼ぶ（0077）', async () => {
    const onArchive = vi.fn().mockResolvedValue(undefined);
    renderThread({ onArchive });
    fireEvent.click(screen.getByRole('button', { name: 'アーカイブ' }));
    expect(onArchive).toHaveBeenCalledWith(true);
    await flush();
  });

  it('アーカイブ成功後にチャット詳細を閉じる（rete-desk-0103）', async () => {
    const onClose = vi.fn();
    renderThread({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'アーカイブ' }));
    // close は onArchive 成功後（await 後）に走るため settle を待ってから検証する。
    await flush();
    expect(onClose).toHaveBeenCalled();
  });

  it('アーカイブ失敗時は閉じず alert を表示する（rete-desk-0103）', async () => {
    const onClose = vi.fn();
    const onArchive = vi.fn().mockRejectedValue(new Error('boom'));
    renderThread({ onArchive, onClose });
    fireEvent.click(screen.getByRole('button', { name: 'アーカイブ' }));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('アーカイブ操作に失敗しました');
  });

  it('アーカイブ済みなら解除ラベルになり、クリックで onArchive(false) を呼ぶ', async () => {
    const onArchive = vi.fn().mockResolvedValue(undefined);
    renderThread({ theme: { ...theme, archived: true }, onArchive });
    const btn = screen.getByRole('button', { name: 'アーカイブ解除' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(onArchive).toHaveBeenCalledWith(false);
    await flush();
  });

  it('他人（非所有者）にはアーカイブボタンを出さない（rete-desk-0110 / 0083 owner-only と整合）', () => {
    renderThread({ currentUserId: 'u2' });
    expect(screen.queryByRole('button', { name: 'アーカイブ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'アーカイブ解除' })).toBeNull();
  });

  it('未ログインでもアーカイブボタンを出さない（rete-desk-0110）', () => {
    renderThread({ currentUserId: undefined });
    expect(screen.queryByRole('button', { name: 'アーカイブ' })).toBeNull();
  });
});

describe('ChatThread — リアクション配線（0042）', () => {
  it('count>0 の既存リアクションをチップで表示し、reactedByMe を視覚ハイライト（aria-pressed）する', () => {
    renderThread();
    // テーマ起点カードの 👍(2, 自分) と 🎉(1)
    const thumbs = screen.getByRole('button', { name: /👍 2件（自分が押した）/ });
    expect(thumbs).toHaveAttribute('aria-pressed', 'true');
    expect(thumbs).toHaveClass('is-reacted');
    const tada = screen.getByRole('button', { name: /🎉 1件$/ });
    expect(tada).toHaveAttribute('aria-pressed', 'false');
  });

  it('count 0 のリアクションは表示しない', () => {
    renderThread({
      theme: { ...theme, reactions: [{ emoji: '👍', count: 0, reactedByMe: false }] },
    });
    expect(screen.queryByRole('button', { name: /👍/ })).not.toBeInTheDocument();
  });

  it('チップ再クリックで同じ emoji の theme トグルを呼ぶ（解除）', async () => {
    const onToggleThemeReaction = vi.fn().mockResolvedValue(undefined);
    renderThread({ onToggleThemeReaction });
    fireEvent.click(screen.getByRole('button', { name: /👍 2件（自分が押した）/ }));
    expect(onToggleThemeReaction).toHaveBeenCalledWith('👍');
    await flush();
  });

  it('「リアクションを追加」でピッカーを開き、選択でメッセージ側トグルを message id 付きで呼ぶ', async () => {
    const onToggleMessageReaction = vi.fn().mockResolvedValue(undefined);
    renderThread({ onToggleMessageReaction });
    // 返信メッセージ（m1）側のバーの add ボタン（テーマ + メッセージで複数あるため最後＝メッセージ側）
    const addButtons = screen.getAllByRole('button', { name: 'リアクションを追加' });
    const messageAdd = addButtons[addButtons.length - 1];
    fireEvent.click(messageAdd);
    const picker = screen.getByRole('menu', { name: '絵文字を選択' });
    // 🚀 は「最近使った」フォールバック（REACTION_EMOJIS）とカテゴリの双方に出るため先頭を選ぶ（rete-desk-0094）。
    fireEvent.click(within(picker).getAllByRole('menuitem', { name: '🚀' })[0]);
    expect(onToggleMessageReaction).toHaveBeenCalledWith('m1', '🚀');
    await flush();
  });

  it('ピッカーは「最近使った」とカテゴリ別の絵文字を全表示する（rete-desk-0094）', () => {
    renderThread();
    const addButtons = screen.getAllByRole('button', { name: 'リアクションを追加' });
    fireEvent.click(addButtons[addButtons.length - 1]);
    const picker = screen.getByRole('menu', { name: '絵文字を選択' });
    expect(within(picker).getByText('最近使った')).toBeInTheDocument();
    expect(within(picker).getByText('笑顔・感情')).toBeInTheDocument();
    // 固定 8 種だった頃より多数の絵文字候補が並ぶ。
    expect(within(picker).getAllByRole('menuitem').length).toBeGreaterThan(50);
  });
});

describe('ChatThread — 添付表示（FL-3b・embed）', () => {
  const attachment = {
    id: 'a1',
    fileId: 'f1',
    fileName: '入荷明細.csv',
    versionNo: 2,
    byteSize: 1024,
    mimeType: 'text/csv',
    attachedBy: '中島',
    createdAt: '2026-06-01T00:00:00.000Z',
  };

  it('発話に同梱された添付（m.attachments）をファイル名で表示する', () => {
    renderThread({
      theme: {
        ...theme,
        messages: [{ ...theme.messages[0], attachments: [attachment] }],
      },
    });
    expect(screen.getByText('入荷明細.csv')).toBeInTheDocument();
  });

  it('添付ゼロの発話では添付一覧を描画しない', () => {
    renderThread();
    expect(screen.queryByText('入荷明細.csv')).not.toBeInTheDocument();
  });
});

describe('ChatThread — 編集クリックとリセット effect の競合（dsk-0431）', () => {
  // 機序（CI run 31238962054 attempt 1 の DOM ダンプで確定）: [theme?.id] のリセット effect
  // （passive）が未消化のうちに「編集」クリックが処理されると、click の setEditing(true) が
  // 後から flush されたリセット effect の setEditing(false) に打ち消され、編集フォームが出ない
  // まま表示モードへ戻る。通常はリセット effect が先に消化されるため緑＝flaky。
  // ここでは layout effect（passive より前が仕様保証）からクリックして窓を決定的に踏む。
  it('リセット effect 消化前の編集クリックが打ち消されないこと（修正前は赤＝クリック無視）', () => {
    const props = renderThreadProps();
    render(
      <>
        <ChatThread {...props} />
        <ClickEditOnCommit />
      </>,
    );
    expect(screen.getByLabelText('テーマ題名')).toBeInTheDocument();
  });

  it('theme 非同期ロード（null → id）後も保存済み顛末がドラフトへ同期されること（リセット限定の退行ガード）', () => {
    // desk-shell 経由では ChatThread は必ず theme=null で mount され、ロード完了で theme が届く。
    // mount 時の useState は '' に固定されるため、null → id の effect が顛末の唯一の同期経路
    // （code-reviewer 指摘: リセットのスキップをここまで広げると保存済み顛末が空表示になる）。
    const props = renderThreadProps({ theme: null, loading: true });
    const { rerender } = render(<ChatThread {...props} />);
    rerender(
      <ChatThread {...props} theme={{ ...theme, tenmatsu: '<p>既存顛末</p>' }} loading={false} />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '顛末' }));
    expect(screen.getByLabelText('顛末')).toHaveValue('<p>既存顛末</p>');
  });
});

describe('ChatThread — テーマ編集の配線（0041）', () => {
  it('編集ボタンで題名 input + 説明エディタの編集フォームを開く', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    expect(screen.getByLabelText('テーマ題名')).toHaveValue('入荷予定 CSV 文字コード');
    expect(screen.getByLabelText('テーマ説明')).toBeInTheDocument();
  });

  it('テーマ編集フォームを開いた直後（dirty=false）は保存ボタンが非活性であること（dsk-0210）', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    // 何も変更していない時（dirty=false）は保存ボタンが disabled
    // ※顛末タブは開いていないため、スレッドタブの保存ボタンはテーマ編集のもの一つ
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('テーマ題名を変更すると保存ボタンが活性化すること（dsk-0210）', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    // 変更前は非活性
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    // 題名を変更すると dirty=true → 活性化
    fireEvent.change(screen.getByLabelText('テーマ題名'), { target: { value: '変更後タイトル' } });
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled();
  });

  it('保存で onUpdateTheme を {title, description} 付きで呼ぶ', async () => {
    const onUpdateTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ onUpdateTheme });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.change(screen.getByLabelText('テーマ題名'), { target: { value: '新タイトル' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onUpdateTheme).toHaveBeenCalledWith({
      title: '新タイトル',
      description: '<p>UTF-8 で統一したい</p>',
    });
    await flush();
  });

  it('題名が空だと検証エラーを出し保存しない', () => {
    const onUpdateTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ onUpdateTheme });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.change(screen.getByLabelText('テーマ題名'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onUpdateTheme).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('タイトルを入力してください');
  });

  it('編集中（dirty）にキャンセルすると破棄ダイアログを出し、OK で表示に戻る（rete-desk-0102）', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.change(screen.getByLabelText('テーマ題名'), { target: { value: '変更' } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    // 旧 window.confirm ではなく Rete ダイアログが開く。
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.queryByLabelText('テーマ題名')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '入荷予定 CSV 文字コード' })).toBeInTheDocument();
  });

  it('破棄ダイアログを「キャンセル」で閉じると編集モードのまま留まる（rete-desk-0102）', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.change(screen.getByLabelText('テーマ題名'), { target: { value: '変更' } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByLabelText('テーマ題名')).toBeInTheDocument();
  });

  it('dirty な編集中に × を押すと破棄ダイアログを経由する（キャンセルで閉じない / rete-desk-0102）', () => {
    const onClose = vi.fn();
    renderThread({ onClose });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.change(screen.getByLabelText('テーマ題名'), { target: { value: '変更' } });
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ChatThread — テーマ編集の添付保留（dsk-0287: dsk-0265 の deferred 方式を横展開）', () => {
  /** 保留変更あり（dirty:true）の deferred controller を差し込み、spy を返す。 */
  const installDirtyController = (
    overrides: Partial<ReturnType<typeof emptyDeferredController>> = {},
  ) => {
    const controller = { ...emptyDeferredController(), dirty: true, ...overrides };
    useDeferredAttachmentsMock.mockImplementation(() => controller);
    return controller;
  };

  it('編集ボタン押下で useDeferredAttachments が theme・そのテーマ id・enabled:true で呼ばれる', () => {
    renderThread();
    expect(useDeferredAttachmentsMock).toHaveBeenCalledWith({
      targetType: 'theme',
      targetId: 't1',
      enabled: false,
    });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    expect(useDeferredAttachmentsMock).toHaveBeenCalledWith({
      targetType: 'theme',
      targetId: 't1',
      enabled: true,
    });
  });

  it('添付のみ変更（本文未編集）でも保存ボタンが活性化する（dsk-0287）', () => {
    installDirtyController();
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled();
  });

  it('添付のみ変更でキャンセルすると破棄確認ダイアログが発火する（dsk-0287）', () => {
    installDirtyController();
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('破棄確認 OK で保留添付を discard し、編集開始時点の一覧に戻す', () => {
    const controller = installDirtyController();
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    expect(controller.discard).toHaveBeenCalled();
  });

  it('保存成功時: テーマ更新 → commit → スレッド再取得の順で呼び、編集モードを閉じる', async () => {
    const controller = installDirtyController();
    const onUpdateTheme = vi.fn().mockResolvedValue(undefined);
    const onRefetchTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ onUpdateTheme, onRefetchTheme });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(onUpdateTheme).toHaveBeenCalled();
    expect(controller.commit).toHaveBeenCalled();
    expect(onRefetchTheme).toHaveBeenCalled();
    expect(screen.queryByLabelText('テーマ題名')).not.toBeInTheDocument();
  });

  it('添付に変更が無い保存では commit もスレッド再取得もしない', async () => {
    installDirtyController({ dirty: false });
    const onUpdateTheme = vi.fn().mockResolvedValue(undefined);
    const onRefetchTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ onUpdateTheme, onRefetchTheme });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.change(screen.getByLabelText('テーマ題名'), { target: { value: '新タイトル' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(onUpdateTheme).toHaveBeenCalled();
    expect(onRefetchTheme).not.toHaveBeenCalled();
  });

  it('本文更新の失敗時は commit を呼ばない（添付も確定しない）', async () => {
    const controller = installDirtyController();
    const onUpdateTheme = vi.fn().mockRejectedValue(new Error('500'));
    const onRefetchTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ onUpdateTheme, onRefetchTheme });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(onUpdateTheme).toHaveBeenCalled();
    expect(controller.commit).not.toHaveBeenCalled();
    expect(onRefetchTheme).not.toHaveBeenCalled();
    expect(screen.getByLabelText('テーマ題名')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('保存に失敗しました');
  });

  it('commit 失敗時: 編集モードに留まり inline エラーを表示する（再取得しない）', async () => {
    installDirtyController({ commit: vi.fn().mockResolvedValue(false) });
    const onRefetchTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ onRefetchTheme });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(screen.getByLabelText('テーマ題名')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('添付の反映に失敗しました');
    expect(onRefetchTheme).not.toHaveBeenCalled();
  });
});

describe('ChatThread — 自分の発話の本文編集（rete-desk-0146）', () => {
  // メッセージ author は 'u2'（中島）。currentUserId='u2' で自分の発話＝編集ボタンが出る
  //（テーマ author は 'u1' のためテーマ編集ボタンは出ない＝「保存」「編集」ボタンは発話側で一意）。
  it('自分の発話には「メッセージを編集」ボタンを出し、押すと本文エディタを開く', () => {
    renderThread({ currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    expect(screen.getByLabelText('発話本文')).toHaveValue('<p>了解です</p>');
  });

  it('他人の発話には「メッセージを編集」ボタンを出さない', () => {
    renderThread({ currentUserId: 'u1' });
    expect(screen.queryByRole('button', { name: 'メッセージを編集' })).not.toBeInTheDocument();
  });

  it('保存で onUpdateMessage(messageId, body, mentionAccountIds) を呼ぶ', async () => {
    const onUpdateMessage = vi.fn().mockResolvedValue(undefined);
    renderThread({ currentUserId: 'u2', onUpdateMessage });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    fireEvent.change(screen.getByLabelText('発話本文'), {
      target: { value: '<p>修正しました</p>' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onUpdateMessage).toHaveBeenCalledWith('m1', '<p>修正しました</p>', []);
    await flush();
  });

  it('本文が空だと保存ボタンが disabled で onUpdateMessage を呼ばない（dsk-0350）', () => {
    const onUpdateMessage = vi.fn().mockResolvedValue(undefined);
    renderThread({ currentUserId: 'u2', onUpdateMessage });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    fireEvent.change(screen.getByLabelText('発話本文'), { target: { value: '' } });
    // 空本文では保存ボタンは disabled（dsk-0350）。クリックしても onUpdateMessage は呼ばれない。
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onUpdateMessage).not.toHaveBeenCalled();
  });

  it('本文を入力すると保存ボタンが活性化する（dsk-0350）', () => {
    renderThread({ currentUserId: 'u2', onUpdateMessage: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    fireEvent.change(screen.getByLabelText('発話本文'), { target: { value: '<p>修正します</p>' } });
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled();
  });

  it('編集中（dirty）にキャンセルすると破棄ダイアログを出し、OK で表示に戻る', () => {
    renderThread({ currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    fireEvent.change(screen.getByLabelText('発話本文'), { target: { value: '<p>変更</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.queryByLabelText('発話本文')).not.toBeInTheDocument();
  });

  it('保存が失敗すると inline alert を出し編集モードに留まる', async () => {
    const onUpdateMessage = vi.fn().mockRejectedValue(new Error('500'));
    renderThread({ currentUserId: 'u2', onUpdateMessage });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    fireEvent.change(screen.getByLabelText('発話本文'), { target: { value: '<p>修正</p>' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();
    // 失敗時はフォームを閉じず（編集モード維持）、エラーを alert 表示する。
    expect(screen.getByLabelText('発話本文')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('保存に失敗しました');
  });
});

describe('ChatThread — 起点カードの所有判定（rete-desk-0083）', () => {
  it('投稿者本人（currentUserId === author.id）には 編集 / その他 を出す', () => {
    renderThread({ currentUserId: 'u1' });
    expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'その他' })).toBeInTheDocument();
  });

  it('他人（currentUserId ≠ author.id）には 編集 / その他 を出さない', () => {
    // currentUserId='u2' はメッセージ m1 の投稿者と一致するため、発話側の その他 ボタン（dsk-0316）が
    // 正当に出る。起点カードのメタ行（.desk-thread-head-meta）に限定して検証する。
    const { container } = renderThread({ currentUserId: 'u2' });
    const themeHeadMeta = container.querySelector('.desk-thread-head-meta') as HTMLElement;
    expect(within(themeHeadMeta).queryByRole('button', { name: '編集' })).not.toBeInTheDocument();
    expect(within(themeHeadMeta).queryByRole('button', { name: 'その他' })).not.toBeInTheDocument();
  });

  it('未ログイン（currentUserId 未指定）でも 編集 / その他 を出さない', () => {
    renderThread({ currentUserId: undefined });
    expect(screen.queryByRole('button', { name: '編集' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'その他' })).not.toBeInTheDocument();
  });
});

describe('ChatThread — その他 > スレッドを削除 / 顛末へコピー（rete-desk-0095 / dsk-0248）', () => {
  it('その他クリックでメニューが開き「スレッドを削除」「メッセージを顛末へコピー」項目を表示する', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    expect(screen.getByRole('menu', { name: 'その他メニュー' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'スレッドを削除' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'メッセージを顛末へコピー' })).toBeInTheDocument();
  });

  it('メニュー外の pointerdown でメニューが閉じること（brd-0227: useOutsideClose 統合）', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    expect(screen.getByRole('menu', { name: 'その他メニュー' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu', { name: 'その他メニュー' })).not.toBeInTheDocument();
  });

  it('発話（返信）側のその他メニューも外側 pointerdown で閉じること（brd-0227・dsk-0316 の発話メニュー）', () => {
    // currentUserId='u2' はメッセージ m1 の投稿者＝発話側の その他 だけが出る（起点カード側は出ない）。
    renderThread({ currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    expect(screen.getByRole('menu', { name: 'その他メニュー' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu', { name: 'その他メニュー' })).not.toBeInTheDocument();
  });

  it('メニュー内の pointerdown では閉じないこと（brd-0227）', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    const menu = screen.getByRole('menu', { name: 'その他メニュー' });
    fireEvent.pointerDown(menu);
    expect(screen.getByRole('menu', { name: 'その他メニュー' })).toBeInTheDocument();
  });

  it('メッセージを顛末へコピーで説明欄を顛末ドラフトへ反映し、顛末タブへ切り替える（dsk-0248）', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージを顛末へコピー' }));
    // 顛末タブへ自動切替し、説明欄（theme.description）が顛末入力へ入る。
    expect(screen.getByRole('tab', { name: '顛末' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('顛末')).toHaveValue('<p>UTF-8 で統一したい</p>');
  });

  it('既存の顛末ドラフトがある場合は説明欄を末尾へ追記する（既入力を失わない・dsk-0248）', () => {
    renderThread({ theme: { ...theme, tenmatsu: '<p>既存の結論</p>' } });
    // tenmatsuDraft は theme.tenmatsu から初期化されるため、顛末タブを開かずともコピーで既存値へ追記される。
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージを顛末へコピー' }));
    expect(screen.getByLabelText('顛末')).toHaveValue('<p>既存の結論</p><p>UTF-8 で統一したい</p>');
  });

  it('説明欄が空の場合はコピーせず顛末タブへ切り替えない（dsk-0248 review MEDIUM）', () => {
    renderThread({ theme: { ...theme, description: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージを顛末へコピー' }));
    // 説明が空＝何もコピーせず、スレッドタブに留まる（空コピーで顛末タブへ飛ぶ事故の防止）。
    expect(screen.getByRole('tab', { name: '顛末' })).toHaveAttribute('aria-selected', 'false');
  });

  it('スレッドを削除クリックで確認ダイアログを開き、OK で onDeleteTheme を呼ぶ', async () => {
    const onDeleteTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ onDeleteTheme });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'スレッドを削除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('このスレッドを削除しますか？元に戻せません。');
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await flush();
    expect(onDeleteTheme).toHaveBeenCalledTimes(1);
  });

  it('確認ダイアログをキャンセルすると onDeleteTheme を呼ばない', async () => {
    const onDeleteTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ onDeleteTheme });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'スレッドを削除' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    await flush();
    expect(onDeleteTheme).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('削除失敗時は inline alert を表示し詳細に留まる', async () => {
    const onDeleteTheme = vi.fn().mockRejectedValue(new Error('500'));
    renderThread({ onDeleteTheme });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'スレッドを削除' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expect(
      screen.getByText('スレッドの削除に失敗しました。時間をおいて再試行してください。'),
    ).toBeInTheDocument();
  });
});

describe('ChatThread — 発話の「その他」> メッセージ削除 / 顛末へコピー（dsk-0316）', () => {
  // メッセージ author は 'u2'（中島）。currentUserId='u2' で自分の発話＝その他ボタンが出る
  // （テーマ author は 'u1' のためテーマ側その他は出ない＝ボタン名が一意）。
  it('自分の発話にはその他ボタンを出し、押すとメニューが開く', () => {
    renderThread({ currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    expect(screen.getByRole('menu', { name: 'その他メニュー' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'メッセージを顛末へコピー' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'メッセージの削除' })).toBeInTheDocument();
  });

  it('他人の発話にはその他ボタンを出さない', () => {
    renderThread({ currentUserId: 'u3' });
    expect(screen.queryByRole('button', { name: 'その他' })).not.toBeInTheDocument();
  });

  it('編集中は その他 ボタンを隠す', () => {
    renderThread({ currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    expect(screen.queryByRole('button', { name: 'その他' })).not.toBeInTheDocument();
  });

  it('メッセージを顛末へコピーで発話本文を顛末ドラフトへ反映し、顛末タブへ切り替える', () => {
    renderThread({ currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージを顛末へコピー' }));
    expect(screen.getByRole('tab', { name: '顛末' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('顛末')).toHaveValue('<p>了解です</p>');
  });

  it('既存の顛末ドラフトがある場合は末尾へ追記する（既入力を失わない）', () => {
    renderThread({ currentUserId: 'u2', theme: { ...theme, tenmatsu: '<p>既存の結論</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージを顛末へコピー' }));
    expect(screen.getByLabelText('顛末')).toHaveValue('<p>既存の結論</p><p>了解です</p>');
  });

  it('発話本文が空の場合はコピーせず顛末タブへ切り替えない', () => {
    renderThread({
      currentUserId: 'u2',
      theme: { ...theme, messages: [{ ...theme.messages[0], body: '' }] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージを顛末へコピー' }));
    expect(screen.getByRole('tab', { name: '顛末' })).toHaveAttribute('aria-selected', 'false');
  });

  it('メッセージの削除クリックで確認ダイアログを開き、OK で onDeleteMessage(messageId) を呼ぶ', async () => {
    const onDeleteMessage = vi.fn().mockResolvedValue(undefined);
    renderThread({ currentUserId: 'u2', onDeleteMessage });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージの削除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('このメッセージを削除しますか？元に戻せません。');
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await flush();
    expect(onDeleteMessage).toHaveBeenCalledWith('m1');
  });

  it('確認ダイアログをキャンセルすると onDeleteMessage を呼ばない', async () => {
    const onDeleteMessage = vi.fn().mockResolvedValue(undefined);
    renderThread({ currentUserId: 'u2', onDeleteMessage });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージの削除' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    await flush();
    expect(onDeleteMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('削除失敗時は inline alert を表示し詳細に留まる', async () => {
    const onDeleteMessage = vi.fn().mockRejectedValue(new Error('500'));
    renderThread({ currentUserId: 'u2', onDeleteMessage });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージの削除' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expect(
      screen.getByText('メッセージの削除に失敗しました。時間をおいて再試行してください。'),
    ).toBeInTheDocument();
  });
});

describe('ChatThread — 発話編集フォームの添付配線（dsk-0250 / dsk-0262 / dsk-0265 保留方式）', () => {
  // メッセージ author は 'u2'（中島）。currentUserId='u2' で「メッセージを編集」が出る。
  const chatMessageCalls = () =>
    useDeferredAttachmentsMock.mock.calls.filter((args) => args[0]?.targetType === 'chatMessage');

  it('編集ボタン押下で useDeferredAttachments が chatMessage・そのメッセージ id・enabled:true で呼ばれる', () => {
    renderThread({ currentUserId: 'u2' });
    // 編集前は対象なし（targetId:'' / enabled:false）で添付 GET を発火させない。
    expect(useDeferredAttachmentsMock).toHaveBeenCalledWith({
      targetType: 'chatMessage',
      targetId: '',
      enabled: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    expect(useDeferredAttachmentsMock).toHaveBeenCalledWith({
      targetType: 'chatMessage',
      targetId: 'm1',
      enabled: true,
    });
  });

  it("編集キャンセルで chatMessage 側の呼び出しが enabled:false（targetId:''）へ戻る", () => {
    renderThread({ currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    useDeferredAttachmentsMock.mockClear();
    // 未編集（dirty=false）のキャンセルは破棄ダイアログを経ず即閉じる。
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    const calls = chatMessageCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][0]).toEqual({
      targetType: 'chatMessage',
      targetId: '',
      enabled: false,
    });
  });

  it('編集フォーム内に添付チップ行と「ファイル添付」ボタンを描画する', () => {
    // チップ行（AttachmentChipsRow）は添付ゼロだと何も描画しないため、編集対象（chatMessage・
    // enabled）の呼び出しにだけ添付 1 件を返して表示を検証する。
    useDeferredAttachmentsMock.mockImplementation(
      (opts: { targetType: string; enabled: boolean }) => ({
        ...emptyDeferredController(),
        attachments:
          opts.targetType === 'chatMessage' && opts.enabled
            ? [
                {
                  id: 'att1',
                  fileId: 'f1',
                  fileName: '修正版仕様.xlsx',
                  versionNo: 1,
                  byteSize: 2048,
                  mimeType: 'application/vnd.ms-excel',
                  attachedBy: '中島',
                  createdAt: '2026-06-01T00:00:00.000Z',
                },
              ]
            : [],
      }),
    );
    const { container } = renderThread({ currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    const editForm = container.querySelector('.desk-thread-comment-edit');
    expect(editForm).not.toBeNull();
    expect(within(editForm as HTMLElement).getByText('修正版仕様.xlsx')).toBeInTheDocument();
    expect(within(editForm as HTMLElement).getByText('ファイル添付')).toBeInTheDocument();
  });
});

describe('ChatThread — 発話編集の添付保留（dsk-0265: 保存で確定・キャンセルで破棄）', () => {
  /** 保留変更あり（dirty:true）の deferred controller を差し込み、spy を返す。 */
  const installDirtyController = (
    overrides: Partial<ReturnType<typeof emptyDeferredController>> = {},
  ) => {
    const controller = { ...emptyDeferredController(), dirty: true, ...overrides };
    useDeferredAttachmentsMock.mockImplementation(() => controller);
    return controller;
  };

  it('保存成功時: 本文更新 → commit → スレッド再取得の順で呼び、編集モードを閉じる', async () => {
    const controller = installDirtyController();
    const onRefetchTheme = vi.fn().mockResolvedValue(undefined);
    const { props, container } = renderThread({ currentUserId: 'u2', onRefetchTheme });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(props.onUpdateMessage).toHaveBeenCalled();
    expect(controller.commit).toHaveBeenCalled();
    expect(onRefetchTheme).toHaveBeenCalled();
    expect(container.querySelector('.desk-thread-comment-edit')).toBeNull();
  });

  it('添付に変更が無い保存では commit もスレッド再取得もしない', async () => {
    // 毎レンダー同一の controller を返し、クリック時に捕捉された commit spy をそのまま検証できるようにする。
    const controller = installDirtyController({ dirty: false });
    const onRefetchTheme = vi.fn().mockResolvedValue(undefined);
    renderThread({ currentUserId: 'u2', onRefetchTheme });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(controller.commit).not.toHaveBeenCalled();
    expect(onRefetchTheme).not.toHaveBeenCalled();
  });

  it('commit 失敗時: 編集モードに留まり inline エラーを表示する（再取得しない）', async () => {
    installDirtyController({ commit: vi.fn().mockResolvedValue(false) });
    const onRefetchTheme = vi.fn().mockResolvedValue(undefined);
    const { container } = renderThread({ currentUserId: 'u2', onRefetchTheme });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(container.querySelector('.desk-thread-comment-edit')).not.toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('添付の反映に失敗しました');
    expect(onRefetchTheme).not.toHaveBeenCalled();
  });

  it('本文更新の失敗時は commit を呼ばない（添付も確定しない）', async () => {
    const controller = installDirtyController();
    renderThread({
      currentUserId: 'u2',
      onUpdateMessage: vi.fn().mockRejectedValue(new Error('boom')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(controller.commit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('保存に失敗しました');
  });

  it('キャンセル確定（破棄）で discard を呼び、保留変更を破棄する', async () => {
    const controller = installDirtyController();
    renderThread({ currentUserId: 'u2' });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを編集' }));
    // 添付の保留変更（dirty:true）だけでも破棄確認を経由する（本文未編集でも）。
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await flush();

    expect(controller.discard).toHaveBeenCalled();
  });
});

describe('ChatThread — 編集モードで返信入力欄を隠す（rete-desk-0089）', () => {
  it('通常時は返信入力欄を表示する', () => {
    renderThread();
    expect(screen.getByPlaceholderText('スレッドに返信')).toBeInTheDocument();
  });

  it('編集モードに入ると返信入力欄を隠す', () => {
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    // dsk-0276/0277 でタスクコメント欄とプレースホルダが同文言になったため、
    // 返信欄は aria-label「返信」で識別する（プレースホルダでは区別できない）。
    expect(screen.queryByLabelText('返信')).not.toBeInTheDocument();
  });
});

describe('ChatThread — 書きかけの返信を消さず戻った時に続きから書ける（d737）', () => {
  // 開発統括回答『残して戻れる形にする』（d729）。テーマ切替（remount）・起点カード編集（unmount）・
  // 画面移動（unmount）で書きかけが消えず、戻ると続きから書けることを確かめる。
  beforeEach(() => clearAllReplyDrafts());

  it('起点カードの編集を開始して戻っても、書きかけの返信が残る', () => {
    renderThread();
    const editor = screen.getByLabelText('返信') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<p>書きかけの返信</p>' } });

    // 編集開始＝返信欄を unmount する経路。
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    expect(screen.queryByLabelText('返信')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect((screen.getByLabelText('返信') as HTMLTextAreaElement).value).toBe(
      '<p>書きかけの返信</p>',
    );
  });

  it('テーマを切り替えて戻ると、そのテーマの書きかけが戻る（別テーマの書きかけは混ざらない）', () => {
    const props = renderThreadProps();
    const { rerender } = render(<ChatThread {...props} />);
    fireEvent.change(screen.getByLabelText('返信'), {
      target: { value: '<p>テーマ1の書きかけ</p>' },
    });

    // テーマ切替。実画面では一覧→詳細の往復で ChatThread ごと載り替わる（key 変更で remount）。
    rerender(
      <ChatThread {...props} theme={{ ...theme, id: 't2', title: '別のテーマ' }} key="t2" />,
    );
    expect((screen.getByLabelText('返信') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('返信'), {
      target: { value: '<p>テーマ2の書きかけ</p>' },
    });

    rerender(<ChatThread {...props} theme={theme} key="t1" />);
    expect((screen.getByLabelText('返信') as HTMLTextAreaElement).value).toBe(
      '<p>テーマ1の書きかけ</p>',
    );
  });

  it('起点カードの編集中に閉じても、書きかけがあるので破棄確認を通す（× はフォームの上にある）', () => {
    const props = renderThreadProps();
    render(<ChatThread {...props} />);
    fireEvent.change(screen.getByLabelText('返信'), {
      target: { value: '<p>編集中の書きかけ</p>' },
    });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    expect(screen.queryByLabelText('返信')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
    );
    // 一度ダイアログを挟んだ後に閉じ直す → 確認なしで閉じる。書きかけが残っている限り、編集フォームの
    // キャンセル後の 2 回目も（古い待ちではなく今の dirty で）1 回だけ確認を出す。
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(
      within(screen.getAllByRole('alertdialog')[0]).getByRole('button', { name: 'OK' }),
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('起点カードの編集中に × → OK で閉じると書きかけは捨てられ、開き直しても戻らない', () => {
    const props = renderThreadProps();
    const { rerender } = render(<ChatThread {...props} />);
    fireEvent.change(screen.getByLabelText('返信'), {
      target: { value: '<p>編集中の書きかけ</p>' },
    });
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    // 破棄確認は Rete ダイアログ（確認ボタンは "OK" / dsk-0125・0126 統一）。フォーム編集中の dirty も
    // 合わさっているため、確認はその 1 枚だけ出る。
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    expect(props.onClose).toHaveBeenCalled();

    rerender(<ChatThread {...props} key="reopen" />);
    expect((screen.getByLabelText('返信') as HTMLTextAreaElement).value).toBe('');
  });

  it('× で閉じた時の書きかけは捨て、開き直しても戻さない', () => {
    const props = renderThreadProps();
    const { rerender } = render(<ChatThread {...props} />);
    fireEvent.change(screen.getByLabelText('返信'), { target: { value: '<p>捨てる書きかけ</p>' } });

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    // 破棄確認（dirty のため）→ OK で閉じる。
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(props.onClose).toHaveBeenCalled();

    rerender(<ChatThread {...props} key="reopen" />);
    expect((screen.getByLabelText('返信') as HTMLTextAreaElement).value).toBe('');
  });

  it('送信に成功したら書きかけを捨てる（同じテーマを開き直しても残らない）', async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const props = renderThreadProps({ onReply });
    const { rerender } = render(<ChatThread {...props} />);
    fireEvent.change(screen.getByLabelText('返信'), { target: { value: '<p>送った返信</p>' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();
    expect(onReply).toHaveBeenCalled();

    rerender(<ChatThread {...props} key="reopen" />);
    expect((screen.getByLabelText('返信') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('ChatThread — 403 エラー文言を surface する（dsk-0318）', () => {
  // apiErrorMessage は axios エラーの response.data.error.message を surface する。
  // fake axios エラーは { isAxiosError: true, response: { data: { error: { message } } } } を作る。
  function makeAxiosError(message: string) {
    return {
      isAxiosError: true,
      response: { data: { error: { message } } },
    };
  }

  it('スレッド削除失敗が 403 のとき backend の権限文言を alert に表示すること', async () => {
    const onDeleteTheme = vi
      .fn()
      .mockRejectedValue(makeAxiosError('この操作を行う権限がありません'));
    renderThread({ currentUserId: 'u1', onDeleteTheme });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'スレッドを削除' }));
    // DiscardConfirmDialog の確認ボタンは "OK"（dsk-0125/0126 統一）
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('この操作を行う権限がありません');
  });

  it('メッセージ削除失敗が 403 のとき backend の権限文言を alert に表示すること', async () => {
    const onDeleteMessage = vi
      .fn()
      .mockRejectedValue(makeAxiosError('この操作を行う権限がありません'));
    renderThread({
      currentUserId: 'u2',
      onDeleteMessage,
    });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'メッセージの削除' }));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('この操作を行う権限がありません');
  });

  it('axios 以外の例外（ネットワーク等）は既存フォールバック文言に倒れること', async () => {
    // 想定外エラー（axios エラーではない）→ apiErrorMessage が fallback を返す安全弁を確認。
    renderThread({
      currentUserId: 'u1',
      onDeleteTheme: vi.fn().mockRejectedValue(new Error('network unreachable')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'その他' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'スレッドを削除' }));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('スレッドの削除に失敗しました');
  });
});
