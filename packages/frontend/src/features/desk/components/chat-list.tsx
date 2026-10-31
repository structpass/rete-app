'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { MessageSquare } from 'lucide-react';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';
import { Spinner } from '@/components/ui/spinner';
import { highlightMatches } from '@/lib/highlight';
import { ChatThemeStatus } from '@rete/shared';
import type { ChatThemeSummary } from '../lib/api';
import type { DragTheme } from '../hooks/use-chat-promotion';
import { applyQuietFocus } from '../utils/quiet-focus';
import { ArchiveIcon, CloseIcon, MentionIcon, TenmatsuIcon } from './desk-status-icons';

interface ChatListProps {
  themes: ChatThemeSummary[];
  selectedId: string | null;
  /** アクティブ枠（.sp-row-ring）用の「最後に開いた」テーマ id（dsk-0401）。閉じても selectedId と
   *  違い null に戻らないため、詳細を閉じた後も枠が残る。selectedId は開閉状態そのもの（トグル判定 /
   *  aria-current）に使う。未指定時は selectedId を使う（呼び出し元が持たない旧経路・テストとの後方互換）。 */
  activeId?: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  /** 検索キーワード（一致部分をカード題名で薄い黄色ハイライト / rete-desk-0048）。空 or 未指定でハイライトなし。 */
  highlight?: string;
}

/**
 * チャット明細（左ペイン・常時表示 / data-left-view="list" は親 section が保持）。
 * モック（desk/index.html の .desk-chat-list）の高密度メールリスト型を `.desk-*` クラスで再現。
 * - 列ヘッダ .desk-chat-list-head（タイトル / 状況）を常時表示。列境界の区切り線は CSS が担う
 * - スクロール領域 .desk-pane-body 内に .desk-chat-list、各行は .desk-chat-card（箱を作らず
 *   border-bottom のみ。hover は .sp-row-hoverband の帯スライド追従＝mdl-0050・選択行は
 *   .sp-row-ring の teal 内枠線 1px＝mdl-0055、正本はモデルタブ「マウスホバー表現」「アクティブ表現」）
 * - 状況列 .desk-chat-card-status-cell はモック JS（正本 / desk/index.html syncChatStatusColumn）準拠で
 *   アーカイブ → クローズ → 顛末 → メンション の最大 4 アイコンを左→右に並べる。コメント数の数字は
 *   モック自身が廃止済（d539: 未読は行内の未読マークで示し、題名の太さは変えない）。
 *
 * 空状態（dsk-0416）: 絞り込み有無で文言を分けず、task-tree の基本空状態（task-tree.tsx:589-598）と
 * 揃えた「チャットがありません」＋ MessageSquare アイコン（h-8 w-8・mb-3・同色 class）を表示する。
 */
export function ChatList({
  themes,
  selectedId,
  activeId = selectedId,
  loading,
  error,
  onSelect,
  highlight,
}: ChatListProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 列ヘッダ（モック .desk-chat-list-head）。タイトル / 状況 の 2 列。列境界線は CSS。 */}
      <div className="desk-chat-list-head" aria-hidden="true">
        <span className="desk-chat-list-head-col-title">タイトル</span>
        <span className="desk-chat-list-head-col-comment">状況</span>
      </div>

      <ChatListBody
        themes={themes}
        selectedId={selectedId}
        activeId={activeId}
        loading={loading}
        error={error}
        onSelect={onSelect}
        highlight={highlight}
      />
    </div>
  );
}

