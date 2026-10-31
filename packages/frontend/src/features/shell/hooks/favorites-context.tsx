'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useFavorites, type UseFavoritesResult } from './use-favorites';

/**
 * 横断お気に入り（HM-1）の共有 state。サイドバー（AppSidebar）/ 管理オーバーレイ / 各タブの★トグル
 * （HM-1-4）が同一の取得結果・add/remove/reorder を参照し、★追加でサイドバーも即時更新される。
 *
 * useFavorites を Provider 内で 1 回だけ呼び、取得・楽観並び替えロジックを再利用する（重複 fetch を作らない）。
 * 認証済みシェル（AppShell）配下にのみ mount され、未ログイン時は描画されない＝無駄な 401 fetch を避ける。
 */
const FavoritesContext = createContext<UseFavoritesResult | null>(null);

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const value = useFavorites();
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

/** 共有お気に入り state を取得する。FavoritesProvider の外で呼ぶと throw する（mount 漏れの早期検出）。 */
export function useFavoritesContext(): UseFavoritesResult {
  const ctx = useContext(FavoritesContext);
  if (ctx === null) {
    throw new Error('useFavoritesContext は FavoritesProvider の内側で使用してください');
  }
  return ctx;
}

/**
 * 共有お気に入り state を、Provider の外では null で返す（throw しない）版（v2-505）。
 * 一覧の行★のように「Provider 配下では出したいが、単体で描画しても壊れてはいけない」
 * 部品が使う。mount 漏れを早期に検出したい画面は従来どおり useFavoritesContext を使う。
 */
export function useOptionalFavoritesContext(): UseFavoritesResult | null {
  return useContext(FavoritesContext);
}
