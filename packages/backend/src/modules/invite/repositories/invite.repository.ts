import { BadRequestException, Injectable } from '@nestjs/common';
import { InviteStatus, MembershipScopeType, SpaceKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import type { PasswordPolicyShape } from '../../../common/security/password-policy';
import { splitDisplayName } from '../../../common/display-name';

/**
 * 招待（ST-5）のデータアクセス層（§2 Repository 分離）。
 * Service は本クラス経由でのみ DB に触る。
 *
 * セキュリティ: tokenHash は select で取得するが mapper の段階で DTO に含めない。
 * repository の select は service / mapper が必要とする全フィールドを返す。
 * Account 作成 + Invite 更新の原子性は acceptInTransaction で保証。
 */

/**
 * tokenHash を含まない公開 select（findAll / findById / create で使用）。
 * 多層防御: DTO には元々出ないが、将来のログ混入を防ぐため repository 層で取得しない。
 */
const inviteSelectPublic = {
  id: true,
  email: true,
  status: true,
  expiresAt: true,
  invitedById: true,
  acceptedAt: true,
  createdAt: true,
  updatedAt: true,
  spaceId: true,
  invitedBy: { select: { name: true } },
} as const;

/** tokenHash を含む完全 select（findByTokenHash / update のみ使用）。 */
const inviteSelect = {
  ...inviteSelectPublic,
  tokenHash: true,
} as const;

/** tokenHash なし select 済み Invite（invite.mapper の入力型）。 */
export type InviteWithRelationsPublic = Prisma.InviteGetPayload<{
  select: typeof inviteSelectPublic;
}>;

/** tokenHash 付き完全 select 済み Invite（findByTokenHash / update の戻り値）。 */
export type InviteWithRelations = Prisma.InviteGetPayload<{
  select: typeof inviteSelect;
}>;

/** invite.repository.create に渡すデータ。 */
export interface CreateInviteData {
  email: string;
  tokenHash: string;
  expiresAt: Date;
  invitedById: string;
  /** 受諾時に追加する GROUP Space ID（論点1）。 */
  spaceId?: string | null;
}

/** invite.repository.update に渡すデータ（再送・再生成用）。 */
export interface UpdateInviteData {
  tokenHash: string;
  expiresAt: Date;
  status: InviteStatus;
}

/**
 * invite.repository.renewPendingByTokenHash の結果。
 * renewed = 書き換えた／accepted = 受諾済みのまま（巻き戻さない）／pending_mismatch = 読んだ時の token か
 * PENDING が既に変わっていた（同時再送など）。
 */
export type RenewPendingOutcome = 'renewed' | 'accepted' | 'pending_mismatch';

/**
 * acceptInTransaction に渡すデータ。
 * TX 内で tokenHash により invite を再取得し email/id を確定するため、呼び出し側からは渡さない。
 */
export interface AcceptInviteData {
  tokenHash: string;
  name: string;
  passwordHash: string;
}

@Injectable()
export class InviteRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 全招待を作成日時降順で返す（一覧）。tokenHash は含まない（inviteSelectPublic）。 */
  findAll(): Promise<InviteWithRelationsPublic[]> {
    return this.prisma.invite.findMany({
      select: inviteSelectPublic,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** id で 1 件取得（再送・削除の対象確認用）。tokenHash は含まない（inviteSelectPublic）。 */
  findById(id: string): Promise<InviteWithRelationsPublic | null> {
    return this.prisma.invite.findUnique({
      where: { id },
      select: inviteSelectPublic,
    });
  }

  /** tokenHash で 1 件取得（受諾検証用）。 */
  findByTokenHash(tokenHash: string): Promise<InviteWithRelations | null> {
    return this.prisma.invite.findUnique({
      where: { tokenHash },
      select: inviteSelect,
    });
  }

  /**
   * id で 1 件取得し tokenHash も返す（再送の条件付き書き換え用）。
   * 再送は「読んだ時の tokenHash のまま」を条件に書き換えるため、公開 select では足りない（d622）。
   */
  findByTokenHashOfId(id: string): Promise<InviteWithRelations | null> {
    return this.prisma.invite.findUnique({
      where: { id },
      select: inviteSelect,
    });
  }

  /**
   * 同 email の有効な PENDING 招待（expiresAt が未来）を 1 件返す。
   * 発行の重複チェック用（期限切れ PENDING は重複とみなさない）。
   */
  findPendingByEmail(email: string): Promise<InviteWithRelations | null> {
    return this.prisma.invite.findFirst({
      where: {
        email,
        status: InviteStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      select: inviteSelect,
    });
  }

  /**
   * 指定 email の Account を 1 件返す（受諾時・発行時の email 重複確認用）。
   * password_hash などの機密列は取得しない（id のみ）。
   */
  findAccountByEmail(email: string): Promise<{ id: string } | null> {
    return this.prisma.account.findUnique({
      where: { email },
      select: { id: true },
    });
  }

  /**
   * 指定 email 群のうち有効な PENDING 招待が存在する email 集合を 1 クエリで返す（CSV 一括 import の
   * 重複判定プリフェッチ用 / rete-settings-0010）。行ごとの findFirst（N 往復）を IN 一括引きへ畳む。
   */
  async findPendingEmails(emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    const rows = await this.prisma.invite.findMany({
      where: {
        email: { in: [...new Set(emails)] },
        status: InviteStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      select: { email: true },
    });
    return new Set(rows.map((r) => r.email));
  }

  /**
   * 指定 email 群のうち Account が既存の email 集合を 1 クエリで返す（CSV 一括 import の既存判定
   * プリフェッチ用 / rete-settings-0010）。行ごとの findUnique（N 往復）を IN 一括引きへ畳む。
   */
  async findExistingAccountEmails(emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    const rows = await this.prisma.account.findMany({
      where: { email: { in: [...new Set(emails)] } },
      select: { email: true },
    });
    return new Set(rows.map((r) => r.email));
  }

  /**
   * パスワードポリシー（singleton）を取得する（受諾時の強度検証用）。
   * minLength だけでなく必須文字種フラグも返し、accept() が validatePassword で全項目 enforce する
   * （rete-settings-0011: 従来は minLength のみ取得で大小英字/数字/記号が素通りしていた）。
   */
  findPasswordPolicy(): Promise<PasswordPolicyShape | null> {
    return this.prisma.passwordPolicy.findFirst({
      select: {
        minLength: true,
        requireLowercase: true,
        requireUppercase: true,
        requireNumber: true,
        requireSymbol: true,
      },
    });
  }

  /**
   * kind=GROUP かつ未アーカイブの Space を ID で引く（招待発行時のスペース検証用・論点1）。
   * null = 存在しない / GROUP でない / アーカイブ済み。archivedAt: null でソフト削除済みの器への招待を防ぐ
   * （security/database review HIGH: アーカイブ済み GROUP へのメンバー追加を遮断）。
   */
  findGroupSpaceById(id: string): Promise<{ id: string } | null> {
    return this.prisma.space.findFirst({
      where: { id, kind: SpaceKind.GROUP, archivedAt: null },
      select: { id: true },
    });
  }

  /** 招待を作成する（send-first 方針のため、メール送信成功後に呼ぶ）。tokenHash は含まない。 */
  create(data: CreateInviteData): Promise<InviteWithRelationsPublic> {
    return this.prisma.invite.create({
      data: {
        email: data.email,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        invitedById: data.invitedById,
        spaceId: data.spaceId ?? null,
      },
      select: inviteSelectPublic,
    });
  }

  /** 招待を更新する（再送用: tokenHash / expiresAt / status の更新）。tokenHash を含む（フル select）。 */
  update(id: string, data: UpdateInviteData): Promise<InviteWithRelations> {
    return this.prisma.invite.update({
      where: { id },
      data: {
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        status: data.status,
      },
      select: inviteSelect,
    });
  }

  /**
   * 再送: 未受諾（PENDING かつ読んだ時の tokenHash のまま）の招待だけを新しい token と期限へ書き換える。
   *
   * 再送はこの書き換えの後に SMTP 送信する（d689・persist-first）。読んでから書き換えるまでの間に受諾が
   * 完了しうるため、id だけを条件に PENDING へ戻すと、受諾済みの招待が未受諾へ巻き戻り、後から送った
   * リンクは既存 Account のため受諾できない死んだ招待が残る（d622）。
   * そのため書き換えは「読んだ時の tokenHash がそのまま かつ status=PENDING」の 1 文で行う:
   *  - 受諾が先に確定していれば status が ACCEPTED なので当たらず、巻き戻らない。
   *  - 別の再送が先に書き換えていれば tokenHash が変わるので当たらず、同時再送でも token は 1 本に定まる。
   * 当たらなかった理由は、更新後の 1 行を読み直して返す（呼び出し側が案内を出し分ける）。
   */
  async renewPendingByTokenHash(
    id: string,
    expectedTokenHash: string,
    data: UpdateInviteData,
  ): Promise<RenewPendingOutcome> {
    const updated = await this.prisma.invite.updateMany({
      where: { id, tokenHash: expectedTokenHash, status: InviteStatus.PENDING },
      data: {
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        status: data.status,
      },
    });
    if (updated.count > 0) return 'renewed';

    const current = await this.prisma.invite.findUnique({
      where: { id },
      select: { status: true },
    });
    return current?.status === InviteStatus.ACCEPTED ? 'accepted' : 'pending_mismatch';
  }

  /** 招待を物理削除する（「期限切れ削除」UI 用・任意 status を削除可）。 */
  async delete(id: string): Promise<void> {
    await this.prisma.invite.delete({ where: { id } });
  }

  /**
   * Account 作成 + Invite ACCEPTED への更新をインタラクティブトランザクションで原子的に実行する。
   *
   * TX 内で invite を再取得して有効性・email 未使用を再チェック（同時実行ハザード対策）:
   *  - 別リクエストが先に受諾を完了していた場合 → invite.status !== PENDING で BadRequest
   *  - 別リクエストが Account を先に作成した場合 → existingAccount で BadRequest
   * P2002（accounts.email unique 違反）はここではそのまま throw し、service 層で曖昧エラーへ変換。
   *
   * 論点1: spaceId が設定されている場合は GROUP Membership を作成する。
   *        null の旧招待はスキップ（ログイン後の空状態案内に委ねる）。
   *
   * 戻り値: 作成した Account の id / email（d559）。受諾経路は未認証で叩けるため、横断の
   * 操作ログ interceptor の記録条件（認証済み利用者）に当たらず、呼び出し側が明示記録する。
   * 記録の actor を「作った当人」にするために id と email を返す。
   */
  async acceptInTransaction(data: AcceptInviteData): Promise<{ accountId: string; email: string }> {
    return this.prisma.$transaction(async (tx) => {
      // TX 内で invite を再取得（他リクエストによる状態変化を反映）
      const invite = await tx.invite.findUnique({
        where: { tokenHash: data.tokenHash },
        select: {
          id: true,
          status: true,
          expiresAt: true,
          email: true,
          spaceId: true,
        },
      });

      // 再検証: PENDING かつ未期限でなければ同一曖昧エラー
      if (!invite || invite.status !== InviteStatus.PENDING || invite.expiresAt <= new Date()) {
        throw new BadRequestException('招待が無効か期限切れです');
      }

      // email の再チェック（並行登録でどちらかが先に Account を作成した場合）
      const existingAccount = await tx.account.findUnique({
        where: { email: invite.email },
        select: { id: true },
      });
      if (existingAccount) {
        throw new BadRequestException('招待が無効か期限切れです');
      }

      // セキュリティ（TOCTOU 対策・security/database review）: 発行〜受諾の間（最大 7 日）に
      // Space の archive / GROUP 以外への変更が起きうる。発行時の検証だけでは不十分なため、
      // TX 内で space を再検証する。無効化されていれば**付与だけスキップ**し受諾自体は成立させる
      // （null の旧招待と同じ「ログイン後の空状態案内に委ねる」挙動へ収束）。これにより:
      //  - archive/削除済み Space への孤立 Membership 生成を回避（database: scopeId は FK 制約なし）
      let effectiveSpaceId: string | null = null;
      if (invite.spaceId) {
        const space = await tx.space.findFirst({
          where: { id: invite.spaceId, kind: SpaceKind.GROUP, archivedAt: null },
          select: { id: true },
        });
        effectiveSpaceId = space?.id ?? null;
      }

      // set-0096: 招待の表示名を姓・名へ分割して同時に保存（migration backfill と同アルゴリズム）。
      const { familyName, givenName } = splitDisplayName(data.name);
      const account = await tx.account.create({
        data: {
          email: invite.email,
          name: data.name,
          familyName,
          givenName,
          passwordHash: data.passwordHash,
          role: 'MEMBER',
          isActive: true,
        },
        select: { id: true },
      });

      // 論点1: 再検証を通過した GROUP Space にのみ Membership を作成する。
      // scopeType=GROUP: MembershipScopeType に SPACE は存在しないため GROUP を使用（ADR 0037）。
      if (effectiveSpaceId) {
        await tx.membership.create({
          data: {
            accountId: account.id,
            scopeType: MembershipScopeType.GROUP,
            scopeId: effectiveSpaceId,
            role: 'MEMBER',
          },
        });
      }

      await tx.invite.update({
        where: { id: invite.id },
        data: {
          status: InviteStatus.ACCEPTED,
          acceptedAt: new Date(),
        },
      });

      return { accountId: account.id, email: invite.email };
    });
  }
}
