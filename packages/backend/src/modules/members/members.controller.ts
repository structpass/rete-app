import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Role } from '@rete/shared';
import { MembersService } from './members.service';
import { UpdateMemberDto } from './dto/update-member.dto';
import { SetSystemRoleDto } from './dto/set-system-role.dto';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { clientIp, clientUserAgent } from '../../common/net/client-ip';
import type { AuthenticatedUser } from '../auth/auth.service';

/**
 * メンバー管理（Settings ST-4）の REST。一覧は email（PII）を含むため、
 * 全エンドポイントを ADMIN 限定にする（クラスレベル @Roles(Role.ADMIN) を RolesGuard が getAllAndOverride で適用）。
 * roles の一覧が全認証ユーザー閲覧可なのと異なり、メンバー一覧は ADMIN のみ（2026-06-05 運用ポリシー）。
 * ここでの ADMIN は既存 Account.role（rete システム権限層）であり、割り当てる業務ロールとは別層（二層併存）。
 */
@ApiTags('members')
@Controller('members')
@UseGuards(AuthenticatedGuard, RolesGuard)
@Roles(Role.ADMIN)
export class MembersController {
  constructor(private readonly service: MembersService) {}

  @Get()
  @ApiOperation({
    summary: 'メンバー一覧（作成順・ADMIN 限定）',
  })
  findAll() {
    return this.service.findAll();
  }

  // ':id' より前に宣言する（'export' を UUID パラメータとして拾わせないため）。
  // export は findAll + 全件 CSV 文字列展開とコスト高のため、
  // list（グローバル制限のみ）より厳しい個別 @Throttle を付与する（ST-6 audit export の 5/60s と境界揃え・rete-settings-0018）。
  // 読み取りでも一覧（メールアドレスを含む）を持ち出す操作だが、記録は横断 interceptor が担う
  // （audit-log.interceptor の GET_EXPORT_PATHS・d534）。ここで記録すると二重になる。
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get('export')
  @ApiOperation({ summary: 'メンバー一覧 CSV エクスポート（UTF-8 BOM・ADMIN 限定）' })
  @ApiProduces('text/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Disposition', 'attachment; filename="members.csv"');
    return this.service.exportCsv();
  }

  @Get(':id')
  @ApiOperation({ summary: 'メンバー詳細（行編集オーバーレイのロード用・ADMIN 限定）' })
  @ApiParam({ name: 'id', description: 'アカウント ID (UUID)' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Patch(':id')
  @ApiOperation({
    summary: 'メンバー編集（ADMIN 限定・ロック/解除・email 変更）',
  })
  @ApiParam({ name: 'id', description: 'アカウント ID (UUID)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    // アクセス元は controller で取り出して渡す（service に Request を持ち込まない・rete-members-0001）。
    return this.service.update(id, dto, actor, {
      ipAddress: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }

  // ログイン試行ロックアウト（set-0025 P4 / lockedUntil）の手動即時解除（set-0030）。
  // ':id/unlock' は ':id' とセグメント数が異なるため衝突しない。クラスレベル @Roles(Role.ADMIN) で ADMIN 限定。
  // isActive のロック/解除（@Patch(':id')）とは別操作（あちらは管理者の手動無効化、こちらは brute-force 自動防御の解除）。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Patch(':id/unlock')
  @ApiOperation({
    summary: 'ログイン試行ロックアウトの手動即時解除（ADMIN 限定・lockedUntil/失敗回数クリア）',
  })
  @ApiParam({ name: 'id', description: 'アカウント ID (UUID)' })
  unlockLockout(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.unlockLockout(id, actor, {
      ipAddress: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }

  // 二段階認証（MFA/TOTP）の管理者強制リセット（set-0033・P6）。':id/mfa-reset' は ':id' とセグメント数が異なり衝突しない。
  // クラスレベル @Roles(Role.ADMIN) で ADMIN 限定。self-service の disable（本人コード確認）とは別操作（管理者は本人コードなしで復旧用にリセット）。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Patch(':id/mfa-reset')
  @ApiOperation({
    summary:
      '二段階認証（MFA）の管理者強制リセット（ADMIN 限定・MfaSetting/バックアップコード削除・復旧用）',
  })
  @ApiParam({ name: 'id', description: 'アカウント ID (UUID)' })
  resetMfa(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.resetMfa(id, actor, {
      ipAddress: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }

  // system-role は ':id' とパスセグメント数が異なる（:id/system-role）ため衝突しない。
  // クラスレベル @Roles(Role.ADMIN) によりシステム管理者のみが昇格/降格を実行できる。
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Patch(':id/system-role')
  @ApiOperation({
    summary:
      'システムロール昇格/降格（ADMIN 限定・Account.role を ADMIN⇆MEMBER・全消失ガード付き）',
  })
  @ApiParam({ name: 'id', description: 'アカウント ID (UUID)' })
  setSystemRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetSystemRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.setSystemRole(id, dto.role, actor, {
      ipAddress: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }
}
