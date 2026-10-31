import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TaskStatus, DEFAULT_CHANNEL_ID } from '@rete/shared';
import { ListConfig } from '../../common/services';
import { validateMentionAccountIds, toMentionBadRequest } from '../../common/mentions';
import { ok, okMessage, okPaginated } from '../../common/dto';
import { sanitizeRichText, toExcerpt } from '../../common/rich-text';
import { assertSpaceVisibleOr404, primeVisibleSpaces } from '../../common/visibility';
import { assertOwnerOrAdmin, OwnerCheckUser } from '../auth/helpers/assert-owner.helper';
import { ScopeVisibilityService } from '../memberships/scope-visibility.service';
import {
  TasksRepository,
  SortOrderContext,
  TaskWithSource,
  MAX_TASK_DEPTH,
} from './repositories/tasks.repository';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MoveTaskDto } from './dto/move-task.dto';
import { FindTasksDto, TASK_SORT_FIELDS } from './dto/find-tasks.dto';
import { toTaskResponse, toTaskTreeResponse } from './tasks.mapper';
import { TaskActivitiesService } from '../task-activities/task-activities.service';
import { TaskActivityChange } from '../task-activities/repositories/task-activities.repository';
import { ChatService } from '../chat/chat.service';
import { CreateReactionDto } from '../chat/dto/create-reaction.dto';

/**
 * 監査ログ（dsk-0223）の status 表示ラベル。shared コメント／desk spec の呼称に一致させる。
 * Prisma の status 値（TaskStatus）をキーに人間可読の日本語ラベルへ写す。
 */
const STATUS_LABELS: Record<TaskStatus, string> = {
  [TaskStatus.TODO]: '未着手',
  [TaskStatus.IN_PROGRESS]: '対応中',
  [TaskStatus.IN_REVIEW]: 'レビュー',
  [TaskStatus.DONE]: '完了',
};

// 監査ログの「未設定」系ラベル（null 値の表示。frontend がそのまま出せる確定文字列）。
const UNASSIGNED_LABEL = '未割当';
const UNCATEGORIZED_LABEL = '未分類';
const UNSET_DATE_LABEL = '未設定';
// 親変更監査（dsk-0240）は親「チケットNo（= タスク id）」を from/to に格納し、null 側は「なし」で表示する。
// 文言「親チケットNoを変更（{before}→{after}）」は frontend の formatActivityText が組み立てる。
const PARENT_NONE_LABEL = 'なし';
// Space 移動監査（dsk-0225）で移動元 Space 名が解決できない場合の安全側ラベル（型上の null フォールバック）。
const UNKNOWN_SPACE_LABEL = '不明な器';
// 履歴 outcome 抜粋の最大文字数（dsk-0345）。コメント履歴 dsk-0269 の 140 と同値だが
// cross-module import を避けローカル保持する。
const OUTCOME_ACTIVITY_EXCERPT_MAX_LENGTH = 140;

/**
 * 404 の「対象不在」文言（v2-254）。対象が存在しない時と、存在するが呼び出し元に非可視の時で
 * 同じ文言を返す——という不変条件を 1 箇所で保つため定数にする。非可視側は common/visibility の
 * assertSpaceVisibleOr404 で本定数へ写し替える。片側だけ変えると応答本文が「存在するか」の
 * oracle に戻る（存在秘匿・ADR 0038 / operational-policy §8）。
 */
const TASK_NOT_FOUND_MESSAGE = 'Task not found';
/** 昇格元チャットテーマが引けない時の文言（不在 / 非可視で共通・v2-254）。 */
const TASK_SOURCE_THEME_NOT_FOUND_MESSAGE = 'Chat theme not found';
/** 器（Space）が引けない時の文言（不在 / 非可視で共通・v2-254）。 */
const TASK_SPACE_NOT_FOUND_MESSAGE = 'Target space not found';

/**
 * 監査ログの日付ラベル（YYYY/MM/DD・時刻不要）。null は「未設定」。
 * UTC 日付部で決定的に整形し、startDate/dueDate の差分比較と表示の両方に使う（同一関数で比較=表示を一致させる）。
 */
function formatDateLabel(value: Date | null): string {
  if (!value) return UNSET_DATE_LABEL;
  return value.toISOString().slice(0, 10).replace(/-/g, '/');
}

/**
 * Task リスト取得の設定（SSOT）。spec はこの定数を import して allowedSortFields の
 * ドリフトを防ぐ（値をハードコード複製しない）。allowedSortFields は FindTasksDto.sort の
 * @IsIn と同じ TASK_SORT_FIELDS を参照し、入力検証と sort 解決のソースを一致させる。
 */
