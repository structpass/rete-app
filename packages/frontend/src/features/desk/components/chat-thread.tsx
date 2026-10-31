'use client';
import { Spinner } from '@/components/ui/spinner';
import { ChatThreadDialogs } from '@/features/desk/components/chat-thread/chat-thread-dialogs';
import { ChatThreadHead } from '@/features/desk/components/chat-thread/chat-thread-head';
import { ChatThreadOutcome } from '@/features/desk/components/chat-thread/chat-thread-outcome';
import { MessageEditForm } from '@/features/desk/components/chat-thread/message-edit-form';
import { avatarColor, avatarInitial } from '@/features/desk/components/desk-avatar';
import { ArchiveIcon } from '@/features/desk/components/desk-status-icons';
import { ReactionBar } from '@/features/desk/components/reaction-bar';
import { ReplyComposer } from '@/features/desk/components/reply-composer';
import { RichTextView } from '@/features/desk/components/rich-text-view';
import { AttachmentList } from '@/features/desk/components/task-attachments';
import { useChatThreadController } from '@/features/desk/hooks/use-chat-thread-controller';
import type { ChatThreadProps } from '@/features/desk/lib/chat-thread-types';
import { isRichTextEmpty } from '@/features/desk/lib/validations';
import { formatDateTime } from '@/lib/utils';
import { MoreHorizontal, Pencil, X } from 'lucide-react';

