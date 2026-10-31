'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  CalendarDays,
  Star,
  Settings,
  Package,
  MessageSquare,
  CheckSquare,
  FileText,
  Folder,
  Building2,
  FolderKanban,
  Hash,
  Tags,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react';
import { FAVORITE_KIND_BADGE_LABELS, type FavoriteDto, type FavoriteKind } from '@rete/shared';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';
import { useSessionContext } from '@/features/auth';
import { useAnnouncementUnread } from '@/features/dashboard';
import { unlockFileLink } from '@/features/files';
import { useFavoritesContext } from '../hooks/favorites-context';
import { useReferenceReachableValue } from '../hooks/reference-reachable-context';
import { useReferenceObjectTypes } from '../hooks/use-reference-object-types';
import { resolveFavoriteLink } from '../lib/nav-config';
import { FavoritesManageOverlay } from './favorites-manage-overlay';

/** kind → アイコン（モック index.html のアイコン選定を踏襲。targetRef 非依存）。 */
const KIND_ICON: Record<FavoriteKind, LucideIcon> = {
  system: Package,
  chat: MessageSquare,
  task: CheckSquare,
  file: FileText,
  folder: Folder,
  // CM-2 / ADR 0037（組織 / プロジェクト / 器）。desk★ は space のみ生成（org/project は遷移先 deferred）。
  organization: Building2,
  project: FolderKanban,
  space: Hash,
};

/** 未接続の案内の id（押せない行の aria-describedby と、案内の本文で共有する）。 */
const UNAVAILABLE_NOTE_ID = 'app-sidebar-unavailable-note';

/**
 * 遷移先が未接続（準備中）の行の案内（S-HOME-09・2026-10-26 実測で確定）。
 *
 * 灰色の行はクリックを受け取らない（`disabled`）ため、押しても画面は何も変わらない。利用者が
 * 「壊れている」と受け取らないよう、行の下に「開けない理由」を文字で出す。読み上げにも同じ文を
 * 渡す（role="status"・行から aria-describedby で指す）。長い一覧でサイドバーを押し広げないよう、
 * 表示は 2 行で切り、全文は title で読める。
 */