export const LIST_CONFIG: ListConfig = {
  searchFields: ['title'],
  allowedSortFields: [...TASK_SORT_FIELDS],
  // アーカイブ済分類のタスクは一覧から非表示（rete-desk-0140。ツリー側 findAllForTree と対）。
  // 未分類（categoryId=null / rete-desk-0158）も一覧に残すため OR で「非アーカイブ分類 OR 未分類」を許す。
  baseWhere: { OR: [{ category: { archivedAt: null } }, { categoryId: null }] },
};

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly repo: TasksRepository,
    private readonly scopeVisibility: ScopeVisibilityService,
    // 属性変更の監査記録（dsk-0223）。記録は副作用なので record 呼び出しは try/catch で隔離する（後述）。
    private readonly taskActivities: TaskActivitiesService,
    // 起点カードへのリアクショントグル本体を再利用するため借用（dsk-0297・§3 コピペ禁止・ChatModule が export 済）。
    private readonly chatService: ChatService,
  ) {}

  /**
   * 監査ログの「旧カテゴリ名」ラベル解決（null=未分類）。fromLabel 専用に findCategoryNameById で id+name のみ引く。
   * 新カテゴリ側は検証（assertCategoryUsable / findCategoryById）で取得済みの name を流用するため、本メソッドは旧側のみで使う。
   */
  private async resolveOldCategoryLabel(categoryId: number | null): Promise<string> {
    if (categoryId == null) return UNCATEGORIZED_LABEL;
    const category = await this.repo.findCategoryNameById(categoryId);
    return category?.name ?? UNCATEGORIZED_LABEL;
  }

  /**
   * 親変更監査の from/to ラベル（dsk-0240）。親「チケットNo（= タスク id）」をそのまま文字列化し、
   * null（トップレベル）側は「なし」へ畳む。No は id 自体なので DB 再取得は不要（title 解決を廃止）。
   */
  private parentNoLabel(parentTaskId: number | null): string {
    return parentTaskId == null ? PARENT_NONE_LABEL : String(parentTaskId);
  }

  /** 新カテゴリ id → ラベル（null=未分類）。検証で取得済みの name を渡して再 SELECT を避ける。 */
  private newCategoryLabel(categoryId: number | null, resolvedName: string | null): string {
    if (categoryId == null) return UNCATEGORIZED_LABEL;
    return resolvedName ?? UNCATEGORIZED_LABEL;
  }

  /**
   * update の差分から監査ログ変更リストを組む（dsk-0223・追跡対象6項目）。
   * 各フィールドは「dto に指定があり、かつ既存値と異なる時のみ」change を積む（無変更は記録しない）。
   * 表示ラベルはスナップショット方針で書込時点の名前を解決して格納する。
   * 新側のラベル（担当名 / カテゴリ名）は呼び出し元の存在検証で取得済みの値を `resolved` 経由で受け取り、
   * 二重 SELECT を避ける（db-reviewer HIGH / code-reviewer MEDIUM）。旧側のみ最小限の再取得を行う。
   * 親は No（id）を直接ラベル化するため title 解決を要さない（dsk-0240）。
   */
  private async buildUpdateChanges(
    // status は Prisma の $Enums.TaskStatus（string union）。shared の TaskStatus enum と構造非互換のため string で受け、ラベル参照時にキャストする。
    // title/description/tenmatsu は dsk-0246（スレッド/顛末の更新記録）の差分判定に使う（生 HTML を保存値と比較）。
    existing: {
      status: string;
      categoryId: number | null;
      assigneeId: string | null;
      parentTaskId: number | null;
      startDate: Date | null;
      dueDate: Date | null;
      assignee: { name: string } | null;
      title: string;
      description: string | null;
      tenmatsu: string | null;
    },
    dto: UpdateTaskDto,
    resolved: { newAssigneeName: string | null; newCategoryName: string | null },
  ): Promise<TaskActivityChange[]> {
    const changes: TaskActivityChange[] = [];

    // 旧ラベルの DB 再取得を要するのは category のみ（親は No を直接ラベル化するため再取得不要・dsk-0240）。
    // push 順序（＝監査ログの表示順 status→category→assignee→start→due→parent）は従来どおり維持（dsk-0224）。
    const categoryChanged = dto.categoryId !== undefined && dto.categoryId !== existing.categoryId;
    const oldCategoryLabel = categoryChanged
      ? await this.resolveOldCategoryLabel(existing.categoryId)
      : null;

    // status: TaskStatus ラベルで from/to。
    if (dto.status !== undefined && dto.status !== existing.status) {
      changes.push({
        field: 'status',
        fromLabel: STATUS_LABELS[existing.status as TaskStatus],
        toLabel: STATUS_LABELS[dto.status as TaskStatus],
      });
    }

    // category: 分類名で from/to（null=未分類）。旧ラベルは上で並列解決済み、新側は検証で取得済みの name を流用。
    // 条件式は categoryChanged と同値だが、ここで再掲して dto.categoryId の undefined narrow を効かせる。
    if (dto.categoryId !== undefined && dto.categoryId !== existing.categoryId) {
      changes.push({
        field: 'category',
        fromLabel: oldCategoryLabel ?? UNCATEGORIZED_LABEL,
        toLabel: this.newCategoryLabel(dto.categoryId, resolved.newCategoryName),
      });
    }

    // assignee: 担当名で from/to（null=未割当）。旧担当は existing.assignee、新担当は検証で取得済みの account.name を流用（無クエリ）。
    if (dto.assigneeId !== undefined && dto.assigneeId !== existing.assigneeId) {
      changes.push({
        field: 'assignee',
        fromLabel: existing.assignee?.name ?? UNASSIGNED_LABEL,
        toLabel:
          dto.assigneeId == null
            ? UNASSIGNED_LABEL
            : (resolved.newAssigneeName ?? UNASSIGNED_LABEL),
      });
    }

    // startDate / dueDate: YYYY/MM/DD（時刻不要・null=未設定）。日付正規化して比較し、表示が変わる時のみ記録。
    if (dto.startDate !== undefined) {
      const fromLabel = formatDateLabel(existing.startDate);
      const toLabel = formatDateLabel(dto.startDate ? new Date(dto.startDate) : null);
      if (fromLabel !== toLabel) changes.push({ field: 'startDate', fromLabel, toLabel });
    }
    if (dto.dueDate !== undefined) {
      const fromLabel = formatDateLabel(existing.dueDate);
      const toLabel = formatDateLabel(dto.dueDate ? new Date(dto.dueDate) : null);
      if (fromLabel !== toLabel) changes.push({ field: 'dueDate', fromLabel, toLabel });
    }

    // parent: 親チケットNo（= id）で from/to（null=なし）。No は id 自体なので DB 再取得不要（dsk-0240）。
    if (dto.parentTaskId !== undefined && dto.parentTaskId !== existing.parentTaskId) {
      changes.push({
        field: 'parent',
        fromLabel: this.parentNoLabel(existing.parentTaskId),
        toLabel: this.parentNoLabel(dto.parentTaskId),
      });
    }

    // thread（dsk-0246）: スレッド = 起点カード（題名 / 説明）の更新。題名 or 説明（sanitize 後）が変われば1件記録。
    // 起点カード編集（frontend handleHeadSave）は {title, description} のみ送るため確実に発火し、属性のみ更新
    // （右ペイン）では title/description が現値と一致するため発火しない（値比較で編集経路を判別）。
    // 顛末/説明は HTML が大きく from/to 表示が不適のため、固定文「スレッドの更新」とし from/to は持たない。
    const titleChanged = dto.title !== undefined && dto.title !== existing.title;
    const descriptionChanged =
      dto.description !== undefined &&
      this.richTextChanged(sanitizeRichText(dto.description), existing.description);
    if (titleChanged || descriptionChanged) {
      changes.push({ field: 'thread', fromLabel: null, toLabel: null });
    }

    // outcome（dsk-0246 / dsk-0345）: 顛末（tenmatsu）の更新。sanitize 後の値が保存値と変われば1件記録。
    // toLabel に本文抜粋（toExcerpt・タグ除去・先頭140字）を載せる。空クリア時は null（frontend が固定文へフォールバック）。
    // thread（起点カード）は複合変更で抜粋対象が一意でないため引き続き from/to=null 固定文。
    if (dto.tenmatsu !== undefined) {
      const sanitizedTenmatsu = sanitizeRichText(dto.tenmatsu);
      if (this.richTextChanged(sanitizedTenmatsu, existing.tenmatsu)) {
        const excerpt =
          sanitizedTenmatsu == null || sanitizedTenmatsu.trim() === ''
            ? null
            : toExcerpt(sanitizedTenmatsu, OUTCOME_ACTIVITY_EXCERPT_MAX_LENGTH);
        // toExcerpt が空文字を返す場合（タグのみ等）も null に畳む（空の「顛末の更新：」を防ぐ）。
        const toLabel = excerpt && excerpt.trim() !== '' ? excerpt : null;
        changes.push({ field: 'outcome', fromLabel: null, toLabel });
      }
    }

    return changes;
  }

  /**
   * リッチテキスト（HTML）/ 顛末の差分判定（dsk-0246）。空文字・空白のみ・null を等価（未設定）に畳んでから比較する。
   * frontend が空入力を null へ正規化して送る（isRichTextEmpty）ため、ここでの空判定は trim 一致で足りる
   * （空 `<p></p>` 等のタグ単独入力は frontend で null 化済み＝backend には到達しない前提）。
   */
  private richTextChanged(next: string | null, prev: string | null): boolean {
    const norm = (v: string | null) => (v == null || v.trim() === '' ? null : v);
    return norm(next) !== norm(prev);
  }

  /**
   * 監査記録を実行する共通ラッパ（dsk-0223）。
   * 記録は監査用の副作用であり、タスク更新本体は既に commit 済み。record の例外で update 全体を 500 にすると
   * 「更新は成功したのに 500」になるため、ここで握って console.error に留め、本処理の戻り値は変えない
   * （監査記録の失敗が業務操作を巻き戻さない）。
   */
  private async recordActivitiesSafely(
    taskId: number,
    actorAccountId: string | null,
    changes: TaskActivityChange[],
  ): Promise<void> {
    try {
      await this.taskActivities.record(taskId, actorAccountId, changes);
    } catch (err) {
      // Prisma 生エラーオブジェクト（接続文字列 / クエリ等を含みうる）はそのまま出さず message のみ記録する。
      this.logger.error(
        `[TaskActivity] failed to record activities for task ${taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 宛先検証・TOCTOU→400 変換は common/mentions の共通ヘルパを使う（dsk-0203・code-review HIGH 是正。
   * chat.service の同名ヘルパを一般化したもの＝逐語重複の3重コピーを排し §3 を守る）。
   */
  private validateMentionAccountIds(ids?: string[]): Promise<string[] | undefined> {
    return validateMentionAccountIds(ids, (unique) => this.repo.countAccountsByIds(unique));
  }

  /**
   * 顛末完了ゲート（DBT-5）。タスクは status=DONE なら顛末（結論・決定事項）が必須。
   * create / update の確定後状態に対し一律に適用し、「完了状態には結論が残る」ことを
   * backend で担保する（チャット顛末は任意＝タスクのみ非対称）。新規 error code は足さず
   * VALIDATION_ERROR 形（BadRequestException）で収める。空白のみは未入力扱い。
   */
  private assertTenmatsuOnDone(
    status: TaskStatus | undefined,
    tenmatsu: string | null | undefined,
  ): void {
    if (status !== TaskStatus.DONE) return;
    if (tenmatsu == null || tenmatsu.trim() === '') {
      throw new BadRequestException('Tenmatsu is required to complete a task');
    }
  }

  async findAll(query: FindTasksDto, accountId?: string) {
    // Repository は Entity + meta を返す。DTO 変換とレスポンス整形（okPaginated）は
    // 他の CRUD（ok() 経由）と責務を揃えて Service 層で行う。
    // 存在秘匿（rete-hardening-0002）: 可視 Space のみ一覧へ含める。enforcement は service 層で
    // visibleIds を解決し、フィルタは LIST_CONFIG.baseWhere（repository where）へ { spaceId: { in } } を重ねる。
    // baseWhere の OR（非アーカイブ分類 OR 未分類）とは別キー（spaceId スカラー）なので AND 結合される。
    // accountId 未指定（内部経路）は絞らない（assertVisibleOr404 の内部スキップと同方針）。
    const visibleSpaceIds =
      accountId != null ? await this.scopeVisibility.resolveVisibleSpaceIds(accountId) : undefined;
    const visibleSpaceIdSet = visibleSpaceIds !== undefined ? new Set(visibleSpaceIds) : undefined;
    const config: ListConfig =
      visibleSpaceIds !== undefined
        ? {
            ...LIST_CONFIG,
            baseWhere: {
              ...LIST_CONFIG.baseWhere,
              spaceId: { in: visibleSpaceIds },
            },
          }
        : LIST_CONFIG;
    // accountId を repository へ配線し「自分宛メンション有無（hasMentionToMe）」を一覧ページ全体で
    // 集約する（dsk-0203・chat.findThemes と同方針・N+1 なし）。
    const { data, meta, mentionedTaskIds } = await this.repo.findManyPaginated(
      query,
      config,
      accountId,
    );
    return okPaginated(
      data.map((task) =>
        toTaskResponse(
          this.hideInvisibleSourceTheme(task, visibleSpaceIdSet),
          mentionedTaskIds.has(task.id),
        ),
      ),
      meta,
    );
  }

  /**
   * カテゴリ別にネストしたタスクツリーを返す（desk タスク明細用）。全件取得 → mapper でツリー化 → ok 包装。
   * spaceId 指定時はその器のタスクのみへ絞る（CM-2 スライスB / ADR 0037 §7・任意＝未指定は全件）。
   */
  async findTree(spaceId?: string, accountId?: string) {
    // 存在秘匿（rete-hardening-0002）。
    //  - spaceId 指定（単一器スコープ）: 非可視なら 404（存在を明かさない）。
    //  - spaceId 未指定（全件ツリー）: 可視 Space のみへ絞る（resolveVisibleSpaceIds フィルタ）。
    // accountId 未指定（内部経路）は絞らない（assertVisibleOr404 の内部スキップと同方針）。
    const visibleIds =
      accountId != null
        ? new Set(await this.scopeVisibility.resolveVisibleSpaceIds(accountId))
        : undefined;
    if (spaceId !== undefined) {
      // 非可視の 404 は器の不在と同じ文言へ揃える（common/visibility の写し替え・v2-254）。
      await assertSpaceVisibleOr404(
        this.scopeVisibility,
        accountId,
        spaceId,
        TASK_SPACE_NOT_FOUND_MESSAGE,
      );
      const tasks = await this.repo.findAllForTree(spaceId);
      return ok(
        toTaskTreeResponse(tasks.map((task) => this.hideInvisibleSourceTheme(task, visibleIds))),
      );
    }
    const tasks = await this.repo.findAllForTree(
      undefined,
      visibleIds !== undefined ? [...visibleIds] : undefined,
    );
    return ok(
      toTaskTreeResponse(tasks.map((task) => this.hideInvisibleSourceTheme(task, visibleIds))),
    );
  }

  async findOne(id: number, accountId?: string) {
    // v2-259: 不在 / 非可視の判定は「同梱なしの軽い取得」で先に行う（応答コストの平準化・v2-255 と同型）。
    // 可視範囲の解決を先に通し、同梱つき詳細（reactions 含む）は可視が確定した後だけ取得する＝不在も非可視も
    // 「可視範囲 1 回 + 軽い取得 1 回」で揃い、同梱クエリ（親行が在るときだけ走る）を不在の枝へ漏らさない。
    await primeVisibleSpaces(this.scopeVisibility, accountId);
    const target = await this.repo.findTaskSpaceId(id);

    if (!target) {
      throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    }

    // 存在秘匿（rete-hardening-0002）: 単体 GET 対象の器が非可視なら「無いことにする」= 404。
    // spaceId は task.spaceId 直接列（既存 null は DEFAULT_CHANNEL_ID へフォールバック・他経路と一貫）。
    await assertSpaceVisibleOr404(
      this.scopeVisibility,
      accountId,
      target.spaceId ?? DEFAULT_CHANNEL_ID,
      TASK_NOT_FOUND_MESSAGE,
    );

    // dsk-0356: reactions include は単体 GET 専用。可視確定後に詳細を取得する（内部バリデーションは findById()）。
    const task = await this.repo.findByIdWithReactions(id);
    if (!task) {
      // 可視判定と詳細取得の間に消えた場合（TOCTOU）も、対象不在と同じ文言へ揃える（存在秘匿）。
      throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    }

    // 単体 GET でも自分宛メンション有無を集約して返す（dsk-0203・一覧と同じ repository 集約を単体へ適用）。
    const mentionedTaskIds = await this.repo.findMentionedTaskIds([id], accountId);
    // 起点カードのリアクション集計は単体 GET のみ実値を渡す（dsk-0297・findAll/create/update/move は未指定→空配列）。
    return ok(
      toTaskResponse(
        await this.hideInvisibleSourceThemeForReader(task, accountId),
        mentionedTaskIds.has(id),
        accountId,
      ),
    );
  }

  /**
   * 起点カード（タスク本体）へのリアクションをトグル（dsk-0297）。所有判定なし＝可視な参加者なら誰でも押せる
   * （taskComment のリアクションと同方針・criteria）。トグル本体は ChatService の共有ロジックをそのまま呼び
   * 複製しない（§3 コピペ禁止）。
   */
  async toggleReaction(taskId: number, authorId: string, dto: CreateReactionDto) {
    // v2-259: 対象取得より先に可視範囲の解決を通す（不在 / 非可視の応答コスト平準化）。
    await primeVisibleSpaces(this.scopeVisibility, authorId);
    const task = await this.repo.findTaskSpaceId(taskId);
    if (!task) {
      throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    }
    // 存在秘匿（rete-hardening-0002）: findOne と同じ境界。非可視 Space の起点カードは「無いことにする」= 404。
    await assertSpaceVisibleOr404(
      this.scopeVisibility,
      authorId,
      task.spaceId ?? DEFAULT_CHANNEL_ID,
      TASK_NOT_FOUND_MESSAGE,
    );
    return this.chatService.toggleReaction({ taskId }, authorId, dto.emoji);
  }

  /**
   * タスク作成（通常作成 + チャット→タスク昇格の共通経路）。
   * 昇格は専用エンドポイントを作らず本メソッドを拡張する（§3 コピペ禁止）。
   * - sourceThemeId 指定時: 昇格元テーマの存在を検証（不在なら NOT_FOUND）し片方向リンクを張る
   * - parentTaskId 指定時（子化）: 親の存在検証 + 4 階層ガード（VALIDATION_ERROR）+ categoryId の親継承
   * - afterTaskId 指定時: 兄弟挿入位置の基準（repository が sortOrder を解決）
   * sortOrder の解決・兄弟シフトは repository.createWithSortOrder の 1 tx に委ねる（§2 ORM 直叩き禁止）。
   */
  async create(dto: CreateTaskDto, creatorId?: string) {
    // v2-259: 昇格元テーマの不在 / 非可視（sourceThemeId 指定時）も同じコストで判定できるよう、対象取得より
    // 先に可視範囲の解決を通す（応答コスト平準化）。
    await primeVisibleSpaces(this.scopeVisibility, creatorId);

    // 顛末完了ゲート: 作成時点で DONE 指定なら顛末必須（status 未指定は DB default=TODO のため対象外）。
    this.assertTenmatsuOnDone(dto.status, dto.tenmatsu);

    // 説明面 / 顛末面の宛先（dsk-0203・dsk-0284で顛末面を作成側にも対称配線）を重複排除 + 存在検証
    // してから repository へ渡す（chat.createTheme と同方針）。
    const descriptionMentionAccountIds = await this.validateMentionAccountIds(
      dto.descriptionMentionAccountIds,
    );
    const tenmatsuMentionAccountIds = await this.validateMentionAccountIds(
      dto.tenmatsuMentionAccountIds,
    );

    // 昇格元テーマの存在検証（指定時のみ）。ChatModule に依存せず repository 経由で確認する。
    if (dto.sourceThemeId !== undefined) {
      const theme = await this.repo.findThemeById(dto.sourceThemeId);
      if (!theme) {
        throw new NotFoundException(TASK_SOURCE_THEME_NOT_FOUND_MESSAGE);
      }
      await assertSpaceVisibleOr404(
        this.scopeVisibility,
        creatorId,
        theme.spaceId ?? DEFAULT_CHANNEL_ID,
        TASK_SOURCE_THEME_NOT_FOUND_MESSAGE,
      );
    }

    // 担当 Account の存在検証（割当指定時のみ）。AccountsModule に依存せず repository 経由で確認する。
    // null / 未指定は未割当なので検証不要（parent / theme と同じ存在検証パターン）。
    if (dto.assigneeId != null) {
      const account = await this.repo.findAccountById(dto.assigneeId);
      if (!account) {
        throw new NotFoundException('Assignee account not found');
      }
    }

    // 子化時: 親の存在 + depth ガード + categoryId 親継承。
    // categoryId は親優先（フロント指定と食い違っても親に揃える）。未分類（null）も許可（rete-desk-0158）。
    let categoryId: number | null = dto.categoryId ?? null;
    // 所属する器（Space / CM-2 ADR 0037 §7）。未指定時は DEFAULT_CHANNEL_ID を刻印（孤児化防止）。
    // 子タスクは親の器を継承する（同一スレッド配下のサブツリーが別チャネルに分裂しないため・親優先）。
    let spaceId = dto.spaceId ?? DEFAULT_CHANNEL_ID;
    if (dto.parentTaskId !== undefined) {
      const parent = await this.repo.findById(dto.parentTaskId);
      if (!parent) {
        throw new NotFoundException('Parent task not found');
      }
      const parentDepth = await this.repo.getDepth(dto.parentTaskId);
      // 子は parentDepth + 1 階層目。これが MAX_TASK_DEPTH を超えるなら拒否。
      if (parentDepth + 1 > MAX_TASK_DEPTH) {
        throw new BadRequestException('Task nesting limit reached');
      }
      categoryId = parent.categoryId;
      spaceId = parent.spaceId ?? DEFAULT_CHANNEL_ID;
    }

    // Space 越境作成の封鎖（rete-hardening-0001）。親継承後の確定 spaceId に対し、リクエストユーザーが
    // 当該 Space を可視（所属）かを検証する。create は owner チェック不能（新規＝所有者がまだ無い）のため
    // 本検証が唯一の防御線。子化時は spaceId が親の器を継承済みなので、これ 1 点で parentTaskId 越境
    // （所属しない親の器に子を作る IDOR）も同時に塞ぐ。検証は分類検証より先に置き、可視性 NG を優先して弾く。
    // 存在秘匿（開発統括合意）に統一: 非可視 Space は 404（ScopeVisibilityService.assertVisibleOr404）。
    // accountId 未指定の内部経路（チャット昇格等）は基盤メソッド側でスキップされる。
    // 非可視の 404 は器の不在と同じ文言（TASK_SPACE_NOT_FOUND_MESSAGE）へ揃える（v2-254）。
    await assertSpaceVisibleOr404(
      this.scopeVisibility,
      creatorId,
      spaceId,
      TASK_SPACE_NOT_FOUND_MESSAGE,
    );

    // 分類の存在 + 非アーカイブ + Space 整合検証（親継承後の確定 categoryId に対して / rete-desk-0140・0158）。
    // null（未分類）は検証スキップ（未分類は常に許可）。
    if (categoryId != null) {
      await this.assertCategoryUsable(categoryId, spaceId);
    }

    // 兄弟挿入（afterTaskId 指定）時: client が渡す drop データを信頼せず基準兄弟を独立検証する。
    // sibling モードで解決される親（トップレベルは null）。dto.parentTaskId 未指定は null とみなす。
    if (dto.afterTaskId !== undefined) {
      await this.assertSiblingInTargetGroup(
        dto.afterTaskId,
        categoryId,
        dto.parentTaskId ?? null,
        spaceId,
      );
    }

    const data: Prisma.TaskCreateInput = {
      title: dto.title,
      // 説明はリッチテキスト（HTML）。保存時に sanitize して XSS を封鎖（ADR 0019・多層防御の保存側）。
      description: sanitizeRichText(dto.description),
      status: dto.status,
      // 顛末もリッチテキスト（HTML）。説明と同じく保存時に sanitize（ADR 0019・XSS 多層防御の保存側）。
      tenmatsu: sanitizeRichText(dto.tenmatsu),
      assigneeName: dto.assigneeName,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      // 分類は任意（rete-desk-0158）。null（未分類）は connect せず未紐づけのまま作成する。
      ...(categoryId != null && { category: { connect: { id: categoryId } } }),
      // 所属する器（Space）を連結（CM-2 / ADR 0037 §7・孤児化防止）。FK が器の存在を保証する。
      space: { connect: { id: spaceId } },
      // 担当 Account 連結（割当指定時のみ。null / 未指定は未割当のまま）。
      ...(dto.assigneeId != null && { assignee: { connect: { id: dto.assigneeId } } }),
      ...(dto.parentTaskId !== undefined && { parentTask: { connect: { id: dto.parentTaskId } } }),
      ...(dto.sourceThemeId !== undefined && {
        sourceTheme: { connect: { id: dto.sourceThemeId } },
      }),
      // 作成者を所有者として登録（H4）。未認証経路（昇格ロジック等）は null 許容。
      ...(creatorId !== undefined && { owner: { connect: { id: creatorId } } }),
    };

    const ctx: SortOrderContext = {
      spaceId,
      categoryId,
      parentTaskId: dto.parentTaskId ?? null,
      ...(dto.afterTaskId !== undefined && { afterTaskId: dto.afterTaskId }),
    };

    try {
      const task = await this.repo.createWithSortOrder(data, ctx, {
        descriptionMentionAccountIds,
        tenmatsuMentionAccountIds,
      });
      return ok(toTaskResponse(await this.hideInvisibleSourceThemeForReader(task, creatorId)));
    } catch (e) {
      // 検証通過後に対象アカウントが消えた TOCTOU（P2003）を 400 へ変換。それ以外は再 throw（§4 filter へ委譲）。
      return toMentionBadRequest(e);
    }
  }

  /**
   * 兄弟挿入の基準兄弟（afterTaskId）を独立検証する（create / move 共通 §3）。
   * client が渡す drop データを信頼せず、基準兄弟が存在し かつ 挿入先の兄弟グループ
   * （categoryId + parentTaskId）に属することを backend で確認する。
   * - 不在: NotFoundException（'Sibling task not found'）
   * - グループ不一致: BadRequestException（'Sibling task does not belong to the target group'）
   */
  private async assertSiblingInTargetGroup(
    afterTaskId: number,
    categoryId: number | null,
    parentTaskId: number | null,
    spaceId: string,
  ): Promise<void> {
    const sibling = await this.repo.findById(afterTaskId);
    if (!sibling || (sibling.spaceId ?? DEFAULT_CHANNEL_ID) !== spaceId) {
      throw new NotFoundException('Sibling task not found');
    }
    if (sibling.categoryId !== categoryId || sibling.parentTaskId !== parentTaskId) {
      throw new BadRequestException('Sibling task does not belong to the target group');
    }
  }

  /**
   * 分類の存在 + 非アーカイブ + Space 整合の検証（create / update / move 共通 §3 / rete-desk-0140・0158）。
   * アーカイブ済分類はツリー・一覧から非表示のため、新規紐づけを許すと「作った瞬間に見えない
   * タスク」が生まれる。存在しない場合は NOT_FOUND、アーカイブ済は VALIDATION_ERROR で拒否する。
   * さらに分類は Space 単位スコープ（rete-desk-0158）のため、category.spaceId が紐づけ先タスクの
   * spaceId と一致しない場合は VALIDATION_ERROR で拒否する（クロス Space の分類付与を防ぐ整合性ルール）。
   */
  // 検証に通った category（name 同梱）を返す。呼び出し側は監査ログ（dsk-0223）の新カテゴリ名に再利用し二重 SELECT を避ける。
  private async assertCategoryUsable(
    categoryId: number,
    spaceId: string,
  ): Promise<{ id: number; name: string }> {
    const category = await this.repo.findCategoryById(categoryId);
    if (!category) {
      throw new NotFoundException('指定された分類が見つかりません。');
    }
    if (category.archivedAt != null) {
      throw new BadRequestException('アーカイブ済みの分類にはタスクを紐づけられません。');
    }
    if (category.spaceId !== spaceId) {
      throw new BadRequestException('分類は同じチャネルのものを指定してください。');
    }
    return { id: category.id, name: category.name };
  }

  /**
   * LOW: user は呼び出し元（controller）が必ず渡す前提。optional のまま残すと
   * 将来の内部呼出し追加時に所有者チェックを silent skip するリスクがある。
   * 内部経路から呼ぶ必要が生じたら undefined を明示渡しすることでスキップ意図を明確化する。
   */
  async update(id: number, dto: UpdateTaskDto, user?: OwnerCheckUser) {
    // v2-259: 不在 / 非可視の判定は「同梱なしの軽い取得」で先に行う（応答コストの平準化・v2-255 と同型）。
    // 可視範囲の解決を先に通し、同梱つき取得（sourceTheme / assignee / owner）は可視確定後にだけ走らせる。
    await primeVisibleSpaces(this.scopeVisibility, user?.id);
    const target = await this.repo.findTaskSpaceId(id);

    if (!target) {
      throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    }

    // 対象タスクの Space 可視性（cmn-0019 存在秘匿）: 非可視 Space のタスクは「無いことにする」=404。
    // 所有者チェック(403)より前に置き、403/404 差での存在推測を防ぐ。user 未指定（内部経路）はスキップ。
    await assertSpaceVisibleOr404(
      this.scopeVisibility,
      user?.id,
      target.spaceId ?? DEFAULT_CHANNEL_ID,
      TASK_NOT_FOUND_MESSAGE,
    );

    const existing = await this.repo.findById(id);
    if (!existing) {
      // 可視判定と取得の間に消えた場合（TOCTOU）も、対象不在と同じ文言へ揃える（存在秘匿）。
      throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    }

    // 所有者チェック（H4）。user が渡された場合のみ適用（未認証/内部経路は無視）。
    if (user !== undefined) {
      assertOwnerOrAdmin(existing.ownerId ?? null, user);
    }

    // 顛末完了ゲート（DBT-5）: 部分更新後の確定状態で判定する。status / tenmatsu とも
    // dto 指定があればそれを、無ければ既存値を採用し、「完了状態かつ顛末空」なら拒否する。
    // TOCTOU: 検証（findById）と適用（repo.update）は別クエリで tx 外。並行 PATCH での
    // 検証-適用間の不整合は単一ユーザー MVP の既知制約（move と同水準・schema は DB 制約を持たない）。
    const finalStatus = (dto.status ?? existing.status) as TaskStatus;
    const finalTenmatsu = dto.tenmatsu !== undefined ? dto.tenmatsu : (existing.tenmatsu ?? null);
    this.assertTenmatsuOnDone(finalStatus, finalTenmatsu);

    // 監査ログ（dsk-0223）の新側ラベルは、以下の存在検証で取得したエンティティを流用する（二重 SELECT 回避）。
    let newAssigneeName: string | null = null;
    let newCategoryName: string | null = null;

    // 担当 Account の存在検証（割当への変更時のみ）。null は割当解除なので検証不要。
    if (dto.assigneeId != null) {
      const account = await this.repo.findAccountById(dto.assigneeId);
      if (!account) {
        throw new NotFoundException('Assignee account not found');
      }
      newAssigneeName = account.name; // 検証で取得した name を新担当ラベルへ流用。
    }

    // 越境 reparent の封鎖（rete-hardening-0001）。parentTaskId 付替え時、新親が既存タスクと別 Space なら
    // 「所属しない器の親へ子を移す IDOR」かつ「親子の器が割れる不整合」になる。update は Space を変えない契約
    // （器移動は move の責務）なので、新親 = 同一 Space を要求する。null（トップレベル化）は対象外。
    // 存在秘匿（開発統括合意）に統一: 別 Space の親は「無いことにする」= 404（403 は使わない）。不在時と同一応答。
    if (dto.parentTaskId !== undefined && dto.parentTaskId !== null) {
      const parent = await this.repo.findById(dto.parentTaskId);
      if (!parent) {
        throw new NotFoundException('Parent task not found');
      }
      if ((parent.spaceId ?? DEFAULT_CHANNEL_ID) !== (existing.spaceId ?? DEFAULT_CHANNEL_ID)) {
        throw new NotFoundException('Parent task not found');
      }
    }

    // 分類変更時: null は未分類化（disconnect）で検証不要、非 null は存在 + 非アーカイブ + Space 整合検証
    // （rete-desk-0140・0158）。整合判定は変更対象タスクの現 spaceId（Space は本 update で変えない）を使う。
    if (dto.categoryId !== undefined && dto.categoryId !== null) {
      const category = await this.assertCategoryUsable(
        dto.categoryId,
        existing.spaceId ?? DEFAULT_CHANNEL_ID,
      );
      newCategoryName = category.name; // 検証で取得した name を新カテゴリラベルへ流用（再 SELECT しない）。
    }

    // 説明面 / 顛末面の宛先（dsk-0203）。undefined=据え置き / 配列（空含む）=当該面を全置換。面別に独立検証し、
    // repository が tx 内で面別全置換する（chat.updateTheme と同方針・面別の独立保存）。
    const validatedDescriptionMentions = await this.validateMentionAccountIds(
      dto.descriptionMentionAccountIds,
    );
    const validatedTenmatsuMentions = await this.validateMentionAccountIds(
      dto.tenmatsuMentionAccountIds,
    );

    const data: Prisma.TaskUpdateInput = {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.description !== undefined && { description: sanitizeRichText(dto.description) }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.tenmatsu !== undefined && { tenmatsu: sanitizeRichText(dto.tenmatsu) }),
      ...(dto.assigneeName !== undefined && { assigneeName: dto.assigneeName }),
      // 担当 Account: id 指定で付替え、null で解除（disconnect）、未指定は変更なし。
      ...(dto.assigneeId !== undefined && {
        assignee:
          dto.assigneeId === null ? { disconnect: true } : { connect: { id: dto.assigneeId } },
      }),
      ...(dto.startDate !== undefined && {
        startDate: dto.startDate ? new Date(dto.startDate) : null,
      }),
      ...(dto.dueDate !== undefined && { dueDate: dto.dueDate ? new Date(dto.dueDate) : null }),
      // 分類変更（rete-desk-0158）: null で未分類化（disconnect）、id で付替え（connect）、未指定は変更なし。
      ...(dto.categoryId !== undefined && {
        category:
          dto.categoryId === null ? { disconnect: true } : { connect: { id: dto.categoryId } },
      }),
      ...(dto.parentTaskId !== undefined && {
        parentTask:
          dto.parentTaskId === null ? { disconnect: true } : { connect: { id: dto.parentTaskId } },
      }),
    };

    let task: TaskWithSource;
    try {
      task = await this.repo.update(id, data, {
        descriptionMentionAccountIds: validatedDescriptionMentions,
        tenmatsuMentionAccountIds: validatedTenmatsuMentions,
      });
    } catch (e) {
      // 検証通過後に対象アカウントが消えた TOCTOU（P2003）を 400 へ変換。それ以外は再 throw（§4 filter へ委譲）。
      return toMentionBadRequest(e);
    }

    // 監査ログ記録（dsk-0223）。更新確定後に差分を解決して記録する。新側ラベルは存在検証で取得済みの値を渡す。記録失敗は本処理を巻き戻さない。
    const changes = await this.buildUpdateChanges(existing, dto, {
      newAssigneeName,
      newCategoryName,
    });
    await this.recordActivitiesSafely(id, user?.id ?? null, changes);

    return ok(toTaskResponse(await this.hideInvisibleSourceThemeForReader(task, user?.id)));
  }

  /**
   * タスク（サブツリーのルート）を別の親 / カテゴリ / 並び順へ移動する（PATCH /tasks/:id/move）。
   * 検証 + オーケストレーションのみを担い、4 操作（穴埋め / 押し出し / 本体 update / 子孫カテゴリ波及）の
   * 原子的実行は repository.moveTask の単一 tx に委ねる（§2 ORM 直叩き禁止）。
   *
   * 検証順序（軽い存在検証 → 構造検証 → 上限検証 → 兄弟検証）:
   *  1. 対象 / 移動先 category / 移動先 parent の存在（NOT_FOUND）
   *  2. 自分自身を親に指定（BAD_REQUEST）
   *  3. 自己子孫への移動 = 循環（新親の祖先チェーンに対象 id が出れば BAD_REQUEST）
   *  4. 4 階層上限超過 = 新親 depth + 移動サブツリー高さ > MAX（BAD_REQUEST）
   *  5. afterTaskId の基準兄弟が移動先グループに属すること（create と同じ独立検証 §3）
   * frontend のガードと二重化した防御的検証。新規 error code は足さず既存例外（NOT_FOUND /
   * VALIDATION_ERROR / BAD_REQUEST）で収める。
   *
   * TOCTOU: 構造検証（findById / getAncestorIds / getSubtreeHeight）は tx 外で走る。並行ドロップでの
   * 検証-適用間の不整合は単一ユーザー MVP の既知制約（createWithSortOrder / moveTask と同水準）。
   * Space と親・兄弟の整合は Repository が保存 tx 内でも再検証する。
   */
  async move(id: number, dto: MoveTaskDto, user?: OwnerCheckUser) {
    // accountId は user.id 由来。内部経路（user 未指定）は基盤メソッド側でスキップ。
    const accountId = user?.id;
    // v2-259: 不在 / 非可視の判定は「同梱なしの軽い取得」で先に行う（応答コストの平準化・v2-255 と同型）。
    await primeVisibleSpaces(this.scopeVisibility, accountId);

    // 1. 対象の存在検証。
    const target = await this.repo.findTaskSpaceId(id);
    if (!target) {
      throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    }

    // 1.5 存在秘匿（rete-hardening-0002）: 移動元 Space が非可視なら 404。owner チェック（403）より先に置く
    // ＝可視範囲外のタスクは「存在を明かさず」404 へ畳む（403 で存在を漏らさない）。
    await assertSpaceVisibleOr404(
      this.scopeVisibility,
      accountId,
      target.spaceId ?? DEFAULT_CHANNEL_ID,
      TASK_NOT_FOUND_MESSAGE,
    );

    // 可視確定後に同梱つきの実体を取得する（可視判定より前の取得は同梱クエリの本数差で存在を漏らす）。
    const task = await this.repo.findById(id);
    if (!task) {
      throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    }

    // 所有者チェック（HIGH-1 IDOR 修正）。user が渡された場合のみ適用（内部経路は無視）。
    // TOCTOU: 所有者検証（findById）と移動適用（repo.moveTask）は tx 外。並行 PATCH での
    // 検証-適用間の不整合は単一ユーザー MVP の既知制約（update/remove と同水準）。将来の
    // マルチユーザー対応では serializable tx 化を検討する（auth-bearing TOCTOU）。
    if (user !== undefined) {
      assertOwnerOrAdmin(task.ownerId ?? null, user);
    }

    // 2.5 器（Space）移動の enforce（CM-2 / ADR 0037 §6）。spaceId 指定かつ現器と異なる時のみ検証する。
    // 「移動先 space.projectId == 現 space.projectId」＝チャネル間移動可・プロジェクト間移動不可。
    // 現器・移動先がともに project 配下（CHANNEL）でなければ projectId が一致せず弾かれる（group/個人へは移せない）。
    // ※ 分類は Space スコープ（rete-desk-0158）のため、検証より先に Space 移動の有無を確定させてから
    //   実効 categoryId を解決する（クロス Space 移動なら分類は移動先に無い → 未分類へリセット）。
    let nextSpaceId: string | undefined;
    // Space 移動の監査ログ（dsk-0225）。器が変わった時のみ field='space' を1行記録する。
    // from/to 表示名は本ブロックの projectId 整合検証で取得済みの Space 名を流用する（二重 SELECT 回避）。
    let spaceChange: TaskActivityChange | null = null;
    if (dto.spaceId !== undefined && dto.spaceId !== task.spaceId) {
      // 存在秘匿（rete-hardening-0002）: 移動先 Space が非可視なら 404（越境移動を「無いことにする」）。
      // project 整合（BadRequest）検証より先に置き、可視性 NG を優先して弾く。
      // 非可視の 404 は移動先の器の不在と同じ文言へ揃える（v2-254）。
      await assertSpaceVisibleOr404(
        this.scopeVisibility,
        accountId,
        dto.spaceId,
        TASK_SPACE_NOT_FOUND_MESSAGE,
      );
      const targetSpace = await this.repo.findSpaceForMove(dto.spaceId);
      if (!targetSpace) {
        throw new NotFoundException(TASK_SPACE_NOT_FOUND_MESSAGE);
      }
      const currentSpace = task.spaceId ? await this.repo.findSpaceForMove(task.spaceId) : null;
      const currentProjectId = currentSpace?.projectId ?? null;
      if (targetSpace.projectId == null || targetSpace.projectId !== currentProjectId) {
        throw new BadRequestException('Cannot move a task across projects');
      }
      nextSpaceId = dto.spaceId;
      // 越境移動はチャネル間（projectId 一致）のみ成立するため currentSpace は実質非 null だが、
      // 型上の null は安全側のラベルへ畳む（他属性の null ラベルと同じく確定文字列を返す）。
      spaceChange = {
        field: 'space',
        fromLabel: currentSpace?.name ?? UNKNOWN_SPACE_LABEL,
        toLabel: targetSpace.name,
      };
    }

    // 2.6 実効カテゴリ（rete-desk-0158 整合性ルール）。クロス Space 移動時は移動先 Space に同分類が
    // 存在しないため categoryId を強制 null（未分類）へリセットする。同 Space 内なら dto.categoryId をそのまま使う。
    const effectiveCategoryId = nextSpaceId !== undefined ? null : dto.categoryId;

    // 2.7 移動先カテゴリの存在 + 非アーカイブ + Space 整合検証（rete-desk-0140・0158）。
    // null（未分類）はスキップ。整合判定の基準 Space は移動先（nextSpaceId）／変えないなら現 spaceId。
    // 監査ログ（dsk-0223）の新カテゴリ名は、この検証で取得した name を流用する（二重 SELECT 回避）。
    let newCategoryName: string | null = null;
    if (effectiveCategoryId != null) {
      const category = await this.assertCategoryUsable(
        effectiveCategoryId,
        nextSpaceId ?? task.spaceId ?? DEFAULT_CHANNEL_ID,
      );
      newCategoryName = category.name;
    }

    // トップレベルへの移動（parentTaskId=null）は親検証・循環検証不要。新親 depth は 0 とみなす。
    let parentDepth = 0;
    if (dto.parentTaskId !== null) {
      // 3. 自分自身を親に指定する循環を拒否（親チェーン走査前の早期拒否）。
      if (dto.parentTaskId === id) {
        throw new BadRequestException('Cannot move a task into itself');
      }

      // 4. 移動先 parent の存在検証。
      const parent = await this.repo.findById(dto.parentTaskId);
      if (
        !parent ||
        (parent.spaceId ?? DEFAULT_CHANNEL_ID) !==
          (nextSpaceId ?? task.spaceId ?? DEFAULT_CHANNEL_ID)
      ) {
        throw new NotFoundException('Parent task not found');
      }

      // 5. 自己子孫への移動を拒否（循環防止）。新親の祖先チェーンに対象 id が出たら、
      // 新親は対象サブツリー内＝親子反転になる。
      // getAncestorIds は対象自身を含む root までの id 列（root=1 / 自身込み）なので、
      // その長さがそのまま新親 depth になる。getDepth の二重走査は呼ばない（指摘[3]）。
      const ancestorIds = await this.repo.getAncestorIds(dto.parentTaskId);
      if (ancestorIds.includes(id)) {
        throw new BadRequestException('Cannot move a task into its own descendant');
      }

      parentDepth = ancestorIds.length;
    }

    // 6. 4 階層上限。新親 depth（トップレベルは 0）+ 移動サブツリー自身の高さが MAX を超えたら拒否。
    // subtreeDepth は frontend 申告を信用せず repository で子孫方向に自前算出する。
    const subtreeHeight = await this.repo.getSubtreeHeight(id);
    if (parentDepth + subtreeHeight > MAX_TASK_DEPTH) {
      throw new BadRequestException('Task nesting limit reached');
    }

    // 7. 兄弟挿入（afterTaskId 指定）時: create と同じく基準兄弟を独立検証する（指摘[1] / §3）。
    // 兄弟グループの判定にも実効カテゴリ（クロス Space 移動でリセット済みなら null）を使う。
    if (dto.afterTaskId !== null) {
      await this.assertSiblingInTargetGroup(
        dto.afterTaskId,
        effectiveCategoryId,
        dto.parentTaskId,
        nextSpaceId ?? task.spaceId ?? DEFAULT_CHANNEL_ID,
      );
    }

    const moved = await this.repo.moveTask(id, {
      expectedSpaceId: target.spaceId ?? DEFAULT_CHANNEL_ID,
      parentTaskId: dto.parentTaskId,
      categoryId: effectiveCategoryId,
      afterTaskId: dto.afterTaskId,
      ...(nextSpaceId !== undefined && { spaceId: nextSpaceId }),
    });

    // 監査ログ記録（dsk-0223）。move では parent（親付替え）と category（実効カテゴリ）の変化を記録する。
    // 親は No（id）を直接ラベル化（null=なし・dsk-0240）、category 新側は検証で取得済みの name を流用し旧側のみ軽量再取得する。
    // 記録失敗は本処理を巻き戻さない。
    const changes: TaskActivityChange[] = [];
    // Space 移動（器変更）を他属性より先に積む（同一 createdAt の表示順を器→親→分類で安定させる）。
    if (spaceChange) {
      changes.push(spaceChange);
    }
    if (dto.parentTaskId !== task.parentTaskId) {
      changes.push({
        field: 'parent',
        fromLabel: this.parentNoLabel(task.parentTaskId),
        toLabel: this.parentNoLabel(dto.parentTaskId),
      });
    }
    if (effectiveCategoryId !== task.categoryId) {
      changes.push({
        field: 'category',
        fromLabel: await this.resolveOldCategoryLabel(task.categoryId),
        toLabel: this.newCategoryLabel(effectiveCategoryId, newCategoryName),
      });
    }
    await this.recordActivitiesSafely(id, user?.id ?? null, changes);

    return ok(toTaskResponse(await this.hideInvisibleSourceThemeForReader(moved, user?.id)));
  }

  /**
   * 元テーマの関連自体は異なるSpaceへの昇格でも保持するが、読者が元テーマを見られない場合は
   * task応答からIDとtitleの両方を除く。作成者だけでなく後続のtask閲覧者にも同じ境界を適用する。
   */
  private hideInvisibleSourceTheme<
    T extends {
      sourceThemeId: string | null;
      sourceTheme?: { spaceId: string | null } | null;
    },
  >(task: T, visibleSpaceIds?: ReadonlySet<string>): T {
    if (!visibleSpaceIds || !task.sourceTheme) return task;
    const sourceSpaceId = task.sourceTheme.spaceId ?? DEFAULT_CHANNEL_ID;
    if (visibleSpaceIds.has(sourceSpaceId)) return task;
    return { ...task, sourceThemeId: null, sourceTheme: null };
  }

  private async hideInvisibleSourceThemeForReader<
    T extends {
      sourceThemeId: string | null;
      sourceTheme?: { spaceId: string | null } | null;
    },
  >(task: T, accountId?: string): Promise<T> {
    if (!accountId || !task.sourceTheme) return task;
    const canView = await this.scopeVisibility.canAccessSpace(
      accountId,
      task.sourceTheme.spaceId ?? DEFAULT_CHANNEL_ID,
    );
    return canView ? task : { ...task, sourceThemeId: null, sourceTheme: null };
  }

  /** LOW: update と同様、user optional 運用の意図を明確化（省略時＝内部経路として所有者チェックをスキップ）。 */
  async remove(id: number, user?: OwnerCheckUser) {
    // v2-259: 不在 / 非可視の判定は「同梱なしの軽い取得」で先に行う（応答コストの平準化・v2-255 と同型）。
    await primeVisibleSpaces(this.scopeVisibility, user?.id);
    const target = await this.repo.findTaskSpaceId(id);

    if (!target) {
      throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    }

    // 対象タスクの Space 可視性（cmn-0019 存在秘匿）: 非可視 Space のタスクは「無いことにする」=404。
    // 所有者チェック(403)より前に置き、403/404 差での存在推測を防ぐ。user 未指定（内部経路）はスキップ。
    await assertSpaceVisibleOr404(
      this.scopeVisibility,
      user?.id,
      target.spaceId ?? DEFAULT_CHANNEL_ID,
      TASK_NOT_FOUND_MESSAGE,
    );

    const existing = await this.repo.findById(id);
    if (!existing) {
      // 可視判定と取得の間に消えた場合（TOCTOU）も、対象不在と同じ文言へ揃える（存在秘匿）。
      throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    }

    // 所有者チェック（H4）。user が渡された場合のみ適用（未認証/内部経路は無視）。
    if (user !== undefined) {
      assertOwnerOrAdmin(existing.ownerId ?? null, user);
    }

    // 親タスク削除時、子タスクの parentTaskId は schema の onDelete: SetNull により null 化され、
    // トップレベルへ昇格する（カスケード削除しない）。category 側は onDelete: Restrict で保護。
    await this.repo.delete(id);

    return okMessage('Task deleted successfully');
  }
}
