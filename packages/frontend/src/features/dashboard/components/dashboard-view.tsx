'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { GripVertical, Paperclip, Pencil, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import toast from 'react-hot-toast';
import { useHomePermissions } from '../hooks/home-permissions-context';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import { highlightMatches } from '@/lib/highlight';
import { Pagination } from '@/components/shared/pagination';
import { PageTitle } from '@/components/shared/page-title';
import { RichTextView } from '@/features/desk/components/rich-text-view';
import { AttachmentChip } from '@/features/desk/components/attachment-chip';
import { Avatar } from '@/features/desk/components/desk-avatar';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useDeleteConfirm } from '@/hooks/use-delete-confirm';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { downloadFile } from '@/features/files/lib/api';
import { TagIcon } from '@/components/tags/tag-icon';
import { Badge } from '@/components/ui/badge';
import { TagFilterDropdown } from '@/components/tags/tag-filter-dropdown';
import { useAnnouncements } from '../hooks/use-announcements';
import { useAnnouncementDetail } from '../hooks/use-announcement-detail';
import { useAnnouncementUnread } from '../hooks/announcement-unread-context';
import { useAnnouncementTagMasterContext } from '../hooks/announcement-tag-master-context';
import {
  type AnnouncementDetail,
  type AnnouncementSummary,
  type AnnouncementTagKind,
} from '../lib/api';
import { stepIndex } from '@/features/desk/lib/keyboard-nav';
import { useAnnouncementEditor } from '../hooks/use-announcement-editor';
import { useAnnouncementReorder } from '../hooks/use-announcement-reorder';
import { AnnouncementForm } from './announcement-form';

/** ISO 8601 → YYYY/MM/DD は @/lib/utils の formatDate を使用（cmn-0278 で一本化）。
 *  ローカルにあった同名・別実装（toLocaleDateString 依存・不正値で iso を素通し）は
 *  取り違えの温床（fil-0111 の原因構造）だったため撤去した。 */

// cmn-0262: ここにあった private な formatDateTime（toLocaleString('ja-JP') 依存）は撤去し、
// @/lib/utils の formatDateTime へ寄せた。同名で実装だけ違う関数が並ぶ状態が取り違えの温床
// （fil-0111 の原因構造）だったため。出力は同一（JST 実測で一致）で、不正値は空文字へ縮退する。

/** 1 行（li）の共通クラス（ストライプ・選択枠・ドラッグ中の浮き上がり / rete-home-0020・H0021）。 */
function rowClassName(idx: number, isSelected: boolean, isDragging: boolean): string {
  return cn(
    // rete-home-0020: 1 行 2 明細（上段=管理情報 / 下段=タイトル）。
    // rete-home-0044: 縦余白を py-2.5→py-2 へ微縮（開発統括指示・2 段表示/ストライプ/選択枠は不変）。
    // mdl-0036: 行罫線は設定タブ .sp-table / Desk 系と同じ薄色（--sp-line-warm-2）へ統一。
    'group relative border-b border-[var(--sp-line-warm-2)] px-3 py-2 text-[var(--sp-text-warm)] transition-colors',
    // hover=薄いグレー帯スライド＋文字濃化。共通部品（globals.css .sp-row-* / useRowHoverBand）。
    'sp-row-pillable',
    // home-row-striped: 板ピル（::before）が行本来の縞色を継承するためのマーカー（globals.css）。
    // hom-0133 で Home は板ピルを外したため現状は無効だが、横展開の判断が済むまで残す。
    idx % 2 === 1 ? 'home-row-striped bg-[var(--sp-row-stripe)]' : 'bg-[var(--sp-card)]',
    // hom-0133: 選択行は teal 内枠線 1px（.sp-row-ring）。hom-0123→mdl-0050 の板ピル
    // （上下 5px はみ出し＋文字/アイコン拡大）は「アクティブで明細が大きくなる」表現ごと廃止し、
    // 旧来の緑枠（rete-home-0013 / cmn-0098 の 2px）より細い 1px へ戻した（開発統括指示 2026-07-20）。
    isSelected && 'sp-row-ring',
    // ドラッグ中の行は紙色で浮かせ影を付ける（tenant-settings の reorder と同じ視覚）。
    isDragging && 'z-10 bg-[var(--sp-card)] shadow-[0_8px_20px_-6px_rgba(0,0,0,0.25)]',
  );
}

interface RowContentProps {
  item: AnnouncementSummary;
  /** D&D 有効時のみ true。グリップ分の左余白を空ける。 */
  draggable: boolean;
  onSelect: (id: string) => void;
  /** 通知検索の一致語ハイライト（hom-0110）。空/未指定はハイライトなし。 */
  keyword?: string;
}

