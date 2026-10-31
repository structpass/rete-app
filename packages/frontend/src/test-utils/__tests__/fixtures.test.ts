import { describe, it, expect } from 'vitest';
import { DEFAULT_CHANNEL_ID, SpaceKind } from '@rete/shared';
import type {
  FavoriteDto,
  InviteDto,
  MemberDto,
  OrganizationDto,
  ProjectDto,
  SpaceDto,
} from '@rete/shared';
import {
  FIXED_DATE,
  makeFavoriteDto,
  makeInviteDto,
  makeMemberDto,
  makeOrganizationDto,
  makeProjectDto,
  makeSpaceDto,
} from '../fixtures';

/**
 * d596: 共有のテストデータ作成手段が「型どおりの 1 件」を返すことと、差分の渡し方を固定する。
 * ここが緩むと、各テストは緑のまま実物と食い違ったデータ（項目の欠落・既定の食い違い）を握る。
 */

/** DTO の全項目名（キー集合）。項目が増えた時に、既定値の追従漏れをここで止める。 */
const keysOf = (v: object): string[] => Object.keys(v).sort();

describe('test-utils/fixtures（d596）', () => {
  it('組織は OrganizationDto の全項目を持つ（差分を渡すとその値が勝つ）', () => {
    const org: OrganizationDto = makeOrganizationDto();
    expect(keysOf(org)).toEqual(
      keysOf({
        id: '',
        name: '',
        sortOrder: 0,
        archived: false,
        createdAt: '',
        updatedAt: '',
      }),
    );
    expect(org).toMatchObject({ id: 'org-1', name: 'Acme', sortOrder: 1, archived: false });
    expect(org.createdAt).toBe(FIXED_DATE);
    expect(makeOrganizationDto({ name: 'Beta', archived: true })).toMatchObject({
      id: 'org-1',
      name: 'Beta',
      archived: true,
    });
  });

  it('プロジェクトは ProjectDto の全項目を持ち、管理可否の既定は false', () => {
    const project: ProjectDto = makeProjectDto();
    expect(keysOf(project)).toEqual(
      keysOf({
        id: '',
        organizationId: '',
        name: '',
        sortOrder: 0,
        archived: false,
        canManageChannels: false,
        createdAt: '',
        updatedAt: '',
      }),
    );
    expect(project).toMatchObject({ organizationId: 'org-1', canManageChannels: false });
    expect(makeProjectDto({ canManageChannels: true }).canManageChannels).toBe(true);
  });

  it('器は SpaceDto の全項目を持ち、既定はチャネル・非管理者', () => {
    const space: SpaceDto = makeSpaceDto();
    expect(keysOf(space)).toEqual(
      keysOf({
        id: '',
        kind: SpaceKind.CHANNEL,
        projectId: null,
        ownerId: null,
        peerAccountId: null,
        name: '',
        sortOrder: 0,
        archived: false,
        canManageMembers: false,
        createdAt: '',
        updatedAt: '',
      }),
    );
    expect(space).toMatchObject({
      kind: SpaceKind.CHANNEL,
      projectId: 'proj-1',
      ownerId: null,
      peerAccountId: null,
      canManageMembers: false,
    });
    // 差分は undefined を含めて呼び出し側が勝つ（...over の一般的な契約）。
    const group = makeSpaceDto({
      kind: SpaceKind.GROUP,
      projectId: null,
      peerName: undefined,
      canManageMembers: true,
    });
    expect(group).toMatchObject({ kind: SpaceKind.GROUP, projectId: null, canManageMembers: true });
    expect(group.peerName).toBeUndefined();
  });

  it('メンバーは MemberDto の全項目を持ち、既定は有効・MFA 無し・ロックアウト無し', () => {
    const member: MemberDto = makeMemberDto();
    expect(keysOf(member)).toEqual(
      keysOf({
        id: '',
        name: '',
        familyName: '',
        givenName: '',
        email: '',
        isActive: false,
        lockedUntil: null,
        mfaEnabled: false,
        createdAt: '',
        updatedAt: '',
      }),
    );
    expect(member).toMatchObject({
      name: '山田 太郎',
      familyName: '山田',
      givenName: '太郎',
      isActive: true,
      lockedUntil: null,
      mfaEnabled: false,
    });
    expect(makeMemberDto({ isActive: false, mfaEnabled: true })).toMatchObject({
      isActive: false,
      mfaEnabled: true,
    });
  });

  it('招待は InviteDto の全項目を持ち、既定は未受諾（PENDING）', () => {
    const invite: InviteDto = makeInviteDto();
    expect(keysOf(invite)).toEqual(
      keysOf({
        id: '',
        email: '',
        status: 'PENDING',
        invitedAt: '',
        expiresAt: '',
        acceptedAt: null,
        invitedByName: '',
      }),
    );
    expect(invite).toMatchObject({ status: 'PENDING', acceptedAt: null });
    expect(makeInviteDto({ status: 'EXPIRED' }).status).toBe('EXPIRED');
  });

  it('お気に入りは FavoriteDto の全項目を持ち、既定はファイル', () => {
    const favorite: FavoriteDto = makeFavoriteDto();
    expect(keysOf(favorite)).toEqual(keysOf({ id: '', kind: 'file', targetRef: '', label: '' }));
    expect(favorite).toMatchObject({ kind: 'file' });
    expect(makeFavoriteDto({ kind: 'chat', targetRef: DEFAULT_CHANNEL_ID }).kind).toBe('chat');
  });

  it('作るたびに新しい 1 件を返す（テスト間で同じ実体を共有しない）', () => {
    const a = makeOrganizationDto();
    const b = makeOrganizationDto();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
