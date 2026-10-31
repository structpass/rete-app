'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { DndContext, DragOverlay, closestCenter } from '@dnd-kit/core';
import toast from 'react-hot-toast';
import { useFileSelection } from '../hooks/use-file-selection';
import { useFileSort } from '../hooks/use-file-sort';
import { useFileDnd } from '../hooks/use-file-dnd';
import { useFileDrop } from '../hooks/use-file-drop';
import { useFileSearch } from '../hooks/use-file-search';
import { useFolderCreate } from '../hooks/use-folder-create';
import { useFilesTreeCollapse } from '../hooks/use-files-tree-collapse';
import { useFileLocalEdit } from '../hooks/use-file-local-edit';
import { useFilesTagMaster } from '../hooks/use-tag-master';
import { useTagSearch } from '../hooks/use-tag-search';
import type { UseFileBrowserResult } from '../hooks/use-file-browser';
import type { UseFileOverlaysResult } from '../hooks/use-file-overlays';
import { extractErrorMessage } from '@/lib/error-utils';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { PageTitle } from '@/components/shared/page-title';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { deleteFile, deleteFolder, downloadFile, uploadFile, createFolder } from '../lib/api';
import { uploadEntries } from '../lib/folder-upload';
import { formatUploadFailures, uploadFailureReason } from '../lib/upload-failure-message';
import { buildFileRows } from '../lib/rows';
import { folderAncestorIds, isDescendant } from '../lib/tree';
import { buildLinks, buildSearchLinks, truncateLinks } from '../lib/path-link';
import type { FileItem } from '../lib/types';
import type { FileRowVM } from './file-list';
import { FileList, FILES_TABLE_ID } from './file-list';
import { useTableColumnWidths } from '@/features/user-table-column-widths';
import { FormButton } from '@/features/settings/components/primitives';
import { FileToolbar } from './file-toolbar';
import { FileTopbar } from './file-topbar';
import { FilesTree } from './files-tree';
import { SendOverlay } from './send-overlay';
import { SettingsOverlay } from './settings-overlay';
import { TagMasterOverlay } from '@/components/tags/tag-master-overlay';
import { TagAssignOverlay } from './tag-assign-overlay';
import { TagSearchResults } from './tag-search-results';
import { SearchResults } from './search-results';
import { FileEditOverlay } from './file-edit-overlay';

/**
 * File タブ本体シェル（実 API 接続）。
 *
 * ナビ/リポジトリ状態（browser）から現在フォルダ内容を受け取り、ツリー / 一覧 / オーバーレイを描画する。
 * 単一 DndContext の移動 D&D は移動 API（FB-2b）へ配線済（ツリー reparent / 一覧行 → フォルダ移動）。選択 / ソート / 検索は
 * 本シェル内のローカル UI state。アップロード（multipart）・ダウンロード（blob 保存）・共有（チャット/
 * タスク生成・Phase FL で実生成に配線済）・新規フォルダ（ツリー上のインライン作成）・クリップボードコピー
 * （Clipboard API で実コピー）はいずれも実挙動。
 */