/**
 * 1 行の内側（選択ボタン + 管理情報 + タイトル）。plain / sortable 行で共通利用し、行マークアップの
 * 重複を避ける（§3）。グリップ（ドラッグハンドル）は sortable 行が li 側に absolute で重ねる。
 * rete-home-0039: 行内の削除ボタンは撤去し、削除は右ペイン（詳細）上部のボタンへ集約した。
 * hom-0056: タグチップを上段（日付の右隣）へ移動。下段タグチップは撤去。
 */
function AnnouncementRowContent({ item, draggable, onSelect, keyword }: RowContentProps) {
  return (
    <button
      type="button"
      data-home-row-select="true"
      onClick={() => onSelect(item.id)}
      className={cn('block w-full text-left', draggable && 'pl-5')}
    >
      {/* 上段: 日付 + タグチップ（hom-0056）。 */}
      {/* sp-row-meta: hover 時の文字濃化（globals.css）の対象マーカー。選択行の拡大は hom-0133 で廃止。 */}
      <div className="sp-row-meta flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] text-[var(--sp-text-warm-2)]">
        <span>{formatDate(item.publishedAt)}</span>
        {item.tags.map((t) => (
          <Badge key={t.id} variant="outline">
            <TagIcon name={t.icon} size={12} color={t.color} />
            <span>{t.name}</span>
          </Badge>
        ))}
      </div>
      {/* 下段: タイトル。未読・既読は補助情報のインクドットで示し、文字の太さは行の正本（.sp-row-title=500）
          に従う（d539・上段より見出しが太い状態の解消。旧 rete-home-0011 の未読=太字は撤回）。 */}
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        {item.unread && (
          <span
            aria-hidden
            data-testid="home-unread-dot"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sp-accent-ink)]"
          />
        )}
        <span
          className={cn(
            // sp-row-title: 選択行の微拡大（hom-0123）は hom-0133 で廃止。横展開の判断が済むまで
            // マーカーだけ残す（Home では .sp-row-pill が付かないため拡大は起きない）。
            'sp-row-title truncate text-[0.8125rem]',
          )}
        >
          {highlightMatches(item.title, keyword)}
        </span>
      </div>
    </button>
  );
}

type RowProps = Omit<RowContentProps, 'draggable'> & { idx: number; isSelected: boolean };

/** D&D 無効時（非 ADMIN / 検索中 / 複数ページ）の通常行。グリップを持たない。 */
function PlainAnnouncementRow({ item, idx, isSelected, onSelect, keyword }: RowProps) {
  return (
    <li className={rowClassName(idx, isSelected, false)}>
      <AnnouncementRowContent item={item} draggable={false} onSelect={onSelect} keyword={keyword} />
    </li>
  );
}

/**
 * D&D 有効時（ADMIN・未フィルタ・単一ページ）の並び替え可能行。useSortable で transform/transition を受け、
 * 左端のグリップに listeners を張る（クリック選択・削除と操作を分離）。永続化は親の onDragEnd が担う。
 */
