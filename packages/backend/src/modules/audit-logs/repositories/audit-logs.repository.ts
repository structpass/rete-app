import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditLog, Prisma } from '@prisma/client';
import { AUDIT_SYSTEM_COMMON } from '@rete/shared';
import { PrismaService } from '../../../database/prisma.service';

/**
 * 操作ログ書き込みの入力型（§1 DTO 境界・Entity 直返し禁止の write 側）。
 * recorder service → repository 境界で使う内部型（HTTP DTO とは別物）。
 */
export interface CreateAuditLogInput {
  actorAccountId?: string | null;
  actorName: string;
  actorEmail: string;
  systemId?: string | null;
  systemName: string;
  actionType: string;
  feature?: string;
  summary?: string;
  /** 構造化詳細（任意）。null / undefined は DB null として省略する。 */
  details?: Prisma.InputJsonValue | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * 操作ログの正規化済みフィルタ（service が DTO を Date 境界へ解決した後の形）。
 * 期間は from=日初 / to=日末（含む）で受け取る（DTO の ISO 日付 → 境界変換は service の責務）。
 */
export interface AuditLogFilter {
  search?: string;
  actionType?: string;
  /** TenantSystem.id / 横断操作は AUDIT_SYSTEM_COMMON（→ systemId IS NULL）。 */
  systemId?: string;
  from?: Date;
  to?: Date;
}

/**
 * フィルタ → Prisma where 句（純関数・§3 共通化 + ユニットテスト可能化）。
 * search はユーザー名 / メールの部分一致（大文字小文字無視）。systemId センチネル AUDIT_SYSTEM_COMMON は
 * systemId IS NULL（横断操作）へ写す。期間は createdAt の gte / lte。
 */
export function buildAuditLogWhere(f: AuditLogFilter): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};

  if (f.search) {
    where.OR = [
      { actorName: { contains: f.search, mode: 'insensitive' } },
      { actorEmail: { contains: f.search, mode: 'insensitive' } },
    ];
  }
  if (f.actionType) {
    where.actionType = f.actionType;
  }
  if (f.systemId) {
    where.systemId = f.systemId === AUDIT_SYSTEM_COMMON ? null : f.systemId;
  }
  if (f.from || f.to) {
    where.createdAt = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lte: f.to } : {}),
    };
  }

  return where;
}

/** Entity の配列・総件数・keyset カーソル（DTO 変換・レスポンス整形前の生結果）。 */
export interface AuditLogPage {
  data: AuditLog[];
  total: number;
  cursors: { next: string | null; prev: string | null };
}

/**
 * keyset カーソル（(createdAt, id) と、その行を含めるかどうか）。
 *
 * d701: 境目を「行そのもの＋外す向き」で持つ。以前は戻り先の id に `\uFFFF` を足して
 * 「その行のすぐ後ろ側」を表していたが、実表の照合順序（locale / collation）は `\uFFFF` を最大と
 * みなさない（実測: en_US.utf8 で `019\uFFFF` が `020` と同じ並びに入る）ため、同じ時刻の行が
 * 頁いっぱいに並ぶと境目が正しく決まらなかった。
 */
interface DecodedCursor {
  createdAt: Date;
  id: string;
  /** true なら境界の行そのものを含める（含めない側は lt / gt で外す）。 */
  include: boolean;
}

/**
 * keyset カーソルの符号化 / 復号（(createdAt, id) を base64 の不透明トークンにする）。
 * OFFSET を使わないため、カーソルは「このページの端の行」を指す座標そのものとして持ち運ぶ。
 * include を省くと false（その行は含めない = 従来の「行より先」を意味する）。
 */
export function encodeCursor(row: Pick<AuditLog, 'createdAt' | 'id'>, include = false): string {
  return Buffer.from(
    JSON.stringify({ c: row.createdAt.toISOString(), id: row.id, x: include ? 1 : 0 }),
    'utf8',
  ).toString('base64url');
}

