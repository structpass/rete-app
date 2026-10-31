import { ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * お気に入りの並び替え DTO。orderedIds は **現在のお気に入り全件の id を新しい順序で重複なく** 含める。
 * 登録件数に上限がないため、並び替えだけの件数制限は設けない。
 * 現存全件との一致は repository の transaction 内で検証する（不一致なら更新しない）。
 * repository は受け取った id 群の sortOrder を配列位置（index）で更新する（accountId スコープ付き）。
 */
export class ReorderFavoritesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  orderedIds!: string[];
}