function ChatListBody({
  themes,
  selectedId,
  activeId = selectedId,
  loading,
  error,
  onSelect,
  highlight,
}: ChatListProps) {
  // チャット明細はチャットログ型（最新を一番下）に並べる（rete-desk-0109）。一覧はサーバーで
  // lastMessageAt 降順（最新が先頭）で来るため、表示時に反転して最新を末尾へ送る。キーボードナビは
  // DOM 順を辿る（use-desk-keyboard-nav）ので、反転後も ↑↓ は見た目どおり動く。
  const ordered = useMemo(() => [...themes].reverse(), [themes]);
  // 末尾（最新）テーマの id。新規作成・最新化で末尾が変わったら最下端へスクロールし、追加行を可視化する。
  const bottomId = ordered.length > 0 ? ordered[ordered.length - 1].id : null;
  const bodyRef = useRef<HTMLDivElement>(null);
  // mdl-0050: 明細行 hover は行個別の :hover 背景でなく単一の薄グレー帯（.sp-row-hoverband）が
  // スライド追従する（正本=モデルタブ「マウスホバー表現」）。
  const { listRef, onMouseOver, onMouseLeave, bandStyle } =
    useRowHoverBand<HTMLDivElement>('.sp-row-pillable');
  const prevLenRef = useRef(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // 件数増（新規テーマ追加＝送信 / 初回ロード）は必ず最下端へ。それ以外（既存テーマの再ソート等）は
    // ユーザーが下端付近を見ている時だけ追従し、履歴を遡って上スクロール中の引き戻し（yank）を避ける。
    const grew = ordered.length > prevLenRef.current;
    prevLenRef.current = ordered.length;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!grew && !nearBottom) return;
    // 追加行の高さがレイアウトへ反映された後に測って最下端へ（commit 直後に測ると下端へ届かず
    // 追加行が画面外に残る / rete-desk-0109 再発防止）。単一フレームだと新規行の高さがまだ未確定で
    // 下端へ届かないことがある（環境依存で再発 / rete-desk-0109 retake）。二段 rAF で、レイアウト確定後の
    // 次フレームでもう一度 scrollHeight を測り直して確実に下端へ寄せる。連続更新時は両 raf を取り消す。
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      raf2 = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [bottomId, ordered.length]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-[var(--sp-accent-red)]">
        {error}
      </div>
    );
  }

  return (
    <div
      ref={bodyRef}
      className="desk-pane-body flex flex-1 flex-col"
      style={themes.length === 0 ? { paddingTop: 0 } : undefined}
    >
      <div
        ref={listRef}
        className={`desk-chat-list relative${themes.length === 0 ? ' flex flex-1 flex-col justify-center' : ''}`}
        style={themes.length === 0 ? { paddingBottom: 0 } : undefined}
        onMouseOver={onMouseOver}
        onMouseLeave={onMouseLeave}
      >
        {/* dsk-0416の空文言と中央配置を保ち、絞り込み0でも一覧の骨格は残す。 */}
        {themes.length === 0 && (
          <div className="flex flex-col items-center justify-center p-6 text-center text-[var(--sp-text-warm-mute)]">
            <MessageSquare className="mb-3 h-8 w-8 text-[var(--sp-text-warm-mute)]" aria-hidden />
            <p className="text-sm font-medium">チャットがありません</p>
          </div>
        )}
        {ordered.map((theme) => (
          <ChatListRow
            key={theme.id}
            theme={theme}
            isSelected={theme.id === selectedId}
            isActive={theme.id === activeId}
            onSelect={onSelect}
            highlight={highlight}
          />
        ))}
        {/* hover 帯（装飾専用）。行の下・末尾に置き、bandStyle 非 null の時だけ描く。 */}
        {bandStyle ? <div aria-hidden className="sp-row-hoverband" style={bandStyle} /> : null}
      </div>
    </div>
  );
}

interface ChatListRowProps {
  theme: ChatThemeSummary;
  /** 詳細（右ペイン thread）が今このテーマを開いているか。トグル閉じ判定・aria-current に使う。 */
  isSelected: boolean;
  /** アクティブ枠（.sp-row-ring）を描くか（dsk-0401・「最後に開いた」を保持・isSelected とは別）。 */
  isActive: boolean;
  onSelect: (id: string) => void;
  /** 検索キーワード（題名の一致箇所を薄い黄色ハイライト / rete-desk-0048）。 */
  highlight?: string;
}

/**
 * チャット明細の 1 行（モック .desk-chat-card）。クリックで右ペインにスレッドを開き、
 * ドラッグで右のタスクツリーへ昇格できる。
 * クリック / ドラッグの両立は DndContext の PointerSensor activationConstraint（小距離移動は click 扱い）に
 * 委ねる。ここでは listeners を行に張り、ドラッグ中は .is-dragging（CSS で opacity）でゴースト化する。
 */
