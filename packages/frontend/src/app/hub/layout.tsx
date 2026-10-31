'use client';

import { useState, type ReactNode } from 'react';
import {
  HomePermissionsProvider,
  useHomePermissions,
} from '@/features/dashboard/hooks/home-permissions-context';
import { AppShell } from '@/features/shell';
import { AppSidebar } from '@/features/shell/components/app-sidebar';
import { AnnouncementTagMasterOverlay } from '@/features/dashboard/components/announcement-tag-master-overlay';

/**
 * home(hub) タブ共通レイアウト（hom-0077）。`/hub`（掲示板）と `/hub/faq` が本レイアウトを共有することで、
 * AppShell（サイドバー・お気に入り取得等の Provider 群）がタブ切替のたびに再mountされず、
 * 切替時のチラつきを防ぐ。settings/layout.tsx と同型。
 *
 * 旧 hub-view.tsx が持っていた AppShell 組み立て（sidebar prop・showTagMaster state・
 * AnnouncementTagMasterOverlay）をここへ移植。各 page.tsx は DashboardView(kind違い)のみを返す。
 */
export default function HubLayout({ children }: { children: ReactNode }) {
  return (
    <HomePermissionsProvider>
      <HomeLayoutContent>{children}</HomeLayoutContent>
    </HomePermissionsProvider>
  );
}
function HomeLayoutContent({ children }: { children: ReactNode }) {
  const [showTagMaster, setShowTagMaster] = useState(false);
  const { tagManage } = useHomePermissions();

  return (
    <AppShell
      activeTab="home"
      sidebar={
        <AppSidebar onOpenTagMaster={tagManage ? () => setShowTagMaster(true) : undefined} />
      }
    >
      {children}
      {showTagMaster && tagManage && (
        <AnnouncementTagMasterOverlay onClose={() => setShowTagMaster(false)} />
      )}
    </AppShell>
  );
}
