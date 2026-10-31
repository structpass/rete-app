import { Injectable } from '@nestjs/common';
import { File, FileSettings, FileVersion, Folder, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  runInSerializableTransaction,
  INTERACTIVE_SAVE_TX_OPTIONS,
} from '../../../common/database/serializable-tx';
import {
  DEFAULT_MAX_SIZE_BYTES,
  DEFAULT_REJECTED_EXTENSIONS,
  FILE_SETTINGS_SINGLETON_ID,
  FOLDER_MAX_DEPTH,
  SEARCH_RESULT_LIMIT,
} from '../files.constants';

/**
 * Prisma `contains`（ILIKE）へ渡す前に LIKE メタ文字（%・_）と区切り文字 \ をエスケープする。
 * これをしないと q="%" が全件マッチ（name フィルタ無効化）になり、複合パターンは DB に高コスト評価を強いる。
 * PostgreSQL の既定 ESCAPE 文字 \ を使い、\→\\、%→\%、_→\_ の順で置換する（\ を最初に処理して二重エスケープを防ぐ）。
 */
function escapeLike(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * 設定 upsert の部分パッチ（app 層が正規化して渡す）。未指定（undefined）フィールドは update 時に
 * 更新スキップされ DB の既存値を保持する（read-modify-write を避けロストアップデートを防ぐ）。
 */
export interface FileSettingsPatch {
  maxSizeBytes?: bigint;
  allowedExtensions?: string[];
  rejectedExtensions?: string[];
}

/**
 * ファイル最新版の表示用 include（版番号降順の先頭 1 件 + アップロード者名 + 付与タグ）。
 * include 形状の SSOT は本 repository。passwordHash 等の個人情報は select しない。
 * tags は一覧のタグ列（rete-files-0006）用に tag マスタを include し、tag 名昇順で安定表示する。
 */
const latestVersionInclude = {
  versions: {
    orderBy: { versionNo: 'desc' as const },
    take: 1,
    include: { uploadedBy: { select: { name: true } } },
  },
  tags: {
    include: { tag: true },
    orderBy: { tag: { name: 'asc' as const } },
  },
} as const;

/** 最新版（先頭 1 件）+ アップロード者名を含む File Entity（一覧の入力型）。 */
export type FileWithLatestVersion = Prisma.FileGetPayload<{
  include: typeof latestVersionInclude;
}>;

/**
 * 付与タグ込みの Folder include（一覧のタグ列 / タグ置換後の行返却用・rete-files-0033）。
 * FileTag と対称に tag マスタを include し、tag 名昇順で安定表示する。
 */
const folderWithTagsInclude = {
  tags: {
    include: { tag: true },
    orderBy: { tag: { name: 'asc' as const } },
  },
} as const;

/** 付与タグ込みの Folder Entity（フォルダ行 / フォルダタグ置換結果の入力型）。 */
export type FolderWithTags = Prisma.FolderGetPayload<{
  include: typeof folderWithTagsInclude;
}>;

/** アップロード者名を include した FileVersion（アップロード結果 mapper の入力型）。 */
const versionUploaderInclude = {
  uploadedBy: { select: { name: true } },
} as const;
export type FileVersionWithUploader = Prisma.FileVersionGetPayload<{
  include: typeof versionUploaderInclude;
}>;

/** File（初版 + アップロード者名 include 済）。新規アップロード時の戻り型。 */
export type FileWithVersions = Prisma.FileGetPayload<{
  include: { versions: { include: typeof versionUploaderInclude } };
}>;

/** 新規版の永続化データ（storageKey / byteSize 等は app 層が確定して渡す）。 */
export interface NewVersionData {
  id: string;
  versionNo: number;
  storageKey: string;
  byteSize: bigint;
  mimeType: string;
  uploadedById: string;
}

/**
 * 可視性判定の最小形（ADR 0063）。folder → 帰属 space の 1 hop 解決だけに使う
 * （祖先チェーン走査は不要になった＝FolderAclService 撤去）。
 */
export interface FolderSpaceRef {
  id: string;
  spaceId: string;
}

/**
 * file 起点取得に同乗させる所属フォルダの帰属 space（fil-0146）。対象取得と可視範囲評価を
 * 同一クエリ数で済ませるための include 素材で、id は File.folderId 側が持つ。
 */
export interface FolderSpaceOnly {
  spaceId: string;
}

/**
 * 原子移動（moveFolderAtomic / moveFileAtomic）の結果。HTTP 例外を repo から投げず、整合判定の結果を
 * union で返して Service が文言付き例外へ翻訳する（§4 エラー一元化）。reason は移動不可の事由。
 * 'depth_exceeded' は移動後の対象チェーン / 対象サブツリーが階層上限（FOLDER_MAX_DEPTH）を超える（fil-0118）。
 */
export type MoveFolderResult =
  | { ok: true; folder: Folder }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'target_not_found'
        | 'self'
        | 'cycle'
        | 'duplicate'
        | 'stale'
        | 'depth_exceeded';
    };

export type MoveFileResult =
  | { ok: true; file: File }
  | {
      ok: false;
      reason: 'not_found' | 'target_not_found' | 'duplicate' | 'stale';
    };

/**
 * 新規フォルダ作成（createFolder）の結果。moveFolderAtomic と同じく HTTP 例外を投げず union で返し、
 * Service が文言付き例外へ翻訳する（fil-0118 criteria 6・深さ検査は repository tx 内で原子的に行う）。
 */
export type CreateFolderResult =
  | { ok: true; folder: Folder }
  | { ok: false; reason: 'parent_not_found' | 'depth_exceeded' | 'duplicate' };

/**
 * File / Folder のデータアクセス層（§2 Repository 分離）。Service は本クラス経由でのみ DB に触る。
 * 本クラスは Prisma Entity だけを返し、DTO 変換は mapper / Service 層に委ねる。
 * 可視性（ADR 0063「チャネル可視＝配下ファイル可視」）は Space 単位で、判定主体は
 * ScopeVisibilityService（memberships）。本クラスは「可視 space 集合で where を絞る」口を提供し、
 * どの space が可視かの判定自体は行わない。
 */