function ChatListRow({ theme, isSelected, isActive, onSelect, highlight }: ChatListRowProps) {
  const dragTheme: DragTheme = { id: theme.id, title: theme.title, description: null };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: theme.id,
    data: { theme: dragTheme },
  });
  const isClosed = theme.status === ChatThemeStatus.CLOSED;
  const archived = theme.archived;
  // 未読は実データ（backend が ChatReadState と他者新着から集約 / rete-desk-0075・DBT-4 返済）。
  // 自分起票・自分投稿は未読に数えない。スレッドを開くと既読化され太字が消える。
  const unread = theme.hasUnread;

  const className = [
    'desk-chat-card',
    // mdl-0050: hover 帯スライドの対象行（帯より上に内容を持ち上げる z-index 確保も担う）。
    'sp-row-pillable',
    'w-full',
    'cursor-grab',
    'text-left',
    'active:cursor-grabbing',
    unread && 'is-unread',
    archived && 'is-archived',
    // mdl-0055: 選択行は teal 内枠線 1px（.sp-row-ring）。mdl-0050 の板ピル（上下 5px はみ出し
    // ＋文字拡大）は「アクティブで明細が大きくなる」表現ごと廃止（開発統括指示 2026-07-20・hom-0133 と同型）。
    // dsk-0401: 枠は isSelected（今開いているか）でなく isActive（最後に開いた行）で描く。詳細を
    // 閉じても選択が isSelected=false になるだけで isActive は残るため、枠が消えない。
    isActive && 'sp-row-ring',
    isDragging && 'is-dragging',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={setNodeRef}
      type="button"
      data-theme-id={theme.id}
      onClick={(e) => {
        // dsk-0391: 選択中の行の再作動＝トグル閉じ。Space/Enter のキーボード作動だと閉じた後の行が
        // :focus-visible に昇格し teal 枠が残るため、Esc 経路（desk-shell）と同じ目印で枠を抑止する。
        if (isSelected) applyQuietFocus(e.currentTarget);
        onSelect(theme.id);
      }}
      aria-current={isSelected ? 'true' : undefined}
      className={className}
      {...attributes}
      {...listeners}
    >
      <div className="desk-chat-card-title-row">
        {/* d539: 未読は文字の太さでなく行内の未読マークで示す（ホームの明細行と同じ語彙・色は
            --sp-accent-ink の印。旧 .is-unread の題名太字は正本 comp-table の「見出しは 500」と割れるため撤回）。 */}
        {unread && (
          <span
            aria-hidden
            data-testid="desk-unread-dot"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sp-accent-ink)]"
          />
        )}
        <span className="desk-chat-card-title sp-row-title">
          {highlightMatches(theme.title, highlight)}
        </span>
        {/* 状況セル（モック .desk-chat-card-status-cell）。並び順はモック JS 準拠で
            アーカイブ → クローズ → 顛末 → メンション。すべて実データ判定
            （メンションは hasMentionToMe = 自分宛メンション有無 / rete-desk-0049）。 */}
        <span className="desk-chat-card-status-cell sp-row-meta">
          {archived && (
            <span
              className="desk-chat-archive-mark"
              title="アーカイブ済み"
              aria-label="アーカイブ済み"
            >
              <ArchiveIcon />
            </span>
          )}
          {isClosed && (
            <span
              className="desk-thread-status status-close"
              title="クローズ"
              aria-label="クローズ"
            >
              <CloseIcon />
            </span>
          )}
          {theme.hasTenmatsu && (
            <span className="desk-thread-tenmatsu" title="顛末あり" aria-label="顛末あり">
              <TenmatsuIcon />
            </span>
          )}
          {theme.hasMentionToMe && (
            <span className="desk-thread-count is-mention" aria-label="自分宛メンションあり">
              <MentionIcon />
            </span>
          )}
        </span>
      </div>
    </button>
  );
}
