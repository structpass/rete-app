import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CreateUserGroupDto, UpdateUserGroupDto } from './dto/user-groups.dto';
import { HOME_PERMISSIONS, MembershipScopeType, type HomeGroupPermissions } from '@rete/shared';
import { AuditRecorderService, type AuditClientInfo } from '../audit-logs/audit-recorder.service';
import { AUDIT_RETE_SYSTEM_NAME } from '../audit-logs/audit-logs.constants';
import { UserGroupsRepository, type UserGroupRow } from './repositories/user-groups.repository';
import { toGrantDto, toUserGroupDto, toUserGroupMemberDto } from './user-groups.mapper';
import type { AuthenticatedUser } from '../auth/auth.service';

/** grant で許可する scopeType。チャットグループ（GROUP）は対象外。 */
const GRANT_ALLOWED_SCOPE_TYPES: MembershipScopeType[] = [
  MembershipScopeType.ORGANIZATION,
  MembershipScopeType.PROJECT,
  MembershipScopeType.CHANNEL,
];

/**
 * grant 対象スコープの日本語ラベル（v2-232）。操作者へ返す 404 / 400 の文言と、監査 summary の
 * 「どのスコープか」を同じ語に揃えるため 1 か所に置く（scope 種別ごとの語は
 * projects / organizations / spaces の各 service と同じ）。
 */
const SCOPE_TYPE_LABELS: Record<string, string> = {
  [MembershipScopeType.ORGANIZATION]: '組織',
  [MembershipScopeType.PROJECT]: 'プロジェクト',
  [MembershipScopeType.CHANNEL]: 'チャネル',
};

/** grant のロール日本語ラベル（監査 summary 用・所属管理の表示と同じ語）。 */
const GRANT_ROLE_LABELS: Record<string, string> = {
  ADMIN: '管理者',
  MEMBER: '一般',
};

/**
 * 監査 summary に載せるスコープ表記（v2-232）。一覧を読む人が ID を照合しなくても
 * 「どのスコープへの grant か」まで読めるよう名前を使い、名前が引けない時だけ ID へ落とす。
 */
function scopeText(scopeType: MembershipScopeType, scopeId: string, name?: string | null): string {
  return `${SCOPE_TYPE_LABELS[scopeType] ?? 'スコープ'}「${name ?? scopeId}」`;
}

/**
 * ユーザーグループ（set-0164）サービス。
 * グループ CRUD / メンバー管理 / 組織・PJ・チャネルへの grant 付与・剥奪を担う。
 * 全操作はシステム ADMIN（Account.role=ADMIN）専用（コントローラの @Roles(Role.ADMIN) がゲート）。
 * 監査は横断 interceptor（mutation 自動記録）+ 本 service の明示行（グループ管理は権限の要）。
 */
@Injectable()
export class UserGroupsService {
  constructor(
    private readonly repo: UserGroupsRepository,
    private readonly audit: AuditRecorderService,
  ) {}

  /** グループ一覧（システム ADMIN 専用・set-0188 でアーカイブは撤去済＝全件が現役）。 */
  async findAll() {
    const rows = await this.repo.findAll();
    const counts = await this.repo.countMembersByGroupIds(rows.map((r) => r.id));
    return rows.map((r) => ({ ...toUserGroupDto(r), memberCount: counts.get(r.id) ?? 0 }));
  }

  /** グループ作成（システム ADMIN 専用）。 */
  async create(
    dto: CreateUserGroupDto,
    requester: AuthenticatedUser,
    client: AuditClientInfo = {},
  ) {
    const row = await this.repo.create(dto.name, homeFlags(dto));
    await this.audit.record({
      actorAccountId: requester.id,
      actorName: requester.name,
      actorEmail: requester.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'create',
      feature: '管理グループ',
      summary: `ユーザーグループを作成（${row.name}）`,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: { groupId: row.id, name: row.name },
    });
    return toUserGroupDto(row);
  }

