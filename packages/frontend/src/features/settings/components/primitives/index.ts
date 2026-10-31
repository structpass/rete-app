// 設定タブ 6 画面で共有するプリミティブ群（architecture-invariants §6: 同型ページの共有化）。
// ページ見出しは全画面共通の PageTitle（mdl-0028）。設定タブ内の import 慣習に合わせ barrel から再輸出する。
// 例外: FormButton は状態取得失敗の復帰導線（再試行 / 再読み込み）でも使うため、files-shell も barrel から取る（v2-225）。
export { PageTitle } from '@/components/shared/page-title';
export { PageTabs } from './page-tabs';
// ActionGroup は set-0150 で filter-bar.tsx の内部関数へ降格（アクションは ListActionRow 経由のみ）。
export { ActionButton, ListActionRow } from './filter-bar';
export { TableCard, RowEditButton, RowDeleteButton, Pagination } from './table';
export { Avatar, StatusBadge, MemberCell, InactiveText } from './badges';
export {
  FormCard,
  FormActions,
  FormButton,
  FormLabel,
  OverlayCancelButton,
  ToggleSwitch,
} from './form';
