/**
 * 明細テーブルの列幅（個人設定）の応答形の SSOT（v2-245 で集約）。
 * backend の UserTableColumnWidthResponseDto と frontend の api 型が同形を別々に宣言していたため、
 * 形の正本をここへ一本化した（backend の dto は再公開のみ・frontend は本型を参照する）。
 * tableId は route パラメータ由来の文字列で、値域の検証（TABLE_IDS のいずれか）は backend の
 * route パラメータの pipe が担う（DB 列は string のため、形としては string のまま公開する）。
 */

/**
 * UserTableColumnWidth の API レスポンス DTO（§1 DTO 境界）。
 * Prisma Entity を直返ししない。userId は自分自身のデータなので冗長のため含めない。
 * Date は ISO 文字列に正規化してフロントへ届ける。
 */
export interface UserTableColumnWidthResponseDto {
  tableId: string;
  columnKey: string;
  width: number;
  updatedAt: string;
}
