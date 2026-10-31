'use client';
import { ThemeEditForm } from '@/features/desk/components/chat-thread/theme-edit-form';
import { Avatar } from '@/features/desk/components/desk-avatar';
import { ReactionBar } from '@/features/desk/components/reaction-bar';
import { RichTextView } from '@/features/desk/components/rich-text-view';
import { AttachmentList } from '@/features/desk/components/task-attachments';
import type { useChatThreadController } from '@/features/desk/hooks/use-chat-thread-controller';
import type { ChatThreadProps } from '@/features/desk/lib/chat-thread-types';
import { isRichTextEmpty } from '@/features/desk/lib/validations';
import { formatDateTime } from '@/lib/utils';
import { MoreHorizontal, Pencil } from 'lucide-react';
type Props = Pick<
  ReturnType<typeof useChatThreadController>,
  | 'setActiveTab'
  | 'editing'
  | 'setEditing'
  | 'saving'
  | 'saveError'
  | 'menuOpen'
  | 'setMenuOpen'
  | 'setDeleteConfirmOpen'
  | 'deleting'
  | 'menuRef'
  | 'menuBtnRef'
  | 'editingMessageId'
  | 'setTenmatsuDraft'
  | 'isOwnTheme'
  | 'canEditTheme'
  | 'canDeleteTheme'
  | 'mentionItems'
  | 'themeAttachments'
  | 'reportEditDirty'
  | 'handleCancelEdit'
  | 'handleSaveEdit'
> &
  Pick<ChatThreadProps, 'onToggleThemeReaction' | 'highlight'> & {
    theme: NonNullable<ChatThreadProps['theme']>;
  };
export function ChatThreadHead({
  theme,
  onToggleThemeReaction,
  highlight,
  setActiveTab,
  editing,
  setEditing,
  saving,
  saveError,
  menuOpen,
  setMenuOpen,
  setDeleteConfirmOpen,
  deleting,
  menuRef,
  menuBtnRef,
  editingMessageId,
  setTenmatsuDraft,
  isOwnTheme,
  canEditTheme,
  canDeleteTheme,
  mentionItems,
  themeAttachments,
  reportEditDirty,
  handleCancelEdit,
  handleSaveEdit,
}: Props) {
  return (
    <div className="desk-thread-head">
      <div className="desk-thread-head-meta">
        <Avatar author={theme.author} size={1.5} />
        <span className="desk-thread-head-name">{theme.author.name}</span>
        <span className="desk-thread-head-time">{formatDateTime(theme.createdAt)}</span>
        {/* 起点カードのアクション。編集（0041 配線済）/ その他（メッセージ削除メニュー / rete-desk-0095）。
                        アーカイブはタブ strip の × 左隣へ移設済（rete-desk-0058）。
                        first-of-type の margin-left:auto でメタ行右端へ寄せる（モック準拠）。
                        編集モード中はトグルボタンを隠してフォームへ集中させる。
                        他人の投稿（author ≠ 自分）では編集・その他を出さない（rete-desk-0083 所有判定）。
                        dsk-0318: 業務ロール由来の canUpdate/canDelete が無いと編集鉛筆は出さない（その他メニューは
                        「メッセージを顛末へコピー」が残るため ownTheme のみ）。「スレッドを削除」項目は下の
                        menu 内側で canDeleteTheme により制御する（押せそうで 403 の UX 不整合を断つ）。 */}
        {canEditTheme && !editing && !editingMessageId && (
          <button
            type="button"
            className="desk-thread-head-icon-btn"
            title="編集"
            aria-label="編集"
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
        {isOwnTheme && !editing && !editingMessageId && (
          <button
            type="button"
            ref={menuBtnRef}
            className="desk-thread-head-icon-btn"
            title="その他"
            aria-label="その他"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls="desk-thread-head-menu-theme"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
        {/* その他メニュー（rete-desk-0095）。メタ行（position:relative）の右肩から下へ開く。
                        編集モード中はトリガーごと隠す（編集ボタンと同じ「フォームへ集中」ゲート）。 */}
        {menuOpen && !editing && (
          <div
            id="desk-thread-head-menu-theme"
            ref={menuRef}
            className="desk-thread-head-menu"
            role="menu"
            aria-label="その他メニュー"
          >
            {/* dsk-0248: 説明欄（テーマ本文）を顛末ドラフトへコピーし、顛末タブへ切り替える。
                            既存の顛末ドラフトが空（空 HTML 含む）なら置換、内容があれば末尾へ追記して
                            既入力を失わないようにする（コピーは保存ではなくドラフト反映＝顛末タブの保存で確定）。 */}
            <button
              type="button"
              role="menuitem"
              className="desk-thread-head-menu-item"
              onClick={() => {
                setMenuOpen(false);
                const desc = theme?.description ?? '';
                // 説明欄が空（空 HTML 含む）なら、コピーもタブ切替もしない
                // （空コピーで顛末タブへ飛ぶ事故・空段落の意図しない追記を防ぐ / dsk-0248 review MEDIUM）。
                if (isRichTextEmpty(desc)) return;
                setTenmatsuDraft((prev) => (isRichTextEmpty(prev) ? desc : `${prev}${desc}`));
                setActiveTab('tenmatsu');
              }}
            >
              メッセージを顛末へコピー
            </button>
            {/* dsk-0248: 従来「メッセージ削除」をラベルのみ「スレッドを削除」へ（開発統括指示）。
                            機能は既存のテーマ（スレッド起点）物理削除（onDeleteTheme）を流用。
                            dsk-0318: 業務ロール由来 canDelete が無いと項目を出さない（押せそうで 403 の UX 不整合を断つ）。 */}
            {canDeleteTheme && (
              <button
                type="button"
                role="menuitem"
                className="desk-thread-head-menu-item is-destructive"
                disabled={deleting}
                onClick={() => {
                  setMenuOpen(false);
                  setDeleteConfirmOpen(true);
                }}
              >
                スレッドを削除
              </button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <ThemeEditForm
          initialTitle={theme.title}
          initialDescription={theme.description ?? ''}
          saving={saving}
          error={saveError}
          attachmentsController={themeAttachments}
          mentionItems={mentionItems}
          onSave={(p) => void handleSaveEdit(p)}
          onCancel={handleCancelEdit}
          onDirtyChange={reportEditDirty}
        />
      ) : (
        <>
          {/* 説明はリッチテキスト（HTML）。sanitize して描画（ADR 0019・生タグ露出/XSS 防止）。
                          backend も description を sanitize するが、描画側でも RichTextView を通す多層防御。 */}
          <RichTextView
            html={theme.description}
            className="desk-thread-head-body"
            highlight={highlight}
          />
          <ReactionBar reactions={theme.reactions} onToggle={onToggleThemeReaction} />
          {/* テーマに付いた添付（FL-3b・embed・読み取り表示）。編集モードで add/remove する。 */}
          <AttachmentList items={theme.attachments} />
        </>
      )}
    </div>
  );
}
