import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccountsService } from './accounts.service';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UpdateDeskPreferenceDto } from './dto/desk-preference.dto';
import { UpdateDisplayPreferenceDto } from './dto/display-preference.dto';
import {
  ACCOUNTS_CONTROLLER_PATH,
  ACCOUNTS_DISPLAY_PREFERENCE_PATH,
} from '../../common/config/api-routes';

/**
 * 担当者割当 UI 向け Account 一覧の REST。ログイン必須（AuthenticatedGuard）だが ADMIN 限定にはしない
 * （MEMBER もタスク担当に割り当てるため tasks / chat と同じ認証のみ境界）。
 *
 * レスポンスは AccountSummaryDto（id + 表示名のみ）に絞り、email / role / passwordHash 等の
 * 機密・内部列は一切返さない（§1 DTO 境界）。
 *
 * me/desk-preference は Desk UI の個人設定（ペイン幅比率 / rete-desk-0142）。対象は常にセッション
 * 本人（@CurrentUser 由来）で、他人の設定 id を指定する経路自体が存在しない（IDOR 不成立）。
 */
@ApiTags('accounts')
@Controller(ACCOUNTS_CONTROLLER_PATH)
@UseGuards(AuthenticatedGuard)
export class AccountsController {
  constructor(private readonly service: AccountsService) {}

  @Get()
  // dsk-0414: 列挙抑止のため by-space と同値の per-route Throttle を付与する（既往の付け忘れ）。
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '担当者候補の一覧（呼び出し元の組織境界内・id + 表示名のみ）' })
  // dsk-0408: 呼び出し元の ORGANIZATION membership で結果を絞る（水平越境の視認防止）。
  findAll(@CurrentUser('id') callerId: string) {
    return this.service.findAll(callerId);
  }

  @Get('by-space')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      '担当者候補を Space メンバーに絞った一覧（非可視 Space は 404・spaceId 未指定/可視だが未紐付けは全有効アカウントへフォールバック）',
  })
  // spaceId は UUID 必須（任意・未指定可）。非 UUID は 400 で弾き、malformed 入力が黙って全員フォールバックに
  // 落ちる曖昧経路を塞ぐ（categories / memberships と同じ ParseUUIDPipe 検証規約）。2 段クエリのため /accounts より
  // 重く、列挙抑止に per-route Throttle を付与する。
  // dsk-0408: フォールバック先（findAll）の org 境界だけでは主経路に caller が届かないため、service 側で
  // ScopeVisibilityService.assertVisibleOr404 を通す（非可視 Space は 404 の存在秘匿・v2-230）。
  findBySpace(
    @CurrentUser('id') callerId: string,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
  ) {
    return this.service.findBySpace(callerId, spaceId);
  }

  @Get('me/desk-preference')
  @ApiOperation({ summary: 'Desk 個人設定（ペイン幅比率）の取得。未保存なら data:null' })
  getDeskPreference(@CurrentUser('id') accountId: string) {
    return this.service.getDeskPreference(accountId);
  }

  @Put('me/desk-preference')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Desk 個人設定（ペイン幅比率）の保存（upsert）' })
  updateDeskPreference(@CurrentUser('id') accountId: string, @Body() dto: UpdateDeskPreferenceDto) {
    return this.service.updateDeskPreference(accountId, dto);
  }

  @Get(ACCOUNTS_DISPLAY_PREFERENCE_PATH)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '表示個人設定（明細の縞模様）の取得。未保存なら data:null' })
  // 個人設定の取得は Rete 自身の UI からのみ呼ばれる（d1264/d1265 で reference からの写しは廃止）。
  // per-route Throttle は列挙抑止のため残す（他ルートと揃える）。
  getDisplayPreference(@CurrentUser('id') accountId: string) {
    return this.service.getDisplayPreference(accountId);
  }

  @Put(ACCOUNTS_DISPLAY_PREFERENCE_PATH)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '表示個人設定（明細の縞模様）の保存（upsert・反映は再ログイン時）' })
  updateDisplayPreference(
    @CurrentUser('id') accountId: string,
    @Body() dto: UpdateDisplayPreferenceDto,
  ) {
    return this.service.updateDisplayPreference(accountId, dto);
  }
}
