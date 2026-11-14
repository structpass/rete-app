'use client';

import type { MouseEvent, ReactNode } from 'react';
import { Spinner } from '@/components/ui/spinner';

/**
 * 一覧の右上に置くアクション行とボタンの共通部品（正本=モデルタブ UI共通
 * 「表右上アクションと表の間隔」「Toolbar」・画面構成「一覧画面」）。
 *
 * 元は設定タブの primitives（set-0151/set-0152）だったが、Desk・File・Home も同じ配置に
 * 揃えるにあたり、feature をまたぐ共通の置き場へ移した（d1273）。設定タブの barrel は
 * そのまま再輸出するので、既存の import 経路は変えない。
 *
 * 配置（3 点セット）:
 * - 行は絞り込み帯の外・表の直上に置き、右端へ寄せる（`margin-left: auto` は CSS 側）。
 * - 行から表ヘッダ罫線までを 4px にする（cmn-0145。値は `.sp-list-action-row` が持つ）。
 * - 行の高さは権限でボタンが消えても確保する（`.sp-list-action-row { min-height }`）。
 *   見る人が違っても表の開始位置が動かない。
 */

/**
 * 一覧に対するアクションを、絞り込み帯の外・表の直上に右寄せで並べる行。
 *
 * 参照実装（struct-pass-reference）の ListPageActions と同じ位置に立つ部品だが、あちらは
 * onExport / onNew を固定 props で受ける別 API なので同名にしない。こちらは children だけを
 * 受け、呼び出し側が ActionButton を直接並べる（新規登録も補助アクションも同じ扱い）。
 *
 * 条件付きで出るアクションは children 側で出し分けてよい。行は常に描画し、ボタンの有無で
 * 高さが変わらない（権限で表の位置がずれない）。
 */
export function ListActionRow({ children }: { children?: ReactNode }) {
  return (
    <div className="sp-list-action-row">
      <div className="sp-list-action-row-actions">{children}</div>
    </div>
  );
}

/**
 * 表右上のアクション 1 個（新規登録・CSV 出力・メンバーを追加 等）。
 *
 * 見た目は `.sp-action-btn`（透明地・hover で accent-soft/ink）が正本で、寸法は v2-224 の
 * 透明系セカンダリ共通グループ（高さ 2rem・文字 0.8125rem・weight 500・角丸 0.375rem）に従う。
 * 画面ごとに高さ・文字サイズ・太さを書き分けない（d1273 で Desk 1.75rem/600・File 1.875rem/
 * 0.75rem・Home の別寸法をこの 1 組へ寄せた）。
 *
 * loading 中はスピナーを前置し押下を抑止する（二重送信防止）。危険操作は danger で赤系。
 * iconOnly は正方形アイコン化（行内アクション用）。
 */
export function ActionButton({
  icon,
  children,
  onClick,
  ariaLabel,
  disabled,
  loading = false,
  danger = false,
  iconOnly = false,
}: {
  icon?: ReactNode;
  children?: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  ariaLabel?: string;
  disabled?: boolean;
  /** 処理中: スピナーを表示し押下を抑止する（既定 false）。 */
  loading?: boolean;
  /** 危険操作（解除等）: is-danger クラスで赤系表示にする（既定 false）。 */
  danger?: boolean;
  /** icon-only 化。CSS modifier は globals.css の .sp-action-btn--icon-only（set-0153）。 */
  iconOnly?: boolean;
}) {
  const isDisabled = disabled || loading;
  const className = [
    'sp-action-btn',
    danger ? 'is-danger' : null,
    iconOnly ? 'sp-action-btn--icon-only' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={isDisabled}
      style={isDisabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : icon}
      {!iconOnly && children}
    </button>
  );
}
