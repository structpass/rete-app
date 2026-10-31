import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Folder } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { extname, resolve, sep } from 'path';
import { Readable } from 'stream';
import { ok } from '../../common/dto';
import { FilesRepository, NewVersionData } from './repositories/files.repository';
import { ScopeVisibilityService } from '../memberships/scope-visibility.service';
import { StorageService } from './storage/storage.service';
import { UpdateFileSettingsDto } from './dto/files-settings.dto';
import {
  toFolderTree,
  toFolderContent,
  toUploadedFileRow,
  toFileRow,
  toFolderRow,
  toFileSettings,
  toMovedFolder,
  toMovedFile,
  toCreatedFolder,
  toSearchFolderItem,
  toSearchFileItem,
  toFileMeta,
} from './files.mapper';
import { BatchAssignTagsDto } from './dto/tag-assignment.dto';
import {
  BATCH_TARGET_NOT_FOUND_MESSAGE,
  FIXED_REJECTED_EXTENSIONS,
  FOLDER_DEPTH_EXCEEDED_MESSAGE,
  FOLDER_MOVE_CYCLE_MESSAGE,
  FOLDER_MOVE_SELF_MESSAGE,
  REF_PATH_SEP,
  SEARCH_RESULT_LIMIT,
  SINGLE_TARGET_NOT_FOUND_MESSAGE,
  resolveUploadTempDir,
} from './files.constants';
import { formatFileSize } from '../../common/text/file-size';
import { checkUploadSignature } from './upload-signature';
import { collectRefAncestors, parseRefIds, refPath, spaceIdOfRef } from './refpath2';

/**
 * File タブの操作主体（ADR 0063）。可視性判定に要るのは accountId だけになった
 * （Space membership が唯一の判定入力＝system Role の全フォルダバイパスは廃止・業務ロール付与も廃止）。
 * 旧 AclUser（id / role / businessRoleId）の後継。
 */
interface FileUser {
  id: string;
}

// 監査記録の型（AuditingUser / AuditClientInfo / feature ラベル）は ADR 0063 で撤去した。
// files で明示的に監査していたのはディレクトリ権限の変更（fil-0100）だけで、権限そのものが無くなった。

/**
 * アップロードで受け取るファイルの最小形（multer の Express.Multer.File と構造互換）。
 * diskStorage（fil-0121）では `path`（一時ファイルの絶対パス）が入り `buffer` は空。memoryStorage 由来の
 * 呼び出し（テスト・後方互換）では `path` が無く `buffer` が入る。保存ソースは path 優先で解決する。
 */
export interface UploadFileInput {
  originalname: string;
  buffer: Buffer;
  size: number;
  mimetype: string;
  /** diskStorage が受けた一時ファイルの絶対パス（memoryStorage 経路では undefined）。 */
  path?: string;
}

/** ダウンロード応答の素材（controller が StreamableFile に包む）。 */
export interface FileDownload {
  stream: Readable;
  mimeType: string;
  fileName: string;
}

/**
 * multipart のファイル名を「保存・検索・拡張子判定に使える安全な UTF-8 basename」へ正規化する。
 *
 * 1. 文字コード復元: multer（FileInterceptor）は filename を latin1 でデコードするため、日本語など
 *    非 ASCII 名は「UTF-8 バイト列を latin1 として読んだ」化けた文字列で届く（の→ã®）。全 codepoint
 *    が 0xFF 以下なら raw バイト列とみなし UTF-8 で読み直す。codepoint > 0xFF を含む文字列は既に正規
 *    UTF-8 とみなしそのまま扱う（二重デコードで壊さない）。
 *    既知の限界: latin1 ネイティブ名（例 `café.txt`）も全 codepoint ≤ 0xFF のため UTF-8 で読み直され
 *    U+FFFD 混入で化けうる。現実の multer 経路では UTF-8 名しか来ないため実害なしとして許容する。
 * 2. パストラバーサル/制御文字除去: 区切り（`/` `\`）で分割した末尾要素（basename）だけを採り、`../`
 *    や絶対パスを `name` 列・拡張子判定・Content-Disposition へ伝播させない。C0 制御文字（null 含む）
 *    と DEL を除去し、拡張子判定 bypass（`evil.pdf\0.js`）やヘッダ汚染を断つ。storageKey は UUID 由来
 *    のため FS 書き込み先は元から安全だが、表示・検索・DL ヘッダへ流れる name 入口をここで塞ぐ。
 *
 * サニタイズ後に空になりうる（`../` 等）。呼び出し側で空判定し弾くこと。
 */
export function normalizeUploadFilename(name: string): string {
  let normalized = name;
  let isLatin1Bytes = true;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized.charCodeAt(i) > 0xff) {
      isLatin1Bytes = false;
      break;
    }
  }
  if (isLatin1Bytes) {
    normalized = Buffer.from(normalized, 'latin1').toString('utf8');
  }
  // パス区切りで割った末尾＝basename。制御文字（C0 + DEL）を除去し前後空白を詰める。
  const base = normalized.split(/[/\\]/).pop() ?? '';
  return base.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/**
 * 拡張子の判定に使う「OS が実際に作る名前」を求める（v2-197 の独立レビュー指摘 F1）。
 *
 * 拒否/許可の一覧は名前の末尾で判定するが、生の名前で比較すると一覧で止めている実行可能な名前が
 * 末尾に 1 文字足すだけで通り抜ける。Windows は保存時に末尾のドットと空白を落とし（`evil.bat.` は
 * `evil.bat` として作られる）、`:` 以降は NTFS の代替データストリーム指定として扱う（`evil.bat::$DATA`
 * は `evil.bat` の中身そのもの）。テキストのスクリプト（.ps1 / .bat / .cmd）は内容署名では検出できない
 * ため、この一覧が唯一の防御層になる。保存・表示に使う name は変えず、判定だけをこの正規化名で行う。
 */
export function extensionDecisionName(name: string): string {
  return name.split(':')[0].replace(/[. ]+$/, '');
}

/**
 * 判定名から拡張子（小文字・先頭ドット付き）を求める。拡張子が無ければ空文字。
 *
 * extname は先頭ドットだけの名前（`.ps1`）を「拡張子なし」と返すが、一覧に載っている形式を名前ごと
 * 置けなくするため、名前全体が拡張子の形ならそれ自体を拡張子として扱う（判定名が空なら空を返す）。
 */
export function extensionForDecision(name: string): string {
  const decisionName = extensionDecisionName(name);
  const ext = extname(decisionName).toLowerCase();
  if (ext) {
    return ext;
  }
  return /^\.[A-Za-z0-9]+$/.test(decisionName) ? decisionName.toLowerCase() : '';
}

/**
 * フォルダ名を保存・表示に安全な形へ正規化する。フォルダは FS 実体を持たず DB の表示ラベルだが、
 * パンくず/パスリンク表示や DL ヘッダ生成へ流れるため、C0 制御文字（null 含む）と DEL を除去し前後空白を
 * 詰める。アップロード名（normalizeUploadFilename）と異なり JSON body 由来で latin1 化けは無いため
 * 文字コード復元は行わない。サニタイズ後に空になりうる（空白のみ等）ため、呼び出し側で空判定し弾く。
 */
export function sanitizeFolderName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/**
 * パンくず（root → 対象の順・対象自身を末尾に含む）を、同一 space の全フォルダから組む（ADR 0063）。
 * 旧実装（FolderAclService.resolveFolderView）は祖先ごとに可視/非可視が割れるため最初の非可視祖先で
 * 打ち切っていたが、統合後は同一 space 内で可視性が一様になり、常に root まで辿れる。
 *
 * 循環データ（本来 repository の深さ検査が防ぐ）で無限ループしないよう、訪問済み id で打ち切る。
 */
function buildCrumb(folder: Folder, foldersInSpace: Folder[]): { id: string; name: string }[] {
  const byId = new Map(foldersInSpace.map((f) => [f.id, f]));
  const crumb: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let cursor: Folder | undefined = folder;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    crumb.unshift({ id: cursor.id, name: cursor.name });
    cursor = cursor.parentFolderId ? byId.get(cursor.parentFolderId) : undefined;
  }
  return crumb;
}

