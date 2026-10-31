import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DEFAULT_CHANNEL_ID } from '@rete/shared';
import { Task, Prisma, TaskMentionField } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  INTERACTIVE_SAVE_TX_OPTIONS,
  runInSerializableTransaction,
} from '../../../common/database/serializable-tx';
import { paginatedList, ListConfig, PaginatedEntities } from '../../../common/services';
import { FindTasksDto } from '../dto/find-tasks.dto';

/** 昇格元テーマの表示用サマリ select。spaceId は読者の可視範囲で要約を伏せる判定用で、DTOには出さない。 */
const sourceThemeSelect = { select: { id: true, title: true, spaceId: true } } as const;

/** 担当者の表示用サマリ select（id+name のみ。email / role / passwordHash 等の機密列を引かない）。 */
const assigneeSelect = { select: { id: true, name: true } } as const;

/**
 * 作成者（所有者）の表示用サマリ select（id+name のみ・assignee と同じ機密非露出方針）。
 * 履歴の「作成」行 actor を担当者と独立に出すため、全 read 経路で owner relation を載せる（dsk-0235）。
 */
const ownerSelect = { select: { id: true, name: true } } as const;

/**
 * category + sourceTheme(id/title) + assignee(id/name) + owner(id/name) relation を含む Task Entity
 * （ツリー / 詳細の入力型）。include 形状の SSOT は本 repository。tree も詳細も同じ select を載せ DTO shape を一貫させる。
 */
export type TaskWithCategory = Prisma.TaskGetPayload<{
  include: {
    category: true;
    sourceTheme: typeof sourceThemeSelect;
    assignee: typeof assigneeSelect;
    owner: typeof ownerSelect;
  };
}>;

/**
 * sourceTheme + assignee + owner relation を含む単体 Task（findById / moveTask / update の戻り値の共通形）。
 */
export type TaskWithSource = Prisma.TaskGetPayload<{
  include: {
    sourceTheme: typeof sourceThemeSelect;
    assignee: typeof assigneeSelect;
    owner: typeof ownerSelect;
  };
}>;

/** ページ付き一覧で読者別の sourceTheme 可視性を判定するための Entity。 */
type TaskWithPaginatedSourceTheme = Prisma.TaskGetPayload<{
  include: { sourceTheme: typeof sourceThemeSelect };
}>;

/** paginatedList の sourceTheme projection に対応する delegate 形状。 */
type PaginatedTaskDelegate = {
  findMany(args: unknown): Promise<TaskWithPaginatedSourceTheme[]>;
  count(args: unknown): Promise<number>;
};

// リアクションは集計に使う emoji / authorId のみ取得（chat.mapper.aggregateReactions が消費・dsk-0297）。
const reactionSelect = { select: { emoji: true, authorId: true } } as const;

/**
 * TaskWithSource + reactions relation（findByIdWithReactions 専用・dsk-0297 / dsk-0356）。
 * reactions は起点カード表示用。findOne（単体 GET）以外＝内部バリデーション 7 箇所を含む経路には
 * 追加しない（クエリコスト・レスポンス shape・コメントと実装の一致・dsk-0356）。
 */
export type TaskWithSourceAndReactions = TaskWithSource & {
  reactions: Prisma.ReactionGetPayload<typeof reactionSelect>[];
};

/** 親子最大 4 階層の制約値（DB ではなく app 層で担保。閾値判定は Service）。 */
export const MAX_TASK_DEPTH = 4;

/**
 * createWithSortOrder の挿入コンテキスト。兄弟グループ（categoryId + parentTaskId）と
 * 挿入位置（afterTaskId 指定で兄弟挿入、省略で末尾追加）を表す。
 */
export interface SortOrderContext {
  spaceId: string;
  // 兄弟グループのカテゴリ。null = 未分類グループ（rete-desk-0158。Prisma は IS NULL で扱う）。
  categoryId: number | null;
  parentTaskId: number | null;
  afterTaskId?: number;
}

/**
 * moveTask の移動先コンテキスト。move payload（DTO）と同形。
 * - parentTaskId: 移動先の親（トップレベルは null）
 * - categoryId: 移動先カテゴリ（サブツリー全体に波及）
 * - afterTaskId: 差し込み先の直前兄弟（兄弟グループ先頭は null）
 */
export interface MoveContext {
  /** Service が可視性を検証した移動元。保存までに器が変わった場合は適用しない。 */
  expectedSpaceId?: string;
  parentTaskId: number | null;
  // 移動先カテゴリ。null = 未分類（rete-desk-0158）。クロス Space 移動時は Service が null へリセット済み。
  categoryId: number | null;
  afterTaskId: number | null;
  // 移動先の器（Space）ID（CM-2 / ADR 0037 §6）。指定時はサブツリー全体を付け替える。
  spaceId?: string;
}

