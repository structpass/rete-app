'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Account } from '@/features/tasks/lib/api';
import { validateMessageInput, isRichTextEmpty } from '../lib/validations';
import { usePendingAttachments } from '../hooks/use-pending-attachments';
import { PendingChipsRow, PendingAddButton } from './pending-attachment-field';
import { RichTextEditor } from './rich-text-editor';
import { extractMentionAccountIds } from '../lib/mentions';

interface ReplyComposerProps {
  /**
   * 送信成功で resolve する。失敗は throw（本コンポーネントが error 表示する）。
   * fileIds は deferred-flush 添付（FL-3b）。mentionAccountIds は宛先（メンション先 / rete-desk-0049）で、
   * 本文中の @ メンションノードから抽出する（rete-desk-0080）。投稿成功後に作成発話へ紐づく。
   */
  onReply: (body: string, fileIds: string[], mentionAccountIds: string[]) => Promise<unknown>;
  /** @ メンション候補（全アカウント / rete-desk-0049）。誰でもメンション可。 */
  accounts: Account[];
  /**
   * 返信ドラフトの差分（本文 or 保留添付あり）を上位へ報告する（rete-desk-0120）。チャット詳細の破棄
   * ガード（rightDirtyRef）へ合流し、書きかけで × / ESC / 枠外クリックで閉じる時に破棄確認の対象にする。
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * 返信入力のキャンセル（入力初期化）時、dirty なら破棄確認を通す（rete-desk-0166）。上位 ChatThread の
   * useDiscardConfirm().request を渡す。未指定なら確認なしで即クリア。**画面は閉じない**（onClose を呼ばず
   * 入力欄を初期化するだけ＝× / ESC の「閉じる」とは別経路 / rete-desk-0165・0166）。
   */
  requestDiscard?: (dirty: boolean, proceed: () => void) => void;
  /**
   * 上位が保持する書きかけ本文（テーマごとの下書き / d737）。指定時は value 制御にし、入力は
   * onChangeBody で上位へ返す。上位がテーマ切替（key の付け替え）でアンマウントしても書きかけは
   * 上位に残り、戻った時に復元される。**保留添付はこの欄に残らない**（アンマウントで消える）。
   */
  value?: string;
  onChangeBody?: (body: string) => void;
  /** 送信に成功した時（保留添付の添付後）に呼ぶ。上位が保持する書きかけを捨てる（d737）。 */
  onSent?: () => void;
}

/** チャット詳細スレッド（右オーバーレイ）下部の返信入力欄。Ctrl/Cmd+Enter で送信。 */
export function ReplyComposer({
  onReply,
  accounts,
  onDirtyChange,
  requestDiscard,
  value,
  onChangeBody,
  onSent,
}: ReplyComposerProps) {
  // 上位が書きかけを保持する時は value 制御（d737）、未指定なら従来どおり自前で持つ。
  const [innerBody, setInnerBody] = useState('');
  const body = value ?? innerBody;
  const setBody = onChangeBody ?? setInnerBody;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingAttachments = usePendingAttachments();

  // 返信ドラフトの差分判定。空本文（<p></p> 等の空 HTML 含む）かつ保留添付なしなら未編集（過剰確認を防ぐ）。
  const dirty = !isRichTextEmpty(body) || pendingAttachments.pending.length > 0;
  // 差分を上位（ChatThread→rightDirtyRef）へ報告する（rete-desk-0120）。onDirtyChange は安定参照のため
  // deps は dirty のみ（編集フォーム / 顛末の dirty 報告と同方式）。
  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);
  // アンマウント時は dirty=false を報告し、閉じた後の誤発火を防ぐ安全網（テーマ切替の remount でも通るが、
  // 上位はテーマごとの書きかけ基準で dirty を報告し直す / d737）。
  useEffect(() => {
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // @ メンション候補（id=accountId / label=表示名）。RichTextEditor の suggestion が参照する。
  const mentionItems = useMemo(
    () => accounts.map((a) => ({ id: a.id, label: a.name })),
    [accounts],
  );

  // 返信入力のキャンセル（rete-desk-0165・0166）。dirty なら破棄確認を通し、確認後に入力欄を初期化する
  // だけにする（本文クリア + 保留添付クリア + エラー解除）。**チャット詳細画面は閉じない**（× / ESC の
  // 「閉じる」経路とは別物）。dirty でなければ確認なしで即クリア。
  const handleCancel = () => {
    const proceed = () => {
      setBody('');
      pendingAttachments.clear();
      setError(null);
    };
    if (requestDiscard) requestDiscard(dirty, proceed);
    else proceed();
  };

  const handleSubmit = async () => {
    const validationError = validateMessageInput(body);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // 保留ファイルは投稿成功後に作成発話へ添付される（onReply→postMessage が post→attach→reload を一括処理）。
      // 宛先（mentionAccountIds）は本文中の @ メンションから抽出し、本体作成と同時に永続化される。
      await onReply(
        body,
        pendingAttachments.pending.map((p) => p.fileId),
        extractMentionAccountIds(body),
      );
      setBody('');
      pendingAttachments.clear();
      // 送信成功で書きかけの保持も捨てる（上位がテーマごとに保持している / d737）。
      onSent?.();
    } catch {
      setError('返信の送信に失敗しました');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="desk-global-input">
      {error && <p className="mb-2 text-xs text-[var(--sp-accent-red)]">{error}</p>}
      <div className="desk-global-input-composer">
        {/* 本文は共有リッチエディタ（Tiptap / ADR 0019）。Ctrl/Cmd+Enter 送信はエディタの
            handleKeyDown へ配線（onSubmitShortcut）。@ 入力で宛先メンション候補が出る（rete-desk-0080）。
            composer 枠は外側が持つため .desk-rte 枠は CSS で無効化（globals.css）。 */}
        <RichTextEditor
          value={body}
          onChange={setBody}
          ariaLabel="返信"
          placeholder="スレッドに返信"
          minRows={3}
          onSubmitShortcut={() => void handleSubmit()}
          enableMention
          mentionItems={mentionItems}
        />
        {/* 保留ファイルのチップは本文直下の専用行へ（送信ボタン行とは分離・rete-desk-0070）。 */}
        <PendingChipsRow
          pending={pendingAttachments.pending}
          onRemove={pendingAttachments.remove}
          disabled={submitting}
        />
        <div className="desk-global-input-footer">
          {/* ファイル添付（FL-3b・deferred-flush）。投稿確定まで保留し、送信成功時に作成発話へ紐づける。 */}
          <PendingAddButton onAdd={pendingAttachments.add} disabled={submitting} />
          {/* キャンセル + 送信は チャット明細の編集フッタ（.desk-thread-head-edit-actions = 列2中央）と同じ
              並び・装飾に統一する（rete-desk-0167・開発統括指示「[キャンセル][送信] の並びにして」）。
              両ボタンとも常時表示し、本文が空のときだけ disabled（dsk-0350）。 */}
          <div className="desk-thread-head-edit-actions">
            <button
              type="button"
              className="desk-ticket-btn desk-ticket-btn-ghost"
              onClick={handleCancel}
              disabled={submitting || isRichTextEmpty(body)}
            >
              キャンセル
            </button>
            <button
              type="button"
              className={`desk-global-input-send${isRichTextEmpty(body) ? '' : ' is-active'}`}
              onClick={handleSubmit}
              disabled={submitting || isRichTextEmpty(body)}
            >
              送信
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
