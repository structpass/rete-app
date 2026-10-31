import { FilesView } from '@/features/files';

// ファイルタブ（ロケーション別ツリー + ファイル一覧の 2 ペイン / ① 見た目シェル）。
// サイドバー + 本体シェルの合成は FilesView に閉じ込める（共有状態のため）。
// ?folderId= / ?fileId= 取り込みは server 側で searchParams を await して FilesView（client）に prop で渡す
// （fil-0077）。旧実装は useSearchParams をクライアントで呼ぶ都合で <Suspense fallback={null}> に包んでおり、
// fallback 無し＋ AppShell を内包する構造が他タブ→files 遷移のシェルごと白化の原因になっていた
//（dsk-0372 と同型・同根の anti-pattern）。searchParams を server へ移すことで境界自体を消す。
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ folderId?: string; fileId?: string; spaceId?: string }>;
}) {
  const params = await searchParams;
  return (
    <FilesView
      key={JSON.stringify([params.spaceId, params.folderId, params.fileId])}
      initialSpaceId={params.spaceId ?? null}
      initialFolderId={params.folderId ?? null}
      initialFileId={params.fileId ?? null}
    />
  );
}