@Injectable()
export class FilesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ツリー構築用に全フォルダを取得する。ページングしない: 木構造は全件で初めて成立するため
   * （tasks.findAllForTree と同方針）。mapper（toFolderTree）は 2-pass で親子を接続するため
   * 入力順に非依存だが、兄弟順だけは入力配列の並びを保持する。よって sortOrder → name 昇順で
   * 兄弟順を確定させる（parentFolderId はグルーピング補助で、2-pass のため順序保証には不要）。
   *
   * ADR 0063: 全件ではなく **単一 space 配下**を返す（ツリーは器ごとに完結する＝祖先が別 space に
   * 跨ることはない・親子の spaceId は app 層で一致を強制）。
   */
  findAllFolders(spaceId: string): Promise<Folder[]> {
    return this.prisma.folder.findMany({
      where: { spaceId },
      orderBy: [{ parentFolderId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  findFolderById(id: string): Promise<Folder | null> {
    return this.prisma.folder.findUnique({ where: { id } });
  }

  /**
   * 指定 id 群の帰属 space を引く（ADR 0063 の可視性判定の素材）。検索結果や一括操作の対象を
   * 「可視 space に属するか」で絞るために使う。存在しない id は結果に現れない。
   *
   * コスト上限（cmn-0422・一括タグ付与の存在検証）: 入力は DTO で fileIds/folderIds 各
   * BATCH_TARGET_MAX=200・タグ各 TAG_ASSIGN_MAX=50 に bounded（tag-assignment.dto.ts）され、
   * 本クエリの join は folder の主キー 1 本だけ＝自明に軽量。count クエリへ戻すと、count 先落ちの
   * タイミング差が存在の oracle に戻るため変更しない（fil-0146）。
   */
  findFolderSpaceIds(ids: string[]): Promise<FolderSpaceRef[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.folder.findMany({
      where: { id: { in: ids } },
      select: { id: true, spaceId: true },
    });
  }

  /**
   * 横断検索（rete-files-0004）: name 部分一致のフォルダを全階層から取得（大文字小文字無視）。
   * ツリー全体を対象にした「検索結果フォルダ」用。LIKE メタ文字（%・_）はエスケープし（q="%" で全件マッチ
   * = フィルタ無効化や高コスト評価を防ぐ）、件数は SEARCH_RESULT_LIMIT で上限を掛ける（暴走スキャン防止）。
   *
   * ADR 0063: 可視 space（visibleSpaceIds）で必ず絞る。絞りを外すと非可視チャネルのフォルダ名が
   * 検索経由で露出する（ACL 撤去で失われた防御をここで担保する）。
   */
  searchFolders(q: string, visibleSpaceIds: string[]): Promise<Folder[]> {
    return this.prisma.folder.findMany({
      where: {
        name: { contains: escapeLike(q), mode: 'insensitive' },
        spaceId: { in: visibleSpaceIds },
      },
      orderBy: { name: 'asc' },
      take: SEARCH_RESULT_LIMIT,
    });
  }

  /**
   * 横断検索（rete-files-0004）: name 部分一致のファイルを全階層から取得（大文字小文字無視・メタ文字エスケープ・件数上限）。
   * ファイル自身は space を持たないため、所属フォルダの spaceId で絞る（ADR 0063）。
   */
  searchFiles(q: string, visibleSpaceIds: string[]): Promise<File[]> {
    return this.prisma.file.findMany({
      where: {
        name: { contains: escapeLike(q), mode: 'insensitive' },
        folder: { spaceId: { in: visibleSpaceIds } },
      },
      orderBy: { name: 'asc' },
      take: SEARCH_RESULT_LIMIT,
    });
  }

  /**
   * タグ横断検索（rete-files-0032）: 指定タグ集合のいずれかが付くファイルを全階層から取得（OR 条件）。
   * `tags: { some: { tagId in } }` で中間テーブル経由の存在絞り込みを行う（@@index([tagId]) が効く）。
   * SEARCH_RESULT_LIMIT+1 件を取得して service 側で超過を検出し truncated フラグを立てる（fil-0043）。
   * 空配列は呼び出し側で弾く前提。
   */
  searchFilesByTags(tagIds: string[], visibleSpaceIds: string[]): Promise<File[]> {
    return this.prisma.file.findMany({
      where: {
        tags: { some: { tagId: { in: tagIds } } },
        // ADR 0063: 所属フォルダの帰属 space で絞る（非可視チャネルのファイルをタグ検索で覗かせない）。
        folder: { spaceId: { in: visibleSpaceIds } },
      },
      orderBy: { name: 'asc' },
      take: SEARCH_RESULT_LIMIT + 1,
    });
  }

  /**
   * タグ横断検索（rete-files-0032）: 指定タグ集合のいずれかが付くフォルダを全階層から取得（OR 条件）。
   * SEARCH_RESULT_LIMIT+1 件を取得して service 側で超過を検出し truncated フラグを立てる（fil-0043）。
   */
  searchFoldersByTags(tagIds: string[], visibleSpaceIds: string[]): Promise<Folder[]> {
    return this.prisma.folder.findMany({
      where: {
        tags: { some: { tagId: { in: tagIds } } },
        spaceId: { in: visibleSpaceIds }, // ADR 0063
      },
      orderBy: { name: 'asc' },
      take: SEARCH_RESULT_LIMIT + 1,
    });
  }

  /**
   * 指定フォルダ直下のサブフォルダ（sortOrder → name 昇順・付与タグ込み）。
   * 一覧のタグ列（rete-files-0033）でフォルダのタグも表示するため tags を include する。
   */
  findSubfolders(parentFolderId: string): Promise<FolderWithTags[]> {
    return this.prisma.folder.findMany({
      where: { parentFolderId },
      include: folderWithTagsInclude,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /** 指定フォルダ直下のファイル（各々最新版 1 件 + アップロード者名付き、name 昇順）。 */
  findFilesWithLatestVersion(folderId: string): Promise<FileWithLatestVersion[]> {
    return this.prisma.file.findMany({
      where: { folderId },
      include: latestVersionInclude,
      orderBy: { name: 'asc' },
    });
  }

  // パンくず用の祖先チェーン取得（getFolderAncestors）は fil-0105 で削除した。移動検証用の
  // walkAncestorIdsTx は別用途のため残す。パンくずは findAllFolders（単一 space 全件）から service が組む。
  //
  // ディレクトリ権限（FB+ / fil-0027・0095）の素材メソッド群（ACL ノード列挙・付与の取得/全置換・
  // 権限設定オーバーレイ専用の付与先解決）は ADR 0063（fil-0136）で全撤去した。
  // 可視性は Space 単位（findFolderSpaceIds ＋ ScopeVisibilityService）へ移管済み。

  /**
   * 指定ファイル群の実在と帰属 space を 1 クエリで引く（fil-0146・一括タグ付与用）。実在検証
   * （refs.length と要求数の照合）と可視範囲評価を単一のクエリ集合に統合し、クエリの回数・形が
   * リクエスト入力（fileIds）だけで決まるようにする（途中のルックアップ結果でクエリを省略すると、
   * その分岐自体が存在の oracle になる）。存在しない id は結果に現れない（findFolderSpaceIds と同じ規約）。
   * 旧 findFolderIdsByFileIds（folderId のみ・count 併用前提）は本メソッドへ統合し撤去した。
   *
   * コスト上限（cmn-0422）: 入力は DTO で fileIds/folderIds 各 BATCH_TARGET_MAX=200・タグ各
   * TAG_ASSIGN_MAX=50 に bounded（tag-assignment.dto.ts）され、本クエリの join は folder の主キー
   * 1 本だけ＝自明に軽量。count クエリへ戻すと count 先落ちのタイミング差が存在の oracle に戻る
   * ため変更しない（findFolderSpaceIds と同じ理由）。
   */
  findFileSpaceRefs(
    fileIds: string[],
  ): Promise<{ id: string; folderId: string; spaceId: string }[]> {
    if (fileIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.file
      .findMany({
        where: { id: { in: fileIds } },
        select: { id: true, folderId: true, folder: { select: { spaceId: true } } },
      })
      .then((rows) =>
        rows.map((r) => ({ id: r.id, folderId: r.folderId, spaceId: r.folder.spaceId })),
      );
  }

  // --- 書き込み系（Phase FB-2: アップロード / 版管理）---

  /** 同一フォルダ内の同名 File を引く（同名再アップ判定。複合一意キー folderId_name）。 */
  findFileByFolderAndName(folderId: string, name: string): Promise<File | null> {
    return this.prisma.file.findUnique({
      where: { folderId_name: { folderId, name } },
    });
  }

  /** 指定 File の最大版番号を返す（版が無ければ 0）。次版番号 = 本値 + 1。 */
  async getMaxVersionNo(fileId: string): Promise<number> {
    const latest = await this.prisma.fileVersion.findFirst({
      where: { fileId },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true },
    });
    return latest?.versionNo ?? 0;
  }

  /**
   * 新規 File と初版 FileVersion を入れ子作成（単一クエリで原子的）。
   * id は app が発行して渡す（実体保存の storageKey を DB 書き込み前に確定させるため）。
   */
  createFileWithInitialVersion(params: {
    fileId: string;
    folderId: string;
    name: string;
    version: NewVersionData;
  }): Promise<FileWithVersions> {
    return this.prisma.file.create({
      data: {
        id: params.fileId,
        folderId: params.folderId,
        name: params.name,
        versions: { create: params.version },
      },
      include: { versions: { include: versionUploaderInclude } },
    });
  }

  /** 既存 File へ新版を追加する（同名再アップ時）。 */
  addFileVersion(data: NewVersionData & { fileId: string }): Promise<FileVersionWithUploader> {
    return this.prisma.fileVersion.create({
      data,
      include: versionUploaderInclude,
    });
  }

  /**
   * ダウンロード用: File を最新版 1 件付きで引く。
   * 所属フォルダの spaceId も同時に返す（fil-0146: 可視範囲評価の素材を追加クエリなしで取得）。
   */
  findLatestVersionWithFile(
    fileId: string,
  ): Promise<(File & { versions: FileVersion[]; folder: FolderSpaceOnly }) | null> {
    return this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        versions: { orderBy: { versionNo: 'desc' }, take: 1 },
        folder: { select: { spaceId: true } },
      },
    });
  }

  /**
   * ダウンロード用: 版番号指定で版を File 付きで引く（複合一意キー fileId_versionNo）。
   * File には所属フォルダの spaceId も載せる（fil-0146）。
   */
  findVersionWithFile(
    fileId: string,
    versionNo: number,
  ): Promise<(FileVersion & { file: File & { folder: FolderSpaceOnly } }) | null> {
    return this.prisma.fileVersion.findUnique({
      where: { fileId_versionNo: { fileId, versionNo } },
      include: { file: { include: { folder: { select: { spaceId: true } } } } },
    });
  }

  // --- 移動（Phase FB-2b: reparent / フォルダ間移動）---

  /**
   * 構造参照の解決素材（FL+1・設計 §2.3）。id 群をフォルダとファイルから引き、フォルダは
   * ルート→自身の祖先 id 列を返す（パス表記を app 層で組み、comma 区切りを扱わないため）。
   * 可視判定は app 層で行う（ここは存在する行だけを返し、不在 id は現れない）。
   *
   * refIds は DTO で上限（REF_RESOLVE_MAX）に bounded してから渡す。フォルダの祖先は
   * 対象と同一 space に閉じる（ADR 0063）。祖先の引きは 1 クエリで受け、辿りは app 層で行う。
   */
  async findRefTargets(ids: string[]): Promise<{
    folders: { id: string; name: string; parentFolderId: string | null; spaceId: string }[];
    files: { id: string; name: string; folderId: string }[];
  }> {
    if (ids.length === 0) {
      return { folders: [], files: [] };
    }
    const [folders, files] = await Promise.all([
      this.prisma.folder.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, parentFolderId: true, spaceId: true },
      }),
      this.prisma.file.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, folderId: true },
      }),
    ]);
    return { folders, files };
  }

  /**
   * フォルダの祖先を 1 クエリで引く（findRefTargets で得た対象から root まで辿る素材）。
   * 渡した spaceIds に属するフォルダだけを返す（他 space の名前をパス表記へ混ぜない）。
   */
  findRefAncestors(
    folderIds: string[],
    spaceIds: string[],
  ): Promise<{ id: string; name: string; parentFolderId: string | null }[]> {
    if (folderIds.length === 0 || spaceIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.folder.findMany({
      where: { id: { in: folderIds }, spaceId: { in: spaceIds } },
      select: { id: true, name: true, parentFolderId: true },
    });
  }

  /**
   * id 指定で File を所属フォルダの spaceId 付きで引く（移動・版追加・メタ取得・タグ付けの存在チェック用）。
   * fil-0146: 可視範囲評価が対象取得と同じ 1 クエリで済むよう folder.spaceId を同時に返す。
   */
  findFileById(id: string): Promise<(File & { folder: FolderSpaceOnly }) | null> {
    return this.prisma.file.findUnique({
      where: { id },
      include: { folder: { select: { spaceId: true } } },
    });
  }

  /**
   * tx スコープで対象 → root の祖先 id 集合（対象自身を含む）を辿る。循環移動の検出と作成後 / 移動後の
   * 深さ測定に使う（getFolderAncestors の tx 版・move / create の検証を書き込みと同一 tx に閉じる）。
   * FOLDER_MAX_DEPTH で打ち切る。既訪ノードへ再訪したら cycle=true で停止し、データ不整合の循環でも
   * 無限ループしない（fil-0118 criteria 7・101 段以遠の循環を見落として commit させない）。
   */
  private async walkAncestorIdsTx(
    tx: Prisma.TransactionClient,
    startId: string,
  ): Promise<{ ids: string[]; cycle: boolean }> {
    const ids: string[] = [];
    const visited = new Set<string>();
    let currentId: string | null = startId;
    let guard = 0;
    while (currentId != null && guard < FOLDER_MAX_DEPTH) {
      if (visited.has(currentId)) {
        return { ids, cycle: true };
      }
      visited.add(currentId);
      const node: { id: string; parentFolderId: string | null } | null = await tx.folder.findUnique(
        {
          where: { id: currentId },
          select: { id: true, parentFolderId: true },
        },
      );
      if (!node) break;
      ids.push(node.id);
      currentId = node.parentFolderId;
      guard += 1;
    }
    return { ids, cycle: false };
  }

  /**
   * フォルダの reparent を「存在・循環・同名衝突の検証 + sortOrder 採番 + 書き込み」まで単一 tx で原子的に行う。
   * 検証と書き込みを別クエリに分けると、検証後・書き込み前に別操作が割り込む TOCTOU 窓（循環/同名）が残る。
   * READ COMMITTED の単一 tx では「祖先チェーン読取り後に別 tx が親を付け替えて循環を作る」「ルート直下 NULL の
   * 同名衝突を findFirst で見た後に別 tx が同名を挿入する（@@unique は NULL を等値比較せず効かない）」窓が残るため、
   * Serializable（SSI）+ P2034 リトライで閉じる（runInSerializableTransaction 共通ヘルパ）。HTTP 例外は投げず
   * result union を返し、Service が文言付き例外へ翻訳する（§4 エラー一元化・repo は DB と整合判定に専念。FB-2b レビュー由来の負債返済）。
   *
   * expectedParentFolderId は公開範囲ガード（assertFolderMoveAllowed）が判定に使った「移動元の親」。
   * ガード判定と書き込みの間に別リクエストが対象フォルダを別の親へ先に移すと、ガードの判定は古い構造に
   * 基づくものになる（fil-0115）。tx 内の一致確認に加えて、更新自体も id と判定時の親の両方を条件にし、
   * 確認と更新の間に割り込まれた場合も count=0 で stale に倒す（fil-0113 のファイル移動側と同型）。
   */
  moveFolderAtomic(
    id: string,
    parentFolderId: string | null,
    expectedParentFolderId: string | null,
  ): Promise<MoveFolderResult> {
    return runInSerializableTransaction(this.prisma, async (tx) => {
      const folder = await tx.folder.findUnique({ where: { id } });
      if (!folder) {
        return { ok: false, reason: 'not_found' } as const;
      }
      // 判定時の親と現在の親が食い違えば stale。no-op より先に判定する（移動先が現在の親と同じでも、
      // ガード判定時から親が変わっているなら古い判定で通してはならない・criteria 5）。
      if (folder.parentFolderId !== expectedParentFolderId) {
        return { ok: false, reason: 'stale' } as const;
      }
      // 現在の親と同じ（null 同士のルート据え置きを含む）なら no-op で現状を返す（書き込みなし）。
      if (folder.parentFolderId === parentFolderId) {
        return { ok: true, folder } as const;
      }
      // 移動後の対象深さ（新親チェーン + 対象自身。ルート直下は 1）。
      let targetDepth = 1;
      if (parentFolderId !== null) {
        if (parentFolderId === id) {
          return { ok: false, reason: 'self' } as const;
        }
        const target = await tx.folder.findUnique({ where: { id: parentFolderId } });
        if (!target) {
          return { ok: false, reason: 'target_not_found' } as const;
        }
        // 移動先の祖先チェーン（移動先自身を含む）に対象 id があれば、対象の子孫へ移そうとしている。
        const ancestorWalk = await this.walkAncestorIdsTx(tx, parentFolderId);
        if (ancestorWalk.ids.includes(id)) {
          return { ok: false, reason: 'cycle' } as const;
        }
        // 循環データ（祖先チェーンが閉じた）は深さ無限＝超過として移動を拒否する（fil-0118・fail-closed）。
        if (ancestorWalk.cycle) {
          return { ok: false, reason: 'depth_exceeded' } as const;
        }
        targetDepth = ancestorWalk.ids.length + 1;
        // 移動後の対象深さが上限を超えるなら書き込まない（fil-0118 criteria 7）。
        if (targetDepth > FOLDER_MAX_DEPTH) {
          return { ok: false, reason: 'depth_exceeded' } as const;
        }
      }
      // 対象サブツリーの最深子孫まで評価する（fil-0118 criteria 7）。移動後の対象深さにサブツリーの
      // 深さを足して上限を超えるなら depth_exceeded。走査は残余深さまでで超過検出時に即終了し、
      // 循環データでも visited で停止する。
      // deepest は「対象を根とする部分木の最大深さ（対象自身 = 1）」。移動後の最深ノードの深さは
      // targetDepth - 1 + deepest（対象自身の深さ targetDepth が deepest の 1 と重複する）なので、
      // 上限は deepest ≤ FOLDER_MAX_DEPTH - targetDepth + 1。maxDepth も同じ式で渡す（fil-0118 review）。
      const subtree = await this.measureSubtreeDepthTx(tx, id, FOLDER_MAX_DEPTH - targetDepth + 1);
      // 循環サブツリー（子はいるが全て訪問済み）は深さ無限＝超過として移動を拒否する（fil-0147・
      // walkAncestorIdsTx の cycle と同じ fail-closed）。cycle を返せないと浅い depth で上限をすり抜ける。
      if (subtree.cycle) {
        return { ok: false, reason: 'depth_exceeded' } as const;
      }
      if (targetDepth - 1 + subtree.depth > FOLDER_MAX_DEPTH) {
        return { ok: false, reason: 'depth_exceeded' } as const;
      }
      // 同名衝突（ルート直下 NULL は @@unique が効かないため findFirst で app チェック）。
      // 器（spaceId）も条件に入れる（ADR 0063・設計書 §1.4）。移動は同一器内に限られる（service 層で
      // 強制）ので対象自身の spaceId が移動先の器と等しく、これで移動先ルートの名前空間と一致する。
      const dup = await tx.folder.findFirst({
        where: { parentFolderId, name: folder.name, spaceId: folder.spaceId },
      });
      if (dup && dup.id !== id) {
        return { ok: false, reason: 'duplicate' } as const;
      }
      const agg = await tx.folder.aggregate({
        where: { parentFolderId, spaceId: folder.spaceId },
        _max: { sortOrder: true },
      });
      const sortOrder = (agg._max.sortOrder ?? -1) + 1;
      // 更新条件に判定時の親を含める（確認と更新の間に別の移動が割り込んだ場合は count=0 → stale）。
      const updated = await tx.folder.updateMany({
        where: { id, parentFolderId: expectedParentFolderId },
        data: { parentFolderId, sortOrder },
      });
      if (updated.count === 0) {
        return { ok: false, reason: 'stale' } as const;
      }
      // updateMany は count しか返さないため、最新のフォルダを読み直して返す。
      const moved = await tx.folder.findUnique({ where: { id } });
      if (!moved) {
        // count=1 を確認した直後で理論上到達不能。型を満たすための保険。
        return { ok: false, reason: 'not_found' } as const;
      }
      return { ok: true, folder: moved } as const;
    });
  }

  /**
   * 対象を根とする部分木の最大深さ（対象自身 = 1）を測る（fil-0118 criteria 7・moveFolderAtomic の深さ検査）。
   * maxDepth までで十分で、残余を超える子が存在した時点で maxDepth+1 を返して即終了する（超過検出）。
   * 循環データでも visited で停止する（同じ子孫を二度辿らない）。段ごとに子を 1 クエリでまとめて引く。
   * 戻り値の cycle は「子はいるが全て訪問済み（＝輪）」を呼び出し元へ伝える（fil-0147・walkAncestorIdsTx と同型の fail-closed）。
   */
  private async measureSubtreeDepthTx(
    tx: Prisma.TransactionClient,
    rootId: string,
    maxDepth: number,
  ): Promise<{ depth: number; cycle: boolean }> {
    let frontier: string[] = [rootId];
    let depth = 1;
    const visited = new Set(frontier);
    while (frontier.length > 0 && depth < maxDepth) {
      const children = await tx.folder.findMany({
        where: { parentFolderId: { in: frontier } },
        select: { id: true },
      });
      const fresh = children.map((c) => c.id).filter((id) => !visited.has(id));
      if (fresh.length === 0) {
        // 子が無い（葉）は cycle=false・子はいるが全て訪問済み（輪）は cycle=true で区別して返す。
        // cycle を伝えられないまま浅い depth だけ返すと、循環サブツリーが深さ上限をすり抜ける（fil-0130 M2）。
        return { depth, cycle: children.length > 0 };
      }
      fresh.forEach((id) => visited.add(id));
      depth += 1;
      frontier = fresh;
    }
    if (frontier.length > 0 && depth >= maxDepth) {
      // 残余ちょうどまで到達した。この段の子が 1 つでも残っていれば超過（走査はここで終了）。
      // 注意: ここは cycle を検査しない（子が cycle-back ポインタでも depth=maxDepth+1 で返す）。
      // 唯一の呼び出し元は depth の算術比較で必ず拒否するため fail-closed は維持される（fil-0147 review・
      // maxDepth 未満の循環のみ cycle=true として検出される）。
      const hasChild = await tx.folder.findFirst({
        where: { parentFolderId: { in: frontier } },
        select: { id: true },
      });
      if (hasChild) {
        return { depth: maxDepth + 1, cycle: false };
      }
    }
    return { depth, cycle: false };
  }

  /**
   * ファイルの所属フォルダ変更を「存在・同名衝突の検証 + 書き込み」まで単一 tx で原子的に行う。
   * ファイルは moveFolderAtomic と異なり循環の概念がなく、同名衝突は @@unique([folderId, name]) が DB レベルで
   * 担保する（folderId は NOT NULL のため NULL 等値比較問題もない）。よって findUnique の事前チェックは早期 409 の
   * UX 用で、検証→書き込みの間に別 tx が同名を挿入しても update 時 P2002 を global PrismaExceptionFilter が 409 化する。
   * この backstop があるため Serializable は不要で、既定の READ COMMITTED で十分（moveFolderAtomic との差分）。
   *
   * expectedSourceFolderId は公開範囲ガード（assertFileMoveAllowed）が判定に使った「移動元フォルダ」。
   * ガード判定と書き込みの間に別リクエストが同じファイルを別のフォルダへ先に移すと、ガードの判定は古い移動元に
   * 基づくものになる（fil-0113 criteria 7）。tx 内の一致確認に加えて、更新自体も id と移動元の両方を条件にし、
   * 確認と更新の間に割り込まれた場合も count=0 で stale に倒す（フォルダ移動側 moveFolderAtomic と同型）。
   */
  moveFileAtomic(
    id: string,
    folderId: string,
    expectedSourceFolderId: string,
  ): Promise<MoveFileResult> {
    return this.prisma.$transaction(async (tx) => {
      const file = await tx.file.findUnique({ where: { id } });
      if (!file) {
        return { ok: false, reason: 'not_found' } as const;
      }
      // 判定時の移動元と現在の移動元が食い違えば stale。no-op より先に判定する（移動先が現在の移動元と
      // 同じでも、ガード判定時から移動元が変わっているなら古い判定で通してはならない・criteria 7）。
      if (file.folderId !== expectedSourceFolderId) {
        return { ok: false, reason: 'stale' } as const;
      }
      // 現在と同じフォルダなら no-op で現状を返す（書き込みなし）。
      if (file.folderId === folderId) {
        return { ok: true, file } as const;
      }
      const target = await tx.folder.findUnique({ where: { id: folderId } });
      if (!target) {
        return { ok: false, reason: 'target_not_found' } as const;
      }
      const dup = await tx.file.findUnique({
        where: { folderId_name: { folderId, name: file.name } },
      });
      if (dup && dup.id !== id) {
        return { ok: false, reason: 'duplicate' } as const;
      }
      // 更新条件に判定時の移動元を含める（確認と更新の間に別の移動が割り込んだ場合は count=0 → stale）。
      const updated = await tx.file.updateMany({
        where: { id, folderId: expectedSourceFolderId },
        data: { folderId },
      });
      if (updated.count === 0) {
        // fil-0146: 更新 0 件の原因を区別する。対象が既に消えていれば「見つかりません」、
        // 残っているのに条件不一致なら「他の人と衝突しました」。
        const still = await tx.file.findUnique({ where: { id } });
        if (still == null) {
          return { ok: false, reason: 'not_found' } as const;
        }
        return { ok: false, reason: 'stale' } as const;
      }
      // updateMany は count しか返さないため、最新のファイルを読み直して返す。
      const moved = await tx.file.findUnique({ where: { id } });
      if (!moved) {
        // count=1 を確認した直後で理論上到達不能。型を満たすための保険。
        return { ok: false, reason: 'not_found' } as const;
      }
      return { ok: true, file: moved } as const;
    });
  }

  /**
   * 指定親グループ（parentFolderId）内の同名フォルダを引く（移動先での衝突チェック用）。
   * parentFolderId=null（ルート直下）は @@unique([parentFolderId, name]) が NULL を等値比較しないため
   * 一意制約で弾けない。よって本 findFirst による app 層チェックで担保する（schema コメントの方針どおり）。
   *
   * spaceId（ADR 0063・設計書 §1.4）: ルート直下は器ごとに独立した名前空間なので、器を条件へ入れないと
   * 別の器のルート名と衝突扱いになる（他の器の存在が 409 で漏れる＝存在秘匿にも反する）。非ルートでは
   * 親が器を一意に決めるため条件は冗長だが、経路で条件が割れないよう常に付ける。
   */
  findFolderByParentAndName(
    parentFolderId: string | null,
    name: string,
    spaceId: string,
  ): Promise<Folder | null> {
    return this.prisma.folder.findFirst({ where: { parentFolderId, name, spaceId } });
  }

  /**
   * 新規フォルダを Serializable tx で原子的に作成する（fil-0118 criteria 6）。作成後チェーン
   * （親 → root + 新規ノード自身）が FOLDER_MAX_DEPTH 以内の時だけ書き込み、101 なら depth_exceeded で
   * 書き込まない。Serializable（SSI）+ P2034 リトライで「深さ検査後に別 tx が親チェーンを深くする」
   * 「service 層の同名チェック後に同名が挿入される」窓を閉じる（moveFolderAtomic と同型）。
   * id は schema の @default(uuid()) に委ね、sortOrder は **tx 内で採番する**（fil-0150・LOW10）:
   * 兄弟グループ（parentFolderId + spaceId）の max+1 を同名確認と同じ述語範囲で読み、SSI の読み取り集合に
   * 入れることで、並行作成の片方が P2034 で abort → リトライで新しい max を読む（同値が付かない）。
   * サービス層の tx 外採番（getMaxFolderSortOrder）はこの変更で撤去した（孤立メソッドも削除）。
   * 表示順規則（max+1・既存兄弟の振り直しなし）は不変。
   * 同名衝突は service 層の app チェック（findFolderByParentAndName）が一次防御（409 を深さ 400 より先に保つ・
   * criteria 6）で、@@unique([parentFolderId, name]) が backstop（ルート直下 NULL は一意制約が効かない
   * ため app チェックのみが担保）。
   */
  createFolder(params: {
    name: string;
    parentFolderId: string | null;
    createdById: string;
    /**
     * ルート直下（parentFolderId=null）に作る時の帰属器（ADR 0063 / fil-0135）。子フォルダは
     * この値ではなく**親の spaceId を継承**する（親子で器が食い違わないための app 層強制・
     * 設計書 §1.5）。API から器を受け取る契約化（CreateFolderDto.spaceId）は fil-0136。
     */
    spaceId: string;
  }): Promise<CreateFolderResult> {
    return runInSerializableTransaction(this.prisma, async (tx) => {
      let spaceId = params.spaceId;
      if (params.parentFolderId !== null) {
        const parent = await tx.folder.findUnique({ where: { id: params.parentFolderId } });
        if (!parent) {
          return { ok: false, reason: 'parent_not_found' } as const;
        }
        // 親から器を継承する（ツリー内で spaceId が割れない・設計書 §1.5）。呼び出し側との食い違いは
        // service 層が先に space_mismatch → 400 で弾く（move の cross-Space 400 と対称・設計書 §5.1）ので、
        // ここへ届く時点で両者は一致している。tx 内で親を読み直すのは、判定と作成の間に親が別の器へ
        // 移る余地を残さないため（同一 tx が Serializable なので継承値は必ず整合する）。
        spaceId = parent.spaceId;
        // 作成後チェーン深さの検査（親チェーン + 新規ノード自身）。循環は深さ無限＝超過として拒否。
        const walk = await this.walkAncestorIdsTx(tx, params.parentFolderId);
        if (walk.cycle || walk.ids.length + 1 > FOLDER_MAX_DEPTH) {
          return { ok: false, reason: 'depth_exceeded' } as const;
        }
      }
      // tx 内でも同名を再確認（service 層チェックとの間の並行挿入を SSI で検出・深さ 400 より先に保つ）。
      // **ルート直下（parentFolderId=null）でも必ず実行する**: ルートは @@unique が NULL を等値比較せず
      // 効かないため、tx 内に述語読み取りが 1 つも無いと SSI が読み書き競合を検出できず、同名ルートの
      // 同時作成が両方 commit してしまう（fil-0136 の database-reviewer 指摘・以前は本チェックが
      // 親ありブランチの中にあった）。tx 内へ移すと SSI が読み書き競合を検出し、P2034 リトライ →
      // duplicate へ落ちる。DB 側 backstop（`(space_id, name) WHERE parent_folder_id IS NULL` の
      // 部分一意 index）は Prisma schema で表現できず migrate diff に drift として出るため採らない。
      const dup = await tx.folder.findFirst({
        where: { parentFolderId: params.parentFolderId, name: params.name, spaceId },
      });
      if (dup) {
        return { ok: false, reason: 'duplicate' } as const;
      }
      // sortOrder 採番（fil-0150・LOW10）: 兄弟グループの max+1 を同名確認と同じ述語範囲で読む。
      // 並行作成時は片方の tx が P2034 で abort → リトライで新しい max を読むため同値が付かない
      // （SSI の読み取り集合にこの aggregate が入る・moveFolderAtomic と同型）。
      const agg = await tx.folder.aggregate({
        where: { parentFolderId: params.parentFolderId, spaceId },
        _max: { sortOrder: true },
      });
      const sortOrder = (agg._max.sortOrder ?? -1) + 1;
      const folder = await tx.folder.create({
        data: {
          name: params.name,
          parentFolderId: params.parentFolderId,
          sortOrder,
          spaceId,
          // 作成者を記録する（監査用。ADR 0063 で暗黙 MANAGE の意味は失い、FileVersion.uploadedById と
          // 対称な「誰が作ったか」の記録として残す・設計書 §3）。
          createdById: params.createdById,
        },
      });
      return { ok: true, folder } as const;
    });
  }

  // --- タグ付与（rete-files-0006: FileTag 多対多の置換）---

  /** 最新版 + アップロード者名 + 付与タグ込みで File を引く（タグ置換後の行返却用）。 */
  findFileWithTags(id: string): Promise<FileWithLatestVersion | null> {
    return this.prisma.file.findUnique({
      where: { id },
      include: latestVersionInclude,
    });
  }

  /** 指定 tagId 群のうち実在する件数を返す（付与前の存在検証用 / 呼び出し側は重複排除済の前提）。 */
  countTagsByIds(tagIds: string[]): Promise<number> {
    if (tagIds.length === 0) {
      return Promise.resolve(0);
    }
    return this.prisma.tag.count({ where: { id: { in: tagIds } } });
  }

  /**
   * ファイルの付与タグ集合を tagIds で全置換する（全消し → 再作成を単一トランザクションで原子的に）。
   * 呼び出し側で file 存在・tagId 実在・重複排除を検証済の前提（本メソッドは整合性の最終書き込みに専念）。
   * 空配列なら全解除（createMany をスキップ）。FileTag の @@id([fileId, tagId]) が同一付与の重複を backstop。
   */
  setFileTags(fileId: string, tagIds: string[]): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await tx.fileTag.deleteMany({ where: { fileId } });
      if (tagIds.length > 0) {
        await tx.fileTag.createMany({
          data: tagIds.map((tagId) => ({ fileId, tagId })),
        });
      }
    });
  }

  // --- フォルダタグ付与（rete-files-0033: FolderTag 多対多・FileTag と対称）---

  /** 付与タグ込みで Folder を引く（タグ置換後の行返却用・findFileWithTags のフォルダ版）。 */
  findFolderWithTags(id: string): Promise<FolderWithTags | null> {
    return this.prisma.folder.findUnique({
      where: { id },
      include: folderWithTagsInclude,
    });
  }

  /**
   * フォルダの付与タグ集合を tagIds で全置換する（setFileTags のフォルダ版・全消し→再作成を単一 tx で原子的に）。
   * 呼び出し側で folder 存在・tagId 実在・重複排除を検証済の前提。空配列なら全解除。
   * FolderTag の @@id([folderId, tagId]) が同一付与の重複を backstop。
   */
  setFolderTags(folderId: string, tagIds: string[]): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await tx.folderTag.deleteMany({ where: { folderId } });
      if (tagIds.length > 0) {
        await tx.folderTag.createMany({
          data: tagIds.map((tagId) => ({ folderId, tagId })),
        });
      }
    });
  }

  // --- 一括タグ付与（rete-files-0034: 複数ファイル/フォルダへ追加方式で付与）---

  /**
   * 複数ファイル / フォルダへタグを追加・解除する（fil-0048: add+remove 1tx 対応）。
   * add は createMany skipDuplicates（既存ペアを温存・rete-files-0034 継承）、remove は deleteMany。
   * ファイル側・フォルダ側の add/remove 全操作を単一 $transaction で原子化し、部分適用を防ぐ（H-2）。
   * 呼び出し側で id 群の実在を検証済の前提。addTagIds と removeTagIds の両方が空なら no-op。
   */
  assignTagsBatch(
    fileIds: string[],
    folderIds: string[],
    addTagIds: string[],
    removeTagIds: string[],
  ): Promise<void> {
    const hasTargets = fileIds.length > 0 || folderIds.length > 0;
    const hasOps = addTagIds.length > 0 || removeTagIds.length > 0;
    if (!hasTargets || !hasOps) return Promise.resolve();

    return this.prisma.$transaction(async (tx) => {
      if (addTagIds.length > 0) {
        if (fileIds.length > 0) {
          await tx.fileTag.createMany({
            data: fileIds.flatMap((fileId) => addTagIds.map((tagId) => ({ fileId, tagId }))),
            skipDuplicates: true,
          });
        }
        if (folderIds.length > 0) {
          await tx.folderTag.createMany({
            data: folderIds.flatMap((folderId) => addTagIds.map((tagId) => ({ folderId, tagId }))),
            skipDuplicates: true,
          });
        }
      }
      if (removeTagIds.length > 0) {
        if (fileIds.length > 0) {
          await tx.fileTag.deleteMany({
            where: { fileId: { in: fileIds }, tagId: { in: removeTagIds } },
          });
        }
        if (folderIds.length > 0) {
          await tx.folderTag.deleteMany({
            where: { folderId: { in: folderIds }, tagId: { in: removeTagIds } },
          });
        }
      }
    });
  }

  // 一括付与前の存在検証用 countFilesByIds / countFoldersByIds は fil-0146 で撤去した。
  // 実在検証は findFileSpaceRefs / findFolderSpaceIds の取得件数照合へ統合（クエリ形を入力のみに
  // 依存させ、count 先落ちの逆転 oracle を作らないため）。

  // --- 削除（Phase FB-4: ファイル / 空フォルダ削除）---

  /**
   * File を全版（FileVersion）付きで引く。削除時に各版の storageKey を集めて実体削除するために使う。
   * 表示用 include（最新 1 件 + uploader）と異なり、全版の storageKey が必要なため take 制限なし。
   * 所属フォルダの spaceId も同時に返す（fil-0146: 可視範囲評価の素材）。
   */
  findFileWithAllVersions(
    id: string,
  ): Promise<(File & { versions: FileVersion[]; folder: FolderSpaceOnly }) | null> {
    return this.prisma.file.findUnique({
      where: { id },
      include: { versions: true, folder: { select: { spaceId: true } } },
    });
  }

  /**
   * File を削除する。FileVersion は schema の onDelete:Cascade で連鎖削除される（DB レコードのみ）。
   * 実体（blob）は app 層（StorageService）の責務のため、呼び出し側が別途削除する。
   */
  deleteFile(id: string): Promise<File> {
    return this.prisma.file.delete({ where: { id } });
  }

  /**
   * 空フォルダのみを原子的に削除する。子（サブフォルダ + ファイル）の count と folder.delete を
   * Serializable(SSI) の単一トランザクションで実行し、「空確認 → 削除」の間に子が割り込む TOCTOU を閉じる。
   * 子が 1 件でもあれば削除せず { deleted: false } を返す（Service が Conflict に変換する）。
   *
   * READ COMMITTED ではこの窓が実在する（実 PostgreSQL で実測）: count が空と判定した後に別 tx が
   * 子 C + 孫 G + ファイルを commit すると、delete の複合自己 FK（folders_parent_folder_id_space_id_fkey
   * ・onDelete: Cascade）が count の見ていない孫まで連鎖削除し、F/C/G/ファイルの全てが消えた。
   * SSI では同じ並行挿入が delete 時に 40001（Prisma P2034）になり、共通ヘルパのリトライ後の再 count が
   * 子を見て { deleted: false } へ落ちる＝「空でないフォルダは消せない」不変条件が同時実行でも守られる。
   *
   * tx オプションは対話保存セット（INTERACTIVE_SAVE_TX_OPTIONS）を使う（cmn-0347）: 画面から 1 件を
   * 消す操作に 500 件想定の既定タイマー（15s×3）を被せると、混雑時に接続を長く保持してプール枯渇を
   * 押す側へ回るため。直列化の所作（timeout / maxWait / 時間予算 / P2034 リトライ）は共通ヘルパが正本。
   */
  deleteEmptyFolder(id: string): Promise<{ deleted: boolean }> {
    // 直に $transaction を呼ぶと P2034 リトライ・時間予算・warn が効かない経路が復活する（cmn-0251）。
    return runInSerializableTransaction(
      this.prisma,
      async (tx) => {
        const [subfolders, files] = await Promise.all([
          tx.folder.count({ where: { parentFolderId: id } }),
          tx.file.count({ where: { folderId: id } }),
        ]);
        if (subfolders + files > 0) {
          return { deleted: false };
        }
        await tx.folder.delete({ where: { id } });
        return { deleted: true };
      },
      INTERACTIVE_SAVE_TX_OPTIONS,
    );
  }

  // --- 設定（Phase FB-3: 単一行 singleton）---

  /** ファイル設定（単一行 singleton）を引く。未設定なら null。 */
  findSettings(): Promise<FileSettings | null> {
    return this.prisma.fileSettings.findUnique({
      where: { id: FILE_SETTINGS_SINGLETON_ID },
    });
  }

  /**
   * ファイル設定を部分 upsert する（単一行 singleton）。
   * update では undefined フィールドが Prisma により更新スキップされ既存値を保持するため、read-modify-write
   * 不要で原子的（同時更新でも未指定フィールドのロストアップデートが起きない）。新規行（create）のみ
   * 未指定フィールドを既定値で補完する（NOT NULL 列を埋めるため）。
   */
  upsertSettings(patch: FileSettingsPatch): Promise<FileSettings> {
    return this.prisma.fileSettings.upsert({
      where: { id: FILE_SETTINGS_SINGLETON_ID },
      create: {
        id: FILE_SETTINGS_SINGLETON_ID,
        maxSizeBytes: patch.maxSizeBytes ?? BigInt(DEFAULT_MAX_SIZE_BYTES),
        allowedExtensions: patch.allowedExtensions ?? [],
        rejectedExtensions: patch.rejectedExtensions ?? [...DEFAULT_REJECTED_EXTENSIONS],
      },
      update: {
        maxSizeBytes: patch.maxSizeBytes,
        allowedExtensions: patch.allowedExtensions,
        rejectedExtensions: patch.rejectedExtensions,
      },
    });
  }
}
