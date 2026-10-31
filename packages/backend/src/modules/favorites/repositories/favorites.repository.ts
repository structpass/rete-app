import { Injectable } from '@nestjs/common';
import { Prisma, UserFavorite } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { runInSerializableTransaction } from '../../../common/database/serializable-tx';
import { validateReorderSet } from '../../../common/database/validate-reorder-set';

/** 新規お気に入りの永続化データ（accountId / sortOrder は service が解決して渡す）。 */
export interface CreateFavoriteData {
  accountId: string;
  kind: string;
  targetRef: string;
  label: string;
  sortOrder: number;
}

/**
 * reorder の結果。トランザクション内で「orderedIds == 現存全件」を検証し、
 * 不一致なら set-mismatch（service が 400 に翻訳）。HTTP 例外を data 層に持ち込まないための型。
 */
export type ReorderResult =
  | { ok: true; items: UserFavorite[] }
  | { ok: false; reason: 'set-mismatch' };

/**
 * 横断お気に入り（HM-1）のデータアクセス層（§2 Repository 分離）。Service は本クラス経由でのみ DB に触る。
 * 全メソッドが accountId で行を絞る（個人データの IDOR 防止 = 他人のお気に入りに触れない）。
 */
@Injectable()
export class FavoritesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 指定アカウントのお気に入りを表示順（sortOrder 昇順 / 同順位は作成順）で引く。 */
  findByAccount(accountId: string): Promise<UserFavorite[]> {
    return this.prisma.userFavorite.findMany({
      where: { accountId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** 同一リソース（kind+targetRef）の既存お気に入りを引く（重複登録の事前検査用）。 */
  findByTarget(accountId: string, kind: string, targetRef: string): Promise<UserFavorite | null> {
    return this.prisma.userFavorite.findUnique({
      where: { accountId_kind_targetRef: { accountId, kind, targetRef } },
    });
  }

  /** 末尾追加用の現在最大 sortOrder（お気に入りが無ければ null）。 */
  async maxSortOrder(accountId: string): Promise<number | null> {
    const agg = await this.prisma.userFavorite.aggregate({
      where: { accountId },
      _max: { sortOrder: true },
    });
    return agg._max.sortOrder;
  }

  create(data: CreateFavoriteData): Promise<UserFavorite> {
    return this.prisma.userFavorite.create({ data });
  }

  /**
   * 採番（max+1）と create を同一 Serializable tx で行う（cmn-0151 分割B④・categories の
   * createWithAutoSortOrder〔categories.repository.ts:81-90・cmn-0221 §3〕を移植・parity 対象）。
   * 採番〜作成の隙間に別プロセスが create しても、Serializable の snapshot 上で同じ max が読まれ、
   * 同じ sortOrder が振られない（番号重複の黙示的発生を封じる）。明示指定があれば採番せず
   * その値を使う（呼び出し元の dto.sortOrder を尊重／既存挙動の維持）。
   *
   * 写し元 categories との説明付き差分: categories は 0 件時 1 始まり（max ?? 0 に +1）だが、
   * favorites は現行仕様どおり **0 件時 0 始まり**を維持する（criteria 4・max === null → 0）。
   *
   * data は sortOrder を除く CreateFavoriteData を受け取り、tx 内で確定した sortOrder とマージして
   * create する（sortOrder は tx の snapshot で計算するため外で固定しない）。
   */
  async createWithAutoSortOrder(
    accountId: string,
    data: Omit<CreateFavoriteData, 'sortOrder' | 'accountId'>,
    explicitSortOrder?: number,
  ): Promise<UserFavorite> {
    return runInSerializableTransaction(this.prisma, async (tx) => {
      // 写し元 categories（categories.repository.ts:87）と同じく、明示指定があれば採番（max 読み）を
      // 行わずその値を使う（?? の右側は遅延評価される）。categories は 0 件時 1 始まり（max ?? 0 に +1）
      // だが、favorites は現行仕様どおり **0 件時 0 始まり**を維持する（criteria 4・null → -1 + 1 = 0）。
      const sortOrder =
        explicitSortOrder ?? ((await this.maxSortOrderInTx(tx, accountId)) ?? -1) + 1;
      return tx.userFavorite.create({ data: { ...data, accountId, sortOrder } });
    });
  }

  /** createWithAutoSortOrder が tx 内で max を引くために使う private helper。tx 外からは maxSortOrder を直接使う。 */
  private async maxSortOrderInTx(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<number | null> {
    const agg = await tx.userFavorite.aggregate({
      where: { accountId },
      _max: { sortOrder: true },
    });
    return agg._max.sortOrder;
  }

  /**
   * 自分のお気に入りを 1 件削除する。accountId スコープの deleteMany で、他人の id を指定しても
   * 0 件削除になる（IDOR 防止）。削除件数を返し、0 なら service が NotFound に翻訳する。
   */
  async deleteOwned(accountId: string, id: string): Promise<number> {
    const res = await this.prisma.userFavorite.deleteMany({ where: { id, accountId } });
    return res.count;
  }

  /**
   * 並び替えを 1 つの interactive transaction で永続化し、反映後の一覧を返す。
   * - 現存全件の読み取り・集合検証・更新・再読込をすべて tx 内で行う（並走 add/delete による
   *   TOCTOU を封じる。検証後〜更新前に別操作が割り込んでも同一 snapshot で整合する）。
   * - 一括 UPDATE も accountId スコープに限定する（IDOR 防止）。
   * - Serializable で直列化し、並行 reorder の lost update（順序混在）を防ぐ。競合 abort（P2034）は
   *   Serializable の仕様上正常に起こり得るため、指数を持たせず数回まで自動リトライする。
   * orderedIds == 現存全件 を満たさなければ更新せず set-mismatch を返す（service が 400 に翻訳）。
   */
  async reorder(accountId: string, orderedIds: string[]): Promise<ReorderResult> {
    return runInSerializableTransaction(this.prisma, async (tx) => {
      const current = await tx.userFavorite.findMany({
        where: { accountId },
        select: { id: true },
      });
      // 集合検証は validateReorderSet へ共通化（cmn-0151）。重複 id（例 ['f1','f1','f2']・現存 {f1,f2}）は
      // Set 化で潰れるため size 比較だけでは集合一致と誤判定する（同一行へ 2 度 write し、末尾側の index
      // が勝って sortOrder の 0 始まりが崩れる）。HTTP 経路は dto の @ArrayUnique が塞ぐが、repository
      // 単体の契約としてここでも長さを突き合わせる。
      const sameSet = validateReorderSet(
        current.map((f) => f.id),
        orderedIds,
      );
      if (!sameSet) {
        return { ok: false, reason: 'set-mismatch' as const };
      }

      if (orderedIds.length > 0) {
        // JSON 1 パラメータで全件を渡し、件数に依存する往復とバインド数を避ける。
        // 添字は要求順、ロックは id 昇順（cmn-0050(C4)）。MATERIALIZED CTE でロック済み行を
        // 一括 UPDATE へ渡す。raw SQL は Prisma の @updatedAt を通らないため明示更新する。
        await tx.$executeRaw(Prisma.sql`
          WITH ordered AS MATERIALIZED (
            SELECT favorite.id, (requested.position - 1)::integer AS sort_order
            FROM user_favorites AS favorite
            JOIN jsonb_array_elements_text(${JSON.stringify(orderedIds)}::jsonb)
              WITH ORDINALITY AS requested(id, position) ON requested.id = favorite.id
            WHERE favorite.account_id = ${accountId}
            ORDER BY favorite.id
            FOR UPDATE OF favorite
          )
          UPDATE user_favorites AS favorite
          SET sort_order = ordered.sort_order, updated_at = ${new Date()}
          FROM ordered
          WHERE favorite.id = ordered.id AND favorite.account_id = ${accountId}
        `);
      }

      const items = await tx.userFavorite.findMany({
        where: { accountId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      return { ok: true, items };
    });
  }
}
