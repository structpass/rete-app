import type {
  HomeGroupPermissionKey,
  HomeGroupPermissions,
  MembershipScopeType,
  UserGroupDto,
  UserGroupMemberDto,
  UserGroupScopeGrantDto,
} from '@rete/shared';
import type {
  UserGroupRow,
  UserGroupMemberRow,
  UserGroupScopeGrantRow,
} from './repositories/user-groups.repository';

/**
 * user-groups の Repository 行 → Response DTO 変換（ADR 0002 §1 DTO 境界）。
 * Repository は Entity を返し、Service が本 mapper を通して DTO へ変換する。
 */

/**
 * 応答へ書いた Home の設定値の名前（d874）。応答の形（UserGroupDto）は設定値を任意にしている
 * ため、書き足し忘れは型で止まらない。この一覧を正本（HOME_PERMISSIONS）と突き合わせ、
 * 下の型で欠けを型エラーにする。値を書き出す所はこの一覧を使うので、型と中身がずれない。
 */
const HOME_GROUP_DTO_KEYS = [
  'canEditHomeBoard',
  'canEditHomeCalendar',
  'canEditHomeFaq',
  'canManageHomeTags',
] as const satisfies readonly HomeGroupPermissionKey[];

type MissingInDto = Exclude<HomeGroupPermissionKey, (typeof HOME_GROUP_DTO_KEYS)[number]>;
/**
 * 設定値の名前が 1 つでも欠けたら型エラーにする（d874）。Record<never, never> は {} になり
 * 空の値を通してしまうため、条件型で true/false に落として確かめる。
 */
const dtoHasAllHomeGroupFlags: [MissingInDto] extends [never] ? true : false = true;
void dtoHasAllHomeGroupFlags;

/** UserGroupRow → UserGroupDto。 */
export function toUserGroupDto(row: UserGroupRow): UserGroupDto {
  const permissions = Object.fromEntries(
    HOME_GROUP_DTO_KEYS.map((key) => [key, row[key]] as const),
  ) as unknown as HomeGroupPermissions;
  return {
    ...permissions,
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** UserGroupMemberRow → UserGroupMemberDto（accountName は account relation の name）。 */
export function toUserGroupMemberDto(row: UserGroupMemberRow): UserGroupMemberDto {
  return {
    id: row.id,
    groupId: row.groupId,
    accountId: row.accountId,
    accountName: row.account?.name,
  };
}

/** UserGroupScopeGrantRow → UserGroupScopeGrantDto。 */
export function toGrantDto(row: UserGroupScopeGrantRow): UserGroupScopeGrantDto {
  return {
    id: row.id,
    groupId: row.groupId,
    scopeType: row.scopeType as MembershipScopeType,
    scopeId: row.scopeId,
    role: row.role as 'ADMIN' | 'MEMBER',
    createdAt: row.createdAt.toISOString(),
  };
}