function SortableAnnouncementRow({ item, idx, isSelected, onSelect }: RowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <li ref={setNodeRef} style={style} className={rowClassName(idx, isSelected, isDragging)}>
      {/* ドラッグハンドル（@dnd-kit handle パターン）: activator は setActivatorNodeRef でグリップに固定し、
          attributes/listeners もグリップに張る。クリック選択・削除（行内の別ボタン）と操作を分離する。 */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`${item.title} を並び替え`}
        className={cn(
          'absolute left-1 top-1/2 z-10 -translate-y-1/2 rounded p-0.5 text-[var(--sp-text-warm-mute)] hover:text-[var(--sp-accent-ink)]',
          isDragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
        style={{ touchAction: 'none' }}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <AnnouncementRowContent item={item} draggable onSelect={onSelect} />
    </li>
  );
}

/**
 * 通知詳細の表示（右ペイン view）。タイトル + 編集ボタン（ADMIN）+ メタ（日付/投稿者）+ 本文（RichTextView）+ 添付一覧（DL）。
 * ヘッダ（作成者メタ行・タイトル）は固定、本文スクロール側は以下の順で構成: 内容 → ファイル → 通知先ロール → タグ（hom-0117 で hom-0109 編集モードの確定順に合わせて整備）。
 * DashboardView の render から自己完結なビュー部を切り出した（code-review HIGH）。
 * rete-home-0043: detail.tags を本文内に表示（編集モードと並び順を合わせる hom-0117 までは header ブロックにあった）。
 */
function AnnouncementDetailView({
  detail,
  isAdmin,
  onEdit,
  onDelete,
  actionsDisabled,
  keyword,
}: {
  detail: AnnouncementDetail;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** 削除 pending 中は編集/削除とも無効化（cmn-0384・memberships の removingId パターン踏襲。
      編集も止めるのは、pending 中に編集を開くと削除完了時の選択追従で編集フォームが無言で閉じ
      入力が破棄されるため＝写し元が編集系コントロールも isRemoving で止めるのと同じ理由）。 */
  actionsDisabled?: boolean;
  /** 通知検索の一致語ハイライト（hom-0110）。空/未指定はハイライトなし。 */
  keyword?: string;
}) {
  return (
    <article className="flex h-full flex-col p-4">
      <header className="shrink-0 space-y-2">
        {/* 作成者メタ行（hom-0090）+ 編集/削除（hom-0111: 別行だったものをメタ行と同一行へ統合。
            desk-thread-head-meta 同型＝アバター＋名前＋日時を左、編集/削除ボタンを右に配置）。
            author は string のため desk-avatar の Avatar({ id, name }) には id=name で代用する（アバター配色はハッシュ由来で成立）。 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Avatar
              author={{ id: detail.author, name: detail.author }}
              size={1.75}
              dataTestid="dashboard-detail-avatar"
            />
            <div className="flex min-w-0 flex-row items-center gap-2">
              <span className="text-sm font-medium text-[var(--sp-text-warm)]">
                {detail.author}
              </span>
              <span className="text-xs text-[var(--sp-text-warm-2)]">
                {formatDateTime(detail.publishedAt)}
              </span>
            </div>
          </div>
          {/* 編集/削除は shrink-0 で常に全体表示・クリック可能を担保（code-review HIGH: 統合行で幅が詰まった時にボタンが押し出される懸念への対処）。 */}
          {isAdmin && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onEdit}
                disabled={actionsDisabled}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[var(--sp-text-warm-2)] hover:bg-[var(--sp-accent-soft)] hover:text-[var(--sp-accent-ink)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                編集
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={actionsDisabled}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[var(--sp-text-warm-2)] transition-colors hover:bg-[color-mix(in_srgb,var(--sp-accent-red)_10%,transparent)] hover:text-[var(--sp-accent-red)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                削除
              </button>
            </div>
          )}
        </div>
        <h3 className="min-w-0 break-words text-xl font-semibold text-[var(--sp-text-warm)]">
          {highlightMatches(detail.title, keyword)}
        </h3>
        {/* hom-0090: 仕切り線をタイトル直下へ移動（従来はヘッダ末尾＝内容セクション直前にあった）。
            hom-0117: 通知先ロール・タグは hom-0109 編集モードの確定順（タイトル→内容→ファイル→通知先ロール→
            タグ）に揃えるため、本文スクロール側（ファイル section の直後）へ移動。 */}
        <hr style={{ borderColor: 'var(--sp-line-warm)' }} />
      </header>

      {/* rete-home-0041: スクロールバーは本文以下（内容＋添付）だけに付ける。従来は article 全体が
          overflow-y-auto でヘッダ（タイトル/メタ）ごとスクロールしていた。ヘッダは固定し、この
          ラッパー（flex-1 + min-h-0 + overflow-y-auto）に内容スクロールを閉じ込める。 */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <section className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-[var(--sp-text-warm)]">内容</h4>
          {/* hom-0090: 内容を枠線付きボックスへ。rete-home-0034: 1.5 でもまだ広いとの差し戻しで
            leading-[1.4] へさらに詰める（Desk 本文 .desk-rte-content / .desk-thread-head-body /
            .desk-thread-comment-text も同じ 1.4 に統一）。段落下マージンは mb-2.5 を維持。 */}
          <RichTextView
            html={detail.body}
            className="rounded-md border border-[var(--sp-line-warm)] p-3 text-sm leading-[1.4] [&_li]:ml-6 [&_li]:list-disc [&_p]:mb-2.5 [&_ul]:mb-2.5"
            highlight={keyword}
          />
        </section>

        {/* ファイル（H0022・hom-0090: ラベル「添付ファイル」→「ファイル」）。添付がある時だけ表示。
          クリックで最新版を DL（files の download を再利用）。 */}
        {detail.attachments.length > 0 && (
          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--sp-text-warm)]">
              <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
              ファイル
            </h4>
            {/* hom-0082: Desk 共有の AttachmentChip（丸ピル型）へ統一（コピペ禁止invariant準拠）。
              Home は読み取り専用一覧のため onRemove は渡さない（× ボタンは出ない）。 */}
            <div className="desk-pending-chips is-flush">
              {detail.attachments.map((att) => (
                <AttachmentChip
                  key={att.id}
                  name={att.fileName}
                  onDownload={() => void downloadFile(att.fileId, att.fileName)}
                />
              ))}
            </div>
          </section>
        )}

        {/* hom-0117: タグ（rete-home-0043）も hom-0109 確定順に揃える。付与タグがある時のみ表示。
           hom-0143 で通知先セクションは撤去済み。 */}
        {detail.tags.length > 0 && (
          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold text-[var(--sp-text-warm)]">タグ</h4>
            <div className="flex flex-wrap gap-1">
              {detail.tags.map((t) => (
                <Badge key={t.id} variant="outline" className="gap-1">
                  <TagIcon name={t.icon} size={12} color={t.color} />
                  <span>{t.name}</span>
                </Badge>
              ))}
            </div>
          </section>
        )}
      </div>
    </article>
  );
}