/**
 * File タブのアプリケーションサービス。検証 + オーケストレーションのみを担い、DB アクセスは
 * FilesRepository 経由（§2）、Entity→DTO 変換は mapper（§1）、実体保存は StorageService 抽象に委ねる。
 *
 * 可視性（ADR 0063・fil-0136）の enforcement は本層に集約する（guard に DB を持ち込まない・
 * architecture-invariants §4）。判定主体は Desk の ScopeVisibilityService で、規則は
 * 「チャネル可視＝配下ファイル可視」の 1 段だけ（VIEW/EDIT/MANAGE の段階権限は撤廃＝見えるなら使える）。
 * 非可視 space の folder / file は一覧・検索・ツリーから除外し、直接アクセスは 404
 * （存在秘匿・ADR 0038 準拠。文言は「存在しない」時と必ず揃える）。
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly repo: FilesRepository,
    private readonly storage: StorageService,
    private readonly scope: ScopeVisibilityService,
  ) {}

  /**
   * 呼び出し元が可視な Space id 集合（ADR 0063）。ScopeVisibilityService は RequestCache
   * （AsyncLocalStorage）で同一リクエスト・同一 accountId の 2 回目以降を再利用するため、
   * 本メソッドを複数回呼んでも DB 往復は 1 リクエスト 1 回に収まる。
   */
  private async visibleSpaceIds(user: FileUser): Promise<Set<string>> {
    return new Set(await this.scope.resolveVisibleSpaceIds(user.id));
  }

  /**
   * 指定フォルダが可視 space に属することを確かめ、フォルダ行を返す（旧 acl.assertLevel の後継）。
   * **不在と非可視は同一文言の 404** で返す（文言差がそのまま存在の oracle になるため・ADR 0038）。
   *
   * fil-0146: 可視範囲の取得をフォルダ存在確認の**前**へ移す（timing oracle 残差の解消）。不在の枝も
   * 非可視の枝と同じ visibleSpaceIds の評価を通ってから 404 を投げるため、応答経路の同期コストは
   * 両枝とも「可視範囲 1 回 + 存在確認 1 回」で同一＝応答時間から存在を推測できない。
   * 非可視（存在するが見えない）の記録は warn 1 行で残すが、404 応答パスの同期コストに載せず
   * 応答後に非同期で書く（warn 書き出し時間が oracle に戻らないようにする・不在は記録しない＝
   * 打ち間違いの掃き溜めで本物の探索を埋めない・set-0034 の形）。※「不在は記録しない」は本
   * サービス層の warn の話で、フィルタ層の 404 warn（http-exception.filter.ts・fil-0157）は
   * 応答として 404 が返った事実を全件 1 行で記録する＝レイヤーが違う（IDOR 探索の痕跡用）。
   */
  private async assertFolderAccessible(
    user: FileUser,
    folderId: string,
    message: string,
  ): Promise<Folder> {
    const spaces = await this.visibleSpaceIds(user);
    const folder = await this.repo.findFolderById(folderId);
    if (!folder) {
      throw new NotFoundException(message);
    }
    if (!spaces.has(folder.spaceId)) {
      setImmediate(() => {
        this.logger.warn(`FOLDER_NOT_VISIBLE: folderId=${folderId} userId=${user.id}`);
      });
      throw new NotFoundException(message);
    }
    return folder;
  }

  /**
   * file 起点経路の標準形（assertFolderAccessible のファイル版・fil-0146）。可視範囲の取得を対象取得より
   * 先に済ませ、不在・非可視の両枝が「可視範囲 1 回＋対象取得 1 回」の同一コスト・同一文言の 404 になる
   * （応答時間・文言のどちらからも存在を推測できない・ADR 0038）。対象の取得は呼び出し元が渡す
   * （経路ごとに include が異なるため）。非可視の warn は assertFolderAccessible と同じく応答パスの外
   * （setImmediate）で残し、不在は記録しない。
   */
  private async findFileTargetAccessible<T>(
    user: FileUser,
    message: string,
    find: () => Promise<T | null>,
    folderRefOf: (target: T) => { folderId: string; spaceId: string },
  ): Promise<T> {
    const spaces = await this.visibleSpaceIds(user);
    const target = await find();
    if (!target) {
      throw new NotFoundException(message);
    }
    const ref = folderRefOf(target);
    if (!spaces.has(ref.spaceId)) {
      setImmediate(() => {
        this.logger.warn(`FOLDER_NOT_VISIBLE: folderId=${ref.folderId} userId=${user.id}`);
      });
      throw new NotFoundException(message);
    }
    return target;
  }

  /**
   * 指定 folder id 群のうち可視 space に属するものだけの集合を返す（旧 acl.filterVisibleFolderIds の後継）。
   * 検索結果の絞り込みと、親フォルダの可視判定（非可視なら parentFolderId を伏せる）に使う。
   */
  private async filterVisibleFolderIds(user: FileUser, folderIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(folderIds)];
    if (ids.length === 0) {
      return new Set();
    }
    const [spaces, refs] = await Promise.all([
      this.visibleSpaceIds(user),
      this.repo.findFolderSpaceIds(ids),
    ]);
    return new Set(refs.filter((r) => spaces.has(r.spaceId)).map((r) => r.id));
  }

  /**
   * 指定 Space のフォルダツリー（ネスト）を返す（ADR 0063 で space スコープ化）。
   * 非可視 space は 404（存在秘匿）。ツリーは器ごとに完結するため、可視判定は space 1 回で足りる
   * （祖先チェーン走査は不要になった）。
   *
   * spaceId は必須（fil-0137 で frontend が常時送るようになり、移行期の DEFAULT_CHANNEL_ID
   * フォールバックを撤去した。controller の ParseUUIDPipe が未指定 / 非 UUID を 400 で弾く）。
   */
  async getTree(user: FileUser, spaceId: string) {
    const spaces = await this.visibleSpaceIds(user);
    if (!spaces.has(spaceId)) {
      throw new NotFoundException(SINGLE_TARGET_NOT_FOUND_MESSAGE);
    }
    return ok(toFolderTree(await this.repo.findAllFolders(spaceId)));
  }

  /**
   * 横断検索（rete-files-0004）: name 部分一致でフォルダ/ファイルを全階層から拾い、フォルダ→ファイルの
   * 順で返す。空クエリ（trim 後 0 文字）は DB を叩かず空結果（無駄な全件 LIKE と過大レスポンスを避ける）。
   * フォルダ/ファイルは相互依存しないため並列取得する。
   *
   * 可視性（ADR 0063）: **DB クエリの段階で可視 space に絞る**（非可視チャネルのフォルダ名 /
   * ファイル名を検索経由で覗けないようにする）。app 側で後から filter する形にしないのは、
   * 上限件数（SEARCH_RESULT_LIMIT）が非可視行で埋まって可視行が押し出されるのを防ぐため。
   * 親フォルダの可視判定だけは取得後に行う（非可視なら parentFolderId を伏せる・fil-0107）。
   */
  async search(rawQuery: string | undefined, user: FileUser) {
    const query = (rawQuery ?? '').trim();
    if (query.length === 0) {
      return ok({ query: '', items: [] });
    }
    const spaceIds = [...(await this.visibleSpaceIds(user))];
    if (spaceIds.length === 0) {
      return ok({ query, items: [] });
    }
    const [folders, files] = await Promise.all([
      this.repo.searchFolders(query, spaceIds),
      this.repo.searchFiles(query, spaceIds),
    ]);
    // 親の可視判定にかける対象 id の組み立ては searchByTags と共通（fil-0122）。
    const visible = await this.filterVisibleFolderIds(
      user,
      this.collectVisibilityTargets(folders, files),
    );
    return ok({
      query,
      items: [
        ...folders.map((f) => toSearchFolderItem(f, visible)),
        ...files.map(toSearchFileItem),
      ],
    });
  }

  /**
   * 指定フォルダの内容（パンくず + 直下サブフォルダ/ファイル）を返す。対象不在は NOT_FOUND。
   *
   * 可視性（ADR 0063）: 非可視 space は「存在しない」と同じ 404 文言で返す（文言差が存在の
   * oracle になるため揃える）。直下サブフォルダは親と同一 space（app 層で強制）なので追加の除外は不要。
   *
   * パンくず: 対象フォルダから root 方向へ遡って組む。同一 space 内で完結し、途中に非可視の段は
   * 生じない（旧 ACL では祖先ごとに可視/非可視が割れ、最初の非可視祖先で打ち切っていた）。
   *
   * 順序: **可視判定 → 中身取得**。非可視フォルダを叩いた時に中身のクエリを走らせない。
   */
  async getFolderContent(id: string, user: FileUser) {
    const folder = await this.assertFolderAccessible(user, id, SINGLE_TARGET_NOT_FOUND_MESSAGE);

    // パンくずは同一 space の全フォルダ 1 回ロードから組む（1 段 1 クエリの逐次 walk を認可後にも作らない）。
    const [siblings, subfolders, files] = await Promise.all([
      this.repo.findAllFolders(folder.spaceId),
      this.repo.findSubfolders(id),
      this.repo.findFilesWithLatestVersion(id),
    ]);

    return ok(toFolderContent(folder, subfolders, files, buildCrumb(folder, siblings)));
  }

  /**
   * 構造参照の解決（GET /files/refs・FL+1・設計 §2.3）。参照ノードの `data-id` をまとめて引き、
   * **可視かつ存在する対象だけ**を現在のパス表記つきで返す。
   *
   * 存在秘匿（ADR 0038）: 不在・非可視・削除済み・失効は**結果から欠落**させ、個別の status も理由も
   * 付けない（別の状態として返すと、見えない Space の実体の存在が漏れる）。その帰結として
   * 「削除済み」「権限なし」「失効」はすべて同じ「返ってこない」になる（設計 §5.1・§5.4）。
   *
   * コスト: 可視 space 1 回 + 対象 2 クエリ（フォルダ・ファイル）+ 祖先 1 クエリ。入力は
   * REF_RESOLVE_MAX で切り捨てる（本文 1 本の参照 10 件に対して余裕を見た固定上限）。
   */
  async resolveRefs(rawIds: string | undefined, user: FileUser) {
    const ids = parseRefIds(rawIds);
    if (ids.length === 0) {
      return ok({ items: [] });
    }
    // 可視範囲の取得を対象取得より先に済ませる（不在と非可視で応答経路のコストを揃える・fil-0146）。
    const spaces = await this.visibleSpaceIds(user);
    if (spaces.size === 0) {
      return ok({ items: [] });
    }
    const { folders, files } = await this.repo.findRefTargets(ids);

    const visibleFolders = folders.filter((f) => spaces.has(f.spaceId));
    // ファイルの帰属 space は所属フォルダの spaceId で決まる（1 クエリでまとめて引く）。
    const fileFolderRows: {
      id: string;
      name: string;
      parentFolderId: string | null;
      spaceId?: string;
    }[] = await this.repo.findRefAncestors([...new Set(files.map((f) => f.folderId))], [...spaces]);
    const ancestors = await collectRefAncestors(
      [...visibleFolders.map((f) => f.id), ...fileFolderRows.map((f) => f.id)],
      visibleFolders,
      fileFolderRows,
      (frontier) => this.repo.findRefAncestors(frontier, [...spaces]),
    );
    // 祖先の並び（refpath の素材）と、所属フォルダの行を id で引くための索引を揃える。
    const ancestorRows: {
      id: string;
      name: string;
      parentFolderId: string | null;
      spaceId?: string;
    }[] = ancestors;
    const fileFolderById = new Map<
      string,
      { id: string; name: string; parentFolderId: string | null }
    >();
    for (const parent of fileFolderRows) fileFolderById.set(parent.id, parent);

    const byId = new Map<
      string,
      {
        id: string;
        kind: 'file' | 'folder';
        path: string;
        parentFolderId: string | null;
        spaceId: string;
      }
    >();
    for (const folder of visibleFolders) {
      byId.set(folder.id, {
        id: folder.id,
        kind: 'folder',
        path: refPath(ancestors, folder.id, folder.name),
        parentFolderId: folder.parentFolderId,
        spaceId: folder.spaceId,
      });
    }
    for (const file of files) {
      const parent = fileFolderById.get(file.folderId);
      if (!parent) continue; // 所属フォルダが可視でない＝ファイルも返さない（存在秘匿）
      const spaceId = spaceIdOfRef(ancestors, parent.id);
      if (!spaceId) continue;
      // ファイルのパスは「所属フォルダの現在のパス＋ファイル名」。
      // refPath は folderId 自身の名前を含まない（名前を別に受けるため）ので、
      // 所属フォルダの名前を落とさないよう、フォルダのフルパスを先に組んでから足す。
      byId.set(file.id, {
        id: file.id,
        kind: 'file',
        path: `${refPath(ancestors, parent.id, parent.name)}${REF_PATH_SEP}${file.name}`,
        parentFolderId: parent.id,
        spaceId,
      });
    }

    // 要求された順（重複は先頭の 1 回）で返し、返らない id は「表示できない」に倒す。
    const items = ids.map((id) => byId.get(id)).filter((i) => i !== undefined);
    return ok({ items });
  }

  /**
   * ファイルを指定フォルダへアップロードする。同名が既にあれば旧版を物理削除せず版を追加（versionNo+1）、
   * 無ければ File と初版を作成する（spec §3.2 版管理）。
   *
   * 整合性順序: id を app で確定（storageKey = `<fileId>/<versionId>`）→ 実体保存 → DB 書き込み。
   * DB 書き込み失敗時は保存済み実体を補償削除して orphan を残さない（DB-FS は原子的でないため）。
   * 同名同時アップロードによる versionNo 競合は @@unique(fileId, versionNo) が強制失敗させ整合性を守る。
   * versionNo 競合は fil-0141 で有限回（最大4試行）まで自動再試行し、それ以外は即 409 を返す。
   * folderId_name 衝突（同名同時アップロード新規作成）は再試行せず 1 試行で 409 を返す（fil-0141・criteria 3）。
   */
  async uploadFile(folderId: string, file: UploadFileInput | undefined, user: FileUser) {
    if (!file) {
      throw new BadRequestException('ファイルが指定されていません');
    }
    try {
      // 可視 space 内なら書き込み可（ADR 0063「見えるなら使える」）。不在・非可視は同一コスト・
      // 同一文言の 404 で存在秘匿（fil-0146: 可視範囲先出しの標準形へ統合）。
      await this.assertFolderAccessible(user, folderId, SINGLE_TARGET_NOT_FOUND_MESSAGE);

      // multer は filename を latin1 デコードするため、保存・検索・拡張子判定の手前で UTF-8 へ正規化＋
      // パス成分/制御文字を除去する（怠ると日本語名が化け、`../` 等が name 列へ漏れる）。以降は
      // file.originalname を直接使わない。サニタイズで空になった名前（`../` のみ等）は不正として弾く。
      const filename = normalizeUploadFilename(file.originalname);
      if (!filename) {
        throw new BadRequestException('ファイル名が不正です');
      }

      // 内容署名検査（fil-0140）: 拡張子偽装と実行形式を保存前に拒否する。diskStorage の一時ファイル
      // 先頭バイトだけを読み、RAM 全量保持はしない。判定不能時は通過（クライアント申告 mime を維持）。
      // 拒否は throw のみで表現し、FileVersion レコード・最終保存実体は残らない（cleanup 経路が維持される）。
      //
      // 業務上の制約（サイズ / 拒否拡張子 / 許可拡張子）より先に置く（v2-197）。実行形式の拒否は内容が
      // 理由であり、拡張子の一覧から外しても効き続けるため、拒否拡張子の一覧に .exe が載っていても
      // 「実行形式だから拒否した」と正しく伝える（一覧から外せば通ると誤解させない）。
      const detectedMime = await this.resolveAndCheckSignature(file, filename);

      // 業務上の最大サイズ・拒否拡張子・許可拡張子（設定タブ可変上限）で弾く。設定未設定なら既定
      // （hard cap / 全許可 / 既定の拒否拡張子）。multipart 層の hard cap（controller）とは別レイヤで、
      // 実体保存前に検証して orphan を作らない。
      const settings = toFileSettings(await this.repo.findSettings());
      this.validateUploadConstraints(filename, file.size, settings);

      const existing = await this.repo.findFileByFolderAndName(folderId, filename);
      const fileId = existing?.id ?? randomUUID();

      if (!existing) {
        // 新規 File 作成経路: 同名同時アップロードによる folderId_name 衝突は再試行せず 1 試行で完了
        // （fil-0141・criteria 3・folderId_name は app 層事前チェック＋DB backstop の二重防御）。
        // versionNo は初版で 1 固定なので競合しない。
        const version = this.buildNewVersion(fileId, 1, file, user, detectedMime);
        return await this.writeVersionWithCompensation(
          version.storageKey,
          this.uploadSource(file),
          async () => {
            const createdFile = await this.repo.createFileWithInitialVersion({
              fileId,
              folderId,
              name: filename,
              version,
            });
            // Prisma の create + include は必ず初版 1 件を返すため versions[0] は non-null。
            return ok(toUploadedFileRow(fileId, createdFile.name, createdFile.versions[0]));
          },
        );
      }

      // 既存 File への版追加: versionNo P2002 のみ最大4試行まで自動再試行する（fil-0141・criteria 1/2）。
      // versionNo 以外の一意衝突（folderId_name 等）は即 409 で返す（criteria 3）。
      return await this.tryAddVersionWithRetry({
        fileId,
        file,
        user,
        detectedMime,
        dbWrite: (version) => this.repo.addFileVersion({ ...version, fileId }),
        toRow: (created) => ok(toUploadedFileRow(fileId, existing.name, created)),
      });
    } finally {
      // multer の一時ファイルは成功・業務エラー・DB 失敗を問わず必ず削除する（fil-0121・criteria 2/3）。
      await this.cleanupUploadTempFile(file.path);
    }
  }

  /**
   * 既存ファイル（id 指定）へ新版を追加する（FF お気に入り編集の「DL→ローカル編集→再アップ」着地点）。
   *
   * 同名一致に依存する uploadFile と異なり、ファイル id で版を確定するため、ローカル編集時の別名保存/
   * リネーム（"report (1).docx" 等）でも別ファイルを誤生成せず確実に同一ファイルの新版になる。
   * ファイルの同一性（保存名）は既存 name を固定し、アップロードされた一時ファイル名は採用しない。
   * 検証は「サイズ＝実バイト」「拡張子＝ファイル自身（既存 name）の拡張子」で行う。
   *
   * versionNo 競合は fil-0141 で有限回（最大4試行）まで自動再試行する。versionNo 以外の一意衝突は
   * 再試行せず即 409 を返す。
   */
  async uploadFileVersion(fileId: string, file: UploadFileInput | undefined, user: FileUser) {
    if (!file) {
      throw new BadRequestException('ファイルが指定されていません');
    }
    try {
      // 版追加は所属フォルダが可視 space であることを要求する（ADR 0063）。不在・非可視は
      // 同一コスト・同一文言の 404（fil-0146）。
      const existing = await this.findFileTargetAccessible(
        user,
        SINGLE_TARGET_NOT_FOUND_MESSAGE,
        () => this.repo.findFileById(fileId),
        (f) => ({ folderId: f.folderId, spaceId: f.folder.spaceId }),
      );

      // 内容署名検査（fil-0140・uploadFile と共通・同一拡張子＝既存 name で判定）。業務上の制約より先に
      // 置く理由は uploadFile と同じ（内容が実行形式なら一覧から外しても拒否される）。
      const detectedMime = await this.resolveAndCheckSignature(file, existing.name);

      // ファイル確定後の設定取得は最大版番号取得の前に確定させる必要がある（順序: signature → validateConstraints → retry loop）。
      // 設定取得は signature 検査と並列化可能だが、versionNo は retry のたびに再取得するためここでは取得しない。
      const settingsEntity = await this.repo.findSettings();
      this.validateUploadConstraints(existing.name, file.size, toFileSettings(settingsEntity));

      return await this.tryAddVersionWithRetry({
        fileId,
        file,
        user,
        detectedMime,
        dbWrite: (version) => this.repo.addFileVersion({ ...version, fileId }),
        toRow: (created) => ok(toUploadedFileRow(fileId, existing.name, created)),
      });
    } finally {
      // multer の一時ファイルは成功・業務エラー・DB 失敗を問わず必ず削除する（fil-0121・criteria 2/3）。
      await this.cleanupUploadTempFile(file.path);
    }
  }

  /**
   * ファイルメタ（名前 / 所属フォルダ / 最新版番号）を返す（FF: Home お気に入りのファイル★クリック起点）。
   * targetRef にファイル id しか持たないお気に入りから、編集オーバーレイ表示と再アップ後のフォルダ整合に
   * 必要な情報を解決する。ファイル不在は NOT_FOUND。
   */
  async getFileMeta(fileId: string, user: FileUser) {
    // 所属フォルダが非可視 space なら 404（非可視チャネルのファイルの存在を漏らさない・ADR 0063）。
    // 不在・非可視は同一コスト・同一文言（fil-0146）。
    const file = await this.findFileTargetAccessible(
      user,
      SINGLE_TARGET_NOT_FOUND_MESSAGE,
      () => this.repo.findFileById(fileId),
      (f) => ({ folderId: f.folderId, spaceId: f.folder.spaceId }),
    );
    const versionNo = await this.repo.getMaxVersionNo(fileId);
    return ok(toFileMeta(file, versionNo));
  }

  /**
   * 業務上のアップロード制約（最大サイズ / 拒否拡張子 / 許可拡張子）で弾く（uploadFile / uploadFileVersion 共通・§3）。
   * 拡張子判定に使う name は呼び出し側が用途に応じて渡す（新規/同名再アップ＝アップロード名、
   * 版差し替え＝ファイル自身の既存名）。設定の allowedExtensions が空なら全許可。
   *
   * 判定順はサイズ → 拒否拡張子 → 許可拡張子（v2-197）。拒否を先に見るのは、管理者が「この形式は置かせない」と
   * 明示した意思を許可一覧より優先するため（両方に載る場合は拒否が勝つ）。内容署名による実行形式の常時拒否は
   * この関数の外側（呼び出し前）にある。
   *
   * 拒否は 2 層の和で見る（要求版2）: コード固定の FIXED_REJECTED_EXTENSIONS（設定から外せない＝画面は固定表示）と
   * 管理者が編集できる settings.rejectedExtensions。固定分を先に判定して文言を分ける＝「設定で外せるのに残って
   * いる」と誤解させない（固定分は編集一覧に入れても保存時に除かれる）。
   *
   * 拡張子は extensionForDecision で求める（生の名前ではなく、OS が実際に作る名前に正規化してから比較する。
   * `evil.bat.` / `evil.bat ` / `evil.bat::$DATA` のような末尾 1 文字の変種で一覧をすり抜けさせない・§F1）。
   * 許可側も同じ判定名を使う（許可の一覧でも `report.txt.` は `.txt` として扱う）。
   *
   * 文言は「何が起きたか」に加えて「どこを直せば通るか」が分かる形にする（v2-191）。サイズを MB へ
   * 切り捨てると 1 MB 未満の上限が「0 MB」になり設定値と食い違うため、formatFileSize で実値の単位に落とす。
   * 拒否・許可のどちらの文言も拡張子の一覧を入れない（開発統括の修正依頼・2026-09-23）。括弧が二重になって
   * 読みにくく、一覧は設定画面（/settings/file-upload）にあるため。弾かれた拡張子も添えない（利用者は自分が
   * 送ったファイル名を知っている）。文言は固定語で始める＝利用者が付けたファイル名を先頭に置くと、例外文言で
   * 訳語を引く multipart フィルタ（upload-error-messages）が別の案内へ誤って差し替えうる。
   */
  private validateUploadConstraints(
    name: string,
    size: number,
    settings: { maxSizeBytes: number; allowedExtensions: string[]; rejectedExtensions: string[] },
  ): void {
    if (size > settings.maxSizeBytes) {
      throw new BadRequestException(
        `ファイルサイズが上限（${formatFileSize(settings.maxSizeBytes)}）を超えています`,
      );
    }
    const ext = extensionForDecision(name);
    if (FIXED_REJECTED_EXTENSIONS.includes(ext)) {
      throw new BadRequestException('常に拒否される拡張子です');
    }
    if (settings.rejectedExtensions.length > 0 && settings.rejectedExtensions.includes(ext)) {
      throw new BadRequestException('拒否する拡張子です');
    }
    if (settings.allowedExtensions.length > 0 && !settings.allowedExtensions.includes(ext)) {
      throw new BadRequestException('許可されていない拡張子です');
    }
  }

  /**
   * 実体保存 → DB 書き込みを補償削除付きで実行する（uploadFile / uploadFileVersion 共通・§3）。
   * DB-FS は原子的でないため、DB 書き込み失敗時は保存済み実体を補償削除（冪等）して orphan を残さない。
   * 補償削除自体が失敗しても元の DB エラーを握り潰さず、orphan を warn ログに残してから再送出する。
   * 保存ソースは Buffer またはストリーム（diskStorage の一時ファイル由来・fil-0121）。一時ファイル自体の
   * 削除は呼び出し側（uploadFile / uploadFileVersion の finally）が担う。
   */
  private async writeVersionWithCompensation<T>(
    storageKey: string,
    source: Buffer | Readable,
    dbWrite: () => Promise<T>,
  ): Promise<T> {
    try {
      // storage.write 自身の失敗（容量切れ等）でも、書きかけの実体が残らないよう補償削除へ流す
      // （fil-0157・criteria 4）。write が成功してから DB 書き込みが失敗した場合も同じ経路。
      // delete は ENOENT 冪等なので、write が実体を生む前に失敗した空振り削除は warn を出さない
      // （local-fs-storage.service.ts が ENOENT を無視する）。
      await this.storage.write(storageKey, source);
      return await dbWrite();
    } catch (e) {
      await this.storage.delete(storageKey).catch((delErr) => {
        this.logger.warn(
          `補償削除に失敗し orphan が残存: storageKey=${storageKey} (${
            delErr instanceof Error ? delErr.message : String(delErr)
          })`,
        );
      });
      throw e;
    }
  }

  /**
   * 保存ソースを解決する（fil-0121）。diskStorage（`path` あり）なら一時ファイルの読み出しストリーム、
   * memoryStorage 経路（`path` なし）なら buffer をそのまま渡す。アップロード本文を全量 RAM に保持しない
   * 本線は controller の diskStorage が担い、本分岐はテスト・後方互換のための受け口。
   * 一時ファイルの読み出しは所定フォルダ配下の検証を通してから行う（fil-0157・criteria 5）。
   */
  private uploadSource(file: UploadFileInput): Buffer | Readable {
    if (file.path) {
      this.assertUploadTempPath(file.path, '読み出し');
      return createReadStream(file.path);
    }
    return file.buffer;
  }

  /**
   * multer の一時ファイルパスが所定の一時フォルダ（resolveUploadTempDir()）配下かを検証する
   * （fil-0157・criteria 5）。読み出し・削除のどちらにも使う前に必ず通す＝将来このパスへ別の
   * 呼び出しが増えても任意ファイルの読み書き・削除を防ぐ（path traversal 対策）。検証は
   * path.resolve で正規化したうえで行い、区切り文字の境界まで見る（`tempDir-evil` を配下と
   * 誤認しない）。配下でない値は実際の読み書きを行わずに拒否する。
   */
  private assertUploadTempPath(tempPath: string, use: '読み出し' | '削除'): void {
    const tempDir = resolve(resolveUploadTempDir());
    const resolved = resolve(tempPath);
    const boundary = tempDir.endsWith(sep) ? tempDir : `${tempDir}${sep}`;
    if (resolved !== tempDir && !resolved.startsWith(boundary)) {
      throw new BadRequestException(
        `アップロード一時ファイルの${use}を拒否しました（所定フォルダ配下ではありません）`,
      );
    }
  }

  /** versionNo 競合時のみ有限回まで自動再試行する（fil-0141）。 */
  private static readonly MAX_VERSION_ATTEMPTS = 4;

  /**
   * 既存ファイルへの版追加を versionNo P2002 のみ有限回自動再試行する共通ヘルパー（fil-0141）。
   *
   * 各試行で以下を毎回作り直す（criteria 5・成功試行の版番号が連番となる／再試行時に保存物の整合性が保たれる）：
   * - versionNo（getMaxVersionNo を試行ごとに再取得）
   * - versionId / storageKey（buildNewVersion で毎回採番）
   * - storageKey ごとの補償削除（writeVersionWithCompensation を毎回呼ぶ）
   *
   * 試行ごとに writeVersionWithCompensation が save → dbWrite → 失敗時 delete を行うため、各試行の
   * 保存済み実体は失敗時に確実に補償削除される。multer 一時ファイル自体は呼び出し元の finally が
   * 一度だけ削除する（criteria 6）。
   *
   * 再試行対象は versionNo P2002 のみ（meta.target に 'versionNo' を含むもの）。それ以外の
   * P2002（folderId_name 等）は即 409 を返すため、folderId_name 衝突で再試行を挟まない（criteria 3）。
   */
  private async tryAddVersionWithRetry<TDb, TRow>(params: {
    fileId: string;
    file: UploadFileInput;
    user: FileUser;
    detectedMime: string | undefined;
    dbWrite: (version: NewVersionData) => Promise<TDb>;
    toRow: (created: TDb) => TRow;
  }): Promise<TRow> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FilesService.MAX_VERSION_ATTEMPTS; attempt++) {
      // 試行ごとに最新の versionNo を取得（fil-0141・criteria 5 連番保証）。
      const maxVersionNo = await this.repo.getMaxVersionNo(params.fileId);
      const version = this.buildNewVersion(
        params.fileId,
        maxVersionNo + 1,
        params.file,
        params.user,
        params.detectedMime,
      );

      try {
        return await this.writeVersionWithCompensation(
          version.storageKey,
          this.uploadSource(params.file),
          async () => params.toRow(await params.dbWrite(version)),
        );
      } catch (e) {
        lastError = e;
        if (!isVersionNoPrismaConflict(e)) {
          // versionNo 以外の P2002（folderId_name 等）や他の DB エラーは即 throw（criteria 3）。
          throw e;
        }
        // versionNo 競合: 次の試行で versionNo を取り直す（writeVersionWithCompensation 内で
        // 試行ごとの実体は補償削除済み＝orphan は残らない・criteria 4）。
      }
    }
    // 全試行失敗: 既存通り P2002 を投げる（PrismaExceptionFilter が 409 へ変換・§4 エラー一元化）。
    throw lastError;
  }

  /**
   * multer の一時ファイルを削除する（fil-0121・criteria 2/3）。`path` が無い経路（memoryStorage）では
   * 何もしない。既に無い（ENOENT）場合は無視し、削除失敗（権限等）は握り潰さず warn ログに残す
   * （残骸は起動時掃除が回収する＝3 層目の守り）。
   * 所定フォルダ配下でないパスは削除しない（fil-0157・criteria 5: 将来このパスへ別の呼び出しが
   * 増えても任意ファイルの削除を防ぐ）。検証は読み出し側（uploadSource）と同じヘルパを通す。
   */
  private async cleanupUploadTempFile(tempPath: string | undefined): Promise<void> {
    if (!tempPath) {
      return;
    }
    try {
      this.assertUploadTempPath(tempPath, '削除');
    } catch {
      this.logger.warn(
        `アップロード一時ファイルの削除を拒否しました（所定フォルダ配下ではありません）: ${tempPath}`,
      );
      return;
    }
    await unlink(tempPath).catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== 'ENOENT') {
        this.logger.warn(
          `アップロード一時ファイルの削除に失敗: ${tempPath} (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    });
  }

  /**
   * 検索の可視判定にかける対象 id を組み立てる（search / searchByTags の共通部品・fil-0122）。
   * ヒット自身に加えて「ヒットしたフォルダの親」も可視判定にかける（fil-0107）。親が見えない時に
   * parentFolderId を伏せるためで、同じ 1 回のロードで判定できるので追加コストは無い。
   */
  private collectVisibilityTargets(
    folders: readonly { id: string; parentFolderId: string | null }[],
    files: readonly { folderId: string }[],
  ): string[] {
    return [
      ...folders.map((f) => f.id),
      ...folders.map((f) => f.parentFolderId).filter((id): id is string => id !== null),
      ...files.map((f) => f.folderId),
    ];
  }

  /**
   * 新版レコードを組み立てる（uploadFile / uploadFileVersion の共通部品・fil-0122）。
   * versionId はここで採番する（storageKey が `${fileId}/${versionId}` の形を取るため、呼び出し元は
   * versionNo だけ決めて渡す）。
   *
   * mime はクライアント申告より内容署名の検出 mime を優先する（fil-0140・criteria 4）。検出不能な形式
   * （magic-bytes が空を返す）のみクライアント申告 mime を採用する。
   */
  private buildNewVersion(
    fileId: string,
    versionNo: number,
    file: { size: number; mimetype: string },
    user: FileUser,
    detectedMime?: string,
  ): NewVersionData {
    const versionId = randomUUID();
    return {
      id: versionId,
      versionNo,
      storageKey: `${fileId}/${versionId}`,
      byteSize: BigInt(file.size),
      mimeType: detectedMime ?? file.mimetype,
      uploadedById: user.id,
    };
  }

  /**
   * アップロード署名検査（fil-0140）を走らせ、結果を文字列で返す。
   * - 実行形式（PE/EXE・ELF・Mach-O）は常に拒否（criteria 3）
   * - 拡張子と検出内容の不整合は拒否（criteria 1）
   * - 検出できた mime を返して buildNewVersion へ渡す（criteria 4）
   * - 判定不能時は undefined を返し、クライアント申告 mime を維持する（criteria 2）
   *
   * 拒否時の例外は呼び出し元の try/finally が multer 一時ファイルを削除する（cleanup 経路維持・criteria 5）。
   *
   * 拒否文言は利用者が次の手を選べる形にする（v2-191）: 実行形式は拡張子を変えても通らないことを示す。
   * 内容不一致は「中身と拡張子が食い違っている」ことだけを伝える（弾かれた拡張子は添えない・
   * 開発統括の修正依頼 2026-09-23＝括弧の二重を避ける）。
   */
  private async resolveAndCheckSignature(
    file: UploadFileInput,
    filename: string,
  ): Promise<string | undefined> {
    // 拡張子の突き合わせも extensionDecisionName で行う（§F1）。`report.docx.` のような末尾ドット付きの
    // 正当なファイルを「拡張子が一致しない」と誤判定せず、`x.pdf.` のような偽装は `.pdf` として弾く。
    const decisionName = extensionDecisionName(filename);
    const result = await checkUploadSignature(
      { path: file.path, buffer: file.buffer, mimetype: file.mimetype },
      decisionName,
    );
    if (result.isExecutable) {
      throw new BadRequestException(
        '実行形式（.exe や .dll など）のファイルはアップロードできません',
      );
    }
    if (result.isMismatch) {
      throw new BadRequestException('ファイルの内容と拡張子が一致しません');
    }
    return result.detectedMime;
  }

  /**
   * 新規フォルダを作成する。
   *
   * 検証順: 名前サニタイズ（空なら BadRequest）→ （作成先指定時）作成先存在 → 同名衝突 → 末尾 sortOrder で作成。
   * - parentFolderId=null はルート直下作成。作成先の存在チェックは不要（root は実体を持たない）。
   * - 同名衝突は app チェック（Conflict）に加え @@unique([parentFolderId, name]) が backstop。ルート直下は
   *   NULL 一意制約が効かないため app チェックのみが担保（schema コメントの方針どおり・移動と同姿勢）。
   * - sortOrder は作成先末尾（最大 + 1）。既存兄弟の sortOrder は振り直さない（移動と同方針）。
   */
  async createFolder(
    parentFolderId: string | null,
    name: string,
    user: FileUser,
    spaceId?: string,
  ) {
    const cleanName = sanitizeFolderName(name);
    if (!cleanName) {
      throw new BadRequestException('フォルダ名が不正です');
    }

    // 帰属器の決定（ADR 0063 §5.1）: 親ありは親から継承し、親と異なる spaceId 指定は 400 で弾く
    // （黙って上書きすると cross-Space 作成のバグが 200 で通って表面化しない）。ルート直下は指定必須
    // （fil-0137 で frontend が常時送るようになり、移行期の DEFAULT_CHANNEL_ID フォールバックを撤去した）。
    let targetSpaceId: string;
    if (parentFolderId !== null) {
      const parent = await this.assertFolderAccessible(
        user,
        parentFolderId,
        SINGLE_TARGET_NOT_FOUND_MESSAGE,
      );
      if (spaceId != null && spaceId !== parent.spaceId) {
        throw new BadRequestException('作成先フォルダと器が一致しません');
      }
      targetSpaceId = parent.spaceId;
    } else {
      if (spaceId == null) {
        throw new BadRequestException('ルート直下の作成には器（spaceId）の指定が必要です');
      }
      targetSpaceId = spaceId;
      const spaces = await this.visibleSpaceIds(user);
      if (!spaces.has(targetSpaceId)) {
        throw new NotFoundException(SINGLE_TARGET_NOT_FOUND_MESSAGE);
      }
    }

    // 同名チェックは器スコープで行う（ADR 0063 §1.4）。ルート直下は @@unique が効かない
    // （Postgres は NULL を等値比較しない）ため app 層のみが担保で、spaceId 条件が無いと
    // 別 Space の同名ルートを誤検出して弾いてしまう。
    const dup = await this.repo.findFolderByParentAndName(parentFolderId, cleanName, targetSpaceId);
    if (dup) {
      throw new ConflictException('同名のフォルダが既に存在します');
    }

    // sortOrder 採番は repository の Serializable tx 内（同名確認と同述語範囲）で行う（fil-0150・LOW10）。
    // 深さ検査も repository の tx 内で原子的に行う（fil-0118 criteria 6）。result union を
    // 文言付き例外へ翻訳するのみ（§4 エラー一元化）。
    const result = await this.repo.createFolder({
      name: cleanName,
      parentFolderId,
      // ルート直下の帰属器（ADR 0063）。子フォルダは repository 側で親から継承する（上で一致を検証済み）。
      spaceId: targetSpaceId,
      // 作成者を記録する（監査情報。ACL 撤去で暗黙 MANAGE の意味は無くなった・ADR 0063）。
      createdById: user.id,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'parent_not_found':
          throw new NotFoundException(SINGLE_TARGET_NOT_FOUND_MESSAGE);
        case 'depth_exceeded':
          throw new BadRequestException(FOLDER_DEPTH_EXCEEDED_MESSAGE);
        case 'duplicate':
          throw new ConflictException('同名のフォルダが既に存在します');
        default:
          // 到達不能（reason は網羅済）。将来 reason 追加時の取りこぼしをここで顕在化させる。
          throw new InternalServerErrorException('未対応のフォルダ作成結果です');
      }
    }
    return ok(toCreatedFolder(result.folder));
  }

  /**
   * フォルダを reparent する。存在・自己/子孫循環・同名衝突の検証と sortOrder 採番・書き込みは
   * repo.moveFolderAtomic が Serializable トランザクション（+P2034 リトライ）で原子的に行い、並行移動の
   * 循環/ルート直下同名の TOCTOU 窓を SSI で封鎖する（FB-2b 負債返済）。本メソッドは result union を
   * 文言付き HTTP 例外へ翻訳するのみ（§4 エラー一元化）。
   *
   * 可視性（ADR 0063）: 移動元・移動先の双方が可視 space であることを要求し、**cross-Space 移動は
   * 400 で拒否する**（移動＝可視範囲の変更になり、意図しない共有事故を作るため）。
   */
  async moveFolder(id: string, parentFolderId: string | null, user: FileUser) {
    // 対象不在の文言は事前読み・ガード引数・switch 翻訳の 3 箇所で同じものを使う（1 箇所だけ
    // 変えると存在秘匿（ADR 0038）の文言一致が崩れる・fil-0148 が一括タグの存在秘匿文言を
    // BATCH_TARGET_NOT_FOUND_MESSAGE へ集約したのと同型のドリフト経路）。
    // 使用箇所は本メソッド内だけなのでローカル定数で足りる。
    // 移動系 2 経路（moveFolder / moveFile）は単件 1 文言化（fil-0154・SINGLE_TARGET_NOT_FOUND_MESSAGE）の
    // 対象外として意図的に残す。1 リクエストで移動元と移動先の 2 対象を扱うため、同一文言へ倒すと
    // どちらが見つからないのか利用者が判別できなくなる。
    //
    // 存在秘匿（ADR 0038）の検証は fil-0155 で行い、現状維持（3 文言）が妥当と裁定した：移動元の
    // assertFolderAccessible (:752 / moveFile :813) は「対象不在」と「他人のもので非可視」を同一文言の
    // 404 で返す作りになっており、3 文言に分けても他人のデータの存在は漏れない。1 文言へ潰すと利用者
    // が「移すもの」と「移す先」の区別を失うだけで安全性は上がらない。移動先のアサート (:758 / :818)
    // も同型。fil-0154 が「単件 1 文言」を採った理由は「対象 1 つ」だからで、本ケースは 2 つ。
    const sourceNotFoundMessage = '移動対象のフォルダが見つかりません';
    // 並行移動の TOCTOU 窓を閉じるための「判定時の親」（fil-0115）。可視判定より前に読み、
    // 同じ値を原子移動へ引き回す（criteria 4）。対象不在・非可視は同一文言で 404（存在秘匿）。
    const current = await this.assertFolderAccessible(user, id, sourceNotFoundMessage);
    const expectedParentFolderId = current.parentFolderId;

    // 移動先も可視 space であること＋移動元と同一 space であること（ADR 0063）。ルート直下への移動
    // （parentFolderId=null）は器が変わらないので追加検証は不要。
    if (parentFolderId !== null) {
      // fil-0157: 移動先の文言は移動元と区別する必要があるため直書き許可（fil-0155 裁定）
      const dest = await this.assertFolderAccessible(
        user,
        parentFolderId,
        // eslint-disable-next-line no-restricted-syntax -- fil-0157: 移動先の文言は移動元と区別する必要があるため直書き許可（fil-0155 裁定）
        '移動先フォルダが見つかりません',
      );
      if (dest.spaceId !== current.spaceId) {
        throw new BadRequestException('別の器へは移動できません');
      }
    }

    const result = await this.repo.moveFolderAtomic(id, parentFolderId, expectedParentFolderId);
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          throw new NotFoundException(sourceNotFoundMessage);
        case 'target_not_found':
          // eslint-disable-next-line no-restricted-syntax -- fil-0157: 移動先の文言は移動元と区別する必要があるため直書き許可（fil-0155 裁定）
          throw new NotFoundException('移動先フォルダが見つかりません');
        case 'self':
          throw new BadRequestException(FOLDER_MOVE_SELF_MESSAGE);
        case 'cycle':
          throw new BadRequestException(FOLDER_MOVE_CYCLE_MESSAGE);
        case 'duplicate':
          throw new ConflictException('移動先に同名のフォルダが既に存在します');
        case 'stale':
          throw new ConflictException('フォルダの移動元が変更されました。再読み込みしてください');
        case 'depth_exceeded':
          throw new BadRequestException(FOLDER_DEPTH_EXCEEDED_MESSAGE);
        default:
          // 到達不能（reason は網羅済）。将来 reason 追加時の取りこぼしをここで顕在化させる。
          throw new InternalServerErrorException('未対応のフォルダ移動結果です');
      }
    }
    return ok(toMovedFolder(result.folder));
  }

  /**
   * ファイルの所属フォルダを変更する。移動元・移動先双方が可視 space であることを要求し、
   * **cross-Space 移動は 400 で拒否する**（ADR 0063・フォルダ移動と対称。MoveFileDto は folderId しか
   * 受けないため、移動先フォルダの spaceId 比較で判定する）。存在・移動先存在・同名衝突の検証と
   * 書き込みは repo.moveFileAtomic が単一トランザクションで行う。ファイルの同名衝突は @@unique([folderId, name])
   * （folderId 非 null）が DB backstop となるため、並行時に app チェックをすり抜けても P2002→409
   * （PrismaExceptionFilter）で弾ける。よってフォルダ移動と異なり Serializable は不要（READ COMMITTED +
   * 一意制約で整合する）。本メソッドは result union を文言付き例外へ翻訳するのみ（§4 エラー一元化）。
   */
  async moveFile(id: string, folderId: string, user: FileUser) {
    // 対象ファイル不在は原子移動と同じ文言で 404（存在秘匿のため非可視も同文言に揃える）。
    // 移動系は単件 1 文言化（fil-0154）の対象外＝移動元と移動先を区別するため文言を残す（理由は
    // moveFolder 冒頭のコメント参照。fil-0155 で存在秘匿の検証を済ませ、現状維持と裁定）。
    // 移動元（＝判定時の所属フォルダ）が可視 space であることをファイル取得と同時に確認する
    // （fil-0146: 不在・非可視は同一コスト・同一文言の 404）。判定時の移動元を原子移動へ引き回し、
    // 並行移動で判定が古くなった書き込みを stale（409）で止める（criteria 7）。
    const file = await this.findFileTargetAccessible(
      user,
      '移動対象のファイルが見つかりません',
      () => this.repo.findFileById(id),
      (f) => ({ folderId: f.folderId, spaceId: f.folder.spaceId }),
    );
    // 移動先も可視 space であること、かつ移動元と同一 space であること（ADR 0063）。
    const dest = await this.assertFolderAccessible(
      user,
      folderId,
      // eslint-disable-next-line no-restricted-syntax -- fil-0157: 移動先の文言は移動元と区別する必要があるため直書き許可（fil-0155 裁定）
      '移動先フォルダが見つかりません',
    );
    if (dest.spaceId !== file.folder.spaceId) {
      throw new BadRequestException('別の器へは移動できません');
    }

    const result = await this.repo.moveFileAtomic(id, folderId, file.folderId);
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          // eslint-disable-next-line no-restricted-syntax -- fil-0157: 移動元の文言は移動先と区別する必要があるため直書き許可（fil-0155 裁定）
          throw new NotFoundException('移動対象のファイルが見つかりません');
        case 'target_not_found':
          // eslint-disable-next-line no-restricted-syntax -- fil-0157: 移動先の文言は移動元と区別する必要があるため直書き許可（fil-0155 裁定）
          throw new NotFoundException('移動先フォルダが見つかりません');
        case 'duplicate':
          throw new ConflictException('移動先に同名のファイルが既に存在します');
        case 'stale':
          throw new ConflictException('ファイルの移動元が変更されました。再読み込みしてください');
        default:
          // 到達不能（reason は網羅済）。将来 reason 追加時の取りこぼしをここで顕在化させる。
          throw new InternalServerErrorException('未対応のファイル移動結果です');
      }
    }
    return ok(toMovedFile(result.file));
  }

  /**
   * ファイルの付与タグ集合を tagIds で全置換する（rete-files-0006）。
   *
   * 検証順: 対象ファイル存在 → tagId 重複排除 → 全 tagId 実在確認 → 置換 → 更新後の行を返す。
   * - 空配列は全タグ解除（誤って null を送られても controller の DTO が配列を強制）。
   * - 存在しない tagId が 1 つでもあれば BadRequest（部分適用せず全体を拒否＝整合性優先）。
   * - 置換は repository の単一トランザクション（全消し→再作成）で原子的に行う。
   */
  async setFileTags(fileId: string, rawTagIds: string[], user: FileUser) {
    // タグ付与は所属フォルダが可視 space であること（ADR 0063）。不在・非可視は同一コスト・
    // 同一文言の 404（fil-0146）。
    await this.findFileTargetAccessible(
      user,
      SINGLE_TARGET_NOT_FOUND_MESSAGE,
      () => this.repo.findFileById(fileId),
      (f) => ({ folderId: f.folderId, spaceId: f.folder.spaceId }),
    );

    const tagIds = await this.normalizeAndVerifyTagIds(rawTagIds);

    await this.repo.setFileTags(fileId, tagIds);
    // 更新後の付与タグ込みで一覧行と同形を返す。存在確認〜置換の間に並行削除されると null になりうるため
    // （TOCTOU）、non-null アサーションに頼らず明示的に NotFound へ落とす（toFileRow への null 流入＝500 を防ぐ）。
    const updated = await this.repo.findFileWithTags(fileId);
    if (!updated) {
      throw new NotFoundException(SINGLE_TARGET_NOT_FOUND_MESSAGE);
    }
    return ok(toFileRow(updated));
  }

  /**
   * フォルダの付与タグ集合を tagIds で全置換する（rete-files-0033・setFileTags のフォルダ版）。
   * 検証・置換・行返却の流れは setFileTags と対称（共通の正規化＋実在検証は normalizeAndVerifyTagIds に集約・§3）。
   * 並行削除で置換後の再取得が null になる TOCTOU は明示的に NotFound へ落とす（toFolderRow への null 流入＝500 を防ぐ）。
   */
  async setFolderTags(folderId: string, rawTagIds: string[], user: FileUser) {
    // タグ付与は可視 space 内であること（ADR 0063）。不在・非可視は同一コスト・同一文言の 404
    // （fil-0146: 可視範囲先出しの標準形へ統合）。
    await this.assertFolderAccessible(user, folderId, SINGLE_TARGET_NOT_FOUND_MESSAGE);

    const tagIds = await this.normalizeAndVerifyTagIds(rawTagIds);

    await this.repo.setFolderTags(folderId, tagIds);
    const updated = await this.repo.findFolderWithTags(folderId);
    if (!updated) {
      throw new NotFoundException(SINGLE_TARGET_NOT_FOUND_MESSAGE);
    }
    return ok(toFolderRow(updated));
  }

  /**
   * 複数ファイル / フォルダへタグを一括追加 / 解除する（fil-0048: add+remove 1tx 対応）。
   *
   * addTagIds（追加）と removeTagIds（解除）を 1 トランザクションで原子的に適用する。いずれか一方のみでも
   * 動作する（省略は空集合として扱う）。単一ファイルの PUT 置換（setFileTags）と別経路。
   * 検証順: 対象（ファイル/フォルダ）少なくとも一方が非空 → add/remove タグ正規化＋実在検証 → 両方空なら
   * BadRequest → 各対象 id 群の実在検証（1 件でも不在なら全体拒否＝部分適用を避ける）→ 1tx 反映。
   * 件数のみ返す（行 shape は frontend が一覧再取得で反映）。
   */
  async assignTagsBatch(dto: BatchAssignTagsDto, user: FileUser) {
    const fileIds = [...new Set(dto.fileIds ?? [])];
    const folderIds = [...new Set(dto.folderIds ?? [])];
    if (fileIds.length === 0 && folderIds.length === 0) {
      throw new BadRequestException('付与対象のファイルまたはフォルダを指定してください');
    }

    // add / remove それぞれを正規化（重複排除）し実在検証する。
    const addTagIds = await this.normalizeAndVerifyTagIds(dto.addTagIds ?? []);
    const removeTagIds = await this.normalizeAndVerifyTagIds(dto.removeTagIds ?? []);
    if (addTagIds.length === 0 && removeTagIds.length === 0) {
      throw new BadRequestException('追加または解除するタグを指定してください');
    }
    // 同一タグを add/remove 両方に指定すると 1tx 内で create→delete の順に「削除」が無言で勝つ。
    // フロントの3状態モデルでは起きないが API 単体での不定挙動を防ぐため明示的に拒否する（code review MEDIUM）。
    const overlap = addTagIds.filter((id) => removeTagIds.includes(id));
    if (overlap.length > 0) {
      throw new BadRequestException('同一タグを追加と解除の両方に指定することはできません');
    }

    // 対象の実在と可視範囲を単一のクエリ集合で評価してから判定する（fil-0146）。守る不変条件＝
    // **クエリの回数と形はリクエスト入力（fileIds / folderIds / user）だけで決まり、途中のルックアップ
    // 結果に依存しない**。ルックアップ結果で評価を省略する枝（count 先落ち・fileFolders 空の早期
    // return 等）を作ると、その分岐自体が「速ければ不在」の逆転 oracle になる。文言・ステータスは
    // 従来どおり全 origin（files / folders）× 不在 / 非可視の 4 ケースで同一の 400 +
    // BATCH_TARGET_NOT_FOUND_MESSAGE（fil-0148 M1・存在と可視性の判別不能化。1 段深いクロス
    // 組み合わせプローブでも文言 oracle は開かない）。
    const [spaces, fileRefs, folderRefs] = await Promise.all([
      this.visibleSpaceIds(user),
      this.repo.findFileSpaceRefs(fileIds),
      this.repo.findFolderSpaceIds(folderIds),
    ]);
    // 実在検証: 存在しない id は refs に現れない（1 件でも不在なら全体を拒否＝部分適用を避ける）。
    const missingTargets =
      fileRefs.length !== fileIds.length || folderRefs.length !== folderIds.length;
    // 可視範囲評価: 対象フォルダ＋対象ファイルの所属フォルダすべてが可視 space 内であること
    // （ADR 0063・ここを抜くと非可視 space のフォルダ / ファイルへタグを書けてしまう）。
    const invisibleFolderIds = [
      ...fileRefs.filter((r) => !spaces.has(r.spaceId)).map((r) => r.folderId),
      ...folderRefs.filter((r) => !spaces.has(r.spaceId)).map((r) => r.id),
    ];
    if (invisibleFolderIds.length > 0) {
      // 存在するが見えない対象は warn 1 行に集約して残す（不在は記録しない）。応答パスの外
      // （setImmediate）で書き、warn 書き出し時間が oracle に戻らないようにする（assertFolderAccessible
      // と同形・記録は帰属フォルダ id の粒度・秘匿情報なし）。1 件ずつ書くと大規模バッチでログ洪水に
      // なるため一括経路は 1 行集約（cmn-0422・単一対象経路の「warn 1 回」は従来どおり）。
      setImmediate(() => {
        const uniqueFolderIds = [...new Set(invisibleFolderIds)];
        this.logger.warn(
          `FOLDER_NOT_VISIBLE: folderIds=[${uniqueFolderIds.join(',')}] userId=${user.id}`,
        );
      });
    }
    if (missingTargets || invisibleFolderIds.length > 0) {
      throw new BadRequestException(BATCH_TARGET_NOT_FOUND_MESSAGE);
    }

    // add + remove を 1 tx で原子適用（fil-0048 add/remove 1tx 対応・H-2 原子化）。
    await this.repo.assignTagsBatch(fileIds, folderIds, addTagIds, removeTagIds);

    return ok({
      fileCount: fileIds.length,
      folderCount: folderIds.length,
      addCount: addTagIds.length,
      removeCount: removeTagIds.length,
    });
  }

  /**
   * タグ横断検索（rete-files-0032）: 指定タグ集合のいずれかが付くファイル / フォルダを全階層から拾い、
   * フォルダ → ファイルの順で返す（name 横断検索 search() と同じ items 形）。
   * tagIds は重複排除する。空（trim 後 0 件）なら DB を叩かず空結果。実在しない tagId はヒット 0 件になるだけで
   * エラーにしない（検索は読み取りのため寛容に倒す）。フォルダ/ファイルは相互依存しないため並列取得する。
   *
   * repository は SEARCH_RESULT_LIMIT+1 件を取得する（fil-0043）。超過を検出したら truncated=true を返し、
   * 各リスト を SEARCH_RESULT_LIMIT 件に切り詰める（超過分は無告知で破棄しない）。
   */
  async searchByTags(rawTagIds: string[] | undefined, user: FileUser) {
    const tagIds = [...new Set(rawTagIds ?? [])];
    if (tagIds.length === 0) {
      return ok({ tagIds: [], items: [], truncated: false });
    }
    const spaceIds = [...(await this.visibleSpaceIds(user))];
    if (spaceIds.length === 0) {
      return ok({ tagIds, items: [], truncated: false });
    }
    // 可視性（ADR 0063）: DB クエリの段階で可視 space に絞る（name 検索と同一規則）。
    // 取得件数が可視行だけになるため、truncated の判定もそのまま取得件数で行える。
    const [folders, files] = await Promise.all([
      this.repo.searchFoldersByTags(tagIds, spaceIds),
      this.repo.searchFilesByTags(tagIds, spaceIds),
    ]);
    // 親も判定にかけて非可視なら parentFolderId を伏せる（fil-0107・name 検索 search() と同一規則）。
    const visible = await this.filterVisibleFolderIds(
      user,
      this.collectVisibilityTargets(folders, files),
    );
    const truncated = folders.length > SEARCH_RESULT_LIMIT || files.length > SEARCH_RESULT_LIMIT;
    const trimmedFolders = folders.slice(0, SEARCH_RESULT_LIMIT);
    const trimmedFiles = files.slice(0, SEARCH_RESULT_LIMIT);
    return ok({
      tagIds,
      items: [
        ...trimmedFolders.map((f) => toSearchFolderItem(f, visible)),
        ...trimmedFiles.map(toSearchFileItem),
      ],
      truncated,
    });
  }

  /**
   * タグ ID 集合を正規化（重複排除）し、全要素の実在を検証して返す（setFileTags / setFolderTags / 一括付与の共通前処理・§3）。
   * 空集合は実在検証をスキップ（全解除 / 対象なしの正常系）。存在しない tagId が 1 つでもあれば BadRequest
   * （部分適用せず全体を拒否＝整合性優先）。重複付与は中間テーブルの複合 PK が backstop するが、件数照合の前に畳む。
   */
  private async normalizeAndVerifyTagIds(rawTagIds: string[]): Promise<string[]> {
    const tagIds = [...new Set(rawTagIds)];
    if (tagIds.length > 0) {
      const found = await this.repo.countTagsByIds(tagIds);
      if (found !== tagIds.length) {
        throw new BadRequestException('存在しないタグが含まれています');
      }
    }
    return tagIds;
  }

  /** 最新版をダウンロード素材として返す。ファイル不在／実体未保存は NOT_FOUND。 */
  async downloadFile(fileId: string, user: FileUser): Promise<FileDownload> {
    // DL は所属フォルダが可視 space であること（非可視チャネルの中身は 404・ADR 0063）。
    // 不在・非可視は同一コスト・同一文言の 404（fil-0146）。
    const file = await this.findFileTargetAccessible(
      user,
      SINGLE_TARGET_NOT_FOUND_MESSAGE,
      () => this.repo.findLatestVersionWithFile(fileId),
      (f) => ({ folderId: f.folderId, spaceId: f.folder.spaceId }),
    );
    const version = file.versions[0];
    if (!version) {
      throw new NotFoundException(SINGLE_TARGET_NOT_FOUND_MESSAGE);
    }
    return {
      stream: this.storage.createReadStream(version.storageKey),
      mimeType: version.mimeType,
      fileName: file.name,
    };
  }

  /** 版番号指定でダウンロード素材を返す。該当版が無ければ NOT_FOUND。 */
  async downloadFileVersion(
    fileId: string,
    versionNo: number,
    user: FileUser,
  ): Promise<FileDownload> {
    // 版指定 DL も所属フォルダが可視 space であること（ADR 0063）。版不在・非可視は同一コスト・
    // 同一文言の 404（fil-0146）。
    const version = await this.findFileTargetAccessible(
      user,
      SINGLE_TARGET_NOT_FOUND_MESSAGE,
      () => this.repo.findVersionWithFile(fileId, versionNo),
      (v) => ({ folderId: v.file.folderId, spaceId: v.file.folder.spaceId }),
    );
    return {
      stream: this.storage.createReadStream(version.storageKey),
      mimeType: version.mimeType,
      fileName: version.file.name,
    };
  }

  /**
   * ファイルを削除する。DB レコード（File + 全 FileVersion を Cascade）を先に消し、その後で各版の実体を
   * StorageService から削除する。
   *
   * 順序の理由: DB を真実とし、DB 削除成功後に実体を片付ける。実体削除が一部失敗しても削除操作自体は
   * 成功扱いとする（storage.delete は冪等。残った blob は孤児だが UUID キーで衝突せず実害なし）。
   * 失敗版は warn ログに残し後追い掃除を可能にする（§4: 個別 try/catch ではなく storage 抽象の冪等性に委譲）。
   */
  async deleteFile(id: string, user: FileUser) {
    // 削除は所属フォルダが可視 space であること（ADR 0063）。不在・非可視は同一コスト・
    // 同一文言の 404（fil-0146）。
    const file = await this.findFileTargetAccessible(
      user,
      SINGLE_TARGET_NOT_FOUND_MESSAGE,
      () => this.repo.findFileWithAllVersions(id),
      (f) => ({ folderId: f.folderId, spaceId: f.folder.spaceId }),
    );

    await this.repo.deleteFile(id);
    // 各版の実体は相互独立のため並列削除する。allSettled で 1 版の失敗が他版を止めない。
    // 失敗版は warn ログに残し後追い掃除を可能にする（孤児は UUID キーで衝突せず実害なし）。
    const results = await Promise.allSettled(
      file.versions.map((version) => this.storage.delete(version.storageKey)),
    );
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        const { reason } = result;
        this.logger.warn(
          `ファイル削除時の実体削除に失敗し孤児が残存: storageKey=${file.versions[i].storageKey} (${
            reason instanceof Error ? reason.message : String(reason)
          })`,
        );
      }
    });
    return ok({ id });
  }

  /**
   * 空フォルダを削除する。子（サブフォルダ / ファイル）が 1 件でもあれば Conflict で拒否する
   * （誤操作での再帰削除を防ぐ。中身を消すには利用者が個別に空にしてから削除する）。
   * 空確認と削除は repository の直列化トランザクション（deleteEmptyFolder）で原子的に行う
   * ＝同時に子が追加されても取り違えず Conflict へ倒れる（v2-237）。
   */
  async deleteFolder(id: string, user: FileUser) {
    // 削除は可視 space 内であること（ADR 0063）。不在・非可視は同一コスト・同一文言の 404
    // （fil-0146: 可視範囲先出しの標準形へ統合）。
    await this.assertFolderAccessible(user, id, SINGLE_TARGET_NOT_FOUND_MESSAGE);

    const { deleted } = await this.repo.deleteEmptyFolder(id);
    if (!deleted) {
      throw new ConflictException('空でないフォルダは削除できません');
    }

    return ok({ id });
  }

  /** ファイル設定（最大サイズ / 許可拡張子 / 拒否拡張子）を返す。未設定なら app 既定。 */
  async getSettings() {
    return ok(toFileSettings(await this.repo.findSettings()));
  }

  /**
   * ファイル設定を部分更新する。指定フィールドのみ patch として渡し、未指定フィールドは undefined のまま
   * repository（upsert の update）で更新スキップさせて DB の既存値を保持する。これにより read-modify-write
   * を行わず、同時更新時のロストアップデートを避ける。拡張子は小文字化・重複排除で正規化する
   * （保存形を一意化し、アップロード検証時の照合を安定させる）。
   *
   * rejectedExtensions からはコード固定分（FIXED_REJECTED_EXTENSIONS）を除いて保存する（要求版2）。固定分は
   * 設定に関係なく常に拒否されるため編集一覧へ持つ意味が無く、画面でも「外せる」と誤解させる。400 にはせず
   * 黙って除く＝古いクライアントが既定 9 種をそのまま送っても保存が壊れない。
   */
  async updateSettings(dto: UpdateFileSettingsDto) {
    const updated = await this.repo.upsertSettings({
      maxSizeBytes: dto.maxSizeBytes !== undefined ? BigInt(dto.maxSizeBytes) : undefined,
      allowedExtensions:
        dto.allowedExtensions !== undefined
          ? normalizeExtensions(dto.allowedExtensions)
          : undefined,
      rejectedExtensions:
        dto.rejectedExtensions !== undefined
          ? normalizeExtensions(dto.rejectedExtensions).filter(
              (ext) => !FIXED_REJECTED_EXTENSIONS.includes(ext),
            )
          : undefined,
    });
    return ok(toFileSettings(updated));
  }
}

/** 拡張子リストを小文字化し、出現順を保ったまま重複排除する。 */
function normalizeExtensions(extensions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ext of extensions) {
    const lower = ext.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(lower);
    }
  }
  return result;
}

/**
 * Prisma P2002 エラーが「FileVersion の @@unique([fileId, versionNo])」由来かを判定する（fil-0141）。
 *
 * Prisma の meta.target はカラム名の配列で返るため、'versionNo' と 'fileId' を含むかで
 * FileVersion の複合一意制約かを識別する。それ以外の P2002（folderId_name 等）は即 409 へ倒す。
 *
 * 実装は code='P2002' + meta.target の文字列一致のみで判定する（instanceof 検査なし）。本経路で
 * P2002 を投げるのは Prisma のみのため実用上の混入余地はない（repository は Prisma クライアント経由）。
 */
function isVersionNoPrismaConflict(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  // Prisma のエラーコード（P2002）で判別。meta は dynamic なので as キャストして参照する。
  const code = (e as { code?: unknown }).code;
  if (code !== 'P2002') return false;
  const meta = (e as { meta?: unknown }).meta;
  const target = (meta as { target?: unknown } | undefined)?.target;
  if (!Array.isArray(target)) return false;
  return target.includes('versionNo') && target.includes('fileId');
}
