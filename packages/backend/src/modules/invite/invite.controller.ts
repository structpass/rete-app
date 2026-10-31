import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Role } from '@rete/shared';
import { UploadErrorFilter } from '../../common/filters';
import { clientIp, clientUserAgent } from '../../common/net/client-ip';
import { InviteService } from './invite.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ImportCsvBodyDto } from './dto/import-csv.dto';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import { AUDIT_RETE_SYSTEM_NAME } from '../audit-logs/audit-logs.constants';

/**
 * 招待 CSV 取り込みの容量上限（multipart 層・1 MB）。
 *
 * 招待 CSV はメールアドレスの一覧で、1 MB で十分（開発統括判断・2026-09-24）。設定値にはせず固定のまま
 * （可変パラメータにしない）。FileInterceptor の上限と拒否文言の実値が同じ定数を参照し、
 * 表示と実際の制限が食い違わないようにする。
 */
const INVITE_CSV_MAX_BYTES = 1024 * 1024;

/**
 * 招待管理（Settings ST-5）の REST。
 *
 * 認可設計:
 *  - 管理系エンドポイント（発行/一覧/再送/削除/CSV/mail-status）: ADMIN 限定（AuthenticatedGuard + RolesGuard）。
 *  - 受諾エンドポイント（POST /invites/accept）: 公開（guard 無し・throttle 付き）。
 *    グローバルな APP_GUARD は ThrottlerGuard のみなので guard を付けなければ公開になる。
 *
 * セキュリティ:
 *  - 受諾は throttle でブルートフォース抑制（login 同等の 5/60s）。
 *  - CSV import の file サイズ上限は 1MB（招待 CSV は行ごとにメールアドレス 1 行のみのため十分）。
 */
@ApiTags('invites')
@Controller('invites')
export class InviteController {
  private readonly logger = new Logger(InviteController.name);

  constructor(
    private readonly service: InviteService,
    private readonly auditRecorder: AuditRecorderService,
  ) {}

  // -----------------------------------------------------------------------
  // ADMIN 管理系（AuthenticatedGuard + RolesGuard(ADMIN) で保護）
  // -----------------------------------------------------------------------

  @Get()
  @UseGuards(AuthenticatedGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '招待一覧（ADMIN 限定・effective status 算出済み）' })
  findAll() {
    return this.service.findAll();
  }

  /**
   * メール設定状態確認（論点2: SMTP 未設定の事前提示）。
   * 招待フォームを開く前に ADMIN がメール設定の有無を確認するためのエンドポイント。
   * GET /api/invites/mail-status → { configured: boolean }
   */
  @Get('mail-status')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseGuards(AuthenticatedGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'メール設定状態確認（ADMIN 限定）' })
  getMailStatus() {
    return this.service.getMailStatus();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(AuthenticatedGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '招待発行（ADMIN 限定・SMTP 必須・重複 PENDING は BadRequest）' })
  issue(@Body() dto: CreateInviteDto, @CurrentUser('id') issuedById: string) {
    return this.service.issue(dto.email, dto.spaceId, issuedById);
  }

  @Post(':id/resend')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(AuthenticatedGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '招待再送（ADMIN 限定・token 再生成・expiresAt 延長）' })
  @ApiParam({ name: 'id', description: '招待 ID (UUID)' })
  resend(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.resend(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthenticatedGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '招待削除（ADMIN 限定・物理削除・任意 status を対象）' })
  @ApiParam({ name: 'id', description: '招待 ID (UUID)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }

  // CSV 関連（':id' より前に宣言して 'import' を UUID パラメータとして拾わせない）
  @Get('csv/template')
  @UseGuards(AuthenticatedGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '招待 CSV テンプレートダウンロード（ADMIN 限定）' })
  @ApiProduces('text/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async downloadTemplate(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Disposition', 'attachment; filename="invite-template.csv"');
    return this.service.getTemplateCsv();
  }

  @Post('csv/import')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(AuthenticatedGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: INVITE_CSV_MAX_BYTES } }))
  // multipart の拒否（サイズ超過 413・回数制限 429）を日本語で案内する（v2-209）。
  // 実値は FileInterceptor の上限と同じ定数を渡す（表示と実際の制限を食い違わせない）。
  @UseFilters(new UploadErrorFilter({ maxFileSizeBytes: INVITE_CSV_MAX_BYTES }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '招待 CSV 一括インポート（ADMIN 限定・best-effort 送信・サマリ返却）' })
  importCsv(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: ImportCsvBodyDto,
    @CurrentUser('id') issuedById: string,
  ) {
    if (!file) {
      throw new BadRequestException('CSV ファイルを選択してください');
    }
    return this.service.importCsv(file.buffer, body.spaceId, issuedById);
  }

  // -----------------------------------------------------------------------
  // 公開（guard 無し・throttle 付き）
  // -----------------------------------------------------------------------

  /**
   * 招待受諾（未ログインユーザーが招待リンクから実行）。
   * login と同等の throttle（5/60s）でブルートフォース抑制。
   * 全失敗ケースは曖昧なエラー（列挙防止）。
   *
   * 記録（d559）: この経路は認証前のため横断の操作ログ interceptor の対象外。受諾でアカウントが
   * できた事実は、作成された当人を actor にして actionType='create' で明示記録する（login と同型）。
   * 失敗（4xx）は operational-policy §6 の方針どおり記録しない。
   */
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: '招待受諾（公開・throttle 付き・token 照合 + Account 作成）' })
  async accept(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    const { accepted, response } = await this.service.accept(dto.token, dto.name, dto.password);
    // best-effort（recorder は reject しない・§3 止めない側）。
    void this.auditRecorder
      .record({
        actorAccountId: accepted.accountId,
        actorName: dto.name,
        actorEmail: accepted.email,
        systemId: null,
        systemName: AUDIT_RETE_SYSTEM_NAME,
        actionType: 'create',
        feature: '招待',
        summary: '招待を受諾してアカウントを作成しました',
        ipAddress: clientIp(req),
        userAgent: clientUserAgent(req),
      })
      .catch((err: unknown) => {
        // recorder 内部 catch の漏れに備えたフォールバック。
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(`InviteController: audit record failed: ${detail}`);
      });
    return response;
  }
}
