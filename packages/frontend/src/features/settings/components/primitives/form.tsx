import type { CSSProperties, ReactNode } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { useOverlayClose } from '@/components/ui/overlay-dialog';

/**
 * 設定タブのフォーム系画面（ログイン設定 / テナント設定）で共有するカード/アクション/ボタン。
 * モック settings/ の .sp-card.sp-form-card / .sp-form-actions / .sp-action-btn(-primary) を React 化。
 * architecture-invariants §3（2 モジュール目の法則）に従い、2 画面で逐語重複していた定義をここへ集約した。
 * FormButton は状態取得失敗の復帰導線（再試行 / 再読み込み）でも使う＝設定タブ以外では
 * files-shell の folderError が variant="secondary" で利用する（v2-225。ツールバー帯の部品は流用しない）。
 */

/** フォーム行のラベル共通スタイル。members/invites/permissions で逐語重複していたものを集約（§3）。 */
const FIELD_LABEL_STYLE: CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: 'var(--sp-text-warm-mute)',
  /* compact フォームのラベル↔入力間隔 4px（mdl-0025・var 参照。旧 0.375rem） */
  marginBottom: 'var(--sp-form-label-gap-compact)',
};

/**
 * フォーム入力のラベル。htmlFor 指定時は `<label>`（入力に紐付く）、無指定時は `<span>`（グループ見出し）を描画。
 * 旧 fieldLabel / labelStyle の逐語複製（3 画面）をここへ集約。
 *
 * required: サーバが空を拒否する項目に「* 必須」を出す（正本 comp-form-field の必須バッジと同字面・同色）。
 * マークは label 要素の外（隣）に置く＝アクセシブル名を変えない。見た目だけのマークなので aria-hidden にし、
 * 必須の意味は入力側の aria-required が担う。
 */
export function FormLabel({
  htmlFor,
  children,
  style,
  required,
}: {
  htmlFor?: string;
  children: ReactNode;
  style?: CSSProperties;
  required?: boolean;
}) {
  const merged = style ? { ...FIELD_LABEL_STYLE, ...style } : FIELD_LABEL_STYLE;
  const mark = required ? (
    <span aria-hidden="true" className="sp-required-mark">
      <span className="sp-required-star">*</span> 必須
    </span>
  ) : null;
  const label = htmlFor ? (
    <label htmlFor={htmlFor} style={merged}>
      {children}
    </label>
  ) : (
    <span style={merged}>{children}</span>
  );
  // マークは label の外（隣）に置くが、行としてはラベルと同じ行に並べる（flex 行に内包）。
  return mark ? (
    <span style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
      {label}
      {mark}
    </span>
  ) : (
    label
  );
}