/**
 * 掲示板ダッシュボード（Home）。通知一覧（左）/ 詳細・編集（右）の 2 ペイン。reference 側の掲示板
 * （features/announcements）の見た目・操作感に寄せている: 一覧は薄字ヘッダ + 1 行行 + 重要/New バッジ +
 * 行内削除、詳細はタイトル + 編集ボタン + 重要/New チェックボックス（表示専用）+ 「内容」、編集は
 * オーバーレイではなく詳細ペインと同じ右カラムに view と排他で差し替え表示する。データは rete backend の announcement API。
 * ADMIN（テナント管理者）のみ作成・編集・削除・並び替えの導線が露出する（認可の実 enforce は backend 側 RolesGuard）。
 * ドラッグ並び替え（H0021 / rete-home-0024）: ADMIN かつ「全件が 1 ページに収まり未フィルタ」の時だけ
 * グリップでの並び替えを許可し、新順序は backend の position 列へ永続化する（部分集合は set-mismatch で弾かれる）。
 * 添付ファイル（H0022 / rete-home-0024）: 新規作成は保留 → 作成後に通知へ flush、編集は即時 add/remove、
 * 詳細は添付一覧をダウンロードリンクで表示する（DL は files の download エンドポイントを再利用）。
 * タグ（rete-home-0043）: ADMIN はタグマスタを管理し、通知に複数タグを付与できる。タグで絞り込む。
 * 通知先（targetRoles / targetBusinessRoles）は hom-0143 で機能ごと撤去（全認証ユーザーが全件閲覧）。
 * 注: 本文の markdown は未対応（rete は共有 RTE の HTML を採用）。
 * hom-0073: kind（'board'=掲示板 / 'faq'=FAQ）で画面を出し分ける。コンポーネントは複製せず、
 * 見出し・空状態文言だけ kind に応じて差し替える（データ取得は useAnnouncements(kind) 側でスコープ）。
 */
const KIND_LABEL: Record<AnnouncementTagKind, string> = { board: '掲示板', faq: 'FAQ' };