  /**
   * グループ更新（改名・システム ADMIN 専用・set-0188）。
   * 更新はグループ名と Home の設定値を扱う。設定値は入力に現れたものだけを書き換える
   * （現れていない設定値は DB の今の値をそのまま残す）。
   */
  async update(
    id: string,
    dto: UpdateUserGroupDto,
    requester: AuthenticatedUser,
    client: AuditClientInfo = {},
  ) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('グループが見つかりません');

    await this.repo.update(id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...homeFlags(dto),
    });

    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('グループが見つかりません');
    await this.audit.record({
      actorAccountId: requester.id,
      actorName: requester.name,
      actorEmail: requester.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'update',
      feature: '管理グループ',
      summary: `管理グループを更新（${row.name}）`,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: { groupId: id, name: row.name, before: homeFlags(existing), after: homeFlags(row) },
    });
    return toUserGroupDto(row);
  }

  /**
   * グループの物理削除（システム ADMIN 専用・set-0188）。
   * アーカイブは撤去したため、所属設定（grant）とメンバーを同一 transaction で連鎖削除してから
   * グループ行を消す（孤児を残さない）。実在しない id は 404（コントローラは 204 を返す）。
   */
  async removeGroup(id: string, requester: AuthenticatedUser, client: AuditClientInfo = {}) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('グループが見つかりません');

    const { blocked, deletedGrantCount, deletedMemberCount } =
      await this.repo.deleteWithDependents(id);
    if (blocked) {
      throw new ConflictException(
        '管理者がいなくなるため、このグループを削除できません。先に別の管理グループへメンバーを追加し、同じスコープの管理者を付けてください',
      );
    }
    await this.audit.record({
      actorAccountId: requester.id,
      actorName: requester.name,
      actorEmail: requester.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'delete',
      feature: '管理グループ',
      summary: `管理グループを削除（${existing.name}・メンバー ${deletedMemberCount} 件・所属設定 ${deletedGrantCount} 件削除）`,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: {
        groupId: id,
        name: existing.name,
        deletedMemberCount,
        deletedGrantCount,
      },
    });
  }

  /** グループのメンバー一覧（システム ADMIN 専用）。 */
  async findMembers(groupId: string) {
    await this.ensureGroupExists(groupId);
    const rows = await this.repo.findMembers(groupId);
    return rows.map(toUserGroupMemberDto);
  }

  /** グループへメンバー追加（システム ADMIN 専用・冪等）。 */
  async addMember(
    groupId: string,
    dto: { accountId: string },
    requester: AuthenticatedUser,
    client: AuditClientInfo = {},
  ) {
    await this.ensureGroupExists(groupId);
    // アカウント実在 cross-check（membership の先例に従う）。
    const account = await this.repo.findAccountSummary(dto.accountId);
    if (!account) throw new NotFoundException('アカウントが見つかりません');

    const { created } = await this.repo.addMember(groupId, dto.accountId);
    await this.audit.record({
      actorAccountId: requester.id,
      actorName: requester.name,
      actorEmail: requester.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: created ? 'create' : 'update',
      feature: '管理グループ',
      summary: `グループメンバーを${created ? '追加' : '更新'}（グループ ${groupId} へ ${account.name}）`,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: { groupId, accountId: dto.accountId, accountName: account.name },
    });
    return { created };
  }

  /**
   * グループメンバー削除（システム ADMIN 専用）。
   * 全消失ガード: グループのメンバー削除で「実効 ADMIN が最後の 1 人になる」場合は 409 で拒否する
   * （3 テーブル横断: memberships / user_group_members / user_group_scope_grants の実効 ADMIN を数える）。
   * 削除対象メンバーが最後の実効 ADMIN になりうるスコープ（= 対象グループが ADMIN grant を持つスコープ）について、
   * 「そのメンバー以外の実効 ADMIN 源」が存在するかを tx 内で数えてから削除する（TOCTOU 安全）。
   */
  async removeMember(
    groupId: string,
    accountId: string,
    requester: AuthenticatedUser,
    client: AuditClientInfo = {},
  ) {
    await this.ensureGroupExists(groupId);
    const { blocked, deleted } = await this.repo.removeMemberGuarded(groupId, accountId);
    if (blocked) {
      throw new ConflictException(
        '管理者がいなくなるため、このメンバーを削除できません。先に別の管理グループへメンバーを追加し、同じスコープの管理者を付けてください',
      );
    }
    if (!deleted) throw new NotFoundException('メンバーが見つかりません');

    await this.audit.record({
      actorAccountId: requester.id,
      actorName: requester.name,
      actorEmail: requester.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'delete',
      feature: '管理グループ',
      summary: `グループメンバーを削除（グループ ${groupId} から ${accountId}）`,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: { groupId, accountId },
    });
    return { deleted: true };
  }

  /** グループの grant 一覧（システム ADMIN 専用）。 */
  async findGrants(groupId: string) {
    await this.ensureGroupExists(groupId);
    const rows = await this.repo.findGrants(groupId);
    return rows.map(toGrantDto);
  }

  /**
   * grant 付与（システム ADMIN 専用・冪等 upsert）。
   * - scopeType は ORGANIZATION / PROJECT / CHANNEL
   * - scopeId 実在 cross-check・archived 済み組織/PJ/チャネルへの付与は不可
   * - 監査行はグループ名・スコープ名・role まで載せ、横断の操作ログ一覧から実体が読めるようにする（v2-232）
   */
  async addGrant(
    groupId: string,
    dto: { scopeType: MembershipScopeType; scopeId: string; role: 'ADMIN' | 'MEMBER' },
    requester: AuthenticatedUser,
    client: AuditClientInfo = {},
  ) {
    const group = await this.ensureGroupExists(groupId);
    if (!GRANT_ALLOWED_SCOPE_TYPES.includes(dto.scopeType)) {
      throw new BadRequestException(
        'この scopeType への grant は許可されていません（ORGANIZATION / PROJECT / CHANNEL のみ）',
      );
    }
    const scopeName = await this.assertScopeActive(dto.scopeType, dto.scopeId);

    const { created, blocked } = await this.repo.upsertGrant(
      groupId,
      dto.scopeType,
      dto.scopeId,
      dto.role,
    );
    if (blocked) {
      throw new ConflictException(
        '管理者がいなくなるため、この grant を降格できません。先に別の管理グループへメンバーを追加し、同じスコープの管理者を付けてください',
      );
    }
    await this.audit.record({
      actorAccountId: requester.id,
      actorName: requester.name,
      actorEmail: requester.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: created ? 'create' : 'update',
      feature: '管理グループ',
      summary: `グループ grant を${created ? '付与' : '更新'}（管理グループ「${group.name}」→ ${scopeText(dto.scopeType, dto.scopeId, scopeName)}を ${GRANT_ROLE_LABELS[dto.role]}）`,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: {
        groupId,
        groupName: group.name,
        scopeType: dto.scopeType,
        scopeId: dto.scopeId,
        scopeName: scopeName ?? null,
        role: dto.role,
      },
    });
    return { created };
  }

  /**
   * grant 剥奪（システム ADMIN 専用）。
   * 全消失ガード: ADMIN grant の剥奪で「そのスコープの実効 ADMIN が最後の 1 人になる」場合は 409 で拒否する
   * （3 テーブル横断: memberships / user_group_members / user_group_scope_grants の実効 ADMIN を数える）。
   */
  async removeGrant(
    groupId: string,
    scopeType: MembershipScopeType,
    scopeId: string,
    requester: AuthenticatedUser,
    client: AuditClientInfo = {},
  ) {
    const group = await this.ensureGroupExists(groupId);
    if (!GRANT_ALLOWED_SCOPE_TYPES.includes(scopeType)) {
      throw new BadRequestException(
        'この scopeType の grant は剥奪できません（ORGANIZATION / PROJECT / CHANNEL のみ）',
      );
    }
    const { blocked, deleted, role } = await this.repo.removeGrantGuarded(
      groupId,
      scopeType,
      scopeId,
    );
    if (blocked) {
      throw new ConflictException(
        '管理者がいなくなるため、この grant を剥奪できません。先に別の管理グループへメンバーを追加し、同じスコープの管理者を付けてください',
      );
    }
    if (!deleted) throw new NotFoundException('grant が見つかりません');

    // スコープが既に消えている grant も剥奪できるため、名前は引けた時だけ載せる（無ければ ID）。
    const scope = await this.repo.findScopeForGrant(scopeType, scopeId);
    const roleSuffix = role ? `を ${GRANT_ROLE_LABELS[role]}` : '';

    await this.audit.record({
      actorAccountId: requester.id,
      actorName: requester.name,
      actorEmail: requester.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'delete',
      feature: '管理グループ',
      summary: `グループ grant を剥奪（管理グループ「${group.name}」→ ${scopeText(scopeType, scopeId, scope?.name)}${roleSuffix}）`,
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: {
        groupId,
        groupName: group.name,
        scopeType,
        scopeId,
        scopeName: scope?.name ?? null,
        role: role ?? null,
      },
    });
    return { deleted: true };
  }

  /**
   * グループ実在チェック（set-0188: アーカイブは撤去済＝存在するかどうかだけを見る）。
   * 実在した行を返し、grant の監査 summary がグループ名まで読めるようにする（v2-232）。
   */
  private async ensureGroupExists(groupId: string): Promise<UserGroupRow> {
    const group = await this.repo.findById(groupId);
    if (!group) throw new NotFoundException('グループが見つかりません');
    return group;
  }

  /**
   * grant 対象（組織/PJ/チャネル）の実在 + 非アーカイブを cross-check する。
   * 文言は SCOPE_TYPE_LABELS（正本）を使い、scope 種別ごとの語を保つ。
   * 実在したスコープの名前を返し、監査 summary が「どのスコープへ付与したか」まで読めるようにする（v2-232）。
   */
  private async assertScopeActive(
    scopeType: MembershipScopeType,
    scopeId: string,
  ): Promise<string | undefined> {
    const label = SCOPE_TYPE_LABELS[scopeType] ?? 'スコープ';

    const scope = await this.repo.findScopeForGrant(scopeType, scopeId);
    if (!scope) throw new NotFoundException(`${label}が見つかりません`);
    if (scope.archivedAt) {
      throw new BadRequestException(
        `アーカイブ済みの${label}へ grant を付与できません（先に復元してください）`,
      );
    }
    if (scopeType === MembershipScopeType.CHANNEL && scope.kind !== 'CHANNEL') {
      throw new BadRequestException('CHANNEL scopeId にはチャネルを指定してください');
    }
    return scope.name;
  }
}

/**
 * Home の設定値だけを入力から抜き出す（d816・d874）。対象の名前は shared の正本
 * HOME_PERMISSIONS（groupFlagKey）から作るため、許可を足す時にここを書き足さない。
 * 入力の形（DTO）は shared の HomeGroupPermissions から広げるので、許可を足すと自動で広がる。
 */
const HOME_GROUP_FLAG_KEYS: readonly string[] = Object.values(HOME_PERMISSIONS).map(
  (permission) => permission.groupFlagKey,
);

function homeFlags(dto: Partial<HomeGroupPermissions>): Partial<HomeGroupPermissions> {
  return Object.fromEntries(
    Object.entries(dto).filter(
      ([key, value]) => value !== undefined && HOME_GROUP_FLAG_KEYS.includes(key),
    ),
  );
}
