import type { HomeGroupPermissions } from './home-permissions';
/**
 * CM-2 マルチユーザー / 組織モデル（管理対象3層）の共有型・SSOT。
 * 設計正本: docs/discover/specs/2026-06-14-cm2-org-model-design.md / ADR 0037。
 *
 * 管理対象3層 = 組織 | グループ | 個人。組織階層は 組織＞プロジェクト＞チャネル＞{チャット明細＋タスク明細}。
 * チャネル/グループ/個人メモ/1:1 は全て「チャット明細＋タスク明細を持つ二ペインの器」＝統一 Space テーブルに
 * kind で吸収する（ADR 0037）。
 *
 * enum（SpaceKind / MembershipScopeType）は Prisma の DB enum と値を完全一致させる（先例 Role / ChatThemeMentionField）。
 * backend の DTO / バリデーション・mapper、frontend のサイドバー描画が本定義を import して使う（§5 shared 型整合）。
 */

/**
 * 器（Space）の種別。Prisma `enum SpaceKind` と値を完全一致させる SSOT。
 * - CHANNEL       : プロジェクト配下のチャネル（projectId 必須）。
 * - GROUP         : 組織非依存のフラットなグループ（1器・メンバーは Membership scopeType=GROUP）。
 * - PERSONAL_MEMO : 自分メモ（ownerId のみ）。
 * - PERSONAL_DM   : 1:1（ownerId + peerAccountId のペア）。
 */
export enum SpaceKind {
  CHANNEL = 'CHANNEL',
  GROUP = 'GROUP',
  PERSONAL_MEMO = 'PERSONAL_MEMO',
  PERSONAL_DM = 'PERSONAL_DM',
}

/**
 * メンバーシップのスコープ種別。Prisma `enum MembershipScopeType` と値を完全一致させる SSOT。
 * 可視範囲＝器のメンバーシップ1階層（spec §4.2）。CHANNEL は親 PROJECT membership の可視性に加算する直接スコープ。
 * 個人（PERSONAL_MEMO/DM）はスコープに含めない（ownerId/peerAccountId 直参照で解決）。
 */
export enum MembershipScopeType {
  ORGANIZATION = 'ORGANIZATION',
  PROJECT = 'PROJECT',
  CHANNEL = 'CHANNEL',
  GROUP = 'GROUP',
}

/**
 * 移行②（spec §8）のデフォルト器の固定 ID。migration SQL のリテラルと**完全一致**させること
 * （migration は TS を import できないため、SQL 側に同じ UUID をハードコードし本定数をコメント参照する）。
 * seed は本定数で同一固定 ID を冪等再現する。既存 ChatTheme/Task は DEFAULT_CHANNEL_ID へ収容される。
 */
export const DEFAULT_ORG_ID = '00000000-0000-4000-b000-000000000001';
export const DEFAULT_PROJECT_ID = '00000000-0000-4000-b000-000000000002';
export const DEFAULT_CHANNEL_ID = '00000000-0000-4000-b000-000000000003';

/** 表示名の最大長（サイドバー 1 行が破綻しない範囲・app 層 DTO で強制）。 */
export const ORG_ENTITY_NAME_MAX_LEN = 80;