export function ChatThread({
  theme,
  loading,
  error,
  onClose,
  onReply,
  onUpdateMessage,
  onRefetchTheme,
  accounts,
  onUpdateTheme,
  onArchive,
  onDeleteTheme,
  onDeleteMessage,
  onToggleMessageReaction,
  onToggleThemeReaction,
  onDirtyChange,
  currentUserId,
  highlight,
}: ChatThreadProps) {
  const {
    showSpinner,
    activeTab,
    setActiveTab,
    tabStripRef,
    onTabStripMouseOver,
    onTabStripMouseLeave,
    tabHoverBandStyle,
    editing,
    setEditing,
    saving,
    saveError,
    archiving,
    archiveError,
    menuOpen,
    setMenuOpen,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    deleting,
    deleteError,
    menuRef,
    menuBtnRef,
    editingMessageId,
    setEditingMessageId,
    messageSaving,
    messageSaveError,
    messageMenuId,
    setMessageMenuId,
    messageMenuRef,
    messageMenuBtnRef,
    deleteMessageId,
    setDeleteMessageId,
    deleteMessageError,
    setDeleteMessageError,
    deletingMessage,
    tenmatsuDraft,
    setTenmatsuDraft,
    tenmatsuSaving,
    tenmatsuError,
    tenmatsuDirty,
    threadBodyRef,
    onThreadScroll,
    isOwnTheme,
    canEditTheme,
    canDeleteTheme,
    mentionItems,
    themeAttachments,
    messageAttachments,
    reportEditDirty,
    reportMessageEditDirty,
    reportReplyDirty,
    discard,
    handleCancelEdit,
    handleCancelMessageEdit,
    handleSaveMessage,
    handleClose,
    handleArchiveToggle,
    handleDeleteTheme,
    handleDeleteMessage,
    handleSaveEdit,
    handleSaveTenmatsu,
    replyDraft,
    handleReplyDraftChange,
    clearReplyDraft,
  } = useChatThreadController({
    theme,
    loading,
    onClose,
    onUpdateMessage,
    onRefetchTheme,
    accounts,
    onUpdateTheme,
    onArchive,
    onDeleteTheme,
    onDeleteMessage,
    onDirtyChange,
    currentUserId,
  });

  return (
    <>
      <ChatThreadDialogs
        deleteConfirmOpen={deleteConfirmOpen}
        setDeleteConfirmOpen={setDeleteConfirmOpen}
        deleting={deleting}
        deleteMessageId={deleteMessageId}
        setDeleteMessageId={setDeleteMessageId}
        deletingMessage={deletingMessage}
        discard={discard}
        handleDeleteTheme={handleDeleteTheme}
        handleDeleteMessage={handleDeleteMessage}
      />
      <section data-right-view="thread" aria-label="チャット詳細" className="desk-view is-active">
        {/* ヘッダ = スレッド / 顛末 タブ strip。閉じる × は右端（モックはタブ strip がヘッダを兼ねる）。 */}
        <div
          className="desk-ticket-tabs"
          role="tablist"
          aria-label="スレッド表示タブ"
          ref={tabStripRef}
          onMouseOver={onTabStripMouseOver}
          onMouseLeave={onTabStripMouseLeave}
        >
          {tabHoverBandStyle ? (
            <div
              aria-hidden="true"
              className="desk-ticket-tab-hoverband"
              style={tabHoverBandStyle}
            />
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'thread'}
            className={`desk-ticket-tab${activeTab === 'thread' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('thread')}
          >
            スレッド
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'tenmatsu'}
            className={`desk-ticket-tab${activeTab === 'tenmatsu' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('tenmatsu')}
          >
            顛末
          </button>
          {/* アーカイブ。開発統括指示（rete-desk-0058）でメタ行から閉じる × の左隣へ移設。クリックでトグル（0077）。
            アーカイブ／解除は起点カードの所有者のみ（backend は rete-desk-0083 でオーナー限定 = 非所有者は 403）。
            編集ボタン（isOwnTheme ゲート）と同じく非所有者には出さず、押下→403→失敗通知の不整合を断つ（rete-desk-0110）。 */}
          {theme && isOwnTheme && (
            <button
              type="button"
              onClick={() => void handleArchiveToggle()}
              disabled={archiving}
              aria-pressed={theme.archived}
              title={theme.archived ? 'アーカイブ解除' : 'アーカイブ'}
              aria-label={theme.archived ? 'アーカイブ解除' : 'アーカイブ'}
              className={`desk-chat-archive-btn is-thread-archive is-labeled ml-auto self-center${theme.archived ? ' is-archived' : ''}`}
            >
              <ArchiveIcon />
              <span>{theme.archived ? 'アーカイブ済' : 'アーカイブ'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleClose}
            aria-label="閉じる"
            // 右端固定: 直前のアーカイブボタン（ml-auto）が在る時はそれが押し出すため × 自身の ml-auto は不要。
            // アーカイブが非表示の時（ロード中 or 非所有テーマ）は × に ml-auto を付けて右端へ寄せる
            // （rete-desk-0118: メンション seed で非所有テーマが増え、× が左寄せに退行していた）。
            className={`desk-pane-close self-center${theme && isOwnTheme ? '' : ' ml-auto'}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* アーカイブ操作の失敗通知（rete-desk-0077）。両タブ共通のため tab strip 直下に置く。 */}
        {archiveError && (
          <p role="alert" className="px-3 py-1.5 text-xs text-[var(--sp-accent-red)]">
            {archiveError}
          </p>
        )}
        {/* メッセージ削除の失敗通知（rete-desk-0095）。成功時は詳細ごと閉じるため通知枠は失敗時のみ出る。 */}
        {deleteError && (
          <p role="alert" className="px-3 py-1.5 text-xs text-[var(--sp-accent-red)]">
            {deleteError}
          </p>
        )}
        {/* 発話削除の失敗通知（dsk-0316）。成功時は一覧から自動で消えるため通知枠は失敗時のみ出る。 */}
        {deleteMessageError && (
          <p role="alert" className="px-3 py-1.5 text-xs text-[var(--sp-accent-red)]">
            {deleteMessageError}
          </p>
        )}

        {activeTab === 'tenmatsu' ? (
          <ChatThreadOutcome
            theme={theme}
            error={error}
            showSpinner={showSpinner}
            tenmatsuDraft={tenmatsuDraft}
            setTenmatsuDraft={setTenmatsuDraft}
            tenmatsuSaving={tenmatsuSaving}
            tenmatsuError={tenmatsuError}
            tenmatsuDirty={tenmatsuDirty}
            mentionItems={mentionItems}
            handleSaveTenmatsu={handleSaveTenmatsu}
          />
        ) : (
          <>
            {theme && !error && !showSpinner && (
              <div className="shrink-0 px-3 py-2">
                <h4 className="desk-thread-head-title truncate" title={theme.title}>
                  {theme.title}
                </h4>
              </div>
            )}
            <div className="desk-pane-body" ref={threadBodyRef} onScroll={onThreadScroll}>
              {showSpinner && (
                <div className="flex h-full items-center justify-center">
                  <Spinner className="h-5 w-5" />
                </div>
              )}
              {error && <p className="p-4 text-sm text-[var(--sp-accent-red)]">{error}</p>}
              {/* dsk-0234: showSpinner（閾値超ロード）中はスピナー専一にし、stale content との二重描画を防ぐ。
                高速再取得（showSpinner=false）では stale theme を保ったままちらつきなく差し替える。 */}
              {!error && theme && !showSpinner && (
                <div className="desk-thread-view">
                  {/* テーマ本体。題名はスクロール領域の外に1回だけ表示する。 */}
                  <ChatThreadHead
                    theme={theme}
                    onToggleThemeReaction={onToggleThemeReaction}
                    highlight={highlight}
                    setActiveTab={setActiveTab}
                    editing={editing}
                    setEditing={setEditing}
                    saving={saving}
                    saveError={saveError}
                    menuOpen={menuOpen}
                    setMenuOpen={setMenuOpen}
                    setDeleteConfirmOpen={setDeleteConfirmOpen}
                    deleting={deleting}
                    menuRef={menuRef}
                    menuBtnRef={menuBtnRef}
                    editingMessageId={editingMessageId}
                    setTenmatsuDraft={setTenmatsuDraft}
                    isOwnTheme={isOwnTheme}
                    canEditTheme={canEditTheme}
                    canDeleteTheme={canDeleteTheme}
                    mentionItems={mentionItems}
                    themeAttachments={themeAttachments}
                    reportEditDirty={reportEditDirty}
                    handleCancelEdit={handleCancelEdit}
                    handleSaveEdit={handleSaveEdit}
                  />

                  {/* 返信なし時は空状態ラベルを出さない（指摘 0009）。返信があるときだけ一覧を描画。 */}
                  {theme.messages.length > 0 && (
                    <ul className="m-0 list-none p-0">
                      {theme.messages.map((m) => (
                        <li key={m.id} className="desk-thread-comment">
                          <span
                            className="desk-thread-comment-avatar"
                            style={{ background: avatarColor(m.author.id), color: 'white' }}
                          >
                            {avatarInitial(m.author.name)}
                          </span>
                          <div className="desk-thread-comment-body">
                            <div className="desk-thread-comment-head">
                              <span className="desk-thread-comment-author truncate">
                                {m.author.name}
                              </span>
                              <span className="shrink-0">{formatDateTime(m.createdAt)}</span>
                              {/* 自分の発話のみ編集/その他ボタン（rete-desk-0146 / dsk-0316）。所有判定は
                                m.author.id === currentUserId。編集中の発話ではトリガを隠してフォームへ集中させる
                                （テーマ編集と同方針）。
                                dsk-0318: 業務ロール由来 canUpdate で編集鉛筆をガード／canDelete で「その他」削除項目をガード。
                                「その他」トリガは顛末コピーが残るため ownMessage のみ。 */}
                              {currentUserId &&
                                m.author.id === currentUserId &&
                                !editing &&
                                !editingMessageId && (
                                  <button
                                    type="button"
                                    className="desk-thread-head-icon-btn ml-auto"
                                    title="編集"
                                    aria-label="メッセージを編集"
                                    onClick={() => setEditingMessageId(m.id)}
                                  >
                                    <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              {currentUserId &&
                                m.author.id === currentUserId &&
                                !editing &&
                                !editingMessageId && (
                                  <span className="flex shrink-0 gap-1">
                                    <button
                                      type="button"
                                      ref={messageMenuId === m.id ? messageMenuBtnRef : undefined}
                                      className="desk-thread-head-icon-btn"
                                      title="その他"
                                      aria-label="その他"
                                      aria-haspopup="menu"
                                      aria-expanded={messageMenuId === m.id}
                                      aria-controls={`desk-thread-message-menu-${m.id}`}
                                      onClick={() =>
                                        setMessageMenuId((id) => (id === m.id ? null : m.id))
                                      }
                                    >
                                      <MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
                                    </button>
                                  </span>
                                )}
                              {/* 発話の「その他」メニュー（dsk-0316: テーマ起点カードのメニュー rete-desk-0095 と同方式）。
                                顛末コピーは空本文ガード・削除は確認ダイアログ経由（handleDeleteMessage）。 */}
                              {messageMenuId === m.id && !editing && !editingMessageId && (
                                <div
                                  id={`desk-thread-message-menu-${m.id}`}
                                  ref={messageMenuRef}
                                  className="desk-thread-head-menu"
                                  role="menu"
                                  aria-label="その他メニュー"
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="desk-thread-head-menu-item"
                                    onClick={() => {
                                      setMessageMenuId(null);
                                      // 空本文（空 HTML 含む）はコピーもタブ切替もしない（テーマ起点カードの
                                      // 顛末コピーと同方針・dsk-0248 review MEDIUM を踏襲）。
                                      if (isRichTextEmpty(m.body)) return;
                                      setTenmatsuDraft((prev) =>
                                        isRichTextEmpty(prev) ? m.body : `${prev}${m.body}`,
                                      );
                                      setActiveTab('tenmatsu');
                                    }}
                                  >
                                    メッセージを顛末へコピー
                                  </button>
                                  {/* dsk-0316 のメッセージ削除項目。所有判定 ownMessage はこの if の外側で成立済み。 */}
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="desk-thread-head-menu-item is-destructive"
                                    onClick={() => {
                                      setMessageMenuId(null);
                                      setDeleteMessageError(null);
                                      setDeleteMessageId(m.id);
                                    }}
                                  >
                                    メッセージの削除
                                  </button>
                                </div>
                              )}
                            </div>
                            {editingMessageId === m.id ? (
                              <MessageEditForm
                                initialBody={m.body}
                                saving={messageSaving}
                                error={messageSaveError}
                                attachmentsController={messageAttachments}
                                mentionItems={mentionItems}
                                onSave={(p) => void handleSaveMessage(m.id, p)}
                                onCancel={handleCancelMessageEdit}
                                onDirtyChange={reportMessageEditDirty}
                              />
                            ) : (
                              <>
                                {/* 本文はリッチテキスト（HTML）。sanitize 描画（ADR 0019）。@ メンションは
                                  本文中に青ラベル（.desk-mention）でインライン表示される（rete-desk-0080）。 */}
                                <RichTextView
                                  html={m.body}
                                  className="desk-thread-comment-text"
                                  highlight={highlight}
                                />
                                <ReactionBar
                                  reactions={m.reactions}
                                  onToggle={(emoji) => onToggleMessageReaction(m.id, emoji)}
                                />
                                {/* この発話に付いた添付（FL-3b・embed・読み取り表示）。 */}
                                <AttachmentList items={m.attachments} />
                              </>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* 編集モード中は返信入力欄を隠し、編集フォームへ集中させる（起点カード=rete-desk-0089 /
              メッセージ=rete-desk-0155）。テーマ切替（key=theme.id）で remount するが、書きかけの返信は
              テーマごとに上位（useChatThreadController / lib/reply-drafts）が保持し、戻った時に続きから書ける
              （d737・旧「前テーマの書きかけ返信を持ち越さない」を置換）。返信ドラフトの dirty は
              reportReplyDirty 経由で破棄ガードへ合流する（rete-desk-0120）。
              個別メッセージ編集中（editingMessageId）は unmount せず visibility:hidden で「非表示かつ高さ維持」に
              する（rete-desk-0163）。返信欄はスクロール容器の外・下にあり、display:none で外すと容器が伸びて
              明細位置が ~72px ジャンプするため。0155 の「編集中は返信欄非表示」は visibility で満たす。
              起点カード編集（editing）は従来どおり unmount する（カードは容器先頭で位置ジャンプ要因にならない）。 */}
            {theme && !editing && (
              <div
                className={editingMessageId ? 'desk-reply-composer-edit-hidden' : undefined}
                aria-hidden={editingMessageId ? true : undefined}
              >
                <ReplyComposer
                  key={theme.id}
                  onReply={onReply}
                  accounts={accounts}
                  onDirtyChange={reportReplyDirty}
                  requestDiscard={discard.request}
                  value={replyDraft}
                  onChangeBody={handleReplyDraftChange}
                  onSent={clearReplyDraft}
                />
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
