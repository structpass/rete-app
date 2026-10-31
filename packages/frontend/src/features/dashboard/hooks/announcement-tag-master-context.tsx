'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useAnnouncementTagMaster } from './use-announcement-tag-master';
import type { UseTagMasterResult } from '@/hooks/use-tag-master';

/**
 * お知らせタグマスタの board/faq 2 インスタンスを共有する Context（hom-0074・design-reviewer CRITICAL 反映）。
 *
 * タグ管理オーバーレイ（AnnouncementTagMasterOverlay）と HubView（DashboardView へ渡す tagMaster）が
 * それぞれ独自に useAnnouncementTagMaster(kind) を呼ぶと別インスタンスになり、「タグ管理での変更が
 * 即座にフィルタ・付与フォームへ反映される」という不変条件（tag-master-overlay.tsx:17 のコメント参照）が
 * 壊れる。生成元を本 Context 1 箇所に統一し、両者が同じインスタンスを参照するようにする。
 * announcement-unread-context.tsx と同型パターン（AppShell 配下で mount）。
 *
 * archiveOnly（hom-0084 で includeArchived として導入・hom-0080 で「アーカイブ済のみ表示」の意味へ
 * 変更）は board/faq 共通の 1 フラグ。ON の間は fetch 自体もアーカイブ込みで取得し（backend 無改修・
 * useAnnouncementTagMaster の includeArchived 引数へそのまま渡す）、タグ管理オーバーレイ側
 * （tag-master-overlay.tsx）が「アーカイブ済のみ」を絞り込んで表示する。OFF に戻ると再度アーカイブ除外の
 * fetch に戻り、TagFilterDropdown / タグ付与ピッカー等 board/faq を直接参照する他の画面にアーカイブ済み
 * タグが漏れ出さない（AnnouncementTagMasterOverlay 側が閉じる時に false へ戻す・hom-0080）。
 * どちらのタブを見ていても同じ状態を保つ（タブを切り替えても直前の切替状態が引き継がれる）ため、
 * board/faq 別々ではなく Provider が単一の state として持つ。
 */
interface AnnouncementTagMasterContextValue {
  calendar: UseTagMasterResult;
  board: UseTagMasterResult;
  faq: UseTagMasterResult;
  archiveOnly: boolean;
  setArchiveOnly: (value: boolean) => void;
}

const AnnouncementTagMasterContext = createContext<AnnouncementTagMasterContextValue | null>(null);

export function AnnouncementTagMasterProvider({ children }: { children: ReactNode }) {
  const [archiveOnly, setArchiveOnly] = useState(false);
  const board = useAnnouncementTagMaster('board', archiveOnly);
  const faq = useAnnouncementTagMaster('faq', archiveOnly);
  const calendar = useAnnouncementTagMaster('calendar', archiveOnly);

  return (
    <AnnouncementTagMasterContext.Provider
      value={{ board, faq, calendar, archiveOnly, setArchiveOnly }}
    >
      {children}
    </AnnouncementTagMasterContext.Provider>
  );
}

/** board/faq 共有インスタンスを取得する。Provider の外で呼ぶと throw する（mount 漏れの早期検出）。 */
export function useAnnouncementTagMasterContext(): AnnouncementTagMasterContextValue {
  const ctx = useContext(AnnouncementTagMasterContext);
  if (ctx === null) {
    throw new Error(
      'useAnnouncementTagMasterContext は AnnouncementTagMasterProvider の内側で使用してください',
    );
  }
  return ctx;
}
