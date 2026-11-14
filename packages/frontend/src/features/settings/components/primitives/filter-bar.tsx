/**
 * 設定タブの barrel。ActionButton / ListActionRow の実体は
 * `components/shared/list-actions.tsx` に移した（d1273）。
 *
 * 理由: 同じ「絞り込み帯 → 表直上のアクション行 → 表」の 3 点配置を Desk・File・Home でも
 * 使うことになり、settings 配下の primitives を他 feature が import する形を増やさないため。
 * 公開 API は変えない（この barrel が再輸出するので既存の import 経路はそのまま動く）。
 */
export { ActionButton, ListActionRow } from '@/components/shared/list-actions';
