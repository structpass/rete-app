'use client';

import { Plus, Settings } from 'lucide-react';
import { ActionButton, ListActionRow } from '@/components/shared/list-actions';

interface DeskTaskToolbarProps {
  /** 新規登録ボタン押下時のハンドラ（タスク新規登録モードを開く / C-新規）。 */
  onCreate: () => void;
  /** 分類設定ボタン押下時のハンドラ（分類マスタ設定モーダルを開く / rete-desk-0140）。 */
  onOpenCategorySettings: () => void;
}

/**
 * タスク明細の右上アクション行（分類設定・新規登録）。
 *
 * d1273: 行とボタンは一覧共通部品（components/shared/list-actions.tsx）へ寄せた。
 * フィルタエリアの直下・表の直上に右寄せで置き、表ヘッダ罫線まで 4px（cmn-0145）。
 * 独立定義だった `.desk-task-tree-toolbar` / `.desk-task-new-btn`（高さ 1.75rem・文字 0.75rem・
 * weight 600）は廃止し、Desk・File・Home の表右上ボタンを同じ寸法（2rem / 0.8125rem / 500）に
 * 揃えた。ボタンの有無で行の高さが変わらないのは共通クラス（min-height）が担保する。
 */
export function DeskTaskToolbar({ onCreate, onOpenCategorySettings }: DeskTaskToolbarProps) {
  return (
    <ListActionRow>
      <ActionButton
        icon={<Settings className="h-3.5 w-3.5" aria-hidden="true" />}
        ariaLabel="分類設定"
        onClick={onOpenCategorySettings}
      >
        分類設定
      </ActionButton>
      <ActionButton
        icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
        ariaLabel="新規登録"
        onClick={onCreate}
      >
        新規登録
      </ActionButton>
    </ListActionRow>
  );
}
