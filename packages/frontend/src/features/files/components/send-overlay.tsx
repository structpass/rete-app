'use client';

import { useEffect, useState } from 'react';
import { Link2, MessageSquare, X } from 'lucide-react';
import toast from 'react-hot-toast';
import type { PathLink, ShareTarget } from '../lib/types';
import { buildShareDescription } from '../lib/path-link';
import { OverlayCloseButton, OverlayDialog } from '@/components/ui/overlay-dialog';
import { OverlayHeader } from '@/components/ui/overlay-header';
import { RequiredMark } from '@/components/ui/required-mark';
import { useFileShare } from '../hooks/use-file-share';
import { RichTextEditor } from '@/features/desk/components/rich-text-editor';
import { isRichTextEmpty } from '@/features/desk/lib/validations';

/**
 * 共有オーバーレイ（FL: ファイル→Desk 導線）。選択した行をパス付きリンク chip として束ね、
 * タイトル・自由記述とともに Desk へ実生成する（chat=新規テーマ / task=新規タスク）。
 * chip は個別に外せ、残ったパスは自由記述の前に plain text として本文へ挿入される（FL-1）。
 *
 * - chat: 送信先セレクトは不要（新規テーマに宛先はない）ため出さない。
 * - task: categoryId が必須のため、サンプル宛先セレクトを実カテゴリ選択に差し替える。
 * focus trap・ESC・背景 inert 隔離は共通部品 OverlayDialog に委譲する（fil-0059/fil-0062）。
 */
export interface SendOverlayProps {
  target: ShareTarget;
  /** 既に上限件数に丸めたパス付きリンク。 */
  links: PathLink[];
  /** 上限超過で落とした件数（0 なら注意書きを出さない）。 */
  overflow: number;
  onClose: () => void;
  /**
   * 破棄確認を挟むか（mdl-0034 規約②）。中身（SendOverlayBody）が自前で同じ判定を持つため、
   * 枠（SendOverlay）へは光らない値を渡す（2 箇所で数えない）。
   */
  dirty?: boolean;
  /** 送信中は閉じる操作を止める。中身が自前の送信状態で止めるので、枠へは false を渡す。 */
  submitting?: boolean;
}

export function SendOverlay(props: SendOverlayProps) {
  return (
    <OverlayDialog
      open
      onClose={() => {
        if (!props.submitting) props.onClose();
      }}
      ariaLabel={props.target === 'task' ? 'タスク共有' : 'チャット共有'}
      width="min(560px, 92vw)"
      dirty={props.dirty}
    >
      <SendOverlayBody {...props} />
    </OverlayDialog>
  );
}

/**
 * オーバーレイの中身（見た目と動き）。破棄確認の判定を受け取るのはこの層で、
 * 枠（OverlayDialog）は外側の SendOverlay に任せる（試験で中身だけを描けるようにする）。
 */
