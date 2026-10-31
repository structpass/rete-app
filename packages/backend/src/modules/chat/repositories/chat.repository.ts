import { Injectable } from '@nestjs/common';
import { Prisma, ChatThemeMentionField } from '@prisma/client';
import { DEFAULT_CHANNEL_ID } from '@rete/shared';
import { PrismaService } from '../../../database/prisma.service';
import {
  INTERACTIVE_SAVE_TX_OPTIONS,
  runInSerializableTransaction,
} from '../../../common/database/serializable-tx';
import { CreateChatThemeDto } from '../dto/create-chat-theme.dto';
import { CreateChatMessageDto } from '../dto/create-chat-message.dto';
import { FindChatThemesDto } from '../dto/find-chat-themes.dto';
import { attachmentDisplayInclude } from '../../attachments/repositories/attachments.repository';

// 投稿者は表示名 + id のみ取得（email 等の個人情報をクエリに乗せない）。
const authorSelect = { select: { id: true, name: true } } as const;

// リアクションは集計に使う emoji / authorId のみ取得（mapper.aggregateReactions が消費）。
const reactionSelect = { select: { emoji: true, authorId: true } } as const;

// 添付（FL-3b）は添付モジュールの表示用 include を再利用（include 形状の SSOT は attachments.repository）。
// テーマ詳細を開いた時にスレッド全体の添付を 1 クエリで同梱する（reactions と同方針・N+1 回避）。
// 一括添付で createdAt が同値になる複数行は id 昇順で安定させる（cmn-0236 で attachments.repository
// と整合＝ChatTheme/ChatMessage 添付も UI 上で同列レンダリングされるため同じ安定順を担保）。
// 各要素に `as const` を付けるのは文字列リテラル 'asc' を型推論させるためで、配列自体は mutable
// のままにして Prisma の AttachmentOrderByWithRelationInput[] 互換を保つ（projects.repository.ts
// と同型）。
const attachmentOrderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const attachmentInclude = {
  include: attachmentDisplayInclude,
  orderBy: attachmentOrderBy,
} as const;

// メンション先は account を id+name に絞って同梱（DTO 境界・スレッド詳細／投稿レスポンスで宛先表示）。
const mentionInclude = { include: { account: authorSelect } } as const;

/** updateTheme へ渡すサニタイズ済み更新値（service が sanitize 後に組み立てる）。 */
export interface UpdateThemeData {
  title?: string;
  description?: string;
  // 顛末（スレッドの結論・自由記入ノート / rete-desk-0092）。string=記入 / null=クリア / undefined=据え置き。
  tenmatsu?: string | null;
  // アーカイブ時刻。Date=アーカイブ / null=解除 / undefined=据え置き（Prisma は undefined キーを無視）。
  archivedAt?: Date | null;
  // 説明面（field=DESCRIPTION）の宛先アカウント id 群（rete-desk-0116）。service が description 指定
  // 保存時に組み立てる。undefined=据え置き（顛末面 TENMATSU も含め一切触らない）/ 配列（空含む）=
  // 説明面の宛先を全置換。顛末面は本キーでは触らない＝面別の独立保存。
  descriptionMentionAccountIds?: string[];
  // 顛末面（field=TENMATSU）の宛先アカウント id 群（rete-desk-0116 Phase B）。service が tenmatsu 指定
  // 保存時に組み立てる。undefined=据え置き / 配列（空含む）=顛末面の宛先を全置換。説明面は触らない。
  tenmatsuMentionAccountIds?: string[];
}

/** リアクション作成の入力（messageId / themeId / taskCommentId / taskId のいずれか一つ + author + emoji）。 */
export interface CreateReactionData {
  messageId?: string;
  themeId?: string;
  taskCommentId?: string;
  taskId?: number;
  authorId: string;
  emoji: string;
}

/** リアクション対象の指定（messageId / themeId / taskCommentId / taskId のいずれか一つ・XOR）。 */
type ReactionTarget = {
  messageId?: string;
  themeId?: string;
  taskCommentId?: string;
  taskId?: number;
};

/** スレッド詳細で一度に返すメッセージ上限（最新からこの件数）。超過分は Phase B のカーソルページングで対応。 */
const THREAD_MESSAGES_LIMIT = 200;