export function DashboardView({ kind = 'board' }: { kind?: AnnouncementTagKind }) {
  const permissions = useHomePermissions();
  const isAdmin = kind === 'faq' ? permissions.faqEdit : permissions.boardEdit;
  const kindLabel = KIND_LABEL[kind];

  // お知らせタグマスタ（rete-home-0043）。AnnouncementTagMasterProvider（AppShell 配下・hom-0073）から
  // kind に応じたインスタンスを取得する。DashboardView は AppShell の children として実際に描画される
  // ため Provider の子孫に位置し、ここで Context を消費できる（HubView は AppShell の祖先で消費不可）。
  const tagMasterCtx = useAnnouncementTagMasterContext();
  const tagMaster = kind === 'faq' ? tagMasterCtx.faq : tagMasterCtx.board;

  const {
    items,
    total,
    page,
    totalPages,
    setPage,
    loading,
    error,
    create,
    update,
    remove,
    reorder,
    markReadLocal,
  } = useAnnouncements(kind);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const {
    detail,
    loading: detailLoading,
    error: detailError,
    refetch: refetchDetail,
  } = useAnnouncementDetail(selectedId);
  const { decrement } = useAnnouncementUnread(kind);

  // お知らせタグマスタ（rete-home-0043）。hom-0059 で HubView から props 受領（フィルタ・フォーム付与で共有）。
  // マスタ管理オーバーレイの開閉は HubView がサイドバー foot ボタンと束ねて保持する。
  // タグ絞り込みの状態（OR 条件・クライアントサイドフィルタ）。
  // cmn-0044/§6: この Set state + toggle は files-shell.tsx と同型（現 2 箇所）。3 箇所目が出たら
  // useTagFilter()（toggle/clear/has を内包する custom hook）へ抽出する。現状 2 箇所のため未抽出。
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const toggleTagFilter = useCallback((id: string) => {
    setTagFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearTagFilter = useCallback(() => setTagFilter(new Set()), []);

  // 右ペインの編集ライフサイクル（create/edit 状態・保存中・編集オープン/クローズ・確定 + 添付 flush + タグ付与）は
  // 専用 hook へ集約し、DashboardView の責務混在を解消する（code-review HIGH）。
  const { editor, setEditor, saving, openEdit, closeEditor, handleSubmit } = useAnnouncementEditor({
    selectedId,
    setSelectedId,
    create,
    update,
    refetchDetail,
  });

  const [query, setQuery] = useState('');

  // 検索 + タグ絞り込みはクライアントサイド（現在ページの items に対するフィルタ・backend 改修なし）。
  // rete-home-0043: タグ絞り込みを追加（タグ OR 条件・一致判定は item.tags[].id で行う）。
  // 選択は items（真の母集合）基準のままにし、フィルタで一時的に visible が縮んでも選択をロストさせない。
  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hasTagFilter = tagFilter.size > 0;
    if (!q && !hasTagFilter) return items;
    return items.filter((a) => {
      const matchesQuery =
        !q || a.title.toLowerCase().includes(q) || a.excerpt.toLowerCase().includes(q);
      const matchesTags = !hasTagFilter || a.tags.some((t) => tagFilter.has(t.id));
      return matchesQuery && matchesTags;
    });
  }, [items, query, tagFilter]);

  // hom-0123→mdl-0050: hover グレー帯のスライド追従。測位は共通 hook（useRowHoverBand）が単一ソース。
  // 描画は ul 末尾の装飾 li（.sp-row-hoverband）が担い、モーションは CSS 側がナビ正本トークンを参照。
  const {
    listRef,
    onMouseOver: handleListMouseOver,
    onMouseLeave: handleListMouseLeave,
    bandStyle,
  } = useRowHoverBand<HTMLUListElement>('li.sp-row-pillable');

  // 通知を開く = 選択 + 既読化（HM-3・ADR 0029）。未読だった時のみ一覧の楽観更新 + サイドバー未読数の
  // 楽観デクリメントを行う（既読化の実書き込みは backend が詳細 GET の副作用で行う・往復を増やさない）。
  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      setEditor(null);
      const target = items.find((a) => a.id === id);
      if (target?.unread) {
        markReadLocal(id);
        decrement();
      }
    },
    [items, markReadLocal, decrement, setEditor],
  );

  // 一覧取得・更新後、選択が外れていれば先頭を選ぶ（削除で対象が消えた時も追従）。
  // 自動選択でも詳細 GET が走り「表示された = 既読」となるため handleSelect 経由で既読化する。
  // d670: handleSelect の items 検索は選択確定前の（または一覧再取得後の）items を見るため、
  // 先頭行が未読のまま選択済みの時に楽観更新が漏れ、既読化してもドットが残っていた。
  // 自動選択の先頭行の未読は handleSelect に委ねず、ここで打ち消す（詳細 GET で既読になる行と一致させる）。
  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    const hasSelection = items.some((a) => a.id === selectedId);
    if (selectedId === null || !hasSelection) {
      const head = items[0];
      if (head.unread) {
        markReadLocal(head.id);
        decrement();
      }
      setEditor(null);
      setSelectedId(head.id);
    }
  }, [items, selectedId, markReadLocal, decrement, setEditor]);

  // cmn-0384: 削除 pending 中の再確定窓を塞ぐ（memberships-admin-screen の removingId パターン踏襲）。
  // close-first 契約（cmn-0352）ではダイアログが確定即閉じるため、remove 未解決の間に削除導線→再確定で
  // 同一 id の DELETE が並走し 2 回目が 404 の誤 toast になる。pending 中は削除ボタンと確定を無効化する。
  // クリアは finally＝削除成功で行が消え選択が自動追従（上の useEffect）した後も確実にリセットされる。
  const [removingId, setRemovingId] = useState<string | null>(null);
  const removeWithToast = useCallback(
    async (id: number | string): Promise<boolean> => {
      setRemovingId(String(id));
      try {
        await remove(String(id));
        toast.success('通知を削除しました');
        return true;
      } catch {
        toast.error('削除に失敗しました');
        return false;
      } finally {
        setRemovingId(null);
      }
    },
    [remove],
  );

  const { deleteTarget, setDeleteTarget, handleDelete } = useDeleteConfirm<AnnouncementSummary>({
    remove: removeWithToast,
  });

  // hom-0124: ↑↓キーで選択行（白板ピル）を移動する（Desk dsk-0012/0013 のキーボードナビ規約を流用）。
  // 母集合は表示中の行（visibleItems）。dndEnabled 時の描画は items だが、その条件は
  // query 空+tagFilter 空を含み visibleItems === items のため index はどちらの分岐でも一致する。
  // 選択はクリックと同経路（handleSelect）を通し、未読の既読化・詳細追従を揃える。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.isComposing) return; // IME 変換中は素通し
      const active = document.activeElement as HTMLElement | null;
      // Desk と違い Home の行（li）はフォーカス可能でないため「一覧内フォーカス時のみ」の
      // 包含チェックは置けない（フォーカス移動方式は設計時に棄却済み）。代わりに、他の
      // インタラクティブ要素（検索欄・ページャ/新規登録等のボタン・タグ絞り込みメニュー・
      // リンク）へフォーカスがある間は矢印を奪わない。
      // hom-0126: 明細行自体が <button>（AnnouncementRowContent）のため、クリック直後は
      // この行の button にフォーカスが乗り、BUTTON 除外条件に誤って一致していた
      // （検索欄クリック後と同じ扱いになり↑↓が無効化される）。data-home-row-select 目印で
      // 明細行の button だけを BUTTON 除外の対象外にする（他の操作系ボタンの保護は不変）。
      const isRowSelectButton = active?.closest('[data-home-row-select]') != null;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          (active.tagName === 'BUTTON' && !isRowSelectButton) ||
          active.tagName === 'SELECT' ||
          active.tagName === 'A' ||
          active.isContentEditable)
      ) {
        return;
      }
      // フォーム表示中の行切替は編集内容を静かに破棄してしまうため抑止。削除確認中も動かさない。
      if (editor !== null || deleteTarget !== null) return;
      if (visibleItems.length === 0) return; // 絞り込み結果が空なら誤動作なし
      const currentIdx = visibleItems.findIndex((a) => a.id === selectedId);
      // hom-0125: 絞り込みで選択行が visibleItems から外れた（currentIdx===-1）時、stepIndex の
      // 純関数意味論（currentIndex<0→null）は変えず、呼び出し側で edge-snap 救済する
      // （ArrowDown=先頭 / ArrowUp=末尾。Gmail 等の慣習・Desk dsk-0012/0013 のテスト保護のため
      // stepIndex 自体には触れない）。
      const nextIdx =
        currentIdx === -1
          ? e.key === 'ArrowDown'
            ? 0
            : visibleItems.length - 1
          : stepIndex(visibleItems.length, currentIdx, e.key === 'ArrowDown' ? 1 : -1);
      if (nextIdx === null) return; // 端で止まる（edge-stop 時は preventDefault しない＝Desk 規約）
      e.preventDefault();
      handleSelect(visibleItems[nextIdx].id);
      // hom-0128: 矢印キー押下というキーボード操作そのものが、フォーカスが乗ったままの旧行を
      // :focus-visible に昇格させてしまい、旧行の inset 枠と新行の板ピルが二重表示される副作用が
      // あった（ui-review-runner 照合で検出）。フォーカスが行 button 上にある時（isRowSelectButton
      // ＝Tab到達 or クリック直後）のみ、Desk use-desk-keyboard-nav の moveAndFollow と同型で新しい
      // 選択行の button へフォーカスを追従させ Tab 位置を保つ（それ以外は新規フォーカスジャンプを
      // 起こさないよう何もしない）。新行側の focus-visible 枠は選択行では出さない CSS 排他
      // （globals.css の `.sp-row-pill / .sp-row-ring [data-home-row-select]:focus-visible`）で
      // 選択表現へ一意化する（hom-0133 以降 Home の選択実体は板ピルでなく teal 枠 .sp-row-ring）。
      if (isRowSelectButton) {
        listRef.current
          ?.querySelectorAll<HTMLElement>('li.sp-row-pillable [data-home-row-select]')
          [nextIdx]?.focus({ preventScroll: true });
      }
      // 選択行がスクロール外なら追従。hoverband li は sp-row-pillable を持たないため index が行と一致する。
      listRef.current
        ?.querySelectorAll<HTMLElement>('li.sp-row-pillable')
        [nextIdx]?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleItems, selectedId, editor, deleteTarget, handleSelect, listRef]);

  // 並び替えは ADMIN かつ「全件が 1 ページに収まり未フィルタ」の時だけ有効化する。
  // backend reorder は orderedIds == 現存全件 を要求するため、ページング中・検索中・タグ絞り込み中は
  // 部分集合になり set-mismatch（400）になる。その条件下では通常行（グリップ無し）にフォールバックする。
  const dndEnabled = isAdmin && query.trim() === '' && tagFilter.size === 0 && totalPages <= 1;

  // D&D の配線（センサー設定・in-flight ガード・arrayMove → 永続化委譲）は共通フック
  // useOptimisticReorder へ集約し、掲示板固有の id 列への畳み込みは useAnnouncementReorder が担う
  // （cmn-0357・DashboardView の責務混在を解消する / code-review HIGH）。
  const { sensors, handleDragEnd } = useAnnouncementReorder(items, reorder);

  return (
    <main className="dashboard-shell sp-page flex flex-col overflow-hidden">
      <PageTitle title={kindLabel} className="shrink-0" />

      {/* ツールバー: 検索（中央）+ タグフィルタ（検索右）+ 管理ボタン（右端・ADMIN のみ）。
          rete-home-0014: 検索入力を Desk 明細の .desk-filter-keyword 様式へ統一し、行の中央に配置
          （新規登録は absolute 右寄せにして中央寄せのオフセットを生まない）。
          rete-home-0015: 新規登録は塗りつぶしを撤去し、背景なし副次ボタン（ink）へ。
          rete-home-0043: TagFilterDropdown を検索の右に追加。タグ管理ボタンを新規登録と並べて配置。
          hom-0134: 新規登録を検索行の外側段（右寄せ・gap=1.5）へ出して「検索」と「登録」を別系統として
          視線分離。absolute 配置を撤廃し自然な flex-col で段を1段ずらす（layout shift 防止）。 */}
      {/* cmn-0145: 検索＋新規登録の縦段から表ヘッダ罫線までの間隔を 4px（mb-1）へ統一。
          hom-0134 の段構造・gap-1.5 は不変。 */}
      <div className="mb-1 flex shrink-0 flex-col gap-1.5">
        <div className="flex items-center justify-center gap-1.5">
          <div className="desk-filter-keyword" style={{ width: '14rem' }}>
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            <input
              type="search"
              placeholder="タイトル・内容で検索..."
              aria-label="通知を検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // 検索ボックスの ESC は値クリア（Desk 明細と同挙動 / rete-desk-0023 系）。
              // フォーム側 window Esc ハンドラへの伝搬を止め、二重発火を防ぐ（code-review HIGH）。
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                  setQuery('');
                  e.stopPropagation();
                }
              }}
            />
          </div>
          {/* タグ絞り込みドロップダウン（rete-home-0043）。タグ 0 件時は自動非表示。 */}
          <TagFilterDropdown
            tags={tagMaster.tags}
            active={tagFilter}
            loading={tagMaster.loading}
            onToggle={toggleTagFilter}
            onClear={clearTagFilter}
          />
          {/* hom-0081: 検索キーワード＋タグ絞り込みを一括解除。Desk 明細フィルタバーの
              「クリア」ボタン（.desk-filter-clear・RotateCcw+ラベル）と同じ意匠。 */}
          <button
            type="button"
            className="desk-filter-clear home-filter-clear"
            title="フィルタをクリア"
            aria-label="検索・タグ絞り込みをクリア"
            onClick={() => {
              setQuery('');
              clearTagFilter();
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="desk-filter-icon-label">クリア</span>
          </button>
        </div>
        {/* hom-0052: 生<button>を Button primitive（variant=sp-action）へ統一。hom-0134 はここから
            独立行（justify-end）へ。search 行は中央寄せのまま・段を分けた別系統の操作として視線分離。 */}
        {isAdmin && (
          <div className="flex items-center justify-end gap-1">
            {/* hom-0059: タグ管理ボタンはサイドバー foot（AppSidebar）へ移設。ツールバーには登録のみ残す。 */}
            <Button
              type="button"
              variant="sp-action"
              size="sp-compact"
              onClick={() => {
                setEditor({ mode: 'create' });
              }}
            >
              {/* hom-0071: 掲示板の登録ボタンのみラベルを「新規登録」へ変更（Deskは指示範囲外のため据え置き）。 */}
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              新規登録
            </Button>
          </div>
        )}
      </div>

      <div
        className="grid flex-1 gap-4"
        style={{ gridTemplateColumns: 'minmax(320px, 1fr) 1fr', minHeight: 0 }}
      >
        {/* 左: 通知リスト */}
        {/* rete-home-0038: min-w-0 で grid トラック（1fr）超過を防ぐ。長いタイトルでも列幅が膨らまず
            明細を行き来してもレイアウトシフトしない（タイトル自体は行内 truncate）。 */}
        {/* 正本 comp-card: 囲み面（枠・角丸・影）は画面側で作り込まず .sp-panel（Card と同値）に寄せる。 */}
        <section className="sp-panel flex h-full min-w-0 flex-col overflow-hidden">
          {/* ヘッダ行は「タイトル」ラベルのみ・中央寄せ（rete-home-0018 / 0020: 通知日・重要・New の
              カラムは廃止し、各明細の管理情報行へ集約）。 */}
          {/* rete-home-0028: ヘッダの縦幅を Desk のチャット明細ヘッダ（.desk-chat-list-head: py 0.375rem / font 0.6875rem）に揃える。 */}
          {/* mdl-0036: ヘッダ下罫線も .sp-table thead / Desk 系と同じ薄色（--sp-line-warm-2）へ統一。 */}
          <div className="shrink-0 border-b border-[var(--sp-line-warm-2)] bg-[var(--sp-card)] px-3 py-1.5 text-center text-[0.6875rem] font-normal text-[var(--sp-text-warm-mute)]">
            <span>タイトル</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Spinner className="h-6 w-6 text-[var(--sp-accent-teal)]" />
              </div>
            ) : error ? (
              <p role="alert" className="px-4 py-6 text-sm text-[var(--sp-accent-red)]">
                {error}
              </p>
            ) : (
              <ul
                ref={listRef}
                className="relative m-0 list-none p-0"
                aria-label="通知一覧"
                onMouseOver={handleListMouseOver}
                onMouseLeave={handleListMouseLeave}
              >
                {visibleItems.length === 0 && (
                  <li className="px-4 py-6 text-sm text-[var(--sp-text-warm-mute)]">
                    {items.length === 0 ? `${kindLabel}はありません` : '該当する通知はありません'}
                  </li>
                )}
                {dndEnabled ? (
                  // ADMIN・未フィルタ・単一ページ: グリップで並び替え可能。permanent な順序は backend に永続化。
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    {/* dndEnabled は query 空 + tagFilter 空を含むため visibleItems === items（全件）。SortableContext には
                        全件を渡し、handleDragEnd / backend reorder の「現存全件」契約と一致させる。
                        SortableAnnouncementRow に keyword を渡していないのは同じ理由（dndEnabled 時は query が
                        必ず空 = ハイライト対象なし）。dndEnabled の定義を変えて非空 query 時にも D&D を許すなら
                        ここも keyword 配線が必要になる（hom-0110）。 */}
                    <SortableContext
                      items={items.map((a) => a.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {items.map((item, idx) => (
                        <SortableAnnouncementRow
                          key={item.id}
                          item={item}
                          idx={idx}
                          isSelected={item.id === selectedId}
                          onSelect={handleSelect}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                ) : (
                  visibleItems.map((item, idx) => (
                    <PlainAnnouncementRow
                      key={item.id}
                      item={item}
                      idx={idx}
                      isSelected={item.id === selectedId}
                      onSelect={handleSelect}
                      keyword={query}
                    />
                  ))
                )}
                {/* hom-0123→mdl-0050: hover グレー帯本体（ナビ .nav-pill と同型の単一スライド要素）。装飾専用・
                    非インタラクティブ。DOM 末尾に置くことで先行する行の背景/罫線より上・
                    z-index:1 の行コンテンツより下に描かれる（選択行は z-index:2 で帯の上）。 */}
                {bandStyle ? (
                  <li aria-hidden className="sp-row-hoverband" style={bandStyle} />
                ) : null}
              </ul>
            )}
          </div>

          {/* フッターは共通 Pagination（mdl-0016・struct-pass-reference マスタ一覧と同型）に統一。 */}
          <Pagination
            total={`全 ${total} 件`}
            pageLabel={totalPages > 0 ? `${page} / ${Math.max(totalPages, 1)} page` : ''}
            onFirst={totalPages > 1 ? () => setPage(1) : undefined}
            onPrev={totalPages > 1 ? () => setPage(page - 1) : undefined}
            onNext={totalPages > 1 ? () => setPage(page + 1) : undefined}
            onLast={totalPages > 1 ? () => setPage(totalPages) : undefined}
            canPrev={page > 1}
            canNext={page < totalPages}
          />
        </section>

        {/* 右: 詳細（view）/ 新規・編集フォーム（create・edit）を排他で表示 */}
        {/* rete-home-0033: h-full min-h-0 で grid セル高を確定し、本文（article overflow-y-auto）の
            スクロールバーをペイン内に収める（旧: 高さ無制限で縦長本文がウィンドウ外へはみ出していた）。
            rete-home-0038: min-w-0 で長いタイトル時の横膨張を防ぐ。 */}
        <section className="sp-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          {editor ? (
            <AnnouncementForm
              // 編集セッション単位で remount し、初期値由来のローカル state（selectedTagIds 等）が
              // 別通知の編集へ持ち越されない（stale）よう保証する（code-review HIGH / rete-home-0043）。
              key={editor.mode === 'edit' ? `edit-${editor.id}` : 'create'}
              mode={editor.mode}
              initial={editor.mode === 'edit' ? editor.initial : undefined}
              announcementId={editor.mode === 'edit' ? editor.id : undefined}
              initialAttachments={editor.mode === 'edit' ? editor.attachments : undefined}
              initialTagIds={editor.mode === 'edit' ? editor.tags.map((t) => t.id) : undefined}
              tagMaster={tagMaster}
              saving={saving}
              canEdit={isAdmin}
              onCancel={closeEditor}
              onSubmit={handleSubmit}
            />
          ) : detailError ? (
            <p role="alert" className="px-5 py-6 text-sm text-[var(--sp-accent-red)]">
              {detailError}
            </p>
          ) : detailLoading ? (
            /* hom-0053: loading は Spinner（左ペインと同じ h-6 w-6 teal / Desk タスク詳細と統一）。 */
            <div className="flex h-full items-center justify-center">
              <Spinner className="h-6 w-6 text-[var(--sp-accent-teal)]" />
            </div>
          ) : !detail ? (
            <p className="px-5 py-6 text-sm text-[var(--sp-text-warm-mute)]">
              左のリストから通知を選択してください
            </p>
          ) : (
            <AnnouncementDetailView
              detail={detail}
              isAdmin={isAdmin}
              onEdit={() => void openEdit(detail.id)}
              onDelete={() => {
                // 削除確認は一覧と共通の useDeleteConfirm を使う。詳細の母集合 items から
                // 対象 summary を引いて渡す（rete-home-0039）。
                const target = items.find((a) => a.id === detail.id);
                if (target) setDeleteTarget(target);
              }}
              actionsDisabled={removingId !== null}
              keyword={query}
            />
          )}
        </section>
      </div>

      {/* 共通ConfirmDialogで削除対象と不可逆な結果を明示する。 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        message={
          deleteTarget
            ? `掲示「${deleteTarget.title}」を削除しますか？削除すると元に戻せません。`
            : ''
        }
        destructive
        busy={removingId !== null}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}
