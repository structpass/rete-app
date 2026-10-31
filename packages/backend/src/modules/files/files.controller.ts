import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  UseFilters,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { Role } from '@rete/shared';
import { FileDownload, FilesService } from './files.service';
import { UpdateFileSettingsDto } from './dto/files-settings.dto';
import { MoveFolderDto, MoveFileDto } from './dto/move.dto';
import { CreateFolderDto } from './dto/create-folder.dto';
import { SearchFilesQueryDto } from './dto/search-files.dto';
import { ResolveFileRefsQueryDto } from './dto/resolve-file-refs.dto';
import { SetFileTagsDto } from './dto/set-file-tags.dto';
import { BatchAssignTagsDto, SetFolderTagsDto, TagSearchQueryDto } from './dto/tag-assignment.dto';
import { resolveUploadTempDir, UPLOAD_HARD_LIMIT_BYTES } from './files.constants';
import { UploadErrorFilter } from '../../common/filters';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

/**
 * アップロード受けの共通 multer オプション（fil-0121）。
 * diskStorage で保存ルート配下の一時フォルダ（UPLOAD_TEMP_DIR_NAME）へ受け、リクエスト本文を全量 RAM に
 * 保持しない（memory storage 不使用・criteria 1）。一時ファイル名は UUID 乱数（元ファイル名は service が
 * サニタイズ後に最終名を決めるため、ここでは保持しない）。multipart 層の hard cap（limits.fileSize）で
 * 切断された時、multer は保存済みの一時ファイルを自動削除する（criteria 4）。
 *
 * destination はリクエスト毎に解決する関数にする（モジュールスコープ定数だと import 評価時＝.env ロード前の
 * 値を掴み、FILE_STORAGE_ROOT を .env で設定した時に LocalFsStorageService と食い違う）。関数は毎回
 * mkdir し直すので、onModuleInit の起動時掃除が一時フォルダを消した後も再作成される（自己 DoS 防止）。
 */
const uploadMulterOptions = {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      try {
        const dir = resolveUploadTempDir();
        mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        // multer は error があれば destination 引数を無視する（型上は 2 引数必須のため空文字を渡す）。
        cb(err as Error, '');
      }
    },
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  // fil-0121 の diskStorage + fileSize 制限に加え、cmn-0260 系の DoS 余地を断つため
  // 1 リクエスト = 1 ファイル・非ファイルフィールド 0 に固定（security-review 2026-08-02 反映）。
  // 非ファイルフィールドを許すと 1MB 以下の multipart フィールド大量投入で fileSize 上限を回避してヒープを枯渇できる。
  // 両 endpoint（uploadFile / uploadFileVersion）は @Body を受け取らないため fields: 0 は実害なし。
  // parts は「本文のパート数（= 境界の数 − 1）」の上限として指定する。busboy は parts を初期境界の分だけ
  // -1 から数えるため、parts: 1 では正当な 1 ファイル目の終端境界で partsLimit に達し、すべての
  // アップロードが 400 Too many parts になる（v2-189 で実測）。一方 parts を外すと、file にも field にも
  // 数えられない Content-Disposition 無しパート（busboy が skipPart で捨てる）の数と本文サイズが
  // 無制限になり、帯域と CPU を消費させられる（security review 指摘）。よって「1 ファイル = 1 パート」を
  // 上限に置くのが正しい。
  //
  // この 1 が上限として効くかは multer の版に依存する（fil-0157 の「部品更新時にアップロード上限まわりを
  // 再確認する」に該当）。multer 2.4.0 で limits.parts / limits.fileSize を busboy へ「上限 + 1」で渡す
  // 変換が入り（lib/make-middleware.js の busboyLimits。busboy の partsLimit は「上限に達した」時点で
  // 発火する仕様のための補正）、2.2.0 の「parts: 2 で実質 1 パート」は 3 パートまで通る形へ変わった。
  // parts は変換後の busboy 側で 2 になるため、1 ファイル目（parts 0）は通り、Content-Disposition 無しの
  // 2 パート目（parts 1）で本文の読み取りが打ち切られる（実測: limits.parts 1 → 400 LIMIT_PART_COUNT、
  // 同 2 → 201。2.2.0 / 2.4.0 の両版で同じ結果）。
  limits: {
    fileSize: UPLOAD_HARD_LIMIT_BYTES,
    files: 1,
    fields: 0,
    parts: 1,
    // fil-0157: multer メジャー更新時は removeUploadedFiles 経路（部分書き込みの補償削除）を再確認する。
    // 上限超過（fileSize）で切られた一時ファイルが確実に削除されること・実体保存失敗時の後始末が
    // 変わらないことを fixture で固定してから上げる（アップロード上限まわりは部品更新時に再確認）。
  },
};

/**
 * File タブの REST。全エンドポイントはログイン必須（AuthenticatedGuard）。
 * 可視性（Space スコープ）は service 層で enforce する（ScopeVisibilityService）。
 * 一部の管理操作（設定更新）は @Roles(Role.ADMIN) + RolesGuard で ADMIN 限定。
 * RolesGuard は @Roles 無しの handler を素通しするため、読み取り/一般書き込み系には影響しない。
 */