@Injectable()
export class ChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * テーマ一覧 + 総件数 + 「自分宛メンションを含むテーマ id 集合」。
   * From/To メンション絞り込み（rete-desk-0049）はサーバー側で判定する。
   * - From 内 OR / To 内 OR / From×To は同一メッセージ（単一 messages.some 内）で AND。
   * - currentUserId 指定時は、取得したページ分のテーマ id 群に対し**単一の集約クエリ**で
   *   「自分宛メンションを含むメッセージを持つテーマ」を引き、Set で返す（mapper が hasMentionToMe
   *   へ畳む）。テーマ毎の take:1 ネストプローブ（N+1）を避けるための分離。
   */
  async findThemesAndCount(
    query: FindChatThemesDto,
    currentUserId?: string,
    // 存在秘匿（rete-hardening）: service が解決した可視 Space id 集合。undefined（匿名/内部経路）は
    // フィルタをスキップ。空配列は「可視 0」＝結果ゼロ件に畳む（越境器の結果を一切返さない）。
    visibleSpaceIds?: string[],
  ) {
    // 昇格済み（タスク化された）スレッドは一覧から外す。スレッドはタスク側へ移った扱いで、
    // 物理削除せずリンク済みタスクの有無から非表示を導出する（専用フラグ列は持たない＝非正規化を避ける）。
    const where: Prisma.ChatThemeWhereInput = { promotedTasks: { none: {} } };
    if (query.status) {
      where.status = query.status;
    }
    // 器（Space）絞り込み（CM-2 スライスB / ADR 0037 §7）＋存在秘匿（rete-hardening）。
    // - visibleSpaceIds 指定時: 常に可視集合へ制約。query.spaceId 指定はその集合との交差に畳む
    //   （可視外の器を直打ちしても可視集合に無ければ `{ in: [] }`＝0 件で越境結果を漏らさない）。
    // - visibleSpaceIds 未指定（匿名/内部経路）: 従来どおり query.spaceId のみで絞る（未指定＝全件）。
    if (visibleSpaceIds !== undefined) {
      if (query.spaceId) {
        where.spaceId = visibleSpaceIds.includes(query.spaceId) ? query.spaceId : { in: [] };
      } else {
        where.spaceId = { in: visibleSpaceIds };
      }
    } else if (query.spaceId) {
      where.spaceId = query.spaceId;
    }
    if (query.search) {
      // 検索対象をタイトルのみ → タイトル / 説明 / スレッド本文（メッセージ body）へ拡張（rete-desk-0048）。
      // プレースホルダ「キーワードで検索」の文言どおり、テーマの題名だけでなくスレッドの中身もヒットさせる。
      // 3 条件の OR。promotedTasks / archivedAt / status / mention 等の他条件とは top-level の AND で併用される
      // （OR と messages はキーが別なので mention 絞り込みの messages.some と衝突しない）。
      const term = query.search;
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { messages: { some: { body: { contains: term, mode: 'insensitive' } } } },
      ];
    }
    // アーカイブ（rete-desk-0061 を server 化）: 既定（archiveOnly 未指定/false）はアーカイブ済を除外し、
    // true でアーカイブ済のみへ反転する（クライアント絞り込みを server へ寄せた / A案）。
    where.archivedAt = query.archiveOnly ? { not: null } : null;
    // 顛末（rete-desk-0050 を server 化）: 記録済（tenmatsu 非 NULL）のみへ絞る。partial index 想定。
    // 未指定時はキーを生やさず記録済/未記録の両方を返す。
    if (query.tenmatsuOnly) {
      where.tenmatsu = { not: null };
    }
    // メンション From/To: 単一の messages.some 条件に両軸を載せ「同一メッセージで AND」を満たす。
    // これは「メンション」フィルタなので From=「その人が（誰かに）メンションした」発信者を意味する。
    // 単なる投稿者一致では一致させない（From で絞ったのにメンションが無いテーマが出る不整合を断つ /
    // rete-desk-0049 差し戻し）。具体的には From 指定時、その発信メッセージが mention を 1 件以上含むことを必須化する:
    //   - From のみ        → authorId∈From かつ mentions.some({})（誰かにメンションした発話）
    //   - To のみ          → mentions.some({ accountId∈To })（To 宛メンションを含む発話）
    //   - From かつ To     → authorId∈From かつ mentions.some({ accountId∈To })（From が To 宛にメンションした発話）
    const hasFrom = (query.mentionFrom?.length ?? 0) > 0;
    const hasTo = (query.mentionTo?.length ?? 0) > 0;
    if (hasFrom || hasTo) {
      const messageWhere: Prisma.ChatMessageWhereInput = {};
      if (hasFrom) messageWhere.authorId = { in: query.mentionFrom };
      if (hasTo) {
        messageWhere.mentions = { some: { accountId: { in: query.mentionTo } } };
      } else if (hasFrom) {
        // From のみ: 宛先は問わないが「メンションを含む発話」であることを要求する。
        messageWhere.mentions = { some: {} };
      }
      // テーマ本文（説明/顛末）メンションでも From/To を判定する（rete-desk-0116）。テーマレベルの
      // From = テーマ起票者（ChatTheme.authorId）。メッセージ側と同じセマンティクスをテーマ自身へ適用:
      //   - From のみ      → authorId∈From かつ mentions.some({})（説明/顛末で誰かにメンション）
      //   - To のみ        → mentions.some({ accountId∈To }）
      //   - From かつ To   → authorId∈From かつ mentions.some({ accountId∈To }）
      const themeMentionWhere: Prisma.ChatThemeWhereInput = {};
      if (hasFrom) themeMentionWhere.authorId = { in: query.mentionFrom };
      if (hasTo) {
        themeMentionWhere.mentions = { some: { accountId: { in: query.mentionTo } } };
      } else if (hasFrom) {
        themeMentionWhere.mentions = { some: {} };
      }
      // メッセージ起因 OR テーマ本文起因のいずれかで一致。search の where.OR（top-level）と衝突させない
      // よう AND の 1 要素として包む（top-level OR と AND は Prisma が AND 結合する）。
      // where.AND は Prisma 上 `T | T[]` の union。既存値を配列へ正規化してから追加する（単一オブジェクト
      // が設定済みでも欠落させない）。現状 AND の先行設定箇所は無いが、将来の where 構築拡張に対する保険。
      const existingAnd = where.AND;
      const andList: Prisma.ChatThemeWhereInput[] = Array.isArray(existingAnd)
        ? existingAnd
        : existingAnd
          ? [existingAnd]
          : [];
      andList.push({ OR: [{ messages: { some: messageWhere } }, themeMentionWhere] });
      where.AND = andList;
    }

    const include: Prisma.ChatThemeInclude = {
      author: authorSelect,
      _count: { select: { messages: true } },
    };

    const [items, total] = await Promise.all([
      this.prisma.chatTheme.findMany({
        where,
        include,
        orderBy: { lastMessageAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.chatTheme.count({ where }),
    ]);

    // hasMentionToMe: 取得済みページのテーマ id 群に対し 1 クエリで「自分宛メンションを含むテーマ」を集約。
    // mention 行 → message → themeId を辿り、該当 themeId を Set 化する（ページ件数に依らず定数クエリ）。
    const mentionedThemeIds = new Set<string>();
    if (currentUserId && items.length > 0) {
      const themeIds = items.map((t) => t.id);
      // メッセージ宛メンション（rete-desk-0049）とテーマ本文宛メンション（説明/顛末 / rete-desk-0116）の
      // 両方から自分宛を集約する。どちらもページ件数に依らず定数クエリ（N+1 なし）。
      const [msgRows, themeRows] = await Promise.all([
        this.prisma.chatMessageMention.findMany({
          where: { accountId: currentUserId, message: { themeId: { in: themeIds } } },
          select: { message: { select: { themeId: true } } },
        }),
        this.prisma.chatThemeMention.findMany({
          where: { accountId: currentUserId, themeId: { in: themeIds } },
          select: { themeId: true },
        }),
      ]);
      for (const r of msgRows) mentionedThemeIds.add(r.message.themeId);
      for (const r of themeRows) mentionedThemeIds.add(r.themeId);
    }

    // hasUnread（未読集約 / rete-desk-0075）: ページ内テーマに対し「自分以外の活動（他者の投稿 or
    // 他者によるテーマ起票）が、自分の最終既読時刻より後に存在するか」を 2 クエリで判定する。
    // - クエリ1: 自分の既読時刻（chat_read_states）。行が無いテーマは epoch 起点（= 全ての他者活動が未読）。
    // - クエリ2: 他者投稿の最新時刻（authorId != self の groupBy _max createdAt）。
    // 自分起票/自分投稿は未読に数えない（authorId != self / theme.authorId != self を課す）。
    // ページ件数に依らず定数クエリ（N+1 なし・hasMentionToMe と同方式）。
    const unreadThemeIds = await this.aggregateUnreadThemeIds(items, currentUserId);

    return { items, total, mentionedThemeIds, unreadThemeIds };
  }

  /**
   * 未読テーマ id 集合を集約する（rete-desk-0075）。currentUserId 無し / items 空なら空集合。
   * items は findThemesAndCount で取得済みのテーマ（authorId / createdAt スカラーを持つ）を再利用し、
   * テーマ起点の「他者起票」判定を追加クエリ無しで行う。
   */
  private async aggregateUnreadThemeIds(
    items: { id: string; authorId: string; createdAt: Date }[],
    currentUserId?: string,
  ): Promise<Set<string>> {
    const unread = new Set<string>();
    if (!currentUserId || items.length === 0) return unread;
    const ids = items.map((t) => t.id);
    const [reads, msgMax] = await Promise.all([
      this.prisma.chatReadState.findMany({
        where: { accountId: currentUserId, themeId: { in: ids } },
        select: { themeId: true, lastReadAt: true },
      }),
      this.prisma.chatMessage.groupBy({
        by: ['themeId'],
        where: { themeId: { in: ids }, authorId: { not: currentUserId } },
        _max: { createdAt: true },
      }),
    ]);
    const lastReadByTheme = new Map(reads.map((r) => [r.themeId, r.lastReadAt]));
    const otherMsgMaxByTheme = new Map(msgMax.map((g) => [g.themeId, g._max.createdAt]));
    const EPOCH = new Date(0);
    for (const t of items) {
      const ref = lastReadByTheme.get(t.id) ?? EPOCH;
      // 他者活動の最新時刻 = max(他者投稿の最新, 他者起票なら theme.createdAt)。
      const otherMsgAt = otherMsgMaxByTheme.get(t.id) ?? EPOCH;
      const themeCreationAt = t.authorId !== currentUserId ? t.createdAt : EPOCH;
      const latestOther = otherMsgAt > themeCreationAt ? otherMsgAt : themeCreationAt;
      if (latestOther > ref) unread.add(t.id);
    }
    return unread;
  }

  /**
   * チャット詳細を開いた時の既読化（rete-desk-0075）。最終既読時刻を現在時刻へ upsert（冪等・リトライ安全）。
   * GET 詳細取得の副作用として呼ぶ（専用 POST は round-trip 増のため不採用 / plan §4 採用方針）。
   */
  async markThemeRead(themeId: string, accountId: string) {
    const now = new Date();
    return this.prisma.chatReadState.upsert({
      where: { accountId_themeId: { accountId, themeId } },
      create: { accountId, themeId, lastReadAt: now },
      update: { lastReadAt: now },
    });
  }

  /** テーマ本体 + スレッドのメッセージ（最新 THREAD_MESSAGES_LIMIT 件）。表示用に時系列昇順へ戻す。 */
  async findThemeDetail(id: string) {
    const theme = await this.prisma.chatTheme.findUnique({
      where: { id },
      include: {
        author: authorSelect,
        // テーマ起点カードのリアクション（単一クエリで同梱・N+1 なし）。
        reactions: reactionSelect,
        // テーマに付いた添付（FL-3b・新規作成コンポーザ／編集モードで付与）。reactions と同方針で同梱。
        attachments: attachmentInclude,
        // 無制限フェッチを防ぐため最新 N 件のみ取得（新しい順）。超過分は Phase B のカーソル送りで対応。
        messages: {
          include: {
            author: authorSelect,
            reactions: reactionSelect,
            attachments: attachmentInclude,
            // 宛先（メンション先）も同梱（スレッドで誰宛てかを可視化 / rete-desk-0049）。
            mentions: mentionInclude,
          },
          orderBy: { createdAt: 'desc' },
          take: THREAD_MESSAGES_LIMIT,
        },
      },
    });
    if (!theme) return null;
    theme.messages.reverse();
    return theme;
  }

  async findById(id: string) {
    return this.prisma.chatTheme.findUnique({ where: { id } });
  }

  /**
   * リアクション対象 / 編集対象メッセージの存在確認。親テーマの spaceId を同梱し、service の存在秘匿
   * ガード（assertVisibleOr404）が越境を 404 へ畳めるようにする（rete-hardening）。message 自身は
   * spaceId 列を持たないため theme 経由で解決する。
   *
   * v2-255: 同梱を Prisma の include で取ると、同梱クエリは親行が在るときだけ走る（不在 1 本 / 実在 2 本）。
   * この 1 本の差が応答時間に現れ、「行が在るか」の oracle になるため、対象の実在に依存せず常に同じ 2 本を
   * 走らせる（Promise.all で必走・不在/非可視の判定は呼び出し側＝service のガードへ遅延）。可視範囲の解決を
   * 先に通す service 側の前処理と合わせ、不在の枝も非可視の枝も同一のクエリ数・同一文言で 404 になる
   * （skill existence-hiding-review の入力依存不変条件＝クエリの回数と形はリクエスト入力だけで決まり、
   * 途中のルックアップ結果で省略・分岐しない）。
   */
  async findMessageById(id: string) {
    const [message, theme] = await Promise.all([
      this.prisma.chatMessage.findUnique({ where: { id } }),
      // 親テーマはメッセージ id の関係フィルタで引く（1 クエリ。対象が不在でも同じ 1 本を必ず走らせる）。
      this.prisma.chatTheme.findFirst({
        where: { messages: { some: { id } } },
        select: { spaceId: true },
      }),
    ]);
    if (!message) return null;
    // 返す形は従来の include と同じ（呼び出し側は message.theme?.spaceId を読む）。
    return { ...message, theme: theme ? { spaceId: theme.spaceId } : null };
  }

  /**
   * テーマの物理削除（rete-desk-0095）。配下の発話・リアクション・既読・宛先・添付行は schema の
   * onDelete: Cascade で同時に消え、昇格済みタスクは Task.sourceTheme の onDelete: SetNull で
   * 切り離される（タスク本体は残る）。
   */
  async deleteTheme(id: string) {
    return this.prisma.chatTheme.delete({ where: { id } });
  }

  /**
   * 発話（返信メッセージ）の物理削除（dsk-0316: 発話「その他」>メッセージの削除）。配下のメンション・
   * リアクション・添付行は schema の onDelete: Cascade で同時に消える（deleteTheme と同方針）。
   * 親テーマの lastMessageAt は据え置き（削除で巻き戻すと直近メッセージ一覧の並びが不整合になるため）。
   */
  async deleteMessage(id: string) {
    return this.prisma.chatMessage.delete({ where: { id } });
  }

  /**
   * テーマ作成 + 説明面のメンション宛先作成を 1 トランザクションで原子的に行う（rete-desk-0116）。
   * メンション存在検証は service（countAccountsByIds）で済ませた前提。0 件なら mention 行は作らない。
   */
  async createTheme(authorId: string, dto: CreateChatThemeDto) {
    const mentionIds = dto.descriptionMentionAccountIds ?? [];
    return this.prisma.$transaction(async (tx) => {
      const theme = await tx.chatTheme.create({
        // 器（Space）未指定時は DEFAULT_CHANNEL_ID を刻印（CM-2 / ADR 0037 §7・孤児化防止）。
        // FK が器の存在を保証するため、存在しない spaceId は DB 層で弾かれる。
        data: {
          title: dto.title,
          description: dto.description,
          authorId,
          spaceId: dto.spaceId ?? DEFAULT_CHANNEL_ID,
        },
        select: { id: true },
      });
      if (mentionIds.length > 0) {
        await tx.chatThemeMention.createMany({
          data: mentionIds.map((accountId) => ({
            themeId: theme.id,
            accountId,
            field: ChatThemeMentionField.DESCRIPTION,
          })),
        });
      }
      return tx.chatTheme.findUniqueOrThrow({
        where: { id: theme.id },
        include: { author: authorSelect, _count: { select: { messages: true } } },
      });
    });
  }

  /**
   * メッセージ作成・メンション行作成・親テーマの lastMessageAt 更新を 1 トランザクションで原子的に行う。
   * メンション存在検証は service（countAccountsByIds）で済ませた前提（ここは永続化に専念）。
   */
  async createMessage(themeId: string, authorId: string, dto: CreateChatMessageDto) {
    const mentionIds = dto.mentionAccountIds ?? [];
    // createdAt は DB の @default(now()) に委ねてアプリ時計依存・同時投稿時の時刻逆転を排除し、
    // テーマの lastMessageAt は作成されたメッセージの createdAt と厳密に一致させる。
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.chatMessage.create({
        data: { themeId, authorId, body: dto.body },
        select: { id: true, createdAt: true },
      });
      if (mentionIds.length > 0) {
        await tx.chatMessageMention.createMany({
          data: mentionIds.map((accountId) => ({ messageId: message.id, accountId })),
        });
      }
      // d623: 同時投稿では古いメッセージの親更新が新しいものより後に完了し得るため、無条件代入だと
      // lastMessageAt が後退して一覧順とページ位置が崩れる（READ COMMITTED では後勝ち）。
      // 非キー更新の行ロックで親更新を直列化し、読み直した現在値より新しい時だけ進める（単調増加）。
      // INSERT の外部キー検査が保持する KEY SHARE と両立させる。FOR UPDATE だと同時投稿同士の
      // KEY SHARE → UPDATE の昇格が互いを待ち、デッドロックで片方の投稿が失われる（d726）。
      // 実テーブル名は Prisma の @@map("chat_themes")。表名を直書きしているため schema.prisma の変更に追従すること。
      await tx.$queryRaw`SELECT id FROM chat_themes WHERE id = ${themeId} FOR NO KEY UPDATE`;
      const parent = await tx.chatTheme.findUniqueOrThrow({
        where: { id: themeId },
        select: { lastMessageAt: true },
      });
      if (message.createdAt > parent.lastMessageAt) {
        await tx.chatTheme.update({
          where: { id: themeId },
          data: { lastMessageAt: message.createdAt },
        });
      }
      // 宛先（mentions）を含めて再取得し、投稿レスポンスに誰宛てかを載せる（mapper が id+name へ畳む）。
      return tx.chatMessage.findUniqueOrThrow({
        where: { id: message.id },
        include: { author: authorSelect, mentions: mentionInclude },
      });
    });
  }

  /**
   * 自分の発話の本文編集（rete-desk-0146）。body 差し替えと宛先（mentions）の全置換を 1 トランザクションで
   * 原子的に行う。mentionAccountIds=undefined は宛先据え置き（mentions を一切触らない）/ 配列（空含む）は
   * delete→createMany で全置換。lastMessageAt は触らない（編集であって新規投稿ではない）。
   * メンション存在検証は service（countAccountsByIds）で済ませた前提。返却は author + mentions 同梱
   *（createMessage と同形・mapper が id+name へ畳む）。
   */
  async updateMessage(messageId: string, data: { body: string; mentionAccountIds?: string[] }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.chatMessage.update({ where: { id: messageId }, data: { body: data.body } });
      if (data.mentionAccountIds !== undefined) {
        await tx.chatMessageMention.deleteMany({ where: { messageId } });
        if (data.mentionAccountIds.length > 0) {
          await tx.chatMessageMention.createMany({
            data: data.mentionAccountIds.map((accountId) => ({ messageId, accountId })),
          });
        }
      }
      return tx.chatMessage.findUniqueOrThrow({
        where: { id: messageId },
        include: { author: authorSelect, mentions: mentionInclude },
      });
    });
  }

  /** 指定 id 群のうち実在するアカウント数（mentionAccountIds の存在検証用 / service が件数照合する）。 */
  async countAccountsByIds(ids: string[]) {
    return this.prisma.account.count({ where: { id: { in: ids } } });
  }

  /**
   * テーマ本文の片面（説明 DESCRIPTION / 顛末 TENMATSU）の宛先を全置換する（rete-desk-0116）。
   * ids=undefined は据え置き（その面を一切触らない）/ 配列（空含む）は当該 field のみ delete→createMany で置換。
   * 説明面・顛末面で逐語重複させないための共通化（architecture-invariants §3）。tx 内から呼ぶ前提。
   */
  private async replaceMentionFace(
    tx: Prisma.TransactionClient,
    themeId: string,
    field: ChatThemeMentionField,
    ids: string[] | undefined,
  ) {
    if (ids === undefined) return;
    await tx.chatThemeMention.deleteMany({ where: { themeId, field } });
    if (ids.length > 0) {
      await tx.chatThemeMention.createMany({
        data: ids.map((accountId) => ({ themeId, accountId, field })),
      });
    }
  }

  /**
   * テーマの title / description / tenmatsu / archivedAt を部分更新（service で sanitize 済みの値を受ける）。
   * description 指定保存時は説明面（DESCRIPTION）/ tenmatsu 指定保存時は顛末面（TENMATSU）の宛先も全置換する
   * （rete-desk-0116）。指定の無い面は触らない＝面別の独立保存。本体更新 + 宛先差し替えを 1 トランザクションで
   * 原子的に行う。summary 形で返す。
   */
  async updateTheme(id: string, data: UpdateThemeData) {
    const { descriptionMentionAccountIds, tenmatsuMentionAccountIds, ...themeData } = data;
    // 宛先は deleteMany→createMany の全置換。同一テーマへの同時保存で
    // 片方の delete がもう片方の createMany を取りこぼす write skew を防ぐため Serializable。
    // 競合頻度は低い（手動の本文保存のみ）が、直列化の所作（timeout / maxWait / 時間予算 /
    // P2034 リトライ / warn）は共通ヘルパへ寄せる＝ここで $transaction を直に呼ぶと、
    // それらが一切効かない経路が復活する（cmn-0251）。上限はヘルパ既定（reorder 500 件向け）
    // ではなく対話保存向けの短い方を使う＝人が待っている保存で 1 接続を長く抱えない。
    return runInSerializableTransaction(
      this.prisma,
      async (tx) => {
        await tx.chatTheme.update({ where: { id }, data: themeData });
        // 各面 undefined（その面を編集しない保存）は宛先を一切触らず据え置く。
        await this.replaceMentionFace(
          tx,
          id,
          ChatThemeMentionField.DESCRIPTION,
          descriptionMentionAccountIds,
        );
        await this.replaceMentionFace(
          tx,
          id,
          ChatThemeMentionField.TENMATSU,
          tenmatsuMentionAccountIds,
        );
        return tx.chatTheme.findUniqueOrThrow({
          where: { id },
          include: { author: authorSelect, _count: { select: { messages: true } } },
        });
      },
      INTERACTIVE_SAVE_TX_OPTIONS,
    );
  }

  /** トグル判定用に既存リアクション（同一 対象 + author + emoji）を引く。target は一方のみ非 NULL。 */
  async findReaction(target: ReactionTarget, authorId: string, emoji: string) {
    return this.prisma.reaction.findFirst({
      where: {
        authorId,
        emoji,
        // 一つのみ指定される前提（XOR）。指定された側で絞る。
        messageId: target.messageId ?? null,
        themeId: target.themeId ?? null,
        taskCommentId: target.taskCommentId ?? null,
        taskId: target.taskId ?? null,
      },
    });
  }

  async createReaction(data: CreateReactionData) {
    return this.prisma.reaction.create({ data });
  }

  /**
   * 対象（target XOR）+ author + emoji が一致するリアクションを削除する。
   * delete（id 指定・対象 0 で P2025）ではなく deleteMany を使い、連打/並列で対象が既に
   * 消えていてもエラー化しない（トグルの冪等化・service の TOCTOU 緩和）。
   */
  async deleteReactions(target: ReactionTarget, authorId: string, emoji: string) {
    return this.prisma.reaction.deleteMany({
      where: {
        authorId,
        emoji,
        messageId: target.messageId ?? null,
        themeId: target.themeId ?? null,
        taskCommentId: target.taskCommentId ?? null,
        taskId: target.taskId ?? null,
      },
    });
  }
}
