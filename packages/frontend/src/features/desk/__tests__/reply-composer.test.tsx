import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { flush } from '@/test-utils/flush';
import { afterEach } from 'vitest';

// cmn-0142: vi.hoisted 化（vi.fn は無いが JSX スタブを hoist し grep ゲートを通す）
const { RichTextEditor, FilePickerOverlay } = vi.hoisted(() => ({
  // 本文エディタ（Tiptap）は jsdom 非対応のため textarea スタブへ。onChange だけ通せれば送信検証は可能。
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
  // ファイルピッカーは files API を引くため、onPick を即時に呼ぶ軽量スタブへ差し替える
  //（deferred-flush の fileIds 配線のみを検証対象にする）。
  FilePickerOverlay: ({
    onPick,
  }: {
    onPick: (fileId: string, fileName: string, source: 'repo' | 'local') => void;
  }) => (
    <button type="button" onClick={() => onPick('f1', '見積.pdf', 'local')}>
      pick-stub
    </button>
  ),
}));

vi.mock('../components/rich-text-editor', () => ({
  RichTextEditor,
}));

vi.mock('../components/file-picker-overlay', () => ({
  FilePickerOverlay,
}));

import { ReplyComposer } from '../components/reply-composer';
// dsk-0203 でチャット/タスク共有ユーティリティ（lib/mentions）へ抽出。既存挙動の検証はここに残す。
import { extractMentionAccountIds } from '../lib/mentions';
import { clearAllReplyDrafts, readReplyDraft, writeReplyDraft } from '../lib/reply-drafts';

/** 親の clearReplyDraft 相当（テーマの書きかけを消す）。 */
function clearReplyDraftForTest(themeId: string) {
  writeReplyDraft(themeId, '');
}
import type { ChatMessage } from '../lib/api';

/** ReplyComposer.onReply の型（実 prop から導出）。無型の vi.fn() を実 prop の型へ結ぶ（v2-253）。 */
type ReplyHandler = ComponentProps<typeof ReplyComposer>['onReply'];

/**
 * 返信投稿（onReply → postChatMessage）の応答。形の正本は desk api の ChatMessage
 * （@rete/shared の ChatMessageResponseDto）で、値の生成をここ 1 箇所へ集約する（v2-253）。
 */
function message(id: string): ChatMessage {
  return {
    id,
    themeId: 't1',
    body: '本文',
    author: { id: 'u1', name: '佐久間' },
    createdAt: '2026-06-01T00:00:00.000Z',
    reactions: [],
    attachments: [],
    mentions: [],
  };
}

/** 応答形を直書きしない onReply モック（v2-253）。 */
function onReplyMock(): ReplyHandler {
  return vi.fn().mockResolvedValue(message('m1'));
}

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe('extractMentionAccountIds — 本文 HTML から宛先 id 抽出（rete-desk-0080 / dsk-0203 共有化）', () => {
  it('Mention ノードの data-id を順序保持・重複排除で返す', () => {
    const html =
      '<p>確認 <span data-type="mention" data-id="u-1" data-label="山田">@山田</span> と ' +
      '<span data-type="mention" data-id="u-2" data-label="田中">@田中</span> ' +
      '<span data-type="mention" data-id="u-1" data-label="山田">@山田</span></p>';
    expect(extractMentionAccountIds(html)).toEqual(['u-1', 'u-2']);
  });

  it('メンションが無い本文は空配列を返す', () => {
    expect(extractMentionAccountIds('<p>ただのテキスト</p>')).toEqual([]);
    expect(extractMentionAccountIds('')).toEqual([]);
  });
});

