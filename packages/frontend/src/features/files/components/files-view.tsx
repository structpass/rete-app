'use client';

import { useEffect, useRef } from 'react';
import { DEFAULT_CHANNEL_ID } from '@rete/shared';
import { AppShell } from '@/features/shell';
import { DeskSpaceProvider, useDeskSpace } from '@/features/desk/hooks/desk-space-context';
import { useFileBrowser } from '../hooks/use-file-browser';
import { useFileOverlays } from '../hooks/use-file-overlays';
import { useFileEditLink } from '../hooks/use-file-edit-link';
import { useFileIdFromLocation } from '../hooks/use-file-id-from-location';
import { FilesShell } from './files-shell';
import { FilesSidebar } from './files-sidebar';

/**
 * File タブのトップレベル合成（fil-0137/fil-0138・ADR 0063）。
 *
 * 器スコープ（selectedSpaceId）を Desk と共有するため、全体を DeskSpaceProvider 配下に置く
 * （localStorage キー 'desk-selected-space-v1' を共有＝Desk で開いていた channel を File 側でも引き継ぎ、
 * File 側の切替も Desk へ追従する双方向同期。保存値が非可視/削除済みの場合は既定チャネルへ
 * フォールバックする＝FilesViewBody 内の 404 effect・fil-0138）。
 * ナビ/リポジトリ状態（browser）とオーバーレイ状態（overlays）をここで生成し、サイドバー
 * （Desk 共有の 組織＞プロジェクト＞チャネル ツリー）と本体シェル（ツリー / 一覧 / オーバーレイ）の
 * 両方へ配る。AppShell の sidebar slot に File 専用サイドバーを差し込み、Desk と同じシェル構成に揃える。
 *
 * Home のお気に入り（HM-1-4）から `/files?folderId=<id>` で精密ジャンプされた場合、その folderId を
 * 初回選択フォルダとして browser へ渡す（ツリーに無ければ先頭フォールバック）。お気に入りファイル★は
 * `/files?fileId=<id>`（FF）で来るため、useFileEditLink がメタ解決→所属フォルダ遷移→編集オーバーレイ起動する。
 * ?folderId / ?fileId の読み取りは server 側で searchParams を await して prop で渡す（fil-0077）。
 * 旧実装の useSearchParams + Suspense（fallback 無し）は AppShell を内包する境界となり、他タブ→files 遷移時に
 * シェルごと白化するため廃止（dsk-0372 と同型・同根の anti-pattern）。
 */
export function FilesView({
  initialSpaceId = null,
  initialFolderId,
  initialFileId,
}: {
  initialSpaceId?: string | null;
  initialFolderId: string | null;
  initialFileId: string | null;
}) {
  return (
    <DeskSpaceProvider initialSpaceId={initialSpaceId}>
      <FilesViewBody initialFolderId={initialFolderId} initialFileId={initialFileId} />
    </DeskSpaceProvider>
  );
}

function FilesViewBody({
  initialFolderId,
  initialFileId,
}: {
  initialFolderId: string | null;
  initialFileId: string | null;
}) {
  const { selectedSpaceId, setSelectedSpaceId, hydrated } = useDeskSpace();
  // localStorage 復元（hydrated）が確定するまで fetch を始めない（DeskShellGate と同型・
  // 「既定チャネル → 最後に開いていた器」の二重 fetch とフラッシュを防ぐ）。未選択（Desk 未訪問）は
  // 既定チャネルへ倒す。
  const spaceId = hydrated ? (selectedSpaceId ?? DEFAULT_CHANNEL_ID) : null;
  const browser = useFileBrowser(spaceId, initialFolderId);
  const overlays = useFileOverlays();

  // 保存されていた器が非可視/削除済み（tree 404）なら選択を解除して既定チャネルで開き直す（fil-0138・
  // criteria 2「エラーにしない」）。選択解除は Desk 側も全件（安全な中断点）へ戻す＝無効値を localStorage に
  // 残さない。404 以外（ネットワーク断・5xx）は一過性なので選択を保ったままエラー表示に委ねる。
  // 既定チャネル自体の 404（メンバー外）で無限に開き直さないよう 1 マウント 1 回に制限する。
  const fellBackRef = useRef(false);
  const { treeError, treeErrorStatus } = browser;
  useEffect(() => {
    if (fellBackRef.current) return;
    if (!treeError || treeErrorStatus !== 404) return;
    if (!selectedSpaceId) return; // 既に既定チャネル（未選択）で 404 → フォールバック先が無い
    fellBackRef.current = true;
    setSelectedSpaceId(null);
  }, [treeError, treeErrorStatus, selectedSpaceId, setSelectedSpaceId]);
  // お気に入りファイル★（/files?fileId=）→ メタ解決 → 所属フォルダ遷移 → 編集オーバーレイ起動（FF）。
  //
  // v2-505: server から渡る initialFileId だけでは足りない。Home の★は router.push で
  // この画面へ来るため、既に /files を開いている状態では server component が再実行されず
  // prop が古いままになる。クライアント側の URL も見て、どちらかで fileId が立ったら解決する。
  // ready には「器が確定したか」を渡す（遷移直後に開くと直後の再構築で消えるため・実測）。
  //
  // d560: 優先順位は URL（クライアント）が先。initialFileId は「開いた時点の URL」で、その後
  // 別のお気に入りへ移っても古い値が残るため、URL が fileId を持たない時だけ使う
  // （initialFileId ?? clientFileId の順にすると、別の★を押しても古いファイルが開いてしまう）。
  const clientFileId = useFileIdFromLocation();
  useFileEditLink(
    clientFileId ?? initialFileId,
    browser.selectFolder,
    overlays.openEdit,
    spaceId !== null,
  );

  return (
    <AppShell
      activeTab="files"
      sidebar={
        <FilesSidebar
          onOpenSettings={overlays.openSettings}
          onOpenTagMaster={overlays.openTagMaster}
        />
      }
    >
      <FilesShell browser={browser} overlays={overlays} />
    </AppShell>
  );
}