export function FilesShell({
  browser,
  overlays,
}: {
  browser: UseFileBrowserResult;
  overlays: UseFileOverlaysResult;
}) {
  const {
    currentFolder,
    currentFolderId,
    currentTree,
    treeLoading,
    treeError,
    folderLoading,
    folderError,
    dndDisabled,
    selectFolder,
    refreshFolder,
    moveFolderTo,
    moveFileTo,
    reloadAll,
  } = browser;
  const selection = useFileSelection(currentFolderId ?? '');
  // インライン新規フォルダ作成（作成成功で reloadAll → ツリー/一覧を再取得）。
  // ルート直下作成は帰属器の指定が必須のため現在の器（browser.spaceId）を渡す（ADR 0063・fil-0137）。
  const folderCreate = useFolderCreate(reloadAll, browser.spaceId);
  // タグマスタ（一覧 + CRUD）。フィルタバー / マスタ管理 / 付与の 3 箇所で単一インスタンスを共有（rete-files-0006）。
  // rete-home-0043: useTagMaster を汎用化し、Files API を明示的に渡す（AnnouncementTag との共有化）。
  // fil-0094: タグ管理オーバーレイの「アーカイブ済のみ表示」フラグ（HOME の archiveOnly と同型）。
  // ON の間だけ fetch がアーカイブ込みになる。閉じる時に必ず false へ戻し、タグ絞り込みドロップダウン /
  // タグ付与ピッカーへアーカイブ済みタグが漏れ出さないようにする（hom-0080 と同じ後始末）。
  const [tagArchiveOnly, setTagArchiveOnly] = useState(false);
  const tagMaster = useFilesTagMaster(tagArchiveOnly);
  // タグ絞り込み集合（空＝絞らない・OR 条件）。非空の間は右ペインを全ツリー横断のヒット一覧へ差し替える（rete-files-0032）。
  // cmn-0044/§6: タグ filter の Set state は dashboard-view.tsx と同型（現 2 箇所）。3 箇所目が出たら
  // useTagFilter()（toggle/clear/has を内包する custom hook）へ抽出する。現状 2 箇所のため未抽出。
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  // タグ横断検索（rete-files-0032）。tagFilter が非空の間だけ /files/tags/search を叩き、結果を右ペインに出す。
  const tagSearch = useTagSearch(tagFilter);
  const { sortKey, sortDir, toggleSort, resetSort } = useFileSort();
  // 列幅リセット（fil-0054）。file-list と同じ module store を共有するため、ここで掴んで reset を呼ぶ。
  const { resetWidths } = useTableColumnWidths(FILES_TABLE_ID);
  // ファイルツリーの折り畳み状態（fil-0072/fil-0073）。accountId キーで localStorage 永続化。
  const treeCollapse = useFilesTreeCollapse();
  // リセット = ソート順 + 列幅（永続値含む）を既定へ戻す。確認なし即実行（開発統括指示・可逆）。
  const handleResetTable = useCallback(() => {
    resetSort();
    resetWidths();
  }, [resetSort, resetWidths]);
  const [search, setSearch] = useState('');
  // 横断検索（rete-files-0004）。同じ search 文字列を debounce して /files/search を叩き、ツリー先頭に結果フォルダを出す。
  const fileSearch = useFileSearch(search);
  const [uploading, setUploading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ローカル編集の自動同期セッション（fil-0075）。ファイル行ダブルクリックで開始し、
  // ローカル保存を検知して新版を自動アップロードする。新版が積まれたら現在フォルダを再取得。
  const localEdit = useFileLocalEdit({ onUploaded: refreshFolder });
  const handleEditFile = useCallback(
    async (item: FileItem) => {
      if (!item.id) return;
      const target = { id: item.id, name: item.name, versionNo: item.versionNo ?? null };
      if (!localEdit.supported) {
        // File System Access API 非対応（非 Chromium）: 従来の手動 DL→再アップ overlay へ fallback。
        overlays.openEdit(target);
        return;
      }
      const result = await localEdit.begin(target);
      if (result === 'started') {
        overlays.openEdit(target);
      } else if (result === 'unsupported' || result === 'error') {
        // 書き出し失敗等でも手動往復で編集は続けられるようにする（キャンセルは何もしない）。
        overlays.openEdit(target);
      }
    },
    [localEdit, overlays],
  );
  // ===== 監視停止クローズ直後の版数列フラッシュ（fil-0082） =====
  // 「ファイルを編集中」オーバーレイを「監視を停止して閉じる」で閉じた直後、その版が
  // 上昇したことが一覧の地味な数字だけだと気付きにくいため、対象ファイルの版数列を
  // 10 秒間だけ赤字＋太字で強調して時間差で自然に消す演出を加える。
  // fil-0082 再々差し戻し後の実機再現（本番同型: real tick()→uploadFileVersion→
  // refreshFolder を通す stub）で t=0.3/5/9.5s は赤字太字維持・t=11s で通常表示へ
  // 復帰することを確認済み（2026-07-17）。versionFlash / refreshFolder は独立した
  // state で相互に干渉しない。過去の「1秒で消える」報告はこのコード起因では再現しない。
  const [versionFlash, setVersionFlash] = useState<{ id: string } | null>(null);
  const versionFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 編集オーバーレイを閉じたら監視も止める（deep link の手動編集時は stop() は no-op）。
  const handleEditClose = useCallback(() => {
    // オーバーレイが閉じる前＝editTarget がまだ生きている瞬間にファイル id を捕捉する。
    // 手動 DL→再アップ fallback（localEdit は idle）でも editTarget 側が真実で動作する。
    const flashId = overlays.editTarget?.id ?? localEdit.target?.id;
    if (flashId) {
      // 既に走っているタイマーを破棄してから新しい 10 秒タイマーを開始する
      // （連続フラッシュでも後勝ち・前のタイマーが残って setVersionFlash(null) を
      // 早めてしまう事故を防ぐ）。
      if (versionFlashTimerRef.current !== null) {
        clearTimeout(versionFlashTimerRef.current);
      }
      setVersionFlash({ id: flashId });
      versionFlashTimerRef.current = setTimeout(() => {
        setVersionFlash(null);
        versionFlashTimerRef.current = null;
      }, 10000);
    }
    localEdit.stop();
    overlays.close();
  }, [localEdit, overlays]);
  // ページ離脱・タブ切替時にタイマーが残らないよう、アンマウントで必ず破棄する。
  useEffect(
    () => () => {
      if (versionFlashTimerRef.current !== null) {
        clearTimeout(versionFlashTimerRef.current);
        versionFlashTimerRef.current = null;
      }
    },
    [],
  );

  const items = useMemo(() => currentFolder?.items ?? [], [currentFolder]);
  const crumb = currentFolder?.crumb ?? [];

  // 段階権限（VIEW/EDIT/MANAGE）は ADR 0063 で撤廃。可視 space のフォルダは全操作可で、
  // 非可視 space は backend が返さない（404・存在秘匿）ため、frontend で表示・操作フィルタは持たない。

  // ソート → 検索の順で現在フォルダの可視 item を導出（ピッカー [ファイル] タブと共有する buildFileRows）。
  // タグ絞り込みは現在フォルダ内ではなく全ツリー横断検索（tagSearch）へ移したため buildFileRows には渡さない（rete-files-0032）。
  const rows: FileRowVM[] = useMemo(
    () => buildFileRows(items, sortKey, sortDir, search),
    [items, sortKey, sortDir, search],
  );

  const { has: selectionHas } = selection;
  const selectedItems = useMemo(
    () => rows.map((r) => r.item).filter((it) => selectionHas(it.name)),
    [rows, selectionHas],
  );
  const selectedCount = selectedItems.length;

  // -------- 横断検索ペインのファイル選択（fil-0051）--------
  // テキスト検索 / タグ検索が有効な間は、右ペインがフォルダ内容の代わりに横断ヒット一覧になる。
  // そのヒット一覧にも通常表示と同型のチェック選択を持たせ、選択ファイルをツールバー操作の対象にする
  // （「通常表示と同じ状態でツールバーの各アクションが使える」が正解像）。
  const searchActive = tagSearch.active || fileSearch.active;
  const activeSearchResults = tagSearch.active ? tagSearch.results : fileSearch.results;
  // 選択は id 基点（複数フォルダ横断で別フォルダ同名ファイルが衝突しないため・name 基点は不可）。
  // 検索コンテキスト（タグ集合 / テキスト）が変わったら選択をリセット（useFileSelection の folder 切替リセットを流用）。
  const searchKey = tagSearch.active
    ? `tag:${[...tagFilter].sort().join(',')}`
    : fileSearch.active
      ? `text:${search}`
      : '';
  const searchSelection = useFileSelection(searchKey);
  // 選択中のファイルヒット（フォルダは選択対象外）。useFileSelection は毎 render で新オブジェクトを返すため
  // deps には安定な has のみ載せる（selectedItems の selectionHas と同じ慣用形）。
  const { has: searchSelectionHas } = searchSelection;
  const searchSelectedResults = useMemo(
    () =>
      searchActive
        ? activeSearchResults.filter((r) => r.kind === 'file' && searchSelectionHas(r.id))
        : [],
    [searchActive, activeSearchResults, searchSelectionHas],
  );
  // ツールバー handler が通常表示と同じく扱える FileItem 形へ写す（download/tag/share/delete は kind/id/name のみ使う）。
  const searchSelectedItems = useMemo<FileItem[]>(
    () =>
      searchSelectedResults.map((r) => ({
        kind: 'file' as const,
        id: r.id,
        name: r.name,
        updatedBy: '',
        updatedAt: '',
      })),
    [searchSelectedResults],
  );

  // 横断検索中はツールバーの対象を検索選択へ、通常時は現在フォルダ選択へ切り替える（同じツールバー・同じ handler）。
  const activeItems = searchActive ? searchSelectedItems : selectedItems;
  const activeCount = activeItems.length;
  const activeCanTagAssign = activeItems.length >= 1;
  // 共有/クリップボード用のパス付きリンク。横断検索は項目ごとの所属フォルダからフルパスを引く（crumb は使えない）。
  const activeLinks = searchActive
    ? buildSearchLinks(currentTree, searchSelectedResults)
    : buildLinks(crumb, selectedItems);

  const toggleTagFilter = useCallback((id: string) => {
    setTagFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearTagFilter = useCallback(() => setTagFilter(new Set()), []);
  // テキスト検索の解除（左ペイン「検索結果(×)」ヘッダ用・fil-0053）。clearTagFilter と参照安定性を揃える。
  const clearSearch = useCallback(() => setSearch(''), []);
  // フィルタ一括クリア（検索＋タグ絞り込みを両方リセット / rete-files-0036）。
  const clearFilters = useCallback(() => {
    setSearch('');
    setTagFilter(new Set());
  }, []);
  // 検索結果（タグ絞込／キーワード）のフォルダ行ダブルクリックで「フォルダを開く＋フィルタ解除」（fil-0046）。
  // タグ・キーワードどちらの検索結果からでも一貫して両フィルタを解除する（キーワード検索結果からの dblclick が
  // onOpenFolder 未配線で no-op だったバグの修正に合わせ、解除対象を tagFilter 単独から両フィルタへ一般化）。
  // fil-0074: 閉じた祖先配下に埋もれないよう、対象より上位（祖先）の折り畳みだけ解除する（対象自身は触らない）。
  const { expand: expandTreeFolders } = treeCollapse;
  const handleOpenFolder = useCallback(
    (fid: string) => {
      expandTreeFolders(folderAncestorIds(currentTree, fid));
      selectFolder(fid);
      clearFilters();
    },
    [currentTree, expandTreeFolders, selectFolder, clearFilters],
  );

  // マスタ削除で消えたタグ id がフィルタ集合に残ると、チップが消えて解除できないのに絞り続ける。
  // マスタ一覧が変わるたび、存在するタグだけに詰め直す（孤立 id の残留防止）。
  useEffect(() => {
    const live = new Set(tagMaster.tags.map((t) => t.id));
    setTagFilter((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tagMaster.tags]);

  /**
   * ツリーの reparent（フォルダ → フォルダ）。move 先を新しい親にする。
   * client 側で自身/子孫ドロップを弾き（backend も二重に検証）、成否を toast で返す。
   * 失敗時は backend の業務メッセージ（NotFound/Conflict/BadRequest）を extractErrorMessage で取り出す。
   */
  const handleReparent = useCallback(
    async (nodeFid: string, targetFid: string) => {
      if (nodeFid === targetFid) return;
      if (isDescendant(currentTree, targetFid, nodeFid)) {
        toast.error('フォルダを自身の子孫へは移動できません');
        return;
      }
      try {
        await moveFolderTo(nodeFid, targetFid);
        toast.success('フォルダを移動しました');
      } catch (e) {
        toast.error(extractErrorMessage(e, 'フォルダの移動に失敗しました'));
      }
    },
    [currentTree, moveFolderTo],
  );

  /**
   * 一覧行の移動（ファイル/サブフォルダ行 → 同一フォルダ内のフォルダ行）。drop 先フォルダ配下へ移す。
   * 行は同階層の兄弟なので drop 先は必ずフォルダ（droppable は isFolder のみ）。種類で move API を分岐する。
   */
  const handleMoveRow = useCallback(
    async (fromIndex: number, targetIndex: number) => {
      const src = items[fromIndex];
      const dest = items[targetIndex];
      if (!src || !dest || dest.kind !== 'folder' || !dest.fid) return;
      if (src.kind === 'folder') {
        if (!src.fid || src.fid === dest.fid) return;
        try {
          await moveFolderTo(src.fid, dest.fid);
          toast.success(`「${src.name}」を移動しました`);
        } catch (e) {
          toast.error(extractErrorMessage(e, 'フォルダの移動に失敗しました'));
        }
      } else {
        if (!src.id) return;
        try {
          await moveFileTo(src.id, dest.fid);
          toast.success(`「${src.name}」を移動しました`);
        } catch (e) {
          toast.error(extractErrorMessage(e, 'ファイルの移動に失敗しました'));
        }
      }
    },
    [items, moveFolderTo, moveFileTo],
  );

  // refresh は useFileSearch 内で useCallback 安定。fileSearch オブジェクト全体を deps に置くと毎 render
  // 参照が変わりメモ化が無効化されるため、安定な refresh のみ取り出して下の handler の deps に使う。
  const { refresh: refreshSearch } = fileSearch;

  /**
   * 一覧の行（一覧の現在地にあるフォルダ/ファイル）を、ツリーのフォルダへドロップして移動する（S-FILE-04-開発エージェント）。
   * 移動の規則は検索結果からの移動（handleMoveFromSearch）と揃える: フォルダは自身/子孫への移動を弾き、
   * 現在地（移動元のフォルダ）へのドロップは no-op にして無駄な書き込みを避ける。
   * 一覧の行は移動後も同じ一覧に残るため、画面の現在地（パンくず）はそのまま（移動先へは替えない）。
   * ツリーは use-file-browser の moveFolderTo が再取得するので、移した先に子フォルダが出る。
   */
  const handleMoveRowToFolder = useCallback(
    async (
      kind: 'folder' | 'file',
      id: string,
      targetFid: string,
      parentFolderId: string | null,
    ) => {
      if (parentFolderId === targetFid) return;
      if (kind === 'folder') {
        if (id === targetFid) return;
        if (isDescendant(currentTree, targetFid, id)) {
          toast.error('フォルダを自身の子孫へは移動できません');
          return;
        }
        try {
          await moveFolderTo(id, targetFid);
          toast.success('フォルダを移動しました');
        } catch (e) {
          toast.error(extractErrorMessage(e, 'フォルダの移動に失敗しました'));
        }
      } else {
        try {
          await moveFileTo(id, targetFid);
          toast.success('ファイルを移動しました');
        } catch (e) {
          toast.error(extractErrorMessage(e, 'ファイルの移動に失敗しました'));
        }
      }
    },
    [currentTree, moveFolderTo, moveFileTo],
  );

  /**
   * 検索結果フォルダ内の項目（folder/file）をツリーのフォルダへドロップして移動する（rete-files-0004）。
   * フォルダは自身/子孫への移動を弾き、folder/file とも同一親（現在地）へのドロップは no-op（無駄 write 回避）。
   * 成功後は移動 API 側がツリー/一覧を再取得し、加えて検索を再実行してヒット一覧も最新化する。
   */
  const handleMoveFromSearch = useCallback(
    async (
      kind: 'folder' | 'file',
      id: string,
      targetFid: string,
      parentFolderId: string | null,
    ) => {
      // 現在地と同じフォルダへ落としても何も変わらない（folder/file 共通の無駄移動ガード）。
      if (parentFolderId === targetFid) return;
      if (kind === 'folder') {
        if (id === targetFid) return;
        if (isDescendant(currentTree, targetFid, id)) {
          toast.error('フォルダを自身の子孫へは移動できません');
          return;
        }
        try {
          await moveFolderTo(id, targetFid);
          toast.success('フォルダを移動しました');
          refreshSearch();
        } catch (e) {
          toast.error(extractErrorMessage(e, 'フォルダの移動に失敗しました'));
        }
      } else {
        try {
          await moveFileTo(id, targetFid);
          toast.success('ファイルを移動しました');
          refreshSearch();
        } catch (e) {
          toast.error(extractErrorMessage(e, 'ファイルの移動に失敗しました'));
        }
      }
    },
    [currentTree, moveFolderTo, moveFileTo, refreshSearch],
  );

  const { sensors, onDragStart, onDragEnd, activeLabel } = useFileDnd({
    onReparent: handleReparent,
    onMoveRow: handleMoveRow,
    onMoveRowToFolder: handleMoveRowToFolder,
    onMoveFromSearch: handleMoveFromSearch,
  });

  const handleToggleAll = (checked: boolean) => {
    selection.setMany(
      rows.map((r) => r.item.name),
      checked,
    );
  };

  const handleUploadClick = () => {
    if (!currentFolderId) {
      toast.error('アップロード先のフォルダを選択してください');
      return;
    }
    fileInputRef.current?.click();
  };

  /**
   * 指定フォルダへ複数ファイルを順次アップロードする（rete-files-0012）。
   * 1 件の失敗で残りを止めず、成功/失敗を集計してまとめて toast し、最後に 1 度だけ一覧を再取得する。
   * ボタン経由（input change）と OS ファイル D&D（fil-0052）の共通ロジック。
   *
   * 失敗はサーバーが返した理由を集めて出す（v2-191）。以前は理由を捨てていたため、利用者は弾かれた
   * 理由（実行形式・サイズ・拡張子など）をアップロードし直すまで知れなかった。名前は出さない
   * （開発統括の修正依頼・2026-09-23。長くなる割に、どのファイルかを読み取る役に立たなかった）。
   */
  const uploadFilesToFolder = useCallback(
    async (folderId: string, files: File[]) => {
      if (files.length === 0) return;
      setUploading(true);
      let okCount = 0;
      const failed: string[] = [];
      try {
        for (const file of files) {
          try {
            await uploadFile(folderId, file);
            okCount += 1;
          } catch (err) {
            failed.push(uploadFailureReason(err));
          }
        }
        if (okCount > 0) {
          toast.success(
            okCount === 1
              ? '1 件のファイルをアップロードしました'
              : `${okCount} 件のファイルをアップロードしました`,
          );
          // 完了後に一覧を自動更新する（受け入れ基準）。左ペインの別フォルダへ D&D した場合は、
          // refreshFolder（現在フォルダ再取得）だと反映が見えないため、そのフォルダへ遷移して中身を出す。
          if (folderId === currentFolderId) refreshFolder();
          else selectFolder(folderId);
        }
        if (failed.length > 0) {
          toast.error(formatUploadFailures(failed));
        }
      } finally {
        setUploading(false);
      }
    },
    [refreshFolder, selectFolder, currentFolderId],
  );

  /**
   * フォルダ階層ごと D&D アップロード（fil-0055）。webkitGetAsEntry のエントリ群を再帰展開し、
   * フォルダは createFolder、ファイルは uploadFile で階層を再現する。ベストエフォート（一部失敗でも継続）。
   * フォルダ作成でツリー構造が変わるため、完了後は reloadAll でツリー + 現フォルダを再取得し、
   * ドロップ先が現在フォルダと異なるならそこへ遷移して中身（新サブフォルダ）を表示する。
   */
  const uploadEntriesToFolder = useCallback(
    async (folderId: string, entries: FileSystemEntry[]) => {
      if (entries.length === 0) return;
      setUploading(true);
      // 大量フォルダ階層は時間がかかるため、件数フィードバックを loading toast で更新（fil-0056・LOW 接続）。
      const progressId = toast.loading('アップロードを開始しています…');
      try {
        // FileSystemEntry は FsEntryLike（構造的最小形）に optional 超過分を欠くだけで代入可。二重キャスト不要（fil-0056）。
        const res = await uploadEntries(folderId, entries, {
          createFolder: (parentId, name) => createFolder(parentId, name),
          uploadFile,
          onProgress: (p) => {
            const done = p.folders + p.files;
            toast.loading(
              `アップロード処理中… ${done} 件完了${p.failed > 0 ? ` / 失敗 ${p.failed}` : ''}`,
              { id: progressId },
            );
          },
        });
        toast.dismiss(progressId);
        if (res.files > 0 || res.folders > 0) {
          toast.success(
            `フォルダ ${res.folders} 件・ファイル ${res.files} 件をアップロードしました`,
          );
          // ツリー（新フォルダ反映）+ 現フォルダを再取得 → 別フォルダ宛なら遷移して中身を出す。
          await reloadAll();
          if (folderId !== currentFolderId) selectFolder(folderId);
        }
        if (res.failed > 0) {
          // 理由を出せる分だけ渡す（v2-191）。理由を持たない失敗（階層・項目数の上限など）は
          // 件数のみになるため、総数は res.failed を渡して数え落とさない。
          const failures = res.failedPaths
            .map((path) => res.failedReasons[path])
            .filter((reason): reason is string => Boolean(reason));
          toast.error(formatUploadFailures(failures, res.failed));
        }
        // 上限超過は黙って切らず通知（fil-0056・自己 DoS 対策）。
        if (res.limited) {
          toast.error(res.limited);
        }
      } finally {
        toast.dismiss(progressId);
        setUploading(false);
      }
    },
    [reloadAll, selectFolder, currentFolderId],
  );

  // OS ファイル D&D の受け口（fil-0052 ファイル単体 / fil-0055 フォルダ階層）。
  // 左ペインの各フォルダ / 右ペインの現在フォルダへドロップでアップロード。
  const { activeZone: fileDropZone, getZoneProps: getFileDropZoneProps } = useFileDrop(
    uploadFilesToFolder,
    uploadEntriesToFolder,
  );

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // 同名ファイル連続選択でも change が発火するようリセット。
    // 選んだ中身を先に取り出す（画面が描き直された後も、取り出した中身は変わらない）。
    e.target.value = '';
    if (files.length === 0 || !currentFolderId) return;
    await uploadFilesToFolder(currentFolderId, files);
  };

  const handleDownload = async () => {
    const files = activeItems.filter((it) => it.kind === 'file' && it.id);
    if (!files.length) {
      toast.error('ダウンロードできるファイルが選択されていません');
      return;
    }
    for (const it of files) {
      try {
        await downloadFile(it.id!, it.name);
      } catch {
        toast.error(`「${it.name}」のダウンロードに失敗しました`);
      }
    }
  };

  /**
   * 選択項目のパス（共有オーバーレイと同じ buildLinks 由来）を 1 行 1 パスでクリップボードへコピーする。
   * Clipboard API が使えない文脈（非セキュアコンテキスト等）では navigator.clipboard が undefined で
   * 同期 TypeError になるため try/catch でエラートーストに落とす（実体化: 旧「（モック）」ラベルを撤去）。
   */
  const handleShareClip = async () => {
    const paths = activeLinks.map((l) => l.path);
    if (!paths.length) return;
    try {
      await navigator.clipboard.writeText(paths.join('\n'));
      toast.success(
        paths.length === 1
          ? 'パスをクリップボードにコピーしました'
          : `${paths.length} 件のパスをクリップボードにコピーしました`,
      );
    } catch {
      toast.error('クリップボードにコピーできませんでした');
    }
  };

  const handleDeleteClick = () => {
    if (activeCount === 0) {
      toast.error('削除する項目を選択してください');
      return;
    }
    setConfirmOpen(true);
  };

  /**
   * 選択項目を一括削除する。種別ごとに DELETE API を呼び、allSettled で全件試行する
   * （1 件の失敗で残りを止めない）。フォルダ削除は非空だと backend が 409 を返すため、その業務
   * メッセージを最初の失敗から拾って toast に出す。完了後は選択を解除しツリー + 一覧を再取得する。
   */
  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      const targets = [...activeItems];
      const results = await Promise.allSettled(
        targets.map((it) => {
          if (it.kind === 'folder') {
            return it.fid
              ? deleteFolder(it.fid)
              : Promise.reject(new Error('フォルダ ID が不明です'));
          }
          return it.id ? deleteFile(it.id) : Promise.reject(new Error('ファイル ID が不明です'));
        }),
      );
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      const okCount = targets.length - failed.length;

      // 横断検索中は検索選択を、通常時は現在フォルダ選択をクリアする。
      (searchActive ? searchSelection : selection).clear();
      setConfirmOpen(false);
      await reloadAll();
      // 横断検索中はヒット一覧も最新化する（削除でヒットが減るため）。
      if (tagSearch.active) tagSearch.refresh();
      else if (fileSearch.active) refreshSearch();

      if (okCount > 0) toast.success(`${okCount} 件を削除しました`);
      if (failed[0]) {
        toast.error(extractErrorMessage(failed[0].reason, '一部の項目を削除できませんでした'));
      }
    } finally {
      setDeleting(false);
    }
  };

  // 共有オーバーレイ用のパス付きリンク（上限件数で丸め、超過数を別途渡す）。横断検索中は検索選択由来（activeLinks）。
  const { shown: shownLinks, overflow } = truncateLinks(activeLinks);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
        aria-hidden="true"
      />
      <main className="sp-page flex flex-col overflow-hidden">
        <PageTitle title="ファイル" />
        <FileTopbar
          crumb={crumb}
          search={search}
          onSearchChange={setSearch}
          onNavigate={selectFolder}
          stacked
          favorite={
            // トップバー★は現在フォルダの登録に固定する（v2-505 差し戻し）。
            // 「★登録は Home 側導線へ一本化」した rete-files-0030 の方針を崩さないため、
            // 選択状態で★の意味を差し替えない。ファイルのお気に入り登録は行の★導線が担う。
            currentFolderId && currentFolder
              ? { kind: 'folder', targetRef: currentFolderId, label: currentFolder.name }
              : undefined
          }
          tags={tagMaster.tags}
          tagFilterActive={tagFilter}
          tagFilterLoading={tagMaster.loading}
          onTagToggle={toggleTagFilter}
          onTagClear={clearTagFilter}
          onClearFilters={clearFilters}
        />
        <FileToolbar
          selectionCount={activeCount}
          canTagAssign={activeCanTagAssign}
          uploading={uploading}
          deleting={deleting}
          onUpload={handleUploadClick}
          onDownload={handleDownload}
          onNewFolder={() => folderCreate.begin(currentFolderId)}
          onShareChat={() => overlays.openSend('chat')}
          onShareClip={handleShareClip}
          onTagAssign={() => {
            if (activeCanTagAssign) overlays.openTagAssign(activeItems);
          }}
          onReset={handleResetTable}
          onDelete={handleDeleteClick}
        />

        <div className="file-layout">
          <section className="sp-card file-pane-tree file-pane-tree--narrow">
            <div className="file-pane-head">
              <span>リポジトリ</span>
            </div>
            {treeError ? (
              <div className="file-empty">ツリーの読み込みに失敗しました</div>
            ) : treeLoading ? (
              <div className="file-empty">
                <Spinner className="h-4 w-4 inline-block" />
              </div>
            ) : (
              <FilesTree
                tree={currentTree}
                currentFolderId={currentFolderId}
                dndDisabled={dndDisabled}
                onSelect={selectFolder}
                fileDrop={{ activeZone: fileDropZone, getZoneProps: getFileDropZoneProps }}
                collapsedIds={treeCollapse.collapsedIds}
                onToggleCollapse={treeCollapse.toggle}
                search={
                  // 左ペイン上段の「検索結果(×)」ヘッダ（fil-0053）。右ペインと同じくタグ絞込を優先し、
                  // (×) は該当モードの解除関数を呼ぶ（タグ=clearTagFilter / テキスト=setSearch('')）。
                  // 両モードで同型ヘッダを使い左ペインの見た目を揃える。
                  tagSearch.active
                    ? {
                        active: true,
                        loading: tagSearch.loading,
                        error: tagSearch.error,
                        results: tagSearch.results,
                        onClear: clearTagFilter,
                      }
                    : {
                        active: fileSearch.active,
                        loading: fileSearch.loading,
                        error: fileSearch.error,
                        results: fileSearch.results,
                        onClear: clearSearch,
                      }
                }
                draft={folderCreate.draft}
                draftSubmitting={folderCreate.submitting}
                onDraftChange={folderCreate.changeName}
                onDraftCommit={folderCreate.commit}
                onDraftCancel={folderCreate.cancel}
              />
            )}
          </section>

          <div
            className={cn('file-pane-detail', fileDropZone === 'pane' && 'is-file-drop')}
            // 右ペインは現在開いているフォルダへドロップ（fil-0052）。横断検索中はフォルダ内容を出していない
            // ため受け口にしない（folderId=null で no-op・fil-0103 で確立）。
            {...getFileDropZoneProps(
              'pane',
              !searchActive && currentFolderId ? currentFolderId : null,
            )}
          >
            {tagSearch.active ? (
              // タグ絞り込み中は現在フォルダの代わりに全ツリー横断のヒット一覧を出す（優先度1 / rete-files-0032）。
              <TagSearchResults
                results={tagSearch.results}
                tree={currentTree}
                loading={tagSearch.loading}
                error={tagSearch.error}
                truncated={tagSearch.truncated}
                onNavigate={selectFolder}
                onOpenFolder={handleOpenFolder}
                selection={searchSelection}
              />
            ) : fileSearch.active ? (
              // テキスト検索中は全ツリー横断のヒット一覧を右ペインに出す（優先度2・タグ絞込より低 / fil-0045）。
              // 左ツリーには「検索結果（N）」ヘッダのみ残す（SearchSection はヘッダ専用に変更済み）。
              <SearchResults
                results={fileSearch.results}
                tree={currentTree}
                loading={fileSearch.loading}
                error={fileSearch.error}
                errorText="検索に失敗しました"
                emptyText="該当する項目がありません"
                onNavigate={selectFolder}
                onOpenFolder={handleOpenFolder}
                selection={searchSelection}
                keyword={search}
              />
            ) : folderError ? (
              <section className="sp-card file-list-card">
                <div className="file-empty">
                  フォルダの読み込みに失敗しました。
                  {/* 状態取得失敗の復帰導線は他画面と同じ FormButton secondary へ寄せる（v2-225）。
                      ツールバー帯の .file-tb-btn は Files ツールバー専用で、エラー領域には使わない。
                      FormButton は style を受けないため、文言との間隔は外側の span で従来値 0.5rem を保つ。 */}
                  <span style={{ marginLeft: '0.5rem' }}>
                    <FormButton variant="secondary" onClick={refreshFolder}>
                      再試行
                    </FormButton>
                  </span>
                </div>
              </section>
            ) : folderLoading && !currentFolder ? (
              <section className="sp-card file-list-card">
                <div className="file-empty">
                  <Spinner className="h-4 w-4 inline-block" />
                </div>
              </section>
            ) : !currentFolder ? (
              <section className="sp-card file-list-card">
                <div className="file-empty">表示するフォルダがありません</div>
              </section>
            ) : (
              <FileList
                rows={rows}
                sortKey={sortKey}
                sortDir={sortDir}
                onToggleSort={toggleSort}
                selectedCount={selectedCount}
                selection={selection}
                dndDisabled={dndDisabled}
                onToggleAll={handleToggleAll}
                onNavigateFolder={selectFolder}
                onEditFile={handleEditFile}
                versionFlashId={versionFlash?.id ?? null}
                parentFolderId={currentFolderId}
              />
            )}
          </div>
        </div>
      </main>

      <DragOverlay>
        {activeLabel ? <div className="file-drag-ghost">{activeLabel}</div> : null}
      </DragOverlay>

      {overlays.overlay === 'send' && (
        <SendOverlay
          target={overlays.shareTarget}
          links={shownLinks}
          overflow={overflow}
          onClose={overlays.close}
          // 中身（SendOverlayBody）が自前で判定する。入力を外側へ持ち上げると 2 箇所で数えることになるので、
          // 枠へは空を渡す（詳細は send-overlay.tsx の型の宣言を見る）。
          dirty={false}
          submitting={false}
        />
      )}
      {overlays.overlay === 'settings' && <SettingsOverlay onClose={overlays.close} />}
      {overlays.overlay === 'tags' && (
        <TagMasterOverlay
          master={tagMaster}
          // fil-0094: 閉じる時に「アーカイブ済のみ表示」を必ず OFF へ戻す（アーカイブ込み fetch の残留防止）。
          onClose={() => {
            setTagArchiveOnly(false);
            overlays.close();
          }}
          archiveFilter={{ value: tagArchiveOnly, onChange: setTagArchiveOnly }}
        />
      )}
      {overlays.overlay === 'tagAssign' && overlays.assignTargets.length > 0 && (
        <TagAssignOverlay
          targets={overlays.assignTargets}
          master={tagMaster}
          onClose={overlays.close}
          onApplied={() => {
            // 付与後は現在フォルダを再取得し、タグ横断検索中ならヒット一覧も最新化する（付与でヒットが変わるため）。
            refreshFolder();
            tagSearch.refresh();
          }}
        />
      )}
      {overlays.overlay === 'edit' && overlays.editTarget && (
        <FileEditOverlay
          target={overlays.editTarget}
          // fil-0083: 「File 側」情報表示用にパンくず文字列を構築。
          folderPath={crumb.map((c) => c.name).join(' ＞ ')}
          onClose={handleEditClose}
          onUploaded={refreshFolder}
          session={
            localEdit.status !== 'idle'
              ? {
                  status: localEdit.status,
                  lastVersionNo: localEdit.lastVersionNo,
                  lastLocalModified: localEdit.lastLocalModified,
                  // fil-0142: paused 状態時の停止理由と再開導線を overlay へ渡す。
                  lastError: localEdit.lastError,
                  stop: localEdit.stop,
                  resume: localEdit.resume,
                }
              : undefined
          }
        />
      )}

      <ConfirmDialog
        open={confirmOpen}
        message={`選択した ${activeCount} 件を削除しますか？ファイルは全版と実体が削除され、元に戻せません。フォルダは空の場合のみ削除できます。`}
        destructive
        busy={deleting}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmOpen(false)}
      />
    </DndContext>
  );
}
