import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MembershipScopeType,
  type HomeGroupPermissionKey,
  type HomeGroupPermissions,
} from '@rete/shared';
import { PrismaService } from '../../../database/prisma.service';
import { MembershipsRepository } from '../../memberships/repositories/memberships.repository';
import { runInSerializableTransaction } from '../../../common/database/serializable-tx';

/**
 * user_group の select 射影（DTO 変換に必要な列のみ・createdAt/updatedAt 込み）。
 * Home の設定値の列はここに並べ、正本（HOME_PERMISSIONS）との抜けは下の型で止める（d874）。
 */
const userGroupSelect = {
  canEditHomeBoard: true,
  canEditHomeCalendar: true,
  canEditHomeFaq: true,
  canManageHomeTags: true,
  id: true,
  name: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * 設定値の列が 1 つでも欠けたら型エラーにする（d874）。正本（HOME_PERMISSIONS）に許可を足した
 * 時に、ここの書き足し忘れを黙って通さない。
 */
type MissingHomeGroupColumns = Exclude<HomeGroupPermissionKey, keyof typeof userGroupSelect>;
export const homeGroupColumnsComplete: Record<MissingHomeGroupColumns, never> = {};

export type UserGroupRow = Prisma.UserGroupGetPayload<{ select: typeof userGroupSelect }>;

/** user_group_member の select 射影（account 名込み）。 */
const userGroupMemberSelect = {
  id: true,
  groupId: true,
  accountId: true,
  createdAt: true,
  account: { select: { name: true } },
} as const;

export type UserGroupMemberRow = Prisma.UserGroupMemberGetPayload<{
  select: typeof userGroupMemberSelect;
}>;

/** user_group_scope_grant の select 射影。 */
const userGroupScopeGrantSelect = {
  id: true,
  groupId: true,
  scopeType: true,
  scopeId: true,
  role: true,
  createdAt: true,
} as const;

export type UserGroupScopeGrantRow = Prisma.UserGroupScopeGrantGetPayload<{
  select: typeof userGroupScopeGrantSelect;
}>;

/**
 * ユーザーグループ（set-0164）のデータアクセス層（ADR 0002 §2 = データアクセス層分離）。
 * UserGroup / UserGroupMember / UserGroupScopeGrant の 3 テーブルを担う。
 * 全消失ガード（実効 ADMIN ベース）は $transaction で 3 テーブル横断の count→write を原子化する。
 */
@Injectable()
export class UserGroupsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membershipsRepo: MembershipsRepository,
  ) {}

  /** 全グループ一覧（set-0188: アーカイブは撤去済み＝返る行はすべて現役）。 */
  async findAll(): Promise<UserGroupRow[]> {
    return this.prisma.userGroup.findMany({
      select: userGroupSelect,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  findById(id: string): Promise<UserGroupRow | null> {
    return this.prisma.userGroup.findUnique({ where: { id }, select: userGroupSelect });
  }

  /** グループのメンバー数（一覧表示用・グループ id 群を一括 count）。 */
  async countMembersByGroupIds(groupIds: string[]): Promise<Map<string, number>> {
    if (groupIds.length === 0) return new Map();
    const rows = await this.prisma.userGroupMember.groupBy({
      by: ['groupId'],
      where: { groupId: { in: groupIds } },
      _count: { id: true },
    });
    return new Map(rows.map((r) => [r.groupId, r._count.id]));
  }

  /** グループ作成（sortOrder は兄弟最大 +1 で採番・tx 内）。 */
  async create(
    name: string,
    permissions: Partial<HomeGroupPermissions> = {},
  ): Promise<UserGroupRow> {
    return this.prisma.$transaction(async (tx) => {
      const max = await tx.userGroup.aggregate({ _max: { sortOrder: true } });
      return tx.userGroup.create({
        data: { ...permissions, name, sortOrder: (max._max.sortOrder ?? -1) + 1 },
        select: userGroupSelect,
      });
    });
  }

  /** グループ更新（改名）。 */
  update(id: string, data: Prisma.UserGroupUpdateInput): Promise<UserGroupRow> {
    return this.prisma.userGroup.update({
      where: { id },
      data,
      select: userGroupSelect,
    });
  }

  /** グループのメンバー一覧（account 名込み・createdAt 昇順）。 */
  findMembers(groupId: string): Promise<UserGroupMemberRow[]> {
    return this.prisma.userGroupMember.findMany({
      where: { groupId },
      select: userGroupMemberSelect,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * グループメンバーを追加する（冪等 upsert・同一グループへの二重所属は unique で抑制）。
   * 戻り値: { created: boolean }（既に所属済みなら false）。
   */
  async addMember(groupId: string, accountId: string): Promise<{ created: boolean }> {
    const existing = await this.prisma.userGroupMember.findUnique({
      where: { groupId_accountId: { groupId, accountId } },
      select: { id: true },
    });
    if (existing) return { created: false };
    await this.prisma.userGroupMember.create({ data: { groupId, accountId } });
    return { created: true };
  }

  /** グループメンバーを削除する。戻り値: 削除した行が存在したか。 */
  async removeMember(groupId: string, accountId: string): Promise<boolean> {
    const res = await this.prisma.userGroupMember.deleteMany({
      where: { groupId, accountId },
    });
    return res.count > 0;
  }

  /**
   * グループメンバー削除（実効 ADMIN 全消失ガード付き・set-0164 criteria 3）。
   * 対象メンバーが「そのグループの ADMIN grant を持つスコープ」で唯一の実効 ADMIN 源になっている場合、
   * 削除後にそのスコープの実効 ADMIN がゼロになるため blocked=true を返す（削除しない）。
   * 実体の消えたスコープ（物理削除済みの組織 / プロジェクト / チャネル）への grant は判定から外す
   * （実効権限を生まないため。deleteWithDependents と同じ扱い＝外さないと剥奪も削除もできない詰まりになる）。
   * 判定は $transaction 内の count→delete で原子化（TOCTOU 安全）。
   * 戻り値: { blocked: boolean; deleted: boolean }
   */
  async removeMemberGuarded(
    groupId: string,
    accountId: string,
  ): Promise<{ blocked: boolean; deleted: boolean }> {
    return runInSerializableTransaction(this.prisma, async (tx) => {
      const existed = await tx.userGroupMember.findUnique({
        where: { groupId_accountId: { groupId, accountId } },
        select: { id: true },
      });
      if (!existed) return { blocked: false, deleted: false };

      // このグループが ADMIN grant を持つスコープを列挙（grant はグループにメンバーが残る間だけ実効 ADMIN 源になる）
      const adminGrants = await tx.userGroupScopeGrant.findMany({
        where: { groupId, role: 'ADMIN' },
        select: { scopeType: true, scopeId: true },
      });
      for (const grant of adminGrants) {
        // 実体の消えたスコープへの grant は実効権限を生まないため判定から外す（deleteWithDependents と同じ扱い）。
        // 数えてしまうと、消えたスコープの grant が残るグループからメンバーも grant も外せなくなる
        // （グループごと削除するしか逃げ道が無くなる）。
        if (!(await this.scopeExists(tx, grant.scopeType, grant.scopeId))) continue;
        // 対象メンバー以外の実効 ADMIN 源（個別 membership + 他グループ grant）を数える。
        // このグループの grant は「このメンバーが唯一のメンバーなら」無効化されるため、
        // excludeGroupId で除外して数える（グループに他メンバーが残る場合は grant は有効のまま＝
        // メンバー削除で ADMIN が消えるのは「このグループにメンバーが対象者 1 人だけ」の時のみ）。
        const otherMembers = await tx.userGroupMember.count({
          where: { groupId, accountId: { not: accountId } },
        });
        if (otherMembers > 0) continue; // グループに他メンバーが残る＝grant は有効なまま
        const effectiveAdmins = await this.membershipsRepo.countEffectiveAdmins(
          grant.scopeType,
          grant.scopeId,
          { excludeGroupId: groupId, tx },
        );
        if (effectiveAdmins === 0) return { blocked: true, deleted: false };
      }

      await tx.userGroupMember.delete({ where: { id: existed.id } });
      return { blocked: false, deleted: true };
    });
  }

  /** グループの grant 一覧。 */
  findGrants(groupId: string): Promise<UserGroupScopeGrantRow[]> {
    return this.prisma.userGroupScopeGrant.findMany({
      where: { groupId },
      select: userGroupScopeGrantSelect,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * grant を付与する（冪等 upsert・同一グループ×同一スコープは unique で抑制）。
   * 戻り値: { created: boolean; blocked: boolean }
   * - 既に付与済みなら created=false（role 変更があれば更新）
   * - **ADMIN → MEMBER への降格は実効 ADMIN 全消失ガードの対象**（set-0164 criteria 3）:
   *   そのスコープの実効 ADMIN がこのグループ grant だけの場合、降格すると管理者ゼロになるため
   *   blocked=true を返す（更新しない）。実体の消えたスコープは判定から外す
   *   （deleteWithDependents と同じ扱い。Service は付与前にスコープ実在を確認するため通常は到達しない）。
   *   判定は $transaction 内の count→update で原子化。
   */
  async upsertGrant(
    groupId: string,
    scopeType: MembershipScopeType,
    scopeId: string,
    role: 'ADMIN' | 'MEMBER',
  ): Promise<{ created: boolean; blocked: boolean }> {
    return runInSerializableTransaction(this.prisma, async (tx) => {
      const existing = await tx.userGroupScopeGrant.findUnique({
        where: { groupId_scopeType_scopeId: { groupId, scopeType, scopeId } },
        select: { id: true, role: true },
      });
      if (existing) {
        if (existing.role !== role) {
          // ADMIN → MEMBER 降格: このグループを除いた実効 ADMIN 源がゼロなら拒否（全消失ガード）。
          // 実体の消えたスコープは実効権限を生まないため判定から外す（deleteWithDependents と同じ扱い）。
          if (
            existing.role === 'ADMIN' &&
            role === 'MEMBER' &&
            (await this.scopeExists(tx, scopeType, scopeId))
          ) {
            const effectiveAdmins = await this.membershipsRepo.countEffectiveAdmins(
              scopeType,
              scopeId,
              {
                excludeGroupId: groupId,
                tx,
              },
            );
            if (effectiveAdmins === 0) return { created: false, blocked: true };
          }
          await tx.userGroupScopeGrant.update({
            where: { id: existing.id },
            data: { role },
          });
        }
        return { created: false, blocked: false };
      }
      await tx.userGroupScopeGrant.create({
        data: { groupId, scopeType, scopeId, role },
      });
      return { created: true, blocked: false };
    });
  }

  /** grant を剥奪する。戻り値: 削除した行が存在したか。 */
  async removeGrant(
    groupId: string,
    scopeType: MembershipScopeType,
    scopeId: string,
  ): Promise<boolean> {
    const res = await this.prisma.userGroupScopeGrant.deleteMany({
      where: { groupId, scopeType, scopeId },
    });
    return res.count > 0;
  }

  /**
   * grant 剥奪（実効 ADMIN 全消失ガード付き・set-0164 criteria 3）。
   * ADMIN grant の剥奪で「そのスコープの実効 ADMIN がゼロになる」場合は blocked=true を返す（剥奪しない）。
   * 実体の消えたスコープへの grant は判定から外す（deleteWithDependents と同じ扱い・剥奪だけが
   * 永久に塞がれる非対称を作らない）。
   * 判定は $transaction 内の count→delete で原子化（TOCTOU 安全）。
   * 戻り値: { blocked: boolean; deleted: boolean; role }。role は対象 grant のロールで、
   * 監査 summary に「どの role を剥奪したか」まで残すために返す（v2-232）。
   */
  async removeGrantGuarded(
    groupId: string,
    scopeType: MembershipScopeType,
    scopeId: string,
  ): Promise<{ blocked: boolean; deleted: boolean; role: 'ADMIN' | 'MEMBER' | null }> {
    return runInSerializableTransaction(this.prisma, async (tx) => {
      const existed = await tx.userGroupScopeGrant.findUnique({
        where: { groupId_scopeType_scopeId: { groupId, scopeType, scopeId } },
        select: { id: true, role: true },
      });
      if (!existed) return { blocked: false, deleted: false, role: null };
      if (existed.role === 'ADMIN' && (await this.scopeExists(tx, scopeType, scopeId))) {
        // 実体の消えたスコープへの grant は実効権限を生まないため判定から外す（deleteWithDependents と同じ扱い）。
        // このグループを除外した実効 ADMIN 源（個別 membership + 他グループ grant）を数える。
        const effectiveAdmins = await this.membershipsRepo.countEffectiveAdmins(
          scopeType,
          scopeId,
          {
            excludeGroupId: groupId,
            tx,
          },
        );
        if (effectiveAdmins === 0) {
          return { blocked: true, deleted: false, role: existed.role as 'ADMIN' | 'MEMBER' };
        }
      }
      await tx.userGroupScopeGrant.delete({ where: { id: existed.id } });
      return { blocked: false, deleted: true, role: existed.role as 'ADMIN' | 'MEMBER' };
    });
  }

  /**
   * グループの物理削除（set-0188・実効 ADMIN 全消失ガード付き）。
   *
   * アーカイブという「器を残して所属設定だけ消す」中間状態を撤去したため、削除は
   * 孤児を残さない 1 本の Serializable transaction に閉じる。削除対象グループの
   * ADMIN grant ごとに、対象グループを除外した実効 ADMIN 源を確認し、いずれかが
   * ゼロになる場合は blocked=true を返して削除しない。
   * 所属設定（UserGroupScopeGrant）→ メンバー（UserGroupMember）→ グループ行の順に削除する。
   */
  async deleteWithDependents(
    id: string,
  ): Promise<{ blocked: boolean; deletedGrantCount: number; deletedMemberCount: number }> {
    return runInSerializableTransaction(this.prisma, async (tx) => {
      const adminGrants = await tx.userGroupScopeGrant.findMany({
        where: { groupId: id, role: 'ADMIN' },
        select: { scopeType: true, scopeId: true },
      });
      const memberCount = await tx.userGroupMember.count({ where: { groupId: id } });
      if (memberCount > 0) {
        for (const grant of adminGrants) {
          // 実体の消えたスコープへの grant は実効権限を生まないため判定から外す（数えると、
          // 消えたスコープの grant が残るグループを二度と削除できない状態を作る）。
          if (!(await this.scopeExists(tx, grant.scopeType, grant.scopeId))) continue;
          const effectiveAdmins = await this.membershipsRepo.countEffectiveAdmins(
            grant.scopeType,
            grant.scopeId,
            { excludeGroupId: id, tx },
          );
          if (effectiveAdmins === 0) {
            return { blocked: true, deletedGrantCount: 0, deletedMemberCount: 0 };
          }
        }
      }

      const grants = await tx.userGroupScopeGrant.deleteMany({ where: { groupId: id } });
      const members = await tx.userGroupMember.deleteMany({ where: { groupId: id } });
      await tx.userGroup.delete({ where: { id } });
      return {
        blocked: false,
        deletedGrantCount: grants.count,
        deletedMemberCount: members.count,
      };
    });
  }

  /**
   * アカウントの実在確認（grant / メンバー追加前の cross-check・§2 データアクセス層分離）。
   * 実在しなければ null。名前は監査 summary に載せるため一緒に返す。
   */
  findAccountSummary(accountId: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true },
    });
  }

  /**
   * grant 付与前の対象スコープ（組織 / プロジェクト / チャネル）の実在 + 非アーカイブ確認。
   *
   * 実在しなければ null（Service が NotFound を投げる）。実在しても archivedAt が入っていれば
   * アーカイブ済みとして返し、Service が BadRequest へ翻訳する（＝本層は HTTP 例外を持たない）。
   * CHANNEL は space.kind も返し、Service が「チャネル以外」を弾けるようにする。
   * name は監査 summary（どのスコープへの grant か）へ載せるため一緒に返す（v2-232）。
   */
  async findScopeForGrant(
    scopeType: MembershipScopeType,
    scopeId: string,
  ): Promise<{ name: string; archivedAt: Date | null; kind?: string } | null> {
    if (scopeType === MembershipScopeType.ORGANIZATION) {
      return this.prisma.organization.findUnique({
        where: { id: scopeId },
        select: { name: true, archivedAt: true },
      });
    }
    if (scopeType === MembershipScopeType.PROJECT) {
      return this.prisma.project.findUnique({
        where: { id: scopeId },
        select: { name: true, archivedAt: true },
      });
    }
    const channel = await this.prisma.space.findUnique({
      where: { id: scopeId },
      select: { kind: true, name: true, archivedAt: true },
    });
    return channel;
  }

  /**
   * grant の対象スコープ（組織 / プロジェクト / チャネル）が実在するか。
   *
   * user_group_scope_grants は scopeId をポリモーフィックに持ち外部キーが無いため、
   * スコープの物理削除後も grant 行が残りうる。実在しないスコープを実効 ADMIN の
   * 判定へ数えると、そのグループを削除できない状態が解除不能になる。
   */
  private async scopeExists(
    tx: Prisma.TransactionClient,
    scopeType: string,
    scopeId: string,
  ): Promise<boolean> {
    if (scopeType === MembershipScopeType.ORGANIZATION) {
      const org = await tx.organization.findUnique({
        where: { id: scopeId },
        select: { id: true },
      });
      return org !== null;
    }
    if (scopeType === MembershipScopeType.PROJECT) {
      const project = await tx.project.findUnique({
        where: { id: scopeId },
        select: { id: true },
      });
      return project !== null;
    }
    if (scopeType === MembershipScopeType.CHANNEL) {
      const space = await tx.space.findUnique({
        where: { id: scopeId },
        select: { kind: true },
      });
      return space !== null && space.kind === 'CHANNEL';
    }
    // 未知の種別は実在を確かめられないため、保守側（判定対象に残す）。
    return true;
  }
}
