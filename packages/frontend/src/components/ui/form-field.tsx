'use client';

import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

interface FormFieldProps {
  label?: React.ReactNode;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  /** mdl-0025: compact 密度画面（設定・ファイル・Desk 等）ではラベル間隔 4px・ラベル 0.75rem/600 を適用する。
      標準密度（ログイン等の単独フォーム）はデフォルトのまま。密度は2値のみ（画面ごとの中間値禁止）。 */
  compact?: boolean;
  children: React.ReactNode;
}

export function FormField({
  label,
  error,
  required,
  htmlFor,
  className,
  compact,
  children,
}: FormFieldProps) {
  return (
    <div
      className={cn(
        'w-full',
        compact
          ? 'space-y-[var(--sp-form-label-gap-compact)]'
          : 'space-y-[var(--sp-form-label-gap)]',
        className,
      )}
    >
      {label && (
        // 必須マークはラベル要素の外に並べる（label の中に入れると読み上げ名が「ラベル * 必須」になり、
        // 正本 comp-form-field の「アクセシブル名を変えない」に反する）。マーク自体は装飾なので aria-hidden。
        <span className="flex flex-wrap items-baseline gap-2">
          <Label htmlFor={htmlFor} className={compact ? 'text-xs font-semibold' : undefined}>
            {label}
          </Label>
          {required && (
            <span className="text-xs text-[var(--sp-accent-red)]" aria-hidden="true">
              <span className="align-middle text-base">*</span> 必須
            </span>
          )}
        </span>
      )}
      {children}
      {error && <p className="text-sm text-[var(--sp-accent-red)]">{error}</p>}
    </div>
  );
}
