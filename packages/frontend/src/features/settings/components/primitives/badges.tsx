import type { CSSProperties, ReactNode } from 'react';
import type { SettingTone } from '../../lib/types';
import { highlightMatches } from '@/lib/highlight';

/**
 * トーン → 配色マップ。モック settings/ は `--accent-teal/blue/orange`（未定義 var）を使うが、
 * rete では sp 名前空間の tone トークン（--sp-tone-teal/blue/orange・globals.css）へ対応づける。
 * teal は Desk の --sp-accent-teal ファミリに揃え済（rete-settings-0009）。
 */
const TONE: Record<SettingTone, { bg: string; fg: string }> = {
  ink: { bg: 'var(--sp-accent-soft)', fg: 'var(--sp-accent-ink)' },
  teal: { bg: 'hsl(var(--sp-tone-teal) / 0.15)', fg: 'hsl(var(--sp-tone-teal))' },
  blue: { bg: 'hsl(var(--sp-tone-blue) / 0.15)', fg: 'hsl(var(--sp-tone-blue))' },
  orange: { bg: 'hsl(var(--sp-tone-orange) / 0.18)', fg: 'hsl(var(--sp-tone-orange))' },
  muted: { bg: 'hsl(var(--muted))', fg: 'var(--sp-text-warm-2)' },
};

/** 円形のイニシャルアバター。 */
export function Avatar({ initials, tone = 'muted' }: { initials: string; tone?: SettingTone }) {
  const t = TONE[tone];
  return (
    <span
      className="text-[0.6875rem] font-semibold"
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        background: t.bg,
        color: t.fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  );
}

/**
 * ステータス/権限バッジ。strong=true は権限の強調表示（ADMIN 等・小さめ padding + 太字）、
 * 既定は状態バッジ（有効 等）。
 * 形は正本 comp-badge の rounded-full（四角ラベルを作らない）。色は画面の tone トークンを
 * 引き続き使う（comp-badge の variant はタスク状態専用のため、設定タブの分類トーンはここが正）。
 */
export function StatusBadge({
  tone = 'muted',
  children,
  strong = false,
}: {
  tone?: SettingTone;
  children: ReactNode;
  strong?: boolean;
}) {
  const t = TONE[tone];
  return (
    <span
      className="text-[10px] font-semibold"
      style={{
        padding: strong ? '1px 8px' : '2px 10px',
        borderRadius: '9999px',
        background: t.bg,
        color: t.fg,
      }}
    >
      {children}
    </span>
  );
}

/**
 * 無効・停止中を表す名称テキスト（mute 色 + 取り消し線）。
 * set-0115: permissions の直書き line-through と MemberCell locked 表現をここへ共通化。
 */
export function InactiveText({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <span
      className={`text-[var(--sp-text-warm-mute)]${className ? ` ${className}` : ''}`}
      style={{ textDecoration: 'line-through', ...style }}
    >
      {children}
    </span>
  );
}

/**
 * アバター + 氏名のセル（メンバー/操作ログ等で共有）。strong は本人/管理者の強調。
 * locked=true はアカウント無効化を表す（アバター減光・氏名の取り消し線・「ロック」バッジ）。
 */
export function MemberCell({
  initials,
  tone,
  name,
  strong = false,
  locked = false,
  highlight,
}: {
  initials: string;
  tone?: SettingTone;
  name: string;
  strong?: boolean;
  locked?: boolean;
  /** 検索ハイライト対象キーワード（set-0055）。空/未指定はハイライトなし。 */
  highlight?: string;
}) {
  if (locked) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ display: 'inline-flex', opacity: 0.6 }}>
          <Avatar initials={initials} tone="muted" />
        </span>
        <InactiveText>{highlightMatches(name, highlight)}</InactiveText>
        <StatusBadge tone="muted">ロック</StatusBadge>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <Avatar initials={initials} tone={tone} />
      <span className={strong ? 'font-semibold text-[var(--sp-text-warm)]' : undefined}>
        {highlightMatches(name, highlight)}
      </span>
    </div>
  );
}
