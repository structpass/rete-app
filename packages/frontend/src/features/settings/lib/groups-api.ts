import apiClient from '@/lib/api-client';
import type {
  ApiResponse,
  UserGroupDto,
  UserGroupMemberDto,
  CreateUserGroupInput,
  UpdateUserGroupInput,
  AddUserGroupMemberInput,
  AddUserGroupScopeGrantInput,
} from '@rete/shared';

/**
 * ユーザーグループ管理 API（set-0164 frontend 用・システム ADMIN 専用）。
 * set-0188: アーカイブ/復元を撤去（includeArchived 廃止・物理削除を追加）。
 * GET    /user-groups                     — グループ一覧（現役のみ）
 * POST   /user-groups                     — グループ作成
 * PATCH  /user-groups/:id                — 更新（名前・Home編集権限）
 * DELETE /user-groups/:id                — 削除（所属設定・メンバーも連鎖削除）
 * GET    /user-groups/:id/members        — メンバー一覧
 * POST   /user-groups/:id/members        — メンバー追加
 * DELETE /user-groups/:id/members/:accountId — メンバー削除
 * GET    /user-groups/:id/grants         — grant 一覧
 * POST   /user-groups/:id/grants         — grant 付与
 * DELETE /user-groups/:id/grants/:scopeType/:scopeId — grant 剥奪
 */

/** グループ一覧（GET /user-groups）。 */
export async function fetchUserGroups(): Promise<UserGroupDto[]> {
  const res = await apiClient.get<ApiResponse<UserGroupDto[]>>('/user-groups');
  return res.data.data;
}

/** グループ作成（POST /user-groups）。 */
export async function createUserGroup(input: CreateUserGroupInput): Promise<UserGroupDto> {
  const res = await apiClient.post<ApiResponse<UserGroupDto>>('/user-groups', input);
  return res.data.data;
}

/** グループ更新（PATCH /user-groups/:id・名前とHome編集権限）。 */
export async function updateUserGroup(
  id: string,
  input: UpdateUserGroupInput,
): Promise<UserGroupDto> {
  const res = await apiClient.patch<ApiResponse<UserGroupDto>>(`/user-groups/${id}`, input);
  return res.data.data;
}

/** グループ削除（DELETE /user-groups/:id・所属設定とメンバーも連鎖削除・set-0188）。 */
export async function deleteUserGroup(id: string): Promise<void> {
  await apiClient.delete(`/user-groups/${id}`);
}

/** グループのメンバー一覧（GET /user-groups/:id/members）。 */
export async function fetchUserGroupMembers(groupId: string): Promise<UserGroupMemberDto[]> {
  const res = await apiClient.get<ApiResponse<UserGroupMemberDto[]>>(
    `/user-groups/${groupId}/members`,
  );
  return res.data.data;
}

/** メンバー追加（POST /user-groups/:id/members）。 */
export async function addUserGroupMember(
  input: AddUserGroupMemberInput,
): Promise<{ created: boolean }> {
  const res = await apiClient.post<ApiResponse<{ created: boolean }>>(
    `/user-groups/${input.groupId}/members`,
    { accountId: input.accountId },
  );
  return res.data.data;
}

/** メンバー削除（DELETE /user-groups/:id/members/:accountId）。 */
export async function removeUserGroupMember(groupId: string, accountId: string): Promise<void> {
  await apiClient.delete(`/user-groups/${groupId}/members/${accountId}`);
}

/** grant 付与（POST /user-groups/:id/grants）。 */
export async function addUserGroupGrant(
  input: AddUserGroupScopeGrantInput,
): Promise<{ created: boolean }> {
  const res = await apiClient.post<ApiResponse<{ created: boolean }>>(
    `/user-groups/${input.groupId}/grants`,
    { scopeType: input.scopeType, scopeId: input.scopeId, role: input.role },
  );
  return res.data.data;
}

/** grant 剥奪（DELETE /user-groups/:id/grants/:scopeType/:scopeId）。 */
export async function removeUserGroupGrant(
  groupId: string,
  scopeType: AddUserGroupScopeGrantInput['scopeType'],
  scopeId: string,
): Promise<void> {
  await apiClient.delete(`/user-groups/${groupId}/grants/${scopeType}/${scopeId}`);
}
