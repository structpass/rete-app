/**
 * CRUD モジュール共通のリスト取得ヘルパー（§3 コピペ回避のための shared abstraction）。
 * 各モジュールの findAll で重複する where 構築・ソート解決・ページネーション処理を集約する。
 *
 * 本ヘルパーは「Prisma Entity + meta」だけを返す（§2 データアクセス層の純粋化）。
 * DTO への mapping と `okPaginated` でのレスポンス整形は呼び出し側の Service が担う。
 */
import type { PaginationMeta } from '../dto/response.dto';
import { buildPaginatedMeta } from '../dto/response.dto';

// 引数の型は各関数のシグネチャに現れるため、利用側は型名を取り込まない（d611）。
interface ListQueryParams {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  status?: string;
  categoryId?: number;
}

export interface ListConfig {
  searchFields: string[];
  allowedSortFields: string[];
  defaultSort?: string;
  /** paginatedList の findMany にだけ渡す include 句 */
  paginatedInclude?: Record<string, unknown>;
  /** 常時適用する固定 where（query 由来の条件とマージ / rete-desk-0140: アーカイブ分類のタスク非表示等）。 */
  baseWhere?: Record<string, unknown>;
}

interface PrismaListDelegate<T> {
  findMany(args: unknown): Promise<T[]>;
  count(args: unknown): Promise<number>;
}

/** Entity の配列とページネーション meta（DTO 変換・レスポンス整形前の生結果）。 */
export interface PaginatedEntities<T> {
  data: T[];
  meta: PaginationMeta;
}

export function buildListWhere(
  query: ListQueryParams,
  config: ListConfig,
): Record<string, unknown> {
  // 固定条件（baseWhere）を土台に query 由来の条件を重ねる。
  // baseWhere はリレーションパスのキー（例: `category: { archivedAt: null }`）に限定して使う運用。
  // 一方 query 由来の `categoryId` は Prisma のスカラー直接フィルタで *別フィールド* のため、両者が
  // 共存しても上書きは起きず AND 結合される（アーカイブ済分類を除外しつつ特定分類で絞れる）。
  // ※ baseWhere 側を `category: { archivedAt: null, id: N }` のように書き換えると意味が変わるため不可。
  const where: Record<string, unknown> = { ...config.baseWhere };

  if (query.search) {
    where.OR = config.searchFields.map((field) => ({
      [field]: { contains: query.search, mode: 'insensitive' },
    }));
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.categoryId !== undefined) {
    where.categoryId = query.categoryId;
  }

  return where;
}

export function resolveSortField(sort: string | undefined, config: ListConfig): string {
  const defaultSort = config.defaultSort ?? 'createdAt';
  if (!sort) return defaultSort;
  return config.allowedSortFields.includes(sort) ? sort : defaultSort;
}

export async function paginatedList<T>(
  model: PrismaListDelegate<T>,
  query: ListQueryParams,
  config: ListConfig,
): Promise<PaginatedEntities<T>> {
  const { page = 1, limit = 20, order = 'desc' } = query;
  const where = buildListWhere(query, config);
  const sortField = resolveSortField(query.sort, config);

  const findManyArgs: Record<string, unknown> = {
    where,
    skip: (page - 1) * limit,
    take: limit,
    orderBy: { [sortField]: order },
  };
  if (config.paginatedInclude) {
    findManyArgs.include = config.paginatedInclude;
  }

  const [data, total] = await Promise.all([model.findMany(findManyArgs), model.count({ where })]);

  return { data, meta: buildPaginatedMeta(total, page, limit) };
}
