import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { HOME_TAG_KINDS, HomeTagKind } from '@rete/shared';

/** query のブールパラメータを正規化する（`?k=true` のみ true、未指定/その他は undefined）。 */
const toBoolean = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  return value === 'true' || value === true;
};

/**
 * タグ一覧取得のクエリ（kind スコープ・hom-0072）。未指定は'board'。
 * includeArchived=true はタグ管理画面専用（既定はアーカイブ済を除外・hom-0083）。
 */
export class FindAnnouncementTagsDto {
  @IsOptional()
  @IsIn(HOME_TAG_KINDS)
  kind?: HomeTagKind = 'board';

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}