/** 組織エントリ 1 件の Response 形。 */
export interface OrganizationDto {
  id: string;
  name: string;
  sortOrder: number;
  /** アーカイブ済か（archivedAt != null を畳む）。 */
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** プロジェクト 1 件の Response 形。 */
export interface ProjectDto {
  id: string;
  organizationId: string;
  name: string;
  sortOrder: number;
  archived: boolean;
  /**
   * 閲覧者がこのプロジェクトの ADMIN かどうか（= チャネルの追加／改名／アーカイブ操作 UI を出してよいか）。
   * 閲覧者依存の派生値のため service が membership から畳んで付与する（mapper 既定は false）。
   */
  canManageChannels: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 器（Space）1 件の Response 形。kind により projectId / ownerId / peerAccountId の有無が変わる。 */
export interface SpaceDto {
  id: string;
  kind: SpaceKind;
  /** CHANNEL のみ非 null（所属プロジェクト）。 */
  projectId: string | null;
  /** PERSONAL_MEMO / PERSONAL_DM のみ非 null（所有者）。 */
  ownerId: string | null;
  /** PERSONAL_DM のみ非 null（1:1 の相手）。 */
  peerAccountId: string | null;
  /**
   * 閲覧者視点で見た相手の表示名。PERSONAL_DM のみ backend が同梱し、閲覧者相対（ownerId/peerAccountId
   * の自分ではない側）の Account.name を返す（dsk-0325）。isActive に関わらず名前を返す（退会・ロック
   * 済みでも 'DM' 固定に落ちない）。空文字も素通しする（name が一時的に空になっても上書きしない）。
   * 他 kind / 解決不能（peer・owner 双方とも結合 null）の場合は null。フィールド自体は optional で
   * （他 API 応答との後方互換・未設定との区別を `undefined` で表現）、mapper は null を明示代入する。
   * 消費側は `dm.peerName != null` で「undefined と null 双方を未確定扱い」できる（frontend dmPartnerName）。
   */
  peerName?: string | null;
  /**
   * 閲覧者がこの GROUP のメンバー設定 UI を出してよいか（GROUP scope-ADMIN またはシステム ADMIN）。
   * 閲覧者依存の派生値のため service が membership / role から畳んで付与する（mapper 既定は false）。
   * GROUP 以外の kind では常に false（dsk-0354・ProjectDto.canManageChannels と同型）。
   */
  canManageMembers: boolean;
  name: string;
  sortOrder: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** メンバーシップ 1 件の Response 形（ユーザー×スコープ×ロール）。 */
export interface MembershipDto {
  id: string;
  accountId: string;
  scopeType: MembershipScopeType;
  /** スコープ対象の id（ORGANIZATION→Organization.id / PROJECT→Project.id / CHANNEL/GROUP→Space.id）。 */
  scopeId: string;
  /** スコープ内ロール（システム Role enum を流用）。 */
  role: 'ADMIN' | 'MEMBER';
  /** 表示用のアカウント名（mapper が結合・一覧表示用）。 */
  accountName?: string;
}

/** 組織エントリ作成入力（組織管理者のみ）。 */
export interface CreateOrganizationInput {
  name: string;
}

/** 組織エントリ更新入力（部分更新）。 */
export interface UpdateOrganizationInput {
  name?: string;
  archived?: boolean;
}

/** プロジェクト作成入力（組織管理者のみ・admin を複数指定可 §9-2）。 */
export interface CreateProjectInput {
  organizationId: string;
  name: string;
  /** プロジェクト管理者に任命する accountId 群（省略時は作成者のみ ADMIN）。 */
  adminAccountIds?: string[];
}

/** プロジェクト更新入力（部分更新）。 */
export interface UpdateProjectInput {
  name?: string;
  archived?: boolean;
}

/**
 * 器（Space）作成入力。kind により必須フィールドが変わる（app 層 DTO で判別検証）:
 * - CHANNEL: projectId + name（プロジェクト管理者のみ）
 * - GROUP: name（誰でも作成）
 * - PERSONAL_MEMO: （owner は作成者）
 * - PERSONAL_DM: peerAccountId（owner は作成者）
 */
export interface CreateSpaceInput {
  kind: SpaceKind;
  name?: string;
  projectId?: string;
  peerAccountId?: string;
}

/** 器（Space）更新入力（部分更新・チャネル/グループの改名・アーカイブ）。 */
export interface UpdateSpaceInput {
  name?: string;
  archived?: boolean;
}

/** メンバーシップ追加入力（器への限定メンバー招待の成立条件 §5・招待メールは CM-3 別）。 */
export interface AddMembershipInput {
  accountId: string;
  scopeType: MembershipScopeType;
  scopeId: string;
  role: 'ADMIN' | 'MEMBER';
}

/** メンバーシップ ロール変更入力（set-0027 新設 PATCH /memberships/:id 用）。 */
export interface UpdateMembershipRoleInput {
  role: 'ADMIN' | 'MEMBER';
}

// ============================================================
// 管理グループ（set-0188）— ユーザーを束ねるだけの器。
// 組織/PJ/チャネルへの参加先は所属管理の UserGroupScopeGrant で設定する。
// ============================================================

/** ユーザーグループ 1 件の Response 形。 */
export interface UserGroupDto extends Partial<HomeGroupPermissions> {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** メンバー数（一覧表示用・repo が count を畳む）。 */
  memberCount?: number;
}

/** ユーザーグループ作成入力（システム ADMIN のみ）。 */
export interface CreateUserGroupInput extends Partial<HomeGroupPermissions> {
  name: string;
}

/** ユーザーグループ更新入力（部分更新・システム ADMIN のみ）。 */
export interface UpdateUserGroupInput extends Partial<HomeGroupPermissions> {
  name?: string;
}

/** グループメンバー 1 件の Response 形（account 名込み）。 */
export interface UserGroupMemberDto {
  id: string;
  groupId: string;
  accountId: string;
  /** 表示用のアカウント名（mapper が結合・一覧表示用）。 */
  accountName?: string;
}

/** グループメンバー追加入力（システム ADMIN のみ）。 */
export interface AddUserGroupMemberInput {
  groupId: string;
  accountId: string;
}

/** グループ grant 1 件の Response 形（グループ→組織/PJ/チャネルのロール付き所属）。 */
export interface UserGroupScopeGrantDto {
  id: string;
  groupId: string;
  scopeType: MembershipScopeType;
  scopeId: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: string;
}

/** グループ grant 付与入力（システム ADMIN のみ）。 */
export interface AddUserGroupScopeGrantInput {
  groupId: string;
  scopeType: MembershipScopeType;
  scopeId: string;
  role: 'ADMIN' | 'MEMBER';
}

/** 権限マトリクスの縦軸。parentId で組織＞プロジェクト＞チャネルを復元する。 */
export interface PermissionMatrixScopeDto {
  id: string;
  scopeType:
    | MembershipScopeType.ORGANIZATION
    | MembershipScopeType.PROJECT
    | MembershipScopeType.CHANNEL;
  name: string;
  parentId: string | null;
  depth: 0 | 1 | 2;
}

/** 管理者向け所属マトリクスの一括取得形。セル値は管理グループの grant だけを返す。 */
export interface PermissionMatrixDto {
  scopes: PermissionMatrixScopeDto[];
  groups: UserGroupDto[];
  grants: UserGroupScopeGrantDto[];
}
