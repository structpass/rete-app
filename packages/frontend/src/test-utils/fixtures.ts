/**
 * frontend のテスト用データ作成の共通手段（d596）。
 *
 * backend には `src/__tests__/factories.ts`（24 ヘルパ・33 spec が利用）があるのに、frontend は
 * 各テストが同じ形の DTO を手で書き直していた。項目が 1 つ増えると、同じデータを使う多数のテストを
 * 直すことになり、テストごとに既定値も少しずつずれる（実測で OrganizationDto の組み立てが 3 か所に
 * 逐語重複していた）。ここを 1 本の正本にし、呼び出し側は差分（overrides）だけを書く。
 *
 * 約束:
 * - 返すのは**共有型（`@rete/shared`）**の DTO。Prisma の Entity ではなく、画面が API から受け取る形そのもの。
 * - 全項目を既定値で埋める（`Partial<XxxDto>` を受けて `...over` で上書き）。テストは「変えたい所だけ」を書く。
 * - 日時は固定値（`FIXED_DATE`）を使い、表示・並びの検証を決定的にする（backend factories.ts と同じ線）。
 * - overrides に `undefined` を渡した時も呼び出し側の値を優先する（`...over` の一般的な契約）。
 * - このファイルはテストではないので vitest へ依存しない（`test-utils/flush.ts`・`list-layout.ts` と同じ線）。
 *   カバレッジ計測の対象外（`vitest.config.ts` の `src/test-utils/**`）。
 */
import type {
  FavoriteDto,
  FavoriteKind,
  InviteDto,
  InviteStatus,
  MemberDto,
  OrganizationDto,
  ProjectDto,
  SpaceDto,
} from '@rete/shared';
import { SpaceKind } from '@rete/shared';

/** 固定日時。ISO 文字列へ変換する検証を決定的にする（backend factories.ts と同じ日時）。 */
export const FIXED_DATE = '2026-05-29T01:23:45.000Z';

/**
 * 組織 1 件。
 * @example makeOrganizationDto(); makeOrganizationDto({ name: 'Beta', archived: true });
 */
export function makeOrganizationDto(over: Partial<OrganizationDto> = {}): OrganizationDto {
  return {
    id: 'org-1',
    name: 'Acme',
    sortOrder: 1,
    archived: false,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...over,
  };
}

/**
 * プロジェクト 1 件。
 * @example makeProjectDto({ organizationId: 'org-2' });
 */
export function makeProjectDto(over: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: 'proj-1',
    organizationId: 'org-1',
    name: '倉庫オペレーション改善',
    sortOrder: 1,
    archived: false,
    // 既定は非管理者（チャネル操作の UI を出さない）。管理者のケースは canManageChannels: true を渡す。
    canManageChannels: false,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...over,
  };
}

/**
 * 器（Space）1 件。kind ごとに意味を持つ項目があるため、既定は CHANNEL。
 * GROUP / PERSONAL_* を渡す時は projectId・ownerId・peerAccountId も合わせて渡す。
 * @example makeSpaceDto(); makeSpaceDto({ kind: SpaceKind.GROUP, name: '営業部', projectId: null });
 */
export function makeSpaceDto(over: Partial<SpaceDto> = {}): SpaceDto {
  return {
    id: 'ch-1',
    kind: SpaceKind.CHANNEL,
    projectId: 'proj-1',
    ownerId: null,
    peerAccountId: null,
    // 既定は非管理者（メンバー設定メニューを出さない）。管理者のケースは canManageMembers: true を渡す。
    canManageMembers: false,
    name: '雑談',
    sortOrder: 1,
    archived: false,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...over,
  };
}

/**
 * メンバー 1 件（= Account の管理画面 DTO）。
 * @example makeMemberDto({ isActive: false });
 */
export function makeMemberDto(over: Partial<MemberDto> = {}): MemberDto {
  return {
    id: 'm-1',
    name: '山田 太郎',
    familyName: '山田',
    givenName: '太郎',
    email: 'taro@rete.local',
    isActive: true,
    lockedUntil: null,
    mfaEnabled: false,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...over,
  };
}

/**
 * 招待 1 件。既定は未受諾（PENDING）。
 * @example makeInviteDto({ status: 'EXPIRED', acceptedAt: null });
 */
export function makeInviteDto(over: Partial<InviteDto> = {}): InviteDto {
  return {
    id: 'inv-1',
    email: 'taro@rete.local',
    status: 'PENDING' satisfies InviteStatus,
    invitedAt: FIXED_DATE,
    expiresAt: FIXED_DATE,
    acceptedAt: null,
    invitedByName: '山田 太郎',
    ...over,
  };
}

/**
 * お気に入り 1 件。既定はファイル。
 * @example makeFavoriteDto({ kind: 'chat', targetRef: 'ch-1', label: '雑談' });
 */
export function makeFavoriteDto(over: Partial<FavoriteDto> = {}): FavoriteDto {
  return {
    id: 'fav-1',
    kind: 'file' satisfies FavoriteKind,
    targetRef: 'file-1',
    label: '入荷データ取込',
    ...over,
  };
}