/**
 * Task のデータアクセス層（§2 Repository 分離）。Service は本クラス経由でのみ DB に触る。
 * 本クラスは Prisma Entity（+ meta）だけを返し、DTO 変換は Service 層に委ねる。
 */
@Injectable()
export class TasksRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * タスク一覧 + 総件数 + 「自分宛メンションを含むタスク id 集合」（dsk-0203・chat.findThemesAndCount の
   * タスク版）。From/To メンション絞り込みはサーバー側で判定する:
   * - コメント起因: From=コメント投稿者（TaskComment.authorId）/ To=コメント宛先（TaskCommentMention）。
   *   両軸は同一コメント（単一 comments.some 内）で AND。
   * - タスク本文起因（説明/顛末）: From=タスク作成者（Task.ownerId）/ To=本文宛先（TaskMention）。
   * currentUserId 指定時は、取得したページ分のタスク id 群に対し定数クエリで「自分宛メンションを含む
   * タスク」を引き、Set で返す（service が hasMentionToMe へ畳む。N+1 なし）。
   */
  async findManyPaginated(
    query: FindTasksDto,
    config: ListConfig,
    currentUserId?: string,
  ): Promise<PaginatedEntities<TaskWithPaginatedSourceTheme> & { mentionedTaskIds: Set<number> }> {
    const mentionWhere = this.buildMentionFilterWhere(query);
    let effectiveConfig = config;
    if (mentionWhere) {
      // search の where.OR（buildListWhere）や baseWhere の OR（非アーカイブ分類 OR 未分類）と衝突させない
      // よう AND の 1 要素として包む（chat.findThemesAndCount と同じ正規化イディオム）。既存 AND は配列へ
      // 正規化してから追加する（単一オブジェクトが設定済みでも欠落させない・将来の where 構築拡張への保険）。
      const existingAnd = config.baseWhere?.AND;
      const andList: unknown[] = Array.isArray(existingAnd)
        ? [...existingAnd]
        : existingAnd
          ? [existingAnd]
          : [];
      andList.push(mentionWhere);
      effectiveConfig = { ...config, baseWhere: { ...config.baseWhere, AND: andList } };
    }
    // 一覧の mapper は sourceThemeId も返すため、読者が元テーマを見られるか判定できるよう
    // ページ取得時にも spaceId を含める（DTO には mapper で出さない）。
    const { data, meta } = await paginatedList<TaskWithPaginatedSourceTheme>(
      this.prisma.task as unknown as PaginatedTaskDelegate,
      query,
      {
        ...effectiveConfig,
        paginatedInclude: {
          ...effectiveConfig.paginatedInclude,
          sourceTheme: sourceThemeSelect,
        },
      },
    );
    const mentionedTaskIds = await this.findMentionedTaskIds(
      data.map((t) => t.id),
      currentUserId,
    );
    return { data, meta, mentionedTaskIds };
  }

  /**
   * メンション From/To 絞り込みの where 断片を組む（dsk-0203・chat 側 findThemesAndCount のセマンティクスを
   * タスクへ写像）。「メンション」フィルタなので From=「その人が（誰かに）メンションした」発信者を意味し、
   * 単なる投稿者/作成者一致では一致させない（From 指定時は mention を 1 件以上含むことを必須化）:
   *   - From のみ      → 発信者∈From かつ mentions.some({})（誰かにメンションした発話/本文）
   *   - To のみ        → mentions.some({ accountId∈To })
   *   - From かつ To   → 発信者∈From かつ mentions.some({ accountId∈To })
   * コメント起因 OR タスク本文起因のいずれかで一致。未指定（両軸空）は null を返しフィルタを掛けない。
   */
  private buildMentionFilterWhere(query: FindTasksDto): Prisma.TaskWhereInput | null {
    const hasFrom = (query.mentionFrom?.length ?? 0) > 0;
    const hasTo = (query.mentionTo?.length ?? 0) > 0;
    if (!hasFrom && !hasTo) return null;
    // コメント起因: From=コメント投稿者 / To=コメント宛先（同一コメントで AND）。
    const commentWhere: Prisma.TaskCommentWhereInput = {};
    if (hasFrom) commentWhere.authorId = { in: query.mentionFrom };
    if (hasTo) {
      commentWhere.mentions = { some: { accountId: { in: query.mentionTo } } };
    } else if (hasFrom) {
      // From のみ: 宛先は問わないが「メンションを含むコメント」であることを要求する。
      commentWhere.mentions = { some: {} };
    }
    // タスク本文（説明/顛末）起因: From=タスク作成者（Task.ownerId）/ To=本文宛先（TaskMention）。
    const taskMentionWhere: Prisma.TaskWhereInput = {};
    if (hasFrom) taskMentionWhere.ownerId = { in: query.mentionFrom };
    if (hasTo) {
      taskMentionWhere.mentions = { some: { accountId: { in: query.mentionTo } } };
    } else if (hasFrom) {
      taskMentionWhere.mentions = { some: {} };
    }
    return { OR: [{ comments: { some: commentWhere } }, taskMentionWhere] };
  }

  /**
   * 指定タスク id 群のうち「自分宛メンション（説明/顛末 または配下コメント）を含むタスク id」の集合を返す
   * （dsk-0203・chat 側 hasMentionToMe 集約のミラー）。タスク本文宛（TaskMention）とコメント宛
   * （TaskCommentMention → comment → taskId）の両方から自分宛を集約する。どちらも対象件数に依らず
   * 定数クエリ（N+1 なし）。currentUserId 無し / 対象空なら空集合。
   */
  async findMentionedTaskIds(taskIds: number[], currentUserId?: string): Promise<Set<number>> {
    const mentioned = new Set<number>();
    if (!currentUserId || taskIds.length === 0) return mentioned;
    const [taskRows, commentRows] = await Promise.all([
      this.prisma.taskMention.findMany({
        where: { accountId: currentUserId, taskId: { in: taskIds } },
        select: { taskId: true },
      }),
      this.prisma.taskCommentMention.findMany({
        where: { accountId: currentUserId, comment: { taskId: { in: taskIds } } },
        select: { comment: { select: { taskId: true } } },
      }),
    ]);
    for (const r of taskRows) mentioned.add(r.taskId);
    for (const r of commentRows) mentioned.add(r.comment.taskId);
    return mentioned;
  }

  /** 指定 id 群のうち実在するアカウント数（mentionAccountIds の存在検証用 / service が件数照合する）。 */
  countAccountsByIds(ids: string[]): Promise<number> {
    return this.prisma.account.count({ where: { id: { in: ids } } });
  }

  /**
   * タスク本文の片面（説明 DESCRIPTION / 顛末 TENMATSU）の宛先を全置換する（dsk-0203・chat 側
   * replaceMentionFace のミラー）。ids=undefined は据え置き（その面を一切触らない）/ 配列（空含む）は
   * 当該 field のみ delete→createMany で置換。説明面・顛末面で逐語重複させないための共通化
   * （architecture-invariants §3）。tx 内から呼ぶ前提。
   */
  private async replaceMentionField(
    tx: Prisma.TransactionClient,
    taskId: number,
    field: TaskMentionField,
    ids: string[] | undefined,
  ) {
    if (ids === undefined) return;
    await tx.taskMention.deleteMany({ where: { taskId, field } });
    if (ids.length > 0) {
      await tx.taskMention.createMany({
        data: ids.map((accountId) => ({ taskId, accountId, field })),
      });
    }
  }

  /**
   * ツリー表示用に全タスクを category + sourceTheme 付きで取得
   * （カテゴリ sortOrder → 兄弟 sortOrder → id 昇順）。
   * ページングしない: 木構造は全件で初めて成立するため。規模拡大時はカーソル等を別途検討。
   * mapper は入力順を保持するため、兄弟順は本クエリの sortOrder 昇順で確定する。
   * アーカイブ済分類のタスクはツリーに出さない（rete-desk-0140。一覧側 LIST_CONFIG.baseWhere と対）。
   */
  findAllForTree(spaceId?: string, visibleSpaceIds?: string[]): Promise<TaskWithCategory[]> {
    // spaceId 指定時はその器のタスクのみ（CM-2 スライスB / ADR 0037 §7）。未指定は生やさず全件（従来どおり）。
    // 未分類（categoryId=null / rete-desk-0158）も一覧に残す: category relation の archivedAt フィルタは
    // null カテゴリのタスクを誤って除外するため、OR で「非アーカイブ分類 OR 未分類」を許す。
    const where: Prisma.TaskWhereInput = {
      OR: [{ category: { archivedAt: null } }, { categoryId: null }],
    };
    if (spaceId) {
      where.spaceId = spaceId;
    } else if (visibleSpaceIds !== undefined) {
      // 存在秘匿（rete-hardening-0002）: spaceId 未指定の全件ツリーは可視 Space のみへ絞る。
      // service が resolveVisibleSpaceIds で解決した集合を渡す（enforcement=service / フィルタ=repository where）。
      where.spaceId = { in: visibleSpaceIds };
    }
    return this.prisma.task.findMany({
      where,
      include: {
        category: true,
        sourceTheme: sourceThemeSelect,
        assignee: assigneeSelect,
        owner: ownerSelect,
      },
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  /** 内部バリデーション・create/update/move/remove 用（reactions 無し・TaskWithSource）。 */
  findById(id: number): Promise<TaskWithSource | null> {
    return this.prisma.task.findUnique({
      where: { id },
      include: {
        sourceTheme: sourceThemeSelect,
        assignee: assigneeSelect,
        owner: ownerSelect,
      },
    });
  }

  /**
   * 単体 GET（findOne）専用。起点カード reactions を include（dsk-0297 / dsk-0356 分離）。
   * 内部バリデーション経路は findById() を使うこと。
   */
  findByIdWithReactions(id: number): Promise<TaskWithSourceAndReactions | null> {
    return this.prisma.task.findUnique({
      where: { id },
      include: {
        sourceTheme: sourceThemeSelect,
        assignee: assigneeSelect,
        owner: ownerSelect,
        reactions: reactionSelect,
      },
    });
  }

  /**
   * 起点カードへのリアクショントグル（dsk-0297）の可視性判定専用の軽量取得。task-comments.repository の
   * findTaskForComment と同型（id+spaceId のみ・findById の include フルセットは不要）。
   */
  findTaskSpaceId(id: number): Promise<{ id: number; spaceId: string | null } | null> {
    return this.prisma.task.findUnique({
      where: { id },
      select: { id: true, spaceId: true },
    });
  }

  /**
   * 担当 Account の存在確認（AccountsModule に依存せず直接 account を引く。存在確認専用なので id のみ select）。
   * isActive: true で絞り、無効化済みアカウントへの新規割当を弾く（accounts 一覧 API も isActive のみ返すため整合）。
   * findUnique は複合条件を取れないため findFirst を使う。
   */
  findAccountById(id: string): Promise<{ id: string; name: string } | null> {
    // name は監査ログ（dsk-0223）の担当者表示ラベル解決に使う。存在チェックの呼び出しは name 追加で壊れない。
    return this.prisma.account.findFirst({
      where: { id, isActive: true },
      select: { id: true, name: true },
    });
  }

  /** 昇格元テーマの存在確認（ChatModule に依存せず直接 chatTheme を引く。存在確認専用なので id のみ select）。 */
  findThemeById(id: string): Promise<{ id: string; spaceId: string | null } | null> {
    return this.prisma.chatTheme.findUnique({ where: { id }, select: { id: true, spaceId: true } });
  }

  /**
   * 器（Space）の所属プロジェクト id + 表示名を引く（CM-2 移動 enforce 用 / ADR 0037 §6）。
   * SpacesModule に依存せず直接 space を引く。存在しなければ null（service が NOT_FOUND を判断）。
   * CHANNEL は projectId 非 null / GROUP・個人は null（＝タスク移動先として projectId 一致しない）。
   * name は監査ログ（dsk-0225）の Space 移動の from/to 表示ラベルに再利用する（projectId 検証と同一クエリで取得し二重 SELECT を防ぐ）。
   */
  findSpaceForMove(id: string): Promise<{ projectId: string | null; name: string } | null> {
    return this.prisma.space.findUnique({ where: { id }, select: { projectId: true, name: true } });
  }

  /** 移動先カテゴリの存在確認（CategoriesModule に依存せず直接 category を引く）。
   *  archivedAt はアーカイブ済分類への新規紐づけ拒否（rete-desk-0140）、spaceId は
   *  「分類は同じ Space のものか」の整合性検証（rete-desk-0158）に使う。
   *  name は監査ログ（dsk-0223）の新カテゴリ表示ラベルに再利用する（検証と同一クエリで取得し二重 SELECT を防ぐ）。 */
  findCategoryById(
    id: number,
  ): Promise<{ id: number; name: string; archivedAt: Date | null; spaceId: string } | null> {
    return this.prisma.category.findUnique({
      where: { id },
      select: { id: true, name: true, archivedAt: true, spaceId: true },
    });
  }

  /**
   * 監査ログ（dsk-0223）用のカテゴリ表示名解決。検証を伴わない「旧カテゴリ名」解決専用に id+name のみ引く。
   * 新カテゴリ側は findCategoryById（検証）で取得済みの name を流用するため、本メソッドは旧側（existing.categoryId）のみで使う。
   */
  findCategoryNameById(id: number): Promise<{ id: number; name: string } | null> {
    return this.prisma.category.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
  }

  /**
   * 対象タスクから root までの祖先 id チェーン（対象自身を含む、root まで昇順）を返す。
   * 自己子孫判定（移動先の親チェーンに移動対象 id が出るか）に使う。getDepth と同じ親方向走査だが、
   * 深さではなく id 列を返す点が異なる。循環ガードは getDepth と同方針（MAX を 1 段超えたら打ち切り）。
   */
  async getAncestorIds(id: number): Promise<number[]> {
    const ids: number[] = [];
    let currentId: number | null = id;
    while (currentId != null && ids.length <= MAX_TASK_DEPTH + 1) {
      const node: { parentTaskId: number | null } | null = await this.prisma.task.findUnique({
        where: { id: currentId },
        select: { parentTaskId: true },
      });
      if (!node) break;
      ids.push(currentId);
      currentId = node.parentTaskId;
    }
    return ids;
  }

  /**
   * 対象を根とするサブツリーの高さ（対象のみ=1、対象+子=2…）を子孫方向 BFS で算出する。
   * frontend が申告する subtreeDepth は信用せず backend で自前算出する（4 階層上限の判定基礎）。
   * 循環ガード: 1 レベルあたりの走査を MAX_TASK_DEPTH+1 で打ち切り、データ不整合でも無限ループしない。
   * 本メソッドは this.prisma（tx 外）を使う。move の検証 read が tx 外で走る点は上記 moveTask の
   * TOCTOU 既知制約の一部（単一ユーザー MVP 前提で受容）。
   */
  async getSubtreeHeight(id: number): Promise<number> {
    let height = 0;
    let level: number[] = [id];
    while (level.length > 0 && height <= MAX_TASK_DEPTH + 1) {
      height += 1;
      const children = await this.prisma.task.findMany({
        where: { parentTaskId: { in: level } },
        select: { id: true },
      });
      level = children.map((c) => c.id);
    }
    return height;
  }

  /**
   * ルートから対象タスクまでの階層数（ルート=1）を親チェーン走査で算出する。
   * 対象が存在しなければ 0（Service が NOT_FOUND を判断）。閾値判定（4 階層）は Service の責務。
   * データ小（兄弟グループ・階層とも浅い前提）のため再帰 CTE ではなく素直な走査で十分。
   */
  async getDepth(id: number): Promise<number> {
    let currentId: number | null = id;
    let depth = 0;
    // 上限ガード: 将来データ不整合で循環参照が生じても無限ループしないよう、
    // 正常な最大深さ（MAX_TASK_DEPTH）を 1 段超えたら打ち切る。正常時の深さ算出には影響しない。
    while (currentId != null && depth <= MAX_TASK_DEPTH + 1) {
      const node: { parentTaskId: number | null } | null = await this.prisma.task.findUnique({
        where: { id: currentId },
        select: { parentTaskId: true },
      });
      if (!node) {
        return depth; // id 自身が無い場合 depth=0、途中で切れた場合はそこまでの深さ
      }
      depth += 1;
      currentId = node.parentTaskId;
    }
    return depth;
  }

  /**
   * sortOrder を解決しつつ Task を作成する（昇格・通常作成の共通経路）。
   * 兄弟グループ（categoryId + parentTaskId）内の整列を 1 トランザクションで原子的に行う:
   *   - afterTaskId 指定（兄弟挿入）: 基準兄弟の sortOrder+1 を挿入位置とし、それ以上の兄弟を +1 シフトしてから create
   *   - afterTaskId 省略（末尾追加 / 子化末尾）: 兄弟グループの max(sortOrder)+1（不在なら 0）で create
   * シフトと create を同一 tx に束ね、並行挿入での順序衝突・部分適用を防ぐ。
   * 説明面 / 顛末面の宛先（mentions.descriptionMentionAccountIds / tenmatsuMentionAccountIds・
   * dsk-0203・dsk-0284で顛末面を対称配線）は create と同一 tx で原子的に作成する
   * （chat.createTheme と同方針）。存在検証は service（countAccountsByIds）で済ませた前提。
   * update と同型の mentions オブジェクト引数（面ごとに undefined=対象外）。新規作成なので
   * update の replaceMentionField（deleteMany→createMany の全置換）は不要＝createMany のみで足りる。
   */
  createWithSortOrder(
    data: Prisma.TaskCreateInput,
    ctx: SortOrderContext,
    mentions?: {
      descriptionMentionAccountIds?: string[];
      tenmatsuMentionAccountIds?: string[];
    },
  ): Promise<Task> {
    const { categoryId, parentTaskId, afterTaskId, spaceId } = ctx;
    const descriptionIds = mentions?.descriptionMentionAccountIds ?? [];
    const tenmatsuIds = mentions?.tenmatsuMentionAccountIds ?? [];
    return runInSerializableTransaction(
      this.prisma,
      async (tx) => {
        await this.assertParentSpaceTx(tx, parentTaskId, spaceId);
        let sortOrder: number;

        if (afterTaskId !== undefined) {
          // 兄弟挿入: 基準兄弟の直後（sortOrder+1）に入れ、それ以上の兄弟を +1 シフト。
          // 基準読み取りも同一 tx（tx.task）で行い、シフト判定の一貫性を保つ。
          const after = await tx.task.findUnique({
            where: { id: afterTaskId },
            select: { sortOrder: true, spaceId: true, categoryId: true, parentTaskId: true },
          });
          this.assertSiblingGroup(after, spaceId, categoryId, parentTaskId);
          const insertAt = after!.sortOrder + 1;
          // 同時挿入による競合は Serializable の共通リトライへ委ねる。
          await tx.task.updateMany({
            where: { spaceId, categoryId, parentTaskId, sortOrder: { gte: insertAt } },
            data: { sortOrder: { increment: 1 } },
          });
          sortOrder = insertAt;
        } else {
          // 末尾追加: 兄弟グループの最大 + 1（兄弟不在なら 0）。
          const agg = await tx.task.aggregate({
            where: { spaceId, categoryId, parentTaskId },
            _max: { sortOrder: true },
          });
          sortOrder = agg._max.sortOrder == null ? 0 : agg._max.sortOrder + 1;
        }

        const task = await tx.task.create({ data: { ...data, sortOrder } });
        if (descriptionIds.length > 0) {
          await tx.taskMention.createMany({
            data: descriptionIds.map((accountId) => ({
              taskId: task.id,
              accountId,
              field: TaskMentionField.DESCRIPTION,
            })),
          });
        }
        if (tenmatsuIds.length > 0) {
          await tx.taskMention.createMany({
            data: tenmatsuIds.map((accountId) => ({
              taskId: task.id,
              accountId,
              field: TaskMentionField.TENMATSU,
            })),
          });
        }
        return task;
      },
      INTERACTIVE_SAVE_TX_OPTIONS,
    );
  }

  /**
   * タスク（サブツリーのルート）を別の親 / カテゴリ / 並び順へ移動する。
   * 以下の操作を単一 $transaction に束ね、部分適用でツリーが壊れないことを保証する:
   *   (a) 移動元の兄弟グループの穴埋め: 旧 sortOrder より後ろを -1 で詰める
   *   (b) 移動先の兄弟グループで挿入位置を確定（afterTaskId 基準。null は先頭=0）
   *   (c) 移動先の兄弟グループの押し出し: 挿入位置以上を +1
   *   (d) 対象自身の parentTaskId / categoryId / sortOrder を update
   *   (e) カテゴリ・Space 変更時は子孫へ一括波及
   * 読み取りも全て tx 経由（tx 外 read 禁止）で一貫性を保つ。
   * 同一グループ内の並べ替えは「(a) 穴埋め → (b) 穴埋め後の afterTask.sortOrder を基準に挿入」の順で
   * 行うため、afterTask の読み取りは穴埋め後に行いインデックスのズレを吸収する。
   * 深さと循環の検証は Service 側で tx 外に走る（既存の並行構造変更の制約）。
   * Space と親・兄弟の整合は Serializable tx 内でも再検証する。
   */
  moveTask(id: number, ctx: MoveContext): Promise<TaskWithSource> {
    const { parentTaskId, categoryId, afterTaskId, spaceId } = ctx;
    return runInSerializableTransaction(
      this.prisma,
      async (tx) => {
        // 対象本体の旧グループ（categoryId / parentTaskId / sortOrder）を tx 内で取得。
        const moving = await tx.task.findUnique({
          where: { id },
          select: { categoryId: true, parentTaskId: true, sortOrder: true, spaceId: true },
        });
        if (!moving) throw new NotFoundException('Task not found');
        if (
          ctx.expectedSpaceId !== undefined &&
          (moving.spaceId ?? DEFAULT_CHANNEL_ID) !== ctx.expectedSpaceId
        ) {
          throw new NotFoundException('Task not found');
        }
        const oldCategoryId = moving.categoryId;
        const oldParentTaskId = moving.parentTaskId;
        const oldSortOrder = moving.sortOrder;
        const targetSpaceId = spaceId ?? moving.spaceId ?? DEFAULT_CHANNEL_ID;
        await this.assertParentSpaceTx(tx, parentTaskId, targetSpaceId);

        // (a) 移動元グループの穴埋め: 旧 sortOrder より後ろの兄弟を -1。
        // 対象自身は今から動かす（後で sortOrder を再設定）ため、gt: oldSortOrder で自身を除外する。
        // 絞りは実列の値で組む（null に DEFAULT_CHANNEL_ID を当てない）。null の行は migration で
        // 既定の器へ backfill 済みで、SQL の `space_id = <既定>` は null 行に当たらないため、
        // まわりの読み取り（targetSpaceId / assertParentSpaceTx / assertSiblingGroup）と同じ null
        // フォールバックを置くと、null 行だけ既定の器の兄弟を巻き込んで採番をずらす（d687）。
        await tx.task.updateMany({
          where: {
            spaceId: moving.spaceId,
            categoryId: oldCategoryId,
            parentTaskId: oldParentTaskId,
            sortOrder: { gt: oldSortOrder },
          },
          data: { sortOrder: { decrement: 1 } },
        });

        // (b) 移動先の挿入位置を確定。afterTaskId 指定時は穴埋め後の afterTask.sortOrder+1、null は先頭=0。
        let insertAt: number;
        if (afterTaskId != null) {
          const after = await tx.task.findUnique({
            where: { id: afterTaskId },
            select: { sortOrder: true, spaceId: true, categoryId: true, parentTaskId: true },
          });
          this.assertSiblingGroup(after, targetSpaceId, categoryId, parentTaskId);
          if (afterTaskId === id)
            throw new BadRequestException('Cannot insert a task after itself');
          insertAt = after!.sortOrder + 1;
        } else {
          insertAt = 0;
        }

        // (c) 移動先グループの押し出し: 挿入位置以上の兄弟を +1。
        await tx.task.updateMany({
          where: { spaceId: targetSpaceId, categoryId, parentTaskId, sortOrder: { gte: insertAt } },
          data: { sortOrder: { increment: 1 } },
        });

        // (e) Space だけが変わる未分類タスクでも子孫を同時に移す。
        if (
          categoryId !== oldCategoryId ||
          targetSpaceId !== (moving.spaceId ?? DEFAULT_CHANNEL_ID)
        ) {
          await this.cascadeMoveTx(
            tx,
            id,
            moving.spaceId ?? DEFAULT_CHANNEL_ID,
            categoryId,
            spaceId,
          );
        }

        // (d) 対象自身を移動先へ。sourceTheme を include して更新後も元チャットリンクを保つ。
        // spaceId 指定時のみ器を付け替える（CM-2 / ADR 0037 §6・service が同一 project を検証済み）。
        return tx.task.update({
          where: { id },
          data: {
            parentTaskId,
            categoryId,
            sortOrder: insertAt,
            ...(spaceId !== undefined && { spaceId }),
          },
          include: { sourceTheme: sourceThemeSelect, assignee: assigneeSelect, owner: ownerSelect },
        });
      },
      INTERACTIVE_SAVE_TX_OPTIONS,
    );
  }

  private async cascadeMoveTx(
    tx: Prisma.TransactionClient,
    id: number,
    sourceSpaceId: string,
    categoryId: number | null,
    spaceId?: string,
  ): Promise<void> {
    const descendantIds = await this.collectDescendantIdsTx(tx, id, sourceSpaceId);
    if (descendantIds.length === 0) return;
    await tx.task.updateMany({
      where: { id: { in: descendantIds } },
      data: { categoryId, ...(spaceId !== undefined && { spaceId }) },
    });
  }

  private async assertParentSpaceTx(
    tx: Prisma.TransactionClient,
    parentTaskId: number | null,
    spaceId: string,
  ): Promise<void> {
    if (parentTaskId === null) return;
    const parent = await tx.task.findUnique({
      where: { id: parentTaskId },
      select: { spaceId: true },
    });
    if (!parent || (parent.spaceId ?? DEFAULT_CHANNEL_ID) !== spaceId) {
      throw new NotFoundException('Parent task not found');
    }
  }

  private assertSiblingGroup(
    sibling: {
      spaceId: string | null;
      categoryId: number | null;
      parentTaskId: number | null;
    } | null,
    spaceId: string,
    categoryId: number | null,
    parentTaskId: number | null,
  ): void {
    if (!sibling || (sibling.spaceId ?? DEFAULT_CHANNEL_ID) !== spaceId) {
      throw new NotFoundException('Sibling task not found');
    }
    if (sibling.categoryId !== categoryId || sibling.parentTaskId !== parentTaskId) {
      throw new BadRequestException('Sibling task does not belong to the target group');
    }
  }

  /**
   * moveTask の tx 内で使う子孫 id 収集（collectDescendantIds の tx 版。tx 外 read を避ける）。
   * 循環ガード（guard <= MAX_TASK_DEPTH + 1）に到達してもまだ子が残っている場合、それ以深の
   * 子孫が categoryId 波及から漏れる。サイレントな部分波及（データ不整合）を黙って残さないため、
   * 打ち切り時は tx を throw して移動全体をロールバックする（指摘[4]）。
   */
  private async collectDescendantIdsTx(
    tx: Prisma.TransactionClient,
    id: number,
    spaceId: string,
  ): Promise<number[]> {
    const result: number[] = [];
    let level: number[] = [id];
    let guard = 0;
    while (level.length > 0) {
      if (guard > MAX_TASK_DEPTH + 1) {
        // 正常な最大深さを超えてなお子孫が続く＝循環相当。波及漏れを残さず tx ごと中断する。
        throw new Error(
          'Descendant traversal exceeded depth guard; aborting move to avoid partial category cascade',
        );
      }
      guard += 1;
      const children = await tx.task.findMany({
        where: { parentTaskId: { in: level } },
        select: { id: true, spaceId: true },
      });
      if (children.some((child) => (child.spaceId ?? DEFAULT_CHANNEL_ID) !== spaceId)) {
        throw new NotFoundException('Task not found');
      }
      level = children.map((c) => c.id);
      result.push(...level);
    }
    return result;
  }

  /**
   * Task を更新する。レスポンスで「元チャット」リンクを保つため、findById と同じ sourceTheme(id/title)
   * を include する（include 無しだと更新後レスポンスの sourceTheme が常に null になる）。
   *
   * 宛先（mentions / dsk-0203）: description 指定保存時は説明面（DESCRIPTION）/ tenmatsu 指定保存時は
   * 顛末面（TENMATSU）の宛先も全置換する。指定の無い面は触らない＝面別の独立保存。宛先を伴う時のみ
   * 本体更新 + 宛先差し替えを 1 トランザクションで原子的に行い、宛先を触らない更新（status 変更等の
   * 高頻度経路）は従来どおり単発 update に留める。
   */
  update(
    id: number,
    data: Prisma.TaskUpdateInput,
    mentions?: {
      descriptionMentionAccountIds?: string[];
      tenmatsuMentionAccountIds?: string[];
    },
  ): Promise<TaskWithSource> {
    const include = {
      sourceTheme: sourceThemeSelect,
      assignee: assigneeSelect,
      owner: ownerSelect,
    };
    const descriptionIds = mentions?.descriptionMentionAccountIds;
    const tenmatsuIds = mentions?.tenmatsuMentionAccountIds;
    if (descriptionIds === undefined && tenmatsuIds === undefined) {
      return this.prisma.task.update({ where: { id }, data, include });
    }
    // 宛先は deleteMany→createMany の全置換。同一タスクへの同時保存で片方の delete がもう片方の
    // createMany を取りこぼす write skew を防ぐため Serializable（chat.updateTheme と同方針）。
    // 直列化の所作（timeout / maxWait / 時間予算 / P2034 リトライ / warn）は共通ヘルパへ寄せる
    // ＝ここで $transaction を直に呼ぶと、それらが一切効かない経路が復活する（cmn-0251）。
    // 上限はヘルパ既定（reorder 500 件向けの 15s×3）ではなく対話保存向けの短い方を使う
    // ＝人が待っている保存で 1 接続を長く抱えるとプール枯渇を押す側に回る。
    return runInSerializableTransaction(
      this.prisma,
      async (tx) => {
        const updated = await tx.task.update({ where: { id }, data, include });
        // 各面 undefined（その面を編集しない保存）は宛先を一切触らず据え置く。
        await this.replaceMentionField(tx, id, TaskMentionField.DESCRIPTION, descriptionIds);
        await this.replaceMentionField(tx, id, TaskMentionField.TENMATSU, tenmatsuIds);
        return updated;
      },
      INTERACTIVE_SAVE_TX_OPTIONS,
    );
  }

  delete(id: number): Promise<Task> {
    return this.prisma.task.delete({ where: { id } });
  }
}