describe('ReplyComposer — 返信 + deferred-flush 添付（FL-3b）', () => {
  it('本文入力欄・ファイル添付ボタン・送信ボタンを描画する', () => {
    render(<ReplyComposer onReply={onReplyMock()} accounts={[]} />);
    expect(screen.getByLabelText('返信')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ファイル添付' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送信' })).toBeInTheDocument();
  });

  it('添付なし・宛先なしで送信すると onReply に (body, [], []) を渡し、本文をクリアする', async () => {
    const onReply = onReplyMock();
    render(<ReplyComposer onReply={onReply} accounts={[]} />);
    const editor = screen.getByLabelText('返信') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<p>承知しました</p>' } });

    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(onReply).toHaveBeenCalledWith('<p>承知しました</p>', [], []);
    expect(editor.value).toBe('');
  });

  it('保留ファイルを添付して送信すると onReply に fileIds を渡す', async () => {
    const onReply = onReplyMock();
    render(<ReplyComposer onReply={onReply} accounts={[]} />);
    fireEvent.change(screen.getByLabelText('返信'), { target: { value: '<p>確認します</p>' } });

    // ファイル添付 → ピッカースタブで 1 件選択（チップとして保留）。
    fireEvent.click(screen.getByRole('button', { name: 'ファイル添付' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick-stub' }));
    expect(screen.getByText('見積.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(onReply).toHaveBeenCalledWith('<p>確認します</p>', ['f1'], []);
  });

  it('空本文では検証エラーを出し onReply を呼ばない', async () => {
    const onReply = vi.fn();
    render(<ReplyComposer onReply={onReply} accounts={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();
    expect(onReply).not.toHaveBeenCalled();
  });

  it('本文中の @ メンションから宛先 id を抽出し onReply の第3引数へ渡す（rete-desk-0080）', async () => {
    const accounts = [
      { id: 'u-1', name: '山田' },
      { id: 'u-2', name: '田中' },
    ];
    const onReply = onReplyMock();
    render(<ReplyComposer onReply={onReply} accounts={accounts} />);
    // 実エディタは @ サジェストで Mention ノードを挿入するが、テストでは stub textarea に
    // 確定後の本文 HTML（mention span 入り）を直接流し込み、抽出→配線を検証する。
    const body =
      '<p>共有します <span data-type="mention" data-id="u-1" data-label="山田">@山田</span></p>';
    fireEvent.change(screen.getByLabelText('返信'), { target: { value: body } });

    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(onReply).toHaveBeenCalledWith(body, [], ['u-1']);
  });

  it('旧「宛先を指定」ピッカーボタンは廃止され描画されない（rete-desk-0080）', () => {
    render(<ReplyComposer onReply={vi.fn()} accounts={[{ id: 'u-1', name: '山田' }]} />);
    expect(screen.queryByRole('button', { name: '宛先を指定' })).not.toBeInTheDocument();
  });
});

describe('ReplyComposer — 上位が保持する書きかけを value で受ける（d737）', () => {
  beforeEach(() => clearAllReplyDrafts());

  it('value を渡すと本文として表示し、入力は onChangeBody へ返す（自前では持たない）', () => {
    const onChangeBody = vi.fn();
    const { rerender } = render(
      <ReplyComposer
        onReply={vi.fn()}
        accounts={[]}
        value="<p>親が保持する書きかけ</p>"
        onChangeBody={onChangeBody}
      />,
    );
    const editor = screen.getByLabelText('返信') as HTMLTextAreaElement;
    expect(editor.value).toBe('<p>親が保持する書きかけ</p>');

    fireEvent.change(editor, { target: { value: '<p>追記</p>' } });
    expect(onChangeBody).toHaveBeenCalledWith('<p>追記</p>');
    // 制御コンポーネントのため、上位が値を返すまで表示は変わらない。
    expect(editor.value).toBe('<p>親が保持する書きかけ</p>');

    rerender(
      <ReplyComposer
        onReply={vi.fn()}
        accounts={[]}
        value="<p>追記</p>"
        onChangeBody={onChangeBody}
      />,
    );
    expect(editor.value).toBe('<p>追記</p>');
  });

  it('送信成功で onSent を呼ぶ（上位が書きかけを捨てる）', async () => {
    const onSent = vi.fn();
    const onReply = onReplyMock();
    render(
      <ReplyComposer
        onReply={onReply}
        accounts={[]}
        value="<p>送信本文</p>"
        onChangeBody={vi.fn()}
        onSent={onSent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();
    expect(onReply).toHaveBeenCalledWith('<p>送信本文</p>', [], []);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('送信に失敗した時は onSent を呼ばない（書きかけを残す）', async () => {
    const onSent = vi.fn();
    const onReply = vi.fn().mockRejectedValue(new Error('network'));
    render(
      <ReplyComposer
        onReply={onReply}
        accounts={[]}
        value="<p>送信本文</p>"
        onChangeBody={vi.fn()}
        onSent={onSent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();
    expect(onSent).not.toHaveBeenCalled();
  });

  it('書きかけを消す口は onSent（onChangeBody が何も反映しない上位でも送信成功で書きかけが消える）', async () => {
    // 親（useChatThreadController）の消し口径路を試験で保護する。送信時に ReplyComposer は本文を空にして
    // onChangeBody('') を呼ぶため、その側だけでは上の「onSent 呼び出し」を外しても試験が通ってしまう。
    // ここでは onChangeBody を変化を反映しない敵対的な上位にして、onSent→保持の消去が効くことを見る。
    writeReplyDraft('t1', '<p>書きかけ</p>');
    const onSent = vi.fn(() => clearReplyDraftForTest('t1'));
    const { rerender } = render(
      <ReplyComposer
        onReply={onReplyMock()}
        accounts={[]}
        value="<p>書きかけ</p>"
        onChangeBody={vi.fn()}
        onSent={onSent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(readReplyDraft('t1')).toBeUndefined();

    rerender(
      <ReplyComposer
        onReply={onReplyMock()}
        accounts={[]}
        value=""
        onChangeBody={vi.fn()}
        onSent={onSent}
      />,
    );
    expect((screen.getByLabelText('返信') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('ReplyComposer — 入力キャンセル（dsk-0350・常時表示+disabled 化）', () => {
  it('未編集でもキャンセルボタンは常時表示・本文空で disabled', () => {
    render(<ReplyComposer onReply={vi.fn()} accounts={[]} />);
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled();
  });

  it('本文を入力するとキャンセルボタンが活性化する', () => {
    render(<ReplyComposer onReply={vi.fn()} accounts={[]} />);
    fireEvent.change(screen.getByLabelText('返信'), { target: { value: '<p>書きかけ</p>' } });
    expect(screen.getByRole('button', { name: 'キャンセル' })).not.toBeDisabled();
  });

  it('requestDiscard 未指定なら確認なしで即クリアし、本文を再び空にする（画面は閉じない・キャンセルは常時表示のまま disabled へ戻る）', () => {
    render(<ReplyComposer onReply={vi.fn()} accounts={[]} />);
    const editor = screen.getByLabelText('返信') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<p>書きかけ</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(editor.value).toBe('');
    // クリア後は dirty=false に戻りキャンセルボタンは再び disabled へ。
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled();
  });

  it('requestDiscard 指定時は (dirty, proceed) を渡し、proceed 実行で初めて本文がクリアされる', () => {
    let captured: { dirty: boolean; proceed: () => void } | null = null;
    const requestDiscard = vi.fn((dirty: boolean, proceed: () => void) => {
      captured = { dirty, proceed };
    });
    render(<ReplyComposer onReply={vi.fn()} accounts={[]} requestDiscard={requestDiscard} />);
    const editor = screen.getByLabelText('返信') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<p>書きかけ</p>' } });

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    // 破棄確認を上位へ委譲した時点では dirty=true を通知し、本文はまだ残っている。
    expect(requestDiscard).toHaveBeenCalledTimes(1);
    expect(captured!.dirty).toBe(true);
    expect(editor.value).toBe('<p>書きかけ</p>');

    // 上位が破棄を確定（proceed）した後に本文が初期化される。
    act(() => captured!.proceed());
    expect(editor.value).toBe('');
  });
});