export function SendOverlayBody({ target, links, overflow, onClose }: SendOverlayProps) {
  const {
    categories,
    categoriesLoading,
    categoriesError,
    categoriesErrorReason,
    submitting,
    submit,
  } = useFileShare(target);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined);
  // 説明（自由記述）は Desk チャット明細と同じ RichTextEditor（Tiptap）で編集する（rete-files-0017）。
  // 値は HTML 文字列。空判定は isRichTextEmpty（<p></p> 等を空とみなす）。
  const [body, setBody] = useState('');

  // カテゴリ取得後、未選択なら先頭を既定に（タスク共有は categoryId 必須のため空送信を避ける）。
  useEffect(() => {
    if (target === 'task' && categoryId === undefined && categories.length > 0) {
      setCategoryId(categories[0].id);
    }
  }, [target, categories, categoryId]);

  const shown = links.filter((l) => !removed.has(l.path));
  // 見出しはツールバー導線（「チャット共有」）と表記を揃える（rete-files-0020・"で" を外す）。
  const titleText = target === 'task' ? 'タスク共有' : 'チャット共有';
  const titlePlaceholder = target === 'task' ? 'タスクのタイトル' : 'スレッドのタイトル';
  // タスク共有は categoryId が要る。読み込み中・取得失敗・0 件・未選択のいずれでも送信不可。
  const taskBlocked = target === 'task' && categoryId === undefined;

  const handleSubmit = async () => {
    if (submitting) return; // 二重送信防止（disabled の同期に依存しない明示ガード）。
    const t = title.trim();
    if (!t) {
      toast.error('タイトルを入力してください');
      return;
    }
    if (target === 'task' && categoryId === undefined) {
      toast.error('カテゴリを選択してください');
      return;
    }
    // 自由記述は RichTextEditor の HTML（body）。空エディタ（<p></p> 等）は空文字として渡す。
    // 生成された description は backend sanitizeRichText + 描画側 RichTextView で多層 sanitize される。
    const description = buildShareDescription(
      shown.map((l) => l.path),
      isRichTextEmpty(body) ? '' : body,
    );
    // backend は description @MaxLength(5000)。超過は原因不明の 400 になるため手前で弾く。
    if (description.length > 5000) {
      toast.error('説明が長すぎます（パスと本文を減らしてください）');
      return;
    }
    // d754: 運ぶ側が遭った理由（権限・上限・宛先の不正など）をそのまま出す。
    // 一律の「作成に失敗しました」は、直せる理由まで見えなくする（v2-198 と同じ扱い）。
    const created = await submit({ title: t, description, categoryId });
    if (created.ok) {
      toast.success(target === 'task' ? 'タスクを作成しました' : 'チャットスレッドを作成しました');
      onClose();
    } else {
      toast.error(created.reason);
    }
  };

  return (
    <div className="file-overlay-panel">
      <OverlayHeader
        icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
        title={titleText}
      />
      <div className="file-overlay-body">
        {target === 'task' && (
          <label className="fo-field">
            <span className="fo-label">カテゴリ</span>
            <select
              className="fo-input"
              value={categoryId ?? ''}
              disabled={categoriesLoading || categories.length === 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                // option の value は妥当なカテゴリ id のみだが、空 option / 異常値は undefined に倒す。
                setCategoryId(Number.isInteger(v) && v > 0 ? v : undefined);
              }}
            >
              {categoriesLoading ? (
                <option value="">読み込み中…</option>
              ) : categories.length === 0 ? (
                <option value="">カテゴリがありません</option>
              ) : (
                categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))
              )}
            </select>
            {/* d754: 取得に失敗した理由を捨てず、そのまま出したうえで共有不能を伝える。 */}
            {!categoriesLoading && categoriesError && (
              <span className="fo-field-error">
                {categoriesErrorReason}。タスクで共有できません。
              </span>
            )}
            {!categoriesLoading && !categoriesError && categories.length === 0 && (
              <span className="fo-field-error">
                カテゴリがありません。先に Desk でカテゴリを作成してください。
              </span>
            )}
          </label>
        )}
        <label className="fo-field">
          {/* タイトルはサーバが必須（CreateTaskDto.title = IsNotEmpty）＝正本 comp-form-field の必須バッジを出す。 */}
          <span className="fo-label">
            タイトル
            <RequiredMark />
          </span>
          <input
            className="fo-input"
            type="text"
            aria-required="true"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={titlePlaceholder}
            maxLength={500}
            autoComplete="off"
          />
        </label>
        <div className="fo-field">
          <span className="fo-label">説明</span>
          {/* 説明コンポーザーは Desk チャット明細のメッセージ入力欄をそのまま流用する（rete-files-0017・
                開発統括指示「チャット明細のメッセージ入力欄をそのまま使って」）。Desk と同じ枠
                （.desk-global-input-composer）＋書式ツールバー付き RichTextEditor で意匠・操作を一致させる。
                共有特有のパス付きリンク chip 群はエディタ直上に置く（reply-composer の保留添付チップ行と同型）。 */}
          <div className="desk-global-input-composer">
            <div className="fo-links">
              {shown.map((link) => (
                <div key={link.path} className="fo-link">
                  <span className="fo-link-glyph">
                    <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className="fo-link-path">{link.path}</span>
                  <span className="fo-link-kind">{link.label}</span>
                  <button
                    type="button"
                    className="fo-link-remove"
                    aria-label="リンクを削除"
                    onClick={() => setRemoved((prev) => new Set(prev).add(link.path))}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            <RichTextEditor
              value={body}
              onChange={setBody}
              ariaLabel="説明"
              placeholder="確認してほしい点など、補足があれば入力…"
              minRows={3}
              onSubmitShortcut={() => void handleSubmit()}
            />
          </div>
          {overflow > 0 && (
            <p className="fo-overflow">
              選択 {links.length + overflow} 件のうち先頭 {links.length} 件をリンク化しました（1
              回の送信は {links.length} 件まで）。
            </p>
          )}
        </div>
      </div>
      <div className="file-overlay-foot">
        <OverlayCloseButton className="fo-btn-ghost" disabled={submitting}>
          キャンセル
        </OverlayCloseButton>
        <button
          type="button"
          className="fo-btn-primary"
          onClick={handleSubmit}
          disabled={submitting || taskBlocked}
        >
          {submitting ? '送信中…' : '送信'}
        </button>
      </div>
    </div>
  );
}
