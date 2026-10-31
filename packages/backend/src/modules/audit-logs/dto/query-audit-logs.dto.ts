import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  AUDIT_ACTION_TYPES,
  AUDIT_PAGE_SIZE,
  type AuditActionType,
  type AuditLogQuery,
} from '@rete/shared';
import { AUDIT_MAX_LIMIT, AUDIT_SEARCH_MAX_LENGTH } from '../audit-logs.constants';

/**
 * 操作ログ検索クエリ DTO（GET /audit-logs・GET /audit-logs/export 共通）。すべて任意。
 * actionType は @rete/shared AUDIT_ACTION_TYPES の値域に強制（不正値は 400）。期間は ISO 日付文字列で受け、
 * service が Date 境界（from=日初 / to=日末）へ正規化する。export は from/to 必須 + 92 日上限を service で検証。
 */
export class QueryAuditLogsDto implements AuditLogQuery {
  @ApiPropertyOptional({ description: 'ページ番号（1 始まり）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'ページサイズ' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_MAX_LIMIT)
  limit: number = AUDIT_PAGE_SIZE;

  @ApiPropertyOptional({ description: 'ユーザー名 / メールの部分一致（大文字小文字無視）' })
  @IsOptional()
  @IsString()
  @MaxLength(AUDIT_SEARCH_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional({ description: '操作種別', enum: AUDIT_ACTION_TYPES })
  @IsOptional()
  @IsIn(AUDIT_ACTION_TYPES)
  actionType?: AuditActionType;

  @ApiPropertyOptional({ description: 'システム id（TenantSystem.id・"共通操作" は __common__）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  systemId?: string;

  @ApiPropertyOptional({ description: '期間開始（ISO 日付・含む）' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: '期間終了（ISO 日付・含む）' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'keyset カーソル（(createdAt, id) の不透明トークン）' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'カーソル起点からの移動方向（省略時は先頭ページ）',
    enum: ['next', 'prev', 'last'],
  })
  @IsOptional()
  @IsIn(['next', 'prev', 'last'])
  direction?: 'next' | 'prev' | 'last';
}
