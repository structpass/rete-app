import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserTableColumnWidthsService } from './user-table-column-widths.service';
import { UpsertColumnWidthDto } from './dto';
import { ParseColumnKeyPipe, ParseTableIdPipe } from './pipes';

// 列幅はユーザー個人設定（AuthenticatedGuard のみ・自分自身の行のみ）。
// tableId / columnKey の検査は decorator の pipe が担う（ParseUUIDPipe と同じ置き方・d925）。
@ApiTags('user-table-column-widths')
@Controller('user-table-column-widths')
@UseGuards(AuthenticatedGuard, RolesGuard)
export class UserTableColumnWidthsController {
  constructor(private readonly service: UserTableColumnWidthsService) {}

  @Get(':tableId')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: '指定テーブルの列幅一覧取得' })
  @ApiParam({ name: 'tableId', description: 'テーブル ID（TABLE_IDS のいずれか）' })
  async getMine(
    @CurrentUser('id') userId: string,
    @Param('tableId', ParseTableIdPipe) tableId: string,
  ) {
    return this.service.getMine(userId, tableId);
  }

  /**
   * drag end + 300ms debounce 前提のため、ユーザー単位で 60 req/60s に制限する。
   * 通常操作（10 列を順次リサイズ）では 10 req 程度。攻撃シナリオ（debounce バイパス）を抑制する。
   */
  @Put(':tableId/:columnKey')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: '列幅を upsert（追加 or 更新）' })
  @ApiParam({ name: 'tableId', description: 'テーブル ID（TABLE_IDS のいずれか）' })
  @ApiParam({ name: 'columnKey', description: '列キー（英数字 / -_.:、1-64 文字）' })
  async upsert(
    @CurrentUser('id') userId: string,
    @Param('tableId', ParseTableIdPipe) tableId: string,
    @Param('columnKey', ParseColumnKeyPipe) columnKey: string,
    @Body() dto: UpsertColumnWidthDto,
  ) {
    return this.service.upsert(userId, tableId, columnKey, dto.width);
  }

  /**
   * 指定テーブルの列幅を既定へリセット（保存済み行を全削除 / fil-0054）。
   * upsert と同じ認可境界・throttle を適用する。
   */
  @Delete(':tableId')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: '指定テーブルの列幅を既定へリセット（全削除）' })
  @ApiParam({ name: 'tableId', description: 'テーブル ID（TABLE_IDS のいずれか）' })
  async reset(
    @CurrentUser('id') userId: string,
    @Param('tableId', ParseTableIdPipe) tableId: string,
  ) {
    return this.service.resetMine(userId, tableId);
  }
}