function UnavailableFavoritesNote({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  const text = labels.join('、');
  return (
    <p id={UNAVAILABLE_NOTE_ID} className="sidebar-note" role="status" title={text}>
      準備中のため開けません: {text}
    </p>
  );
}

interface FavoriteRowProps {
  fav: FavoriteDto;
  onOpen: (fav: FavoriteDto) => void;
  /** 遷移先が未接続（灰色・クリック不可）か。 */
  disabled: boolean;
  /** 未接続の行が 1 つでもあるか（案内の本文と行を結ぶかの判定）。 */
  hasUnavailableNote: boolean;
}

function FavoriteRow({ fav, onOpen, disabled, hasUnavailableNote }: FavoriteRowProps) {
  const Icon = KIND_ICON[fav.kind] ?? Star;
  // mdl-0056: w-full / text-left は button.sidebar-link の共通 reset が持つ。ここで w-full を足すと
  // utilities layer が勝ち、行がホバー帯より 12px 広くなる（幅は globals.css §サイドバー行の幅が単一ソース）。
  // 押せない行は disabled 属性で止める（案内は行の外に出す。S-HOME-09）。
  return (
    <button
      type="button"
      className={cn('sidebar-link', disabled && 'disabled')}
      aria-disabled={disabled}
      aria-describedby={disabled && hasUnavailableNote ? UNAVAILABLE_NOTE_ID : undefined}
      disabled={disabled}
      title={disabled ? '遷移先は準備中です' : fav.label}
      onClick={() => onOpen(fav)}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">{fav.label}</span>
      <span className={cn('fav-kind-sidebar', `kind-${fav.kind}`)}>
        {FAVORITE_KIND_BADGE_LABELS[fav.kind]}
      </span>
    </button>
  );
}

/**
 * 共通シェルの左サイドバー（Home モード）。
 * 通知管理（ダッシュボード）+ 横断お気に入り（ユーザー別・実 API / HM-1）。
 * お気に入りクリックは kind から遷移先を解決し、未接続の導線は灰色（準備中）で表示する。
 * 歯車ボタンで管理オーバーレイ（追加 / 削除 / 並び替え）を開く。
 */
export function AppSidebar({ onOpenTagMaster }: { onOpenTagMaster?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, menuItems } = useSessionContext();
  // ヘッダタブと同じ reference 実起動確認結果（AppShell の単一 probe）。system お気に入りも同じく gating する。
  const referenceReachable = useReferenceReachableValue();
  const { items, loading, error, remove, reorder, add } = useFavoritesContext();
  // hom-0067: reference 種別一覧（ADMIN ロールのみ取得。reference 側方針 SYS_ADMIN 限定に揃える）。
  const isAdmin = user?.role === 'ADMIN';
  const referenceObjectTypes = useReferenceObjectTypes(isAdmin);
  // 掲示板/FAQ は独立した未読カウント（hom-0073・kind 別に AnnouncementUnreadProvider から取得）。
  const { unreadCount: boardUnreadCount } = useAnnouncementUnread('board');
  const { unreadCount: faqUnreadCount } = useAnnouncementUnread('faq');
  const [manageOpen, setManageOpen] = useState(false);

  // cmn-0127→cmn-0128→rete-top-0004: hover グレー帯のスライド追従。測位は共通 hook
  // （useRowHoverBand）へ集約（設定/モデルサイドバーと同じ hook を共有・invariants §3）。
  // 掲示板 ul と違い scroll 内はリンク行だけではない（セクション見出し・空状態等）ため、
  // leaveOnNoMatch=true で非リンク領域へ移った時に帯を自動で消す（凍結残置しない）。
  // disabled 行は pointer-events:none でイベントが下の要素へ抜ける＝非リンク扱いとなり同じく帯は出ない。
  // hom-0131: active 行は帯の対象から外す（:not(.active)）。アクティブ帯を半透明のすりガラス面へ
  // 変えたため、下に黒9%の帯が入ると透けて二重に見える（不透明な白板だった時は隠れていた）。
  // leaveOnNoMatch=true なので active 行へ hover が移った瞬間に帯が消える。
  const {
    listRef: scrollRef,
    onMouseOver: handleScrollMouseOver,
    onMouseLeave: handleScrollMouseLeave,
    bandStyle,
  } = useRowHoverBand<HTMLDivElement>('.sidebar-link:not(.active)', 'vertical', true);

  // 遷移先が未接続（準備中）の行の呼び名。行は押せないため、理由を下の案内にまとめて出す（S-HOME-09）。
  // 行の判定と案内の判定で同じ解決を 2 度書かないよう、ここで 1 度だけ解いて両方が使う。
  const favoriteLinks = items.map((fav) => ({
    fav,
    href: resolveFavoriteLink(
      fav.kind,
      fav.targetRef,
      menuItems,
      referenceReachable,
      referenceObjectTypes,
    ).href,
  }));
  const unavailableLabels = favoriteLinks.filter((l) => l.href === null).map((l) => l.fav.label);

  const handleOpenFavorite = (fav: FavoriteDto) => {
    const link = resolveFavoriteLink(
      fav.kind,
      fav.targetRef,
      menuItems,
      referenceReachable,
      referenceObjectTypes,
    );
    if (!link.href) return;
    if (link.external) {
      window.location.href = link.href;
      return;
    }
    // d560: 同じ URL への★押し直しは Next が遷移を取り消し URL が変わらないため、遷移前に
    // 対象を直接 File 画面へ伝える（targetRef は decode 済みのまま・URL 側の読み取りと揃える）。
    if (fav.kind === 'file') unlockFileLink(fav.targetRef);
    router.push(link.href);
  };

  return (
    <aside className="app-sidebar app-sidebar--home">
      <div className="app-sidebar-header">
        <h1>Home</h1>
      </div>

      <div
        className="app-sidebar-scroll"
        ref={scrollRef}
        onMouseOver={handleScrollMouseOver}
        onMouseLeave={handleScrollMouseLeave}
      >
        <div>
          <div className="sidebar-section-label">通知管理</div>
          {/* hom-0073: FAQ の 2 項目目を追加。掲示板/FAQ は同じ画面コンポーネント（HubView kind 切替）を
              別ルートで呼び出すため、遷移先も別ルートにして usePathname で active を判定する。 */}
          <Link
            href="/hub"
            className={cn('sidebar-link', pathname === '/hub' && 'active')}
            aria-current={pathname === '/hub' ? 'page' : undefined}
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" />
            <span className="flex-1">掲示板</span>
            {boardUnreadCount > 0 && (
              <span aria-label={`未読 ${boardUnreadCount} 件`} className="sidebar-badge ml-auto">
                {boardUnreadCount > 99 ? '99+' : boardUnreadCount}
              </span>
            )}
          </Link>
          {/* d880: カレンダーは掲示板と FAQ の間（開発統括指定の並び「掲示板 → カレンダー → FAQ → タグ管理」）。
              d744 で入れた導線が b2fe0726 の戻しで落ちていたので戻した。選択状態は掲示板・FAQ と同じく
              usePathname で判定する。 */}
          <Link
            href="/hub/calendar"
            className={cn('sidebar-link', pathname === '/hub/calendar' && 'active')}
            aria-current={pathname === '/hub/calendar' ? 'page' : undefined}
          >
            <CalendarDays className="h-4 w-4 shrink-0" />
            <span className="flex-1">カレンダー</span>
          </Link>
          <Link
            href="/hub/faq"
            className={cn('sidebar-link', pathname === '/hub/faq' && 'active')}
            aria-current={pathname === '/hub/faq' ? 'page' : undefined}
          >
            <HelpCircle className="h-4 w-4 shrink-0" />
            <span className="flex-1">FAQ</span>
            {faqUnreadCount > 0 && (
              <span aria-label={`未読 ${faqUnreadCount} 件`} className="sidebar-badge ml-auto">
                {faqUnreadCount > 99 ? '99+' : faqUnreadCount}
              </span>
            )}
          </Link>
          {/* hom-0079: タグ管理は通知管理グループ内・FAQ の直後（ADMIN のみ・HubView が opener を注入した
              時だけ表示）。開発統括指定の並び「ダッシュボード → FAQ → タグ管理」。Home 以外のタブには
              onOpenTagMaster が来ないため出ない。 */}
          {onOpenTagMaster && (
            <button type="button" className="sidebar-link" onClick={onOpenTagMaster}>
              <Tags className="h-4 w-4" aria-hidden="true" />
              <span className="flex-1">タグ管理</span>
            </button>
          )}
        </div>

        <div className="mt-2">
          <div className="sidebar-section-label">
            <span className="inline-flex items-center gap-1.5">
              <Star className="h-3.5 w-3.5" />
              お気に入り管理
            </span>
            <button
              type="button"
              className="sidebar-add-btn"
              aria-label="お気に入りを管理"
              title="お気に入りを管理"
              onClick={() => setManageOpen(true)}
            >
              <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {loading ? (
            <div className="flex justify-center py-3">
              <Spinner className="h-4 w-4" />
            </div>
          ) : error ? (
            // 取得失敗を空状態と取り違えさせない（「0 件」と「読み込めなかった」を区別）。
            <p className="px-3 py-2 text-xs text-[var(--sp-accent-red)]" role="alert">
              {error}
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[hsl(var(--sidebar-foreground)/0.5)]">
              お気に入りはまだありません
            </p>
          ) : (
            <>
              {favoriteLinks.map(({ fav, href }) => (
                <FavoriteRow
                  key={fav.id}
                  fav={fav}
                  onOpen={handleOpenFavorite}
                  disabled={href === null}
                  hasUnavailableNote={unavailableLabels.length > 0}
                />
              ))}
              {/* 準備中の行は押しても何も起きないため、理由を画面に出す（S-HOME-09）。 */}
              <UnavailableFavoritesNote labels={unavailableLabels} />
            </>
          )}
        </div>

        {/* cmn-0127: hover 帯本体（掲示板 .home-row-hoverband と同型の単一スライド要素）。装飾専用・
            非インタラクティブ。DOM 末尾の絶対配置＝リストと一体でスクロールし、z-index:1 の
            .sidebar-link コンテンツより下に描かれる（active 行の背景も帯の上に残る）。 */}
        {bandStyle ? <div aria-hidden className="app-sidebar-hoverband" style={bandStyle} /> : null}
      </div>

      <FavoritesManageOverlay
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        items={items}
        loading={loading}
        error={error}
        remove={remove}
        reorder={reorder}
        add={add}
        referenceObjectTypes={referenceObjectTypes}
        canShowReferenceGroup={isAdmin}
      />
    </aside>
  );
}
