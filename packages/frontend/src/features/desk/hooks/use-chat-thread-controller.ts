'use client';
import { useDeferredAttachments } from '@/features/desk/hooks/use-deferred-attachments';
import { apiErrorMessage } from '@/features/desk/lib/api-error';
import type { ChatThreadProps } from '@/features/desk/lib/chat-thread-types';
import { extractMentionAccountIds } from '@/features/desk/lib/mentions';
import { readReplyDraft, writeReplyDraft } from '@/features/desk/lib/reply-drafts';
import { isRichTextEmpty } from '@/features/desk/lib/validations';
import { useDelayedLoading } from '@/hooks/use-delayed-loading';
import { useDiscardConfirm } from '@/hooks/use-discard-confirm';
import { useEscapeConsume } from '@/hooks/use-escape-consume';
import { useOutsideClose } from '@/hooks/use-outside-close';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
export function useChatThreadController({
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
}: Pick<
  ChatThreadProps,
  | 'theme'
  | 'loading'
  | 'onClose'
  | 'onUpdateMessage'
  | 'onRefetchTheme'
  | 'accounts'
  | 'onUpdateTheme'
  | 'onArchive'
  | 'onDeleteTheme'
  | 'onDeleteMessage'
  | 'onDirtyChange'
  | 'currentUserId'
>) {
  // dsk-0234: タスク詳細と一貫させ、loading 由来のスピナーフラッシュを遅延表示で抑制する
  // （高速な再取得では stale 表示を保ち、閾値超の遅い時だけスピナーを出す）。
  const showSpinner = useDelayedLoading(loading);

  // 開いているテーマの id。フック先頭で固定する（この後 theme を条件で読む所と、書きかけ保持の基準とで
  // 同じ値を使う / d737）。
  const draftThemeId = theme?.id ?? null;

  const [activeTab, setActiveTab] = useState<'thread' | 'tenmatsu'>('thread');

  // dsk-0386: スレッド/顛末タブ strip へ帯スライドを配線（app-header の .nav-hoverband と同型）。
  // dsk-0424: strip 内の非タブ領域（アーカイブ/閉じるボタン）へ移ったら帯を消すのは hook の
  // leaveOnNoMatch が担う（従来のローカルラッパーを置換。task-detail-overlay.tsx と同型）。
  const {
    listRef: tabStripRef,
    onMouseOver: onTabStripMouseOver,
    onMouseLeave: onTabStripMouseLeave,
    bandStyle: tabHoverBandStyle,
  } = useRowHoverBand<HTMLDivElement>('.desk-ticket-tab', 'horizontal', true);

  const [editing, setEditing] = useState(false);

  const [saving, setSaving] = useState(false);

  const [saveError, setSaveError] = useState<string | null>(null);

  const [archiving, setArchiving] = useState(false);

  const [archiveError, setArchiveError] = useState<string | null>(null);

  // その他メニュー（rete-desk-0095: メッセージ削除）。開閉 + 削除確認 + 実行中 + 失敗通知。
  const [menuOpen, setMenuOpen] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const [deleting, setDeleting] = useState(false);

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const editDirtyRef = useRef(false);

  // 自分の発話の本文編集（rete-desk-0146）。編集中の発話 id・保存中・失敗通知。一度に 1 件のみ編集（排他）。
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const [messageSaving, setMessageSaving] = useState(false);

  const [messageSaveError, setMessageSaveError] = useState<string | null>(null);

  // 発話編集フォームの dirty。テーマ編集 / 顛末 / 返信 と OR して破棄ガードへ合流する。
  const messageEditDirtyRef = useRef(false);

  // 発話の「その他」メニュー（dsk-0316: task-detail-overlay の commentMenuId 横展開）。開いている発話 id を
  // 保持（同時に1つ）。外側クリック / ESC クローズはテーマ起点カードのその他メニュー（rete-desk-0095）と同方針。
  const [messageMenuId, setMessageMenuId] = useState<string | null>(null);

  const messageMenuRef = useRef<HTMLDivElement>(null);

  const messageMenuBtnRef = useRef<HTMLButtonElement>(null);

  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);

  const [deleteMessageError, setDeleteMessageError] = useState<string | null>(null);

  const [deletingMessage, setDeletingMessage] = useState(false);

  // 外側 pointerdown / Esc クローズは useOutsideClose へ統合（brd-0227）。Esc は hook 内の
  // useEscapeConsume が担うため、ここでの個別 useEscapeConsume は持たない。
  useOutsideClose({
    active: messageMenuId != null,
    refs: [messageMenuRef, messageMenuBtnRef],
    onClose: () => setMessageMenuId(null),
    eventType: 'pointerdown',
  });

  // 返信ドラフトの dirty（ReplyComposer が報告 / rete-desk-0120）。編集・顛末 dirty と OR して破棄ガードへ合流。
  const replyDirtyRef = useRef(false);

  // 書きかけの返信本文をテーマごとに保持する（d737）。ChatThread は開いた時しか載らず、テーマ切替で
  // スレッド一覧→詳細の往復によりアンマウントされる。返信欄を key=theme.id で載せ替えるだけでは書きかけが
  // 消えるため、保持は上位（このフック）が持ち、返信欄へ value/onChangeBody で渡す。モジュールスコープの
  // 置き場なので、他テーマを開いて戻っても復元される（閉じても残る）。**保留添付はテーマ切替で復元されない**
  // （送信されないファイルが他テーマの返信に紛れるのを防ぐ）。閉じた時と送信成功時に下書きを捨てる。
  const replyDraftKey = draftThemeId;

  const [replyDraft, setReplyDraft] = useState(() =>
    replyDraftKey ? (readReplyDraft(replyDraftKey) ?? '') : '',
  );

  // 開いているテーマが変わったら、そのテーマの書きかけを返信欄へ読み直す（保持は捨てない）。
  useEffect(() => {
    setReplyDraft(replyDraftKey ? (readReplyDraft(replyDraftKey) ?? '') : '');
  }, [replyDraftKey]);

  // 入力は即時に保持へ書き戻す（切替でアンマウントされても書きかけを失わない）。
  const handleReplyDraftChange = useCallback(
    (body: string) => {
      setReplyDraft(body);
      if (replyDraftKey) writeReplyDraft(replyDraftKey, body);
    },
    [replyDraftKey],
  );

  // 下書きを捨てる（閉じる・送信成功）。入力欄も空へ戻す。
  const clearReplyDraft = useCallback(() => {
    if (replyDraftKey) writeReplyDraft(replyDraftKey, '');
    setReplyDraft('');
  }, [replyDraftKey]);

  // 顛末（スレッドの結論ノート / rete-desk-0092）。タスク詳細の顛末欄と同型。overlay ローカルでドラフトを
  // 保持し、保存時に onUpdateTheme へ合流する。baseline は dirty 判定（破棄ガード）と保存後の解消に使う。
  const [tenmatsuDraft, setTenmatsuDraft] = useState(theme?.tenmatsu ?? '');

  const [tenmatsuBaseline, setTenmatsuBaseline] = useState(theme?.tenmatsu ?? '');

  const [tenmatsuSaving, setTenmatsuSaving] = useState(false);

  const [tenmatsuError, setTenmatsuError] = useState<string | null>(null);

  // 空 HTML の表記揺れ（'' と '<p></p>' 等）は未編集とみなす（rete-desk-0134: 顛末を開いて何も
  // 編集していないのに破棄確認が出る誤判定の防止）。
  const tenmatsuDirty =
    tenmatsuDraft !== tenmatsuBaseline &&
    !(isRichTextEmpty(tenmatsuDraft) && isRichTextEmpty(tenmatsuBaseline));

  // 破棄ガード（guardDiscard）は ref を読むため、最新の顛末 dirty を ref へも反映する。
  const tenmatsuDirtyRef = useRef(false);

  // スレッド本文のスクロール容器（.desk-pane-body）。返信投稿で発話が増えたら最下部へ追従し、
  // 追加した発話が見えるようにする（rete-desk-0089）。初回ロード時も最新（末尾）を表示する。
  const threadBodyRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const previousThreadRef = useRef<string | undefined>(undefined);
  const previousTabRef = useRef(activeTab);
  const onThreadScroll = useCallback(() => {
    const el = threadBodyRef.current;
    if (el) followLatestRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 32;
  }, []);

  const messageCount = theme?.messages.length ?? 0;

  // 起点カードの編集・その他アクションの所有判定（rete-desk-0083）。投稿者本人のみ操作可。
  const isOwnTheme = !!theme && !!currentUserId && theme.author.id === currentUserId;

  // set-0180: 業務ロール権限（FeaturePermission）は撤去。所有判定 isOwn* のみで 4 導線
  // （テーマ編集鉛筆・テーマ削除・発話編集・発話削除）の有無を切り替える。
  const canEditTheme = isOwnTheme;

  const canDeleteTheme = isOwnTheme;

  // 説明文中の @ メンション候補（id=accountId / label=表示名 / rete-desk-0116）。編集フォームの RTE が参照する。
  const mentionItems = useMemo(
    () => accounts.map((a) => ({ id: a.id, label: a.name })),
    [accounts],
  );

  // テーマ起点カードの添付（FL-3b・対象 theme）。view 表示は theme.attachments（embed・スレッド取得済で
  // ロードのちらつき無し）を使い、編集モードの add/remove だけ controller を使う。controller は編集中のみ
  // enabled にして余計な GET を避ける。
  // dsk-0287: 追加・解除を保留（deferred）方式にし、「保存」で commit ／キャンセルで discard する
  // （即時確定だとキャンセルしても元に戻らないため・メッセージ編集 dsk-0265 と同方式）。
  const themeAttachments = useDeferredAttachments({
    targetType: 'theme',
    targetId: theme?.id ?? '',
    enabled: theme != null && editing,
  });

  // 発話（自分の投稿）の添付（dsk-0250・対象 chatMessage）。編集中の発話のみ enabled にして余計な GET を
  // 避ける（テーマ添付 themeAttachments と同方式）。編集は一度に 1 件のみ（排他）のため hook は 1 つで足りる。
  // dsk-0265: 追加・解除を保留（deferred）方式にし、「保存」で commit ／キャンセルで discard する
  // （即時確定だとキャンセルしても元に戻らないため）。
  const messageAttachments = useDeferredAttachments({
    targetType: 'chatMessage',
    targetId: editingMessageId ?? '',
    enabled: editingMessageId != null,
  });

  // テーマ切替（id 変化）で編集状態をリセットする。別スレッドを開いた時に前の編集が残らないように。
  // dsk-0431: 編集状態のリセットは「読み込み済みテーマからの実切替（prev が非 null）」に限定する。
  // mount 直後や初回ロード（null → id）でもリセットを走らせると、コミット済み UI で押された「編集」
  // クリックの setEditing(true) を、遅れて flush された本 effect の setEditing(false) が打ち消す競合窓
  // になる（CI 低速環境で実測・run 31238962054）。prev が null の遷移には巻き戻すべき前テーマの編集
  // 状態が存在しないため、リセットのスキップで失うものはない。なお実切替（A→B）のリセットは仕様
  // 意図そのもののため残しており、切替直後の同型の窓は意図的に許容している。
  // 例外＝顛末ドラフトの「値同期」: mount 時は theme=null で useState が '' に固定されるため、
  // null → id（初回ロード）の本 effect がロード済み顛末を draft/baseline へ流し込む唯一の経路。
  // これをスキップすると保存済み顛末が空表示になり、空のまま保存すると既存顛末を上書き消失する
  // （code-reviewer 指摘・初回ロード中の顛末 RTE は theme=null ゲートで操作不能のため競合窓は無い）。
  const prevThemeIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prevThemeId = prevThemeIdRef.current;
    prevThemeIdRef.current = theme?.id ?? null;
    if (prevThemeId != null) {
      setEditing(false);
      setSaving(false);
      setSaveError(null);
      setArchiveError(null);
      setMenuOpen(false);
      setDeleteConfirmOpen(false);
      setDeleting(false);
      setDeleteError(null);
      editDirtyRef.current = false;
      // 別スレッド切替で発話編集も解除（前スレッドの編集状態を持ち越さない）。
      setEditingMessageId(null);
      setMessageSaving(false);
      setMessageSaveError(null);
      messageEditDirtyRef.current = false;
      // 発話「その他」メニュー・削除確認も別スレッド切替で解除（dsk-0316）。
      setMessageMenuId(null);
      setDeleteMessageId(null);
      setDeleteMessageError(null);
      // 返信欄はテーマ切替で key により remount され空に戻るが、ref も併せて初期化しておく。
      replyDirtyRef.current = false;
      onDirtyChange?.(false);
    }
    // 顛末ドラフトの値同期は初回ロード（null → id）でも必ず行う（上記コメントの例外）。切替時は
    // 「前スレッドの編集を持ち越さない」初期化を兼ねる。
    setTenmatsuDraft(theme?.tenmatsu ?? '');
    setTenmatsuBaseline(theme?.tenmatsu ?? '');
    setTenmatsuSaving(false);
    setTenmatsuError(null);
    tenmatsuDirtyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme?.id]);

  // 顛末 dirty を ref へ同期し、編集フォーム dirty と OR して上位へ報告する（破棄ガードの単一情報源）。
  useEffect(() => {
    tenmatsuDirtyRef.current = tenmatsuDirty;
    onDirtyChange?.(
      editDirtyRef.current || tenmatsuDirty || replyDirtyRef.current || messageEditDirtyRef.current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenmatsuDirty]);

  // アンマウント時のみ dirty=false を報告し、閉じた後の破棄確認の誤発火を防ぐ（タスク詳細編集と同じ安全網）。
  // onDirtyChange（reportRightDirty）は安定参照のため deps 空で初回クロージャを使う。
  useEffect(() => {
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初回・スレッド切替は最新へ。過去の発話を読んでいる間は新着で位置を変えない。
  useEffect(() => {
    const opening = previousThreadRef.current !== theme?.id || previousTabRef.current !== activeTab;
    previousThreadRef.current = theme?.id;
    previousTabRef.current = activeTab;
    if (activeTab !== 'thread') return;
    const el = threadBodyRef.current;
    if (el && (opening || followLatestRef.current)) {
      el.scrollTop = el.scrollHeight;
      followLatestRef.current = true;
    }
  }, [messageCount, activeTab, theme?.id]);

  const reportEditDirty = (dirty: boolean) => {
    editDirtyRef.current = dirty;
    onDirtyChange?.(
      dirty || tenmatsuDirtyRef.current || replyDirtyRef.current || messageEditDirtyRef.current,
    );
  };

  // 発話編集フォームの dirty 報告（MessageEditForm → onDirtyChange）。他の dirty と OR して破棄ガードへ合流。
  const reportMessageEditDirty = useCallback(
    (dirty: boolean) => {
      messageEditDirtyRef.current = dirty;
      onDirtyChange?.(
        editDirtyRef.current || tenmatsuDirtyRef.current || replyDirtyRef.current || dirty,
      );
    },
    [onDirtyChange],
  );

  // 返信ドラフトの dirty 報告（ReplyComposer → onDirtyChange）。編集/顛末 dirty と OR して上位へ合流する
  // （破棄ガードの単一情報源 / rete-desk-0120）。ReplyComposer の cleanup effect（アンマウント時の
  // false 報告）が安定参照を捕捉できるよう useCallback で固定する（onDirtyChange は親で安定 / 参照のみ deps）。
  // 起点カードの編集開始などで返信欄がアンマウントされても、**保持に書きかけが残っている間は dirty を
  // 保つ**（d737）。載り替えの cleanup が false を報告すると、書きかけがあるのに確認なしで閉じられて消える。
  const reportReplyDirty = useCallback(
    (dirty: boolean) => {
      // 保持に本文が残っているかはその場で読む（返信欄の載り替え直後に古い値を掴まない）。
      const kept = !isRichTextEmpty(replyDraftKey ? (readReplyDraft(replyDraftKey) ?? '') : '');
      replyDirtyRef.current = dirty || kept;
      onDirtyChange?.(
        editDirtyRef.current ||
          tenmatsuDirtyRef.current ||
          replyDirtyRef.current ||
          messageEditDirtyRef.current,
      );
    },
    [onDirtyChange, replyDraftKey],
  );

  // 破棄確認（Rete デザインダイアログ / rete-desk-0102・旧 window.confirm を置換）。dirty な時だけ
  // ダイアログを開き、破棄するで proceed を実行する。経路により対象 dirty を変える（下記）。
  const discard = useDiscardConfirm();

  // 編集フォーム（題名/説明）のキャンセル。顛末は別タブ・独立保存のため対象外＝編集フォーム dirty のみで判定する
  // （顛末ドラフトはキャンセルしても残し、顛末タブの保存ボタンで別途確定させる / rete-desk-0092）。
  const handleCancelEdit = () => {
    discard.request(editDirtyRef.current, () => {
      setSaveError(null);
      themeAttachments.discard();
      reportEditDirty(false);
      setEditing(false);
    });
  };

  const handleCancelEditRef = useRef(handleCancelEdit);

  handleCancelEditRef.current = handleCancelEdit;

  // 発話編集のキャンセル。dirty なら破棄確認を通してから編集モードを解除する（テーマ編集と同方式）。
  // 添付の保留変更（dsk-0265）も破棄し、開始時点の添付一覧へ戻す（確定済み添付には影響しない）。
  const handleCancelMessageEdit = () => {
    discard.request(messageEditDirtyRef.current, () => {
      setMessageSaveError(null);
      messageAttachments.discard();
      reportMessageEditDirty(false);
      setEditingMessageId(null);
    });
  };

  const handleCancelMessageEditRef = useRef(handleCancelMessageEdit);

  handleCancelMessageEditRef.current = handleCancelMessageEdit;

  // 発話本文の保存（rete-desk-0146）。成功で編集モード解除 + dirty 解消し、再取得（onUpdateMessage 内）で
  // 本文が最新化される。失敗は inline alert（フォーム内）で通知して編集モードに留まる。
  // dsk-0265: 本文保存の成功後に保留添付を一括確定（commit）する。本文保存に失敗したら添付も確定しない。
  // commit が一部でも失敗したら編集モードに留まって再試行を促す（再送は commit 内の 409/404 許容で冪等）。
  const handleSaveMessage = async (
    messageId: string,
    payload: { body: string; mentionAccountIds: string[] },
  ) => {
    setMessageSaving(true);
    setMessageSaveError(null);
    try {
      try {
        await onUpdateMessage(messageId, payload.body, payload.mentionAccountIds);
      } catch (e) {
        // dsk-0318: backend の error.message（403=「この操作を行う権限がありません」等）を surface。
        // 既存のフォールバック文言は権限以外の失敗（ネットワーク等）の安全弁として残す。
        setMessageSaveError(
          apiErrorMessage(e, '保存に失敗しました。入力内容を確認して再試行してください。'),
        );
        return;
      }
      const hadAttachmentChanges = messageAttachments.dirty;
      if (hadAttachmentChanges) {
        const committed = await messageAttachments.commit();
        if (!committed) {
          setMessageSaveError('添付の反映に失敗しました。保存を再試行してください。');
          return;
        }
      }
      reportMessageEditDirty(false);
      setEditingMessageId(null);
      // 更新成功の揮発性トースト（rete-desk-0204）。本文＋添付の全体が確定してから出す（dsk-0265 で
      // 添付 commit が本文 PATCH の後に続くため、desk-shell の wrapper でなくここが成功を確定できる唯一の点）。
      toast.success('メッセージを更新しました');
      // 添付を確定した時は読み取り表示（発話カードの添付一覧＝embed）へ反映するためスレッドを取り直す
      // （onUpdateMessage 内の再取得は commit 前のため添付が乗っていない）。
      if (hadAttachmentChanges) await onRefetchTheme?.();
    } finally {
      setMessageSaving(false);
    }
  };

  // 編集モード中の ESC は「画面ごと閉じる」ではなくキャンセルボタンと同じ「編集モード解除」にする
  // （rete-desk-0131）。document 段階で消費して desk-shell の window リスナ（closeAllGuarded）へ
  // 伝播させない。破棄確認ダイアログ表示中はダイアログ側の ESC（キャンセル扱い）を優先する
  // （guardSelector で内包・cmn-0113）。
  useEscapeConsume(() => handleCancelEditRef.current(), {
    enabled: editing,
    guardSelector: '[role="alertdialog"]',
  });

  // 発話編集モード中の ESC も「画面ごと閉じる」ではなくキャンセル（編集モード解除）にする（rete-desk-0146・
  // テーマ編集 ESC と同方式）。document 段階で消費し desk-shell の closeAllGuarded へ伝播させない。
  // 破棄確認ダイアログ表示中はダイアログ側の ESC を優先する（cmn-0113）。
  useEscapeConsume(() => handleCancelMessageEditRef.current(), {
    enabled: editingMessageId != null,
    guardSelector: '[role="alertdialog"]',
  });

  // × 押下でスレッドを閉じる経路。オーバーレイ全体を畳むため、編集フォーム dirty・顛末 dirty の
  // いずれかが未保存なら破棄確認を通してから閉じる（A1 状態機械は不触のため本体側でガード）。
  // 返信の書きかけは閉じた時点で捨てる（d737: 開き直した時に前回の書きかけは戻さない）。
  const handleClose = () => {
    discard.request(
      editDirtyRef.current ||
        tenmatsuDirtyRef.current ||
        replyDirtyRef.current ||
        messageEditDirtyRef.current,
      () => {
        clearReplyDraft();
        onClose();
      },
    );
  };

  // アーカイブ／解除のトグル（rete-desk-0077・モック toggleArchive 移植）。
  // アーカイブ実行（成功）時はチャット詳細を閉じる（rete-desk-0103）。明細へ戻し、完了したテーマを
  // 開いたまま残さない。解除（unarchive）時は閉じずその場に留める。close/API は成功後に行い、失敗時は
  // inline alert で通知して詳細を閉じない。
  const handleArchiveToggle = async () => {
    if (!theme || archiving) return;
    const willArchive = !theme.archived;
    setArchiving(true);
    setArchiveError(null);
    try {
      await onArchive(willArchive);
      if (willArchive) {
        clearReplyDraft();
        onClose();
      }
    } catch (e) {
      setArchiveError(
        apiErrorMessage(e, 'アーカイブ操作に失敗しました。時間をおいて再試行してください。'),
      );
    } finally {
      setArchiving(false);
    }
  };

  // その他メニューの外側 pointerdown / Escape クローズ（ReactionBar のピッカーと同方針 / rete-desk-0095）。
  // brd-0227 で手書きの pointerdown 監視を useOutsideClose（eventType='pointerdown'）へ統合。Esc は hook 内の
  // useEscapeConsume が document 段で消費し、desk-shell の closeAllGuarded（オーバーレイごと閉じる）へ伝播しない。
  useOutsideClose({
    active: menuOpen,
    refs: [menuRef, menuBtnRef],
    onClose: () => setMenuOpen(false),
    eventType: 'pointerdown',
  });

  // メッセージ削除の実行（rete-desk-0095: その他 > メッセージ削除 → 確認ダイアログ OK 後）。
  // テーマ＝起点メッセージごとスレッドを物理削除する。成功時は親（desk-shell）が詳細を閉じて一覧を
  // 取り直すため、ここでの後処理は不要。失敗時は inline alert で通知して詳細に留まる。
  const handleDeleteTheme = async () => {
    if (!theme || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteTheme();
    } catch (e) {
      setDeleteError(
        apiErrorMessage(e, 'スレッドの削除に失敗しました。時間をおいて再試行してください。'),
      );
    } finally {
      setDeleting(false);
    }
  };

  // 発話（返信メッセージ）削除の実行（dsk-0316: 発話「その他」> メッセージの削除 → 確認ダイアログ OK 後）。
  // 成功時は hook 側（deleteMessage）がスレッドを再取得するため、ここでの後処理は不要（一覧から自動で消える）。
  // 失敗時は inline alert で通知し、対象発話はそのまま残す。
  const handleDeleteMessage = async (messageId: string) => {
    if (deletingMessage) return;
    setDeletingMessage(true);
    setDeleteMessageError(null);
    try {
      await onDeleteMessage(messageId);
    } catch (e) {
      setDeleteMessageError(
        apiErrorMessage(e, 'メッセージの削除に失敗しました。時間をおいて再試行してください。'),
      );
    } finally {
      setDeletingMessage(false);
    }
  };

  // dsk-0287: 本文保存の成功後に保留添付を一括確定（commit）する。本文保存に失敗したら添付も確定しない。
  // commit が一部でも失敗したら編集モードに留まって再試行を促す（handleSaveMessage と同方針）。
  const handleSaveEdit = async (payload: {
    title: string;
    description: string;
    descriptionMentionAccountIds?: string[];
  }) => {
    setSaving(true);
    setSaveError(null);
    try {
      try {
        await onUpdateTheme(payload);
      } catch (e) {
        setSaveError(
          apiErrorMessage(e, '保存に失敗しました。入力内容を確認して再試行してください。'),
        );
        return;
      }
      const hadAttachmentChanges = themeAttachments.dirty;
      if (hadAttachmentChanges) {
        const committed = await themeAttachments.commit();
        if (!committed) {
          setSaveError('添付の反映に失敗しました。保存を再試行してください。');
          return;
        }
      }
      reportEditDirty(false);
      setEditing(false);
      // 添付を確定した時は読み取り表示（起点カードの添付一覧＝embed）へ反映するためスレッドを取り直す
      // （onUpdateTheme 内の再取得は commit 前のため添付が乗っていない）。
      if (hadAttachmentChanges) await onRefetchTheme?.();
    } finally {
      setSaving(false);
    }
  };

  // 顛末の保存（rete-desk-0092）。空入力は null で送りクリア（タスク詳細と同方針）。成功で baseline を
  // 更新して dirty を解消し、再取得（onUpdateTheme 内）で theme.tenmatsu が最新化される。
  const handleSaveTenmatsu = async () => {
    if (!theme || tenmatsuSaving || !tenmatsuDirty) return;
    setTenmatsuSaving(true);
    setTenmatsuError(null);
    try {
      // RTE 化に伴い空判定は isRichTextEmpty（<p></p> 等の空 HTML も null へ畳む / rete-desk-0091）。
      // 顛末面の @ メンションを宛先（tenmatsuMentionAccountIds）として抽出（rete-desk-0116 Phase B）。
      // 空入力（null クリア）時は宛先も空配列＝顛末面の宛先をクリア。
      const isEmpty = isRichTextEmpty(tenmatsuDraft);
      await onUpdateTheme({
        tenmatsu: isEmpty ? null : tenmatsuDraft,
        tenmatsuMentionAccountIds: isEmpty ? [] : extractMentionAccountIds(tenmatsuDraft),
      });
      setTenmatsuBaseline(tenmatsuDraft);
    } catch (e) {
      setTenmatsuError(
        apiErrorMessage(e, '顛末の保存に失敗しました。時間をおいて再試行してください。'),
      );
    } finally {
      setTenmatsuSaving(false);
    }
  };
  return {
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
  };
}
