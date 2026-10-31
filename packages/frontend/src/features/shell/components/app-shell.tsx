'use client';
import { requestNavigation } from '@/lib/navigation-intent';

import { useEffect, useMemo, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import toast from 'react-hot-toast';
import { useSessionContext, logout } from '@/features/auth';
import { MFA_SETUP_PATH } from '@/features/auth/constants';
import { resetColumnWidthsStore } from '@/features/user-table-column-widths';
// desk barrel（DeskPage → AppShell）を経由すると shell↔desk が循環するため、フックを直接参照する。
import { resetChatThreadCache } from '@/features/desk/hooks/use-chat-thread';
import { clearAllReplyDrafts } from '@/features/desk/lib/reply-drafts';
import { extractErrorMessage } from '@/lib/error-utils';
import { Spinner } from '@/components/ui/spinner';
import { AnnouncementUnreadProvider, AnnouncementTagMasterProvider } from '@/features/dashboard';
import { AppHeader } from './app-header';
import { AppSidebar } from './app-sidebar';
import { FavoritesProvider } from '../hooks/favorites-context';
import { TenantInfoProvider, resetTenantInfoCache } from '../hooks/tenant-info-context';
import { useReferenceReachable } from '../hooks/use-reference-reachable';
import { ReferenceReachableProvider } from '../hooks/reference-reachable-context';
import { resolveTabs, SHELL_TABS, type ResolvedTab, type ShellTabKey } from '../lib/nav-config';

/** 強制パスワード変更画面のパス（set-0035・AppShell 外の独立ページ。横断ゲートの誘導先）。 */
const PASSWORD_CHANGE_PATH = '/change-password';

interface AppShellProps {
  /** 現在アクティブなタブ。 */
  activeTab?: ShellTabKey;
  /**
   * 左サイドバーの差し替え。未指定なら共通の Home サイドバー（AppSidebar）。
   * タブごとにスコープの異なるサイドバー（例: Desk のチャネル/メンバー）を出すための slot。
   * `false` を渡すとサイドバーを出さない（埋め込みタブ＝/backlog が Board 自前の画面を iframe 表示する時に使う）。
   */
  sidebar?: ReactNode;
  children: ReactNode;
}

/**
 * 共通アプリシェル（上部タブ + 左サイドバー）。ログイン後の全画面の土台。
 * session / hub menu は SessionProvider が起動時 1 回だけ取得し context で共有するため、
 * タブ切替で AppShell が再マウントされても再取得・スピナーのフラッシュは起きない。
 * 未ログイン（context の user=null）なら /login へ送る。「システム」タブの遷移先は
 * hub menu（reference の OIDC 連携導線）から解決し、未設定なら灰色にする。
 */
export function AppShell({ activeTab = 'home', sidebar, children }: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading, menuItems, setUser } = useSessionContext();

  // 強制MFA未設定者（me が mfaSetupRequired を立てた状態）は、MFA 設定画面以外の全画面をブロックする（set-0032）。
  // 設定画面自身（MFA_SETUP_PATH）は除外して無限 redirect を防ぐ。設定完了で login-settings-screen が
  // context の mfaSetupRequired を落とすとゲートが解け、通常の画面遷移へ戻る。
  const needsMfaSetup = Boolean(user?.mfaSetupRequired) && pathname !== MFA_SETUP_PATH;

  // 強制パスワード変更（me/login が mustChangePassword を立てた状態）は、変更画面以外の全画面をブロックする（set-0035）。
  // MFA 設定強制より優先（より基礎的な資格情報を先に更新させる）。変更画面は AppShell 外の独立ページのため
  // 本シェル配下で pathname がそこになることは無いが、防御的に除外する。設定完了で change-password-screen が
  // context の mustChangePassword を落とすとゲートが解け、通常の画面へ戻る。
  const needsPasswordChange =
    Boolean(user?.mustChangePassword) && pathname !== PASSWORD_CHANGE_PATH;

  // システムタブ（reference）の実起動確認（rete-files-0037 / common-0018）。env 連携が available の時だけ probe し、
  // 到達不能なら下の resolveTabs でタブを灰色（クリック不可）にして空振り ERR_CONNECTION_REFUSED を防ぐ。
  // フックはルール上 early return より前で常に呼ぶ（loading 中は menuItems=[] で enabled=false なので probe しない）。
  const referenceItem = menuItems.find((m) => m.key === 'reference');
  const referenceEnabled = Boolean(referenceItem?.available);
  const referenceReachable = useReferenceReachable(
    referenceEnabled ? (referenceItem?.href ?? null) : null,
    referenceEnabled,
  );

  // タブ一覧は中身が変わらない限り同一参照を返す（cmn-0104）。AppHeader のピル再計測 ResizeObserver は
  // deps=[tabs] で張り直すため、毎レンダー新配列だと無関係な再描画でも observer を作り直してしまう。
  // hooks 規則上、下の early return より前に置く。
  const tabs = useMemo(
    () => resolveTabs(SHELL_TABS, menuItems, activeTab, referenceReachable),
    [menuItems, activeTab, referenceReachable],
  );

  useEffect(() => {
    if (loading) return;
    if (!user) {
      // セッション失効（me の 401 で user=null）は handleLogout を通らないため、機微データを持つ
      // スレッドキャッシュはここでも破棄する（共有端末で次のログイン利用者へ残さない / dsk-0393）。
      resetChatThreadCache();
      // 書きかけの返信本文（d737）も同じ理由で破棄する（次ログインの利用者へ渡さない）。
      clearAllReplyDrafts();
      router.replace('/login');
      return;
    }
    // パスワード強制変更を MFA 設定強制より先に誘導する（資格情報の更新を優先）。
    if (needsPasswordChange) {
      router.replace(PASSWORD_CHANGE_PATH);
      return;
    }
    if (needsMfaSetup) router.replace(MFA_SETUP_PATH);
  }, [loading, user, needsPasswordChange, needsMfaSetup, router]);

  // needsMfaSetup / needsPasswordChange を条件に含めるのは意図的（set-0032 / set-0035）。上の useEffect が
  // 誘導先へ replace する“間”、保護画面の children を 1 フレームも描画させずスピナーで覆う（content flash 防止）。
  // 各誘導先（MFA 設定画面 / 独立の変更画面）では当該フラグが false なのでここは通らず、ちらつきは発生しない。
  if (loading || !user || needsPasswordChange || needsMfaSetup) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const handleSelectTab = (tab: ResolvedTab) => {
    if (!tab.href || tab.active) return;
    requestNavigation(() => {
      if (tab.external) {
        window.location.href = tab.href!;
      } else {
        router.push(tab.href!);
      }
    });
  };

  const handleLogout = async () => {
    try {
      await logout();
      // context の user を即クリア。これをしないと遷移までの数フレームや「戻る」操作で
      // stale な user が残り、保護ページが一瞬描画されうる（認証境界の後退防止）。
      setUser(null);
      // 列幅ストアはモジュールレベルの Map で保持されるため、client-side nav で完結するログアウト経路では
      // 次にログインしたユーザーへ旧ユーザーの列幅が漏れる。明示的にリセットする（code review HIGH）。
      resetColumnWidthsStore();
      // テナントバッジのモジュールレベルキャッシュも同様に、次ログインのユーザーへ
      // 前テナント名が漏れないようリセットする（mdl-0038）。
      resetTenantInfoCache();
      // Desk のスレッド短時間キャッシュ（dsk-0393）も同様にモジュールレベル保持のため破棄する。
      resetChatThreadCache();
      // 書きかけの返信本文（d737）も同じ理由で破棄する（次ログインの利用者へ渡さない）。
      clearAllReplyDrafts();
      router.replace('/login');
    } catch (err) {
      toast.error(extractErrorMessage(err, 'ログアウトに失敗しました'));
    }
  };

  return (
    // 認証済みシェル配下でのみ FavoritesProvider / AnnouncementUnreadProvider を mount し、
    // お気に入り state（サイドバー + 各タブの★トグル）と通知未読数（サイドバーバッジ + 掲示板）を
    // それぞれ 1 つの取得結果に共有する。
    <ReferenceReachableProvider value={referenceReachable}>
      <FavoritesProvider>
        <AnnouncementUnreadProvider>
          <AnnouncementTagMasterProvider>
            {/* set-0105: テナントバッジ state。AppShell 認証ゲート内側＝未ログイン時 401 を構造的に避ける */}
            <TenantInfoProvider>
              <div className="app-shell">
                {sidebar ?? <AppSidebar />}
                <div className="app-main">
                  <AppHeader
                    tabs={tabs}
                    userName={user.name}
                    onSelectTab={handleSelectTab}
                    onLogout={() => requestNavigation(() => void handleLogout())}
                  />
                  {children}
                </div>
              </div>
            </TenantInfoProvider>
          </AnnouncementTagMasterProvider>
        </AnnouncementUnreadProvider>
      </FavoritesProvider>
    </ReferenceReachableProvider>
  );
}