/** セクションカード共通シェル（アイコン + タイトル・任意の説明/バッジ・上線仕切り本体）。 */
export function FormCard({
  icon,
  title,
  description,
  badge,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sp-card" style={{ padding: '1rem 1.125rem', marginBottom: '0.75rem' }}>
      <h3
        className="text-sm font-semibold text-[var(--sp-text-warm)]"
        style={{ margin: '0 0 0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
      >
        {icon}
        {title}
        {badge}
      </h3>
      {description && (
        <p className="text-xs text-[var(--sp-text-warm-mute)]" style={{ margin: '0 0 0.875rem' }}>
          {description}
        </p>
      )}
      <div style={{ paddingTop: '0.625rem', borderTop: '1px solid var(--sp-line-warm-2)' }}>
        {children}
      </div>
    </section>
  );
}

/**
 * フォーム下部のアクションフッター（上線 + ボタン群）。
 * align: 'center'（既定・中央寄せ）| 'end'（右寄せ）。
 * set-0108: 既定を中央寄せへ統一（set-0095 の開発統括指示型を全画面昇格）。
 */
export function FormActions({
  children,
  align = 'center',
}: {
  children: ReactNode;
  align?: 'end' | 'center';
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: align === 'center' ? 'center' : 'flex-end',
        gap: '0.5rem',
        paddingTop: '0.875rem',
        marginTop: '0.875rem',
        borderTop: '1px solid var(--sp-line-warm-2)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * OverlayDialog 内フォームのキャンセルボタン（mdl-0034 Esc 規約②）。
 * onClose を直接呼ばず useOverlayClose 経由で閉じ、dirty 時は破棄確認を挟む。
 * 設定タブの各ダイアログ（組織管理 / 所属管理 / 招待）で共有する（§3）。
 */
export function OverlayCancelButton({
  disabled = false,
  children = 'キャンセル',
}: {
  disabled?: boolean;
  children?: ReactNode;
}) {
  const requestClose = useOverlayClose();
  return (
    <FormButton variant="ghost" onClick={requestClose} disabled={disabled}>
      {children}
    </FormButton>
  );
}

/**
 * 有効/無効トグルスイッチ（モック .sp-toggle 意匠）。
 * set-0109: tenant / members で別実装・別寸法だったトグルをここへ統合（寸法は tenant 版基準）。
 */
export function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      style={{
        // button 既定の枠線・余白・背景描画を打ち消し、span 実装と 1px も変えない（set-0117 項目3）。
        appearance: 'none',
        border: 0,
        padding: 0,
        margin: 0,
        position: 'relative',
        display: 'inline-block',
        width: '2.25rem',
        height: '1.25rem',
        background: checked ? 'var(--sp-accent-teal)' : 'var(--sp-paper-2)',
        borderRadius: '9999px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : undefined,
        transition: 'background-color 0.15s',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 'calc(100% - 1rem - 2px)' : 2,
          width: '1rem',
          height: '1rem',
          background: 'white',
          borderRadius: '50%',
          transition: 'left 0.15s',
          boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
        }}
      />
    </button>
  );
}

/**
 * FormButton variant → CSS クラス対応（set-0144: hover/focus/disabled は globals.css .sp-form-btn 系が正本）。
 * ghost も .sp-form-btn 系（sp-form-btn-ghost）へ寄せ、同一コンポーネント内で系統を割らない（v2-224 / ADR 0081）。
 */
const FORM_BTN_CLASS: Record<'primary' | 'secondary' | 'ghost' | 'destructive', string> = {
  primary: 'sp-form-btn sp-form-btn-primary',
  secondary: 'sp-form-btn sp-form-btn-secondary',
  ghost: 'sp-form-btn sp-form-btn-ghost',
  destructive: 'sp-form-btn sp-form-btn-danger',
};

/**
 * フォーム用ボタン。
 * - primary: accent-teal 塗りつぶし（保存/更新）
 * - secondary: ボーダー透明地（補助操作）
 * - ghost: 透明地＋中立文字（軽量操作・キャンセル等。v2-224 で .sp-action-btn 直書きから .sp-form-btn 系へ統一）
 * - destructive: accent-red 塗りつぶし（削除等の破壊的操作・規約「destructive=赤(不変)」）
 * loading 中はスピナーを前置し押下を抑止する。
 * set-0144: primary/secondary/destructive を CSS クラス（.sp-form-btn 系）化し、
 * inline style + JS ホバー（onMouseEnter/onMouseLeave）を全廃。hover 色・focus-visible ring・
 * disabled 減光は globals.css 側で表現する（キーボード/タッチでも focus 表現が効く）。
 */
export function FormButton({
  variant = 'primary',
  onClick,
  children,
  disabled = false,
  loading = false,
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  onClick?: () => void;
  children: ReactNode;
  /** in-flight 中などに押下を抑止する（既定 false = 従来挙動）。 */
  disabled?: boolean;
  /** 処理中: スピナーを表示し押下を抑止する（既定 false）。 */
  loading?: boolean;
}) {
  const isDisabled = disabled || loading;
  const content = loading ? (
    <>
      <Spinner className="h-3.5 w-3.5" />
      {children}
    </>
  ) : (
    children
  );

  return (
    <button
      type="button"
      className={FORM_BTN_CLASS[variant]}
      onClick={onClick}
      disabled={isDisabled}
    >
      {content}
    </button>
  );
}