/**
 * cursor は外部（クライアント）由来の不透明文字列のため、壊れた base64/JSON や不正な日時・空 id を
 * DB クエリへ素通りさせない（Invalid Date は Prisma の比較で静かに空/不定結果を返し得るため 400 で弾く）。
 */
export function decodeCursor(token: string): DecodedCursor {
  let parsed: { c?: unknown; id?: unknown; x?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('cursor の形式が不正です');
  }
  if (typeof parsed.c !== 'string' || typeof parsed.id !== 'string' || parsed.id === '') {
    throw new BadRequestException('cursor の形式が不正です');
  }
  const createdAt = new Date(parsed.c);
  if (Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('cursor の形式が不正です');
  }
  // x は省略可（従来のカーソルは「行を含めない」）。1/0 以外は壊れた入力として弾く。
  if (parsed.x !== undefined && parsed.x !== 0 && parsed.x !== 1) {
    throw new BadRequestException('cursor の形式が不正です');
  }
  return { createdAt, id: parsed.id, include: parsed.x === 1 };
}

/** (createdAt, id) が cursor より「古い」行（= createdAt 降順で cursor より後ろ）を選ぶ複合条件。 */
function beforeCursor(cursor: DecodedCursor): Prisma.AuditLogWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      {
        createdAt: cursor.createdAt,
        id: cursor.include ? { lte: cursor.id } : { lt: cursor.id },
      },
    ],
  };
}

/** (createdAt, id) が cursor より「新しい」行（= createdAt 降順で cursor より前）を選ぶ複合条件。 */
function afterCursor(cursor: DecodedCursor): Prisma.AuditLogWhereInput {
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      {
        createdAt: cursor.createdAt,
        id: cursor.include ? { gte: cursor.id } : { gt: cursor.id },
      },
    ],
  };
}

/**
 * 操作ログのデータアクセス層（§2 Repository 分離）。読み取り（ST-6）と書き込み（H5）を統合。
 * Service / Recorder は本クラス経由でのみ DB に触る。
 */
