'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border border-transparent bg-primary text-primary-foreground',
        // タスクステータス配色（status 色 SSOT = globals.css の --sp-status-* トークン。
        // desk の .desk-task-status と同一トークンを参照し画面間で同色に保つ）。
        todo: 'bg-[var(--sp-status-todo-bg)] text-[var(--sp-status-todo-fg)]',
        progress: 'bg-[var(--sp-status-progress-bg)] text-[var(--sp-status-progress-fg)]',
        review: 'bg-[var(--sp-status-review-bg)] text-[var(--sp-status-review-fg)]',
        done: 'bg-[var(--sp-status-done-bg)] text-[var(--sp-status-done-fg)]',
        outline: 'border border-input text-foreground',
        // 注意喚起の一時状態（Desk の「未保存」等）。色は globals.css の --warning トークンのみ。
        warning: 'bg-[hsl(var(--warning))] text-[hsl(var(--warning-foreground))]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