@ApiTags('files')
@Controller('files')
@UseGuards(AuthenticatedGuard, RolesGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  // ツリーは器（Space）単位で完結する（ADR 0063）。spaceId は必須（fil-0137 で frontend が常時送る
  // ようになり移行期フォールバックを撤去）。非可視 space の指定は service 層が 404 で返す（存在秘匿）。
  @Get('tree')
  @ApiOperation({ summary: 'フォルダツリー取得（ネスト・器スコープ）' })
  @ApiQuery({ name: 'spaceId', required: true, description: '対象の器（Space ID・UUID）' })
  async getTree(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId', new ParseUUIDPipe()) spaceId: string,
  ) {
    return this.filesService.getTree(user, spaceId);
  }

  // 横断検索（rete-files-0004）。読み取り系だが LIKE 全件走査でコストが高いため、グローバル既定（30/min）より
  // 厳しめの throttle を掛ける（検索は 300ms debounce のため入力中でも 20/min に収まる）。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('search')
  @ApiOperation({ summary: '横断検索（ファイル名 / フォルダ名の部分一致・全階層）' })
  async search(@Query() query: SearchFilesQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.filesService.search(query.q, user);
  }

  // 構造参照の解決（FL+1・設計 §2.3）。本文 1 本の描画ごとに最大 1 回呼ばれる読み取りで、id は 20 件上限。
  // 返すのは可視の対象だけ（不在・非可視は結果に現れない＝存在秘匿・ADR 0038）。
  // fileId の列挙を伴うため、既存のファイル参照と同じ 20/min に制限する。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('refs')
  @ApiOperation({ summary: '構造参照の解決（可視の対象だけを現在のパス表記つきで返す）' })
  @ApiQuery({
    name: 'ids',
    required: false,
    description: '参照ノードの id（カンマ区切り・最大 20 件）',
  })
  async resolveRefs(
    @Query() query: ResolveFileRefsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.resolveRefs(query.ids, user);
  }

  @Get('settings')
  @ApiOperation({ summary: 'ファイル設定取得（最大サイズ / 許可拡張子）' })
  async getSettings() {
    return this.filesService.getSettings();
  }

  // 設定書き込みは ADMIN 限定。FileSettings は全ユーザー共通の singleton のため、非管理者が
  // maxSizeBytes=1 / allowedExtensions=[] へ改変すると全員のアップロードを妨害（DoS）できる。
  // throttle は連続上書きの抑止のみで認可の代替にならないため @Roles(Role.ADMIN) で封鎖する
  // （announcement-tags の書き込み系と同方針）。throttle も従来どおり併用。
  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Patch('settings')
  @ApiOperation({ summary: 'ファイル設定更新（ADMIN 限定・最大サイズ / 許可拡張子・部分更新可）' })
  async updateSettings(@Body() dto: UpdateFileSettingsDto) {
    return this.filesService.updateSettings(dto);
  }

  @Get('folders/:id')
  @ApiOperation({ summary: 'フォルダ内容取得（パンくず + 直下サブフォルダ/ファイル）' })
  @ApiParam({ name: 'id', description: 'フォルダ ID (UUID)' })
  async getFolderContent(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.getFolderContent(id, user);
  }

  // ディレクトリ権限（per-folder ACL）の取得・保存エンドポイントは ADR 0063 で撤去した。
  // 可視性は「チャネル（Space）が見えれば配下ファイルも見える」の一本になり、設定対象を持たない。

  // フォルダ作成は書き込み系のため厳しめ throttle（アップロードと同方針）。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('folders')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'フォルダ作成（新規・空フォルダ。parentFolderId=null でルート直下）' })
  async createFolder(@Body() dto: CreateFolderDto, @CurrentUser() user: AuthenticatedUser) {
    return this.filesService.createFolder(dto.parentFolderId, dto.name, user, dto.spaceId);
  }

  // 書き込み系はスパムアップロード抑制のため全体 throttle より厳しめ（chat 書き込みと同方針）。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('folders/:id/files')
  @UseInterceptors(FileInterceptor('file', uploadMulterOptions))
  @UseFilters(new UploadErrorFilter({ maxFileSizeBytes: UPLOAD_HARD_LIMIT_BYTES }))
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'ファイルアップロード（同名は版追加・新規は初版作成）' })
  @ApiParam({ name: 'id', description: 'アップロード先フォルダ ID (UUID)' })
  uploadFile(
    @Param('id', ParseUUIDPipe) folderId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.uploadFile(folderId, file, user);
  }

  // 既存ファイルへの新版アップロード（FF お気に入り編集の「DL→ローカル編集→再アップ」着地点）。
  // 同名一致でなくファイル id で版を確定するため、ローカル編集時のリネームでも別ファイル誤生成しない。
  // 書き込み系のためアップロードと同方針の厳しめ throttle。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('files/:id/versions')
  @UseInterceptors(FileInterceptor('file', uploadMulterOptions))
  @UseFilters(new UploadErrorFilter({ maxFileSizeBytes: UPLOAD_HARD_LIMIT_BYTES }))
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'ファイル新版アップロード（既存ファイル id へ版追加・FF お気に入り編集）',
  })
  @ApiParam({ name: 'id', description: '対象ファイル ID (UUID)' })
  uploadFileVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.uploadFileVersion(id, file, user);
  }

  // 移動は書き込み系のため厳しめ throttle（アップロード/設定と同方針）。
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch('folders/:id/move')
  @ApiOperation({ summary: 'フォルダ移動（親フォルダの付け替え・null でルート直下）' })
  @ApiParam({ name: 'id', description: '移動するフォルダ ID (UUID)' })
  async moveFolder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveFolderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.moveFolder(id, dto.parentFolderId, user);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch('files/:id/move')
  @ApiOperation({ summary: 'ファイル移動（所属フォルダの変更）' })
  @ApiParam({ name: 'id', description: '移動するファイル ID (UUID)' })
  async moveFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveFileDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.moveFile(id, dto.folderId, user);
  }

  // 削除は破壊的操作のため書き込み系と同方針の厳しめ throttle（移動と同 limit）。
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete('files/:id')
  @ApiOperation({ summary: 'ファイル削除（全版 + 実体を削除）' })
  @ApiParam({ name: 'id', description: '削除するファイル ID (UUID)' })
  async deleteFile(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.filesService.deleteFile(id, user);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete('folders/:id')
  @ApiOperation({ summary: 'フォルダ削除（空フォルダのみ・非空は 409）' })
  @ApiParam({ name: 'id', description: '削除するフォルダ ID (UUID)' })
  async deleteFolder(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.deleteFolder(id, user);
  }

  // タグ付与は書き込み系のため厳しめ throttle（移動/削除と同 limit）。付与後の行（タグ込み）を返す。
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Put('files/:id/tags')
  @ApiOperation({ summary: 'ファイルのタグ付与集合を置換（全置換・空配列で全解除）' })
  @ApiParam({ name: 'id', description: 'ファイル ID (UUID)' })
  async setFileTags(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetFileTagsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.setFileTags(id, dto.tagIds, user);
  }

  // フォルダのタグ付与（rete-files-0033・ファイルと同方針の全置換・厳しめ throttle）。
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Put('folders/:id/tags')
  @ApiOperation({ summary: 'フォルダのタグ付与集合を置換（全置換・空配列で全解除）' })
  @ApiParam({ name: 'id', description: 'フォルダ ID (UUID)' })
  async setFolderTags(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetFolderTagsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.setFolderTags(id, dto.tagIds, user);
  }

  // 複数ファイル / フォルダへタグを一括「追加」付与（rete-files-0034・追加方式・件数を返す）。書き込み系の厳しめ throttle。
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('tags/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '複数ファイル/フォルダへのタグ一括付与（追加方式・既存付与は保持）' })
  async assignTagsBatch(@Body() dto: BatchAssignTagsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.filesService.assignTagsBatch(dto, user);
  }

  // タグ横断検索（rete-files-0032）。指定タグが付くファイル/フォルダを全階層から拾う。LIKE 走査と同じく
  // 中間テーブル経由の絞り込みでコストがあるため、name 検索と同方針の厳しめ throttle を掛ける。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('tags/search')
  @ApiOperation({
    summary: 'タグ横断検索（指定タグが付くファイル/フォルダを全階層から取得・OR 条件）',
  })
  async searchByTags(@Query() query: TagSearchQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.filesService.searchByTags(query.tagIds, user);
  }

  // 認証済みでも fileId（UUID）を総当りして存在有無を列挙されうるため、search と同方針の厳しめ throttle を掛ける。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('files/:id')
  @ApiOperation({
    summary: 'ファイルメタ取得（名前 / 所属フォルダ / 最新版番号・FF お気に入り編集）',
  })
  @ApiParam({ name: 'id', description: 'ファイル ID (UUID)' })
  async getFileMeta(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.getFileMeta(id, user);
  }

  @Get('files/:id/download')
  @ApiOperation({ summary: 'ファイルダウンロード（最新版）' })
  @ApiParam({ name: 'id', description: 'ファイル ID (UUID)' })
  async downloadFile(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    return this.toStreamable(await this.filesService.downloadFile(id, user));
  }

  @Get('files/:id/versions/:versionNo/download')
  @ApiOperation({ summary: 'ファイルダウンロード（版指定）' })
  @ApiParam({ name: 'id', description: 'ファイル ID (UUID)' })
  @ApiParam({ name: 'versionNo', description: '版番号（1 始まり）' })
  async downloadVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionNo', ParseIntPipe) versionNo: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    return this.toStreamable(await this.filesService.downloadFileVersion(id, versionNo, user));
  }

  /**
   * ダウンロード素材を StreamableFile に包む。日本語ファイル名は RFC 5987 の filename*（UTF-8）で
   * エンコードし、非 ASCII 名でも文字化け/ヘッダ破損を防ぐ。
   */
  private toStreamable(dl: FileDownload): StreamableFile {
    return new StreamableFile(dl.stream, {
      type: dl.mimeType,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(dl.fileName)}`,
    });
  }
}
