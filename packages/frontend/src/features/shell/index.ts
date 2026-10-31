// 外部（app ルート）が使うのは AppShell のみ。タブ/お気に入り定義・resolveTabs は
// feature 内（app-shell / app-header / spec）から直接 import する（barrel に出さない）。
export { AppShell } from './components/app-shell';
// ★トグル（HM-1-4）は各タブ（files / desk）が現在コンテキストを★化するために横断利用する。
export { FavoriteToggle, type FavoriteTarget } from './components/favorite-toggle';
// 共有お気に入り state（HM-1-4）。一覧の行★・サイドバー・管理オーバーレイが同一 state を共有する。
// useOptionalFavoritesContext は Provider 外を null で返す版（一覧の行★が単体描画でも壊れないため・v2-505）。
export { useFavoritesContext, useOptionalFavoritesContext } from './hooks/favorites-context';