@Injectable()
export class AuditLogsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 操作ログを 1 件挿入する（H5 記録 infra）。
   * §1 DTO 境界: 戻り値は void（Entity を返さない）。
   * best-effort 例外制御は呼び出し元（AuditRecorderService）の責務（ここは純粋な write のみ担う）。
   */
  async create(input: CreateAuditLogInput): Promise<void> {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      actorAccountId: input.actorAccountId ?? null,
      actorName: input.actorName,
      actorEmail: input.actorEmail,
      systemId: input.systemId ?? null,
      systemName: input.systemName,
      actionType: input.actionType,
      feature: input.feature ?? '',
      summary: input.summary ?? '',
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    };
    // details は省略時は DB null（nullable Json）。null / undefined 以外の値のみ付与する。
    if (input.details != null) {
      data.details = input.details;
    }
    await this.prisma.auditLog.create({ data });
  }

  /**
   * retention 超過（createdAt < cutoff）の操作ログをバッチ分割で物理削除し、総削除件数を返す（H5 purge）。
   *
   * audit_logs は mutating リクエスト毎に 1 行 INSERT されるため他テーブルより桁違いに成長する。
   * 単一 deleteMany で全件削除すると大量 WAL / dead tuple / I/O スパイクが 1 トランザクションに集中するため、
   * id を batchSize 件ずつ拾って分割削除する（並行 INSERT をブロックせず autovacuum 圧力を平準化）。
   */
  async deleteOlderThan(cutoff: Date, batchSize = 1000): Promise<number> {
    let totalDeleted = 0;
    for (;;) {
      const rows = await this.prisma.auditLog.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: batchSize,
      });
      if (rows.length === 0) break;

      const { count } = await this.prisma.auditLog.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      totalDeleted += count;

      // 拾えた行が batchSize 未満なら最終バッチ（次回 findMany は 0 件確定）。
      if (rows.length < batchSize) break;
    }
    return totalDeleted;
  }

  /**
   * フィルタ + keyset カーソルで操作ログを引く（createdAt, id の複合順で OFFSET を使わない）。
   * direction='next'/'prev' は cursor 必須（欠けば first と同義に倒す）。'last' は最終頁の先頭行を
   * 1 行の読み飛ばしで求め、その行から降順で limit 件採る（頁の先頭行から並ぶので反転しない）。
   * 'last' の先頭行は「総件数を limit で割った端数」の位置へ揃え、次で辿った頁と行の境界を一致させる
   * （d653）。total は監査ログ画面の「全 N 件」表示（set-0150 で設定タブの語彙へ統一・意味は絞り込み後の
   * 件数のまま）とページ数計算に使うため、keyset 化後も count クエリは維持する。
   */
  async search(
    filter: AuditLogFilter,
    opts: { limit: number; direction?: 'next' | 'prev' | 'last'; cursor?: string },
  ): Promise<AuditLogPage> {
    const where = buildAuditLogWhere(filter);
    const { limit, direction, cursor } = opts;
    const decoded = cursor ? decodeCursor(cursor) : null;

    let scopedWhere: Prisma.AuditLogWhereInput = where;
    let orderBy: Prisma.AuditLogOrderByWithRelationInput[];
    let reverseResult = false;
    // 実際に採った分岐（direction 指定だが cursor 欠落時は 'first' 相当に倒れる点を cursors 算出にも反映する）。
    let mode: 'first' | 'next' | 'prev' = 'first';

    if (direction === 'next' && decoded) {
      scopedWhere = { AND: [where, beforeCursor(decoded)] };
      orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
      mode = 'next';
    } else if (direction === 'prev' && decoded) {
      scopedWhere = { AND: [where, afterCursor(decoded)] };
      orderBy = [{ createdAt: 'asc' }, { id: 'asc' }];
      reverseResult = true;
      mode = 'prev';
    } else if (direction === 'last') {
      return this.searchLastPage(where, limit);
    } else {
      orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
    }

    // limit+1 件を先読みし、「移動先方向にまだ続きがあるか」を実データで判定する（余分な1件は捨てる）。
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where: scopedWhere, orderBy, take: limit + 1 }),
      this.prisma.auditLog.count({ where }),
    ]);
    // 降順（次へ・先頭頁）は先頭 limit 件、昇順（前へ）も採った向きの先頭 limit 件が頁になる。
    // どちらも「採った向きの先頭から limit 件」で、余りの 1 行は採った向きの末尾（= 遠い側）に
    // 付く（d713: 前へ を古い側の端から落としていたため、前へ で戻った頁が 1 行ずれていた）。
    const trimmed = rows.slice(0, limit);
    const data = reverseResult ? [...trimmed].reverse() : trimmed;
    if (data.length === 0) return { data, total, cursors: { next: null, prev: null } };

    const start = data[0];
    const end = data[data.length - 1];
    // 前の頁があるかは、先頭行より新しい側に 1 行でも残っているかで決める（総件数 25・20 件の
    // 最終頁から前の頁へ戻れるように）。次の頁があるかは、末尾行より古い側に 1 行でも残っているか
    // で決める（どの向きから来た頁でも同じ判定。先読みの余りは採る向きで付く側が変わるため、
    // 続きの判定に使うと 前へ で戻った頁の 次へ がずれた）。
    const hasNext = await this.hasRowBefore(where, end);
    const hasPrev = mode !== 'first' && (await this.hasRowAfter(where, start));

    // 戻り先は、この頁の先頭行そのもの（含めない）。前へは「その行より新しい側」を昇順に採り、
    // 反転するので、戻った頁は手前の頁の末尾までがちょうど limit 件になる。
    // 先頭行を含める形にすると 1 行重なる（d701: 以前は id に接尾辞 `\uFFFF` を足していたが、
    // 実表の照合順序では接尾辞が最大にならず、同じ時刻の行が並ぶと境目が崩れた）。
    // 進み先は「今の頁の末尾行のすぐ古い側」を降順 limit 件なので、境目は末尾行そのもの（d668）。
    // どの向きから来た頁でも 次へ は末尾行そのもの（含めない）で持つ（d713）。前へ で戻った頁だけ
    // 境目を「1 つ先の頁の先頭行を含める」形にすると、総件数が頁件数の倍数でない時（21・25 件）に
    // 最終頁の頭がずれた。末尾行を含めない形なら、次へ は末尾行の次から始まるので、どの経路から
    // 戻ってきても次へ で辿った頁と行の境目が揃う。
    const cursors: { next: string | null; prev: string | null } = {
      next: hasNext ? encodeCursor(end) : null,
      prev: hasPrev ? encodeCursor(start) : null,
    };

    return { data, total, cursors };
  }

  /**
   * 最終頁（'last'）を返す。末尾から固定件数を採ると、総件数が limit の倍数でない時に
   * 「次」で辿った最終頁と行の境界が揃わない（総件数 25・20 件なら last が 6〜25 行目・next 経由が
   * 21〜25 行目）。総ページ数（切り上げ）から求めた最終頁の先頭を読み飛ばしで求め、そこから降順で
   * limit 件採る（頁の先頭行から並ぶので反転しない）。切り捨てで割ると、総件数が頁件数の倍数の時に
   * 1 頁過ぎて空になる（20 件・20 件表示で 0 行）ため切り上げる（d653）。
   */
  private async searchLastPage(
    where: Prisma.AuditLogWhereInput,
    limit: number,
  ): Promise<AuditLogPage> {
    const counted = await this.prisma.auditLog.aggregate({ where, _count: { _all: true } });
    const total = counted._count._all;
    const pages = Math.max(1, Math.ceil(total / limit));
    const offset = (pages - 1) * limit;
    const lastRows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
    });
    // 最終頁は末尾（古い側）が終端なので「次」は常に無い。戻り先は、この頁の先頭行そのもの
    // （含めない）。前へは「その行より新しい側」を昇順に limit+1 件採って古い側の端を落とすので、
    // 先頭行を含める形にすると 1 行重なる（d701）。
    const prev = lastRows.length > 0 && offset > 0 ? encodeCursor(lastRows[0]) : null;
    return { data: lastRows, total, cursors: { next: null, prev } };
  }

  /** line より新しい側（同じ時刻なら id の大きい側）に 1 行でも残っているか。前へ戻れるかの判定に使う。 */
  private async hasRowAfter(
    where: Prisma.AuditLogWhereInput,
    line: Pick<AuditLog, 'createdAt' | 'id'>,
  ): Promise<boolean> {
    const [found] = await this.prisma.auditLog.findMany({
      where: {
        AND: [where, afterCursor({ createdAt: line.createdAt, id: line.id, include: false })],
      },
      select: { id: true },
      take: 1,
    });
    return found !== undefined;
  }

  /** line より古い側（同じ時刻なら id の小さい側）に 1 行でも残っているか。次へ進めるかの判定に使う。 */
  private async hasRowBefore(
    where: Prisma.AuditLogWhereInput,
    line: Pick<AuditLog, 'createdAt' | 'id'>,
  ): Promise<boolean> {
    const [found] = await this.prisma.auditLog.findMany({
      where: {
        AND: [where, beforeCursor({ createdAt: line.createdAt, id: line.id, include: false })],
      },
      select: { id: true },
      take: 1,
    });
    return found !== undefined;
  }

  /**
   * CSV 出力用にフィルタ該当行を取得する（ページングなし・createdAt 降順）。
   * OOM 防止のため cap 行で打ち切る（期間上限 92 日で実質バウンド済 / cap 到達は service が件数で検知）。
   */
  findForExport(filter: AuditLogFilter, cap: number): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: buildAuditLogWhere(filter),
      orderBy: { createdAt: 'desc' },
      take: cap,
    });
  }
}
