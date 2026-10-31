import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 構造参照の解決の入力（GET /files/refs・FL+1・設計 §2.3）。
 * ids は参照ノードの `data-id`（ファイル / フォルダ）をカンマ区切りで渡す。
 * 1 回の要求で受ける id 数は REF_RESOLVE_MAX（20 件）を固定上限とし、超えた分は service で切り捨てる
 * （本文 1 本あたりの参照は 10 件上限のため余裕を見た値・設計 §2.3）。
 */
export class ResolveFileRefsQueryDto {
  @ApiPropertyOptional({
    description: '参照ノードの id（カンマ区切り・最大 20 件）',
    type: String,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  ids?: string;
}
