import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getUniqueConflictMessage } from '../../common/filters/unique-conflict-context';
import { Role, SpaceKind } from '@rete/shared';
import { SpacesService } from './spaces.service';
import { SpacesRepository } from './repositories/spaces.repository';
import { ProjectsRepository } from '../projects/repositories/projects.repository';
import { MembershipsRepository } from '../memberships/repositories/memberships.repository';
import { ScopeVisibilityService } from '../memberships/scope-visibility.service';
import { AccountsRepository } from '../accounts/repositories/accounts.repository';
import { makeSpaceRow, makeProjectRow } from '../../__tests__/factories';

const FIXED_DATE = new Date('2026-06-14T00:00:00.000Z');
const USER_ID = 'user-1';
const PEER_ID = 'user-2';
const PROJECT_ID = 'proj-1';
const SPACE_ID = 'space-1';
const mockSpaceRepo = {
  createChannel: jest.fn(),
  findChannelsByProject: jest.fn(),
  createGroupWithMembership: jest.fn(),
  findGroupsForUser: jest.fn(),
  // dsk-0319: テナント管理 ADMIN 向け GROUP 全件取得（membership 非依存）。
  findAllGroupsAdmin: jest.fn(),
  createPersonalMemo: jest.fn(),
  findPersonalMemosForUser: jest.fn(),
  findExistingDm: jest.fn(),
  createPersonalDm: jest.fn(),
  // dsk-0325: peer/owner Account 双方結合版（findPersonalDmsForUser は旧版で本変更で削除）。
  findPersonalDmsForUserWithPeer: jest.fn(),
  findById: jest.fn(),
  update: jest.fn(),
  // set-0162: チャネル物理削除（紐づき検査 + 削除を同一 tx）。
  deleteChannelIfNoChildren: jest.fn(),
};

const mockProjRepo = {
  findById: jest.fn(),
};

const mockMembershipRepo = {
  findMembership: jest.fn(),
  findEffectiveMembership: jest.fn(),
  findAdminScopeIds: jest.fn(),
  findEffectiveAdminScopeIds: jest.fn(),
};

const mockVisibility = {
  resolveVisibleSpaceIds: jest.fn(),
};

const mockAccountRepo = {
  findById: jest.fn(),
};

describe('SpacesService', () => {
  let service: SpacesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpacesService,
        { provide: SpacesRepository, useValue: mockSpaceRepo },
        { provide: ProjectsRepository, useValue: mockProjRepo },
        { provide: MembershipsRepository, useValue: mockMembershipRepo },
        { provide: ScopeVisibilityService, useValue: mockVisibility },
        { provide: AccountsRepository, useValue: mockAccountRepo },
      ],
    }).compile();

    service = module.get<SpacesService>(SpacesService);
    // PERSONAL_DM 系テストの既定: peer は実在する（個別テストで上書き）。
    mockAccountRepo.findById.mockResolvedValue({ id: PEER_ID });
  });

  describe('create – CHANNEL', () => {
    it('projectId 未指定なら BadRequestException', async () => {
      await expect(
        service.create({ kind: SpaceKind.CHANNEL, name: 'ch' }, USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('プロジェクト不在なら NotFoundException', async () => {
      mockProjRepo.findById.mockResolvedValue(null);
      await expect(
        service.create({ kind: SpaceKind.CHANNEL, name: 'ch', projectId: PROJECT_ID }, USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('プロジェクト ADMIN でない場合は ForbiddenException', async () => {
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue(null);
      await expect(
        service.create({ kind: SpaceKind.CHANNEL, name: 'ch', projectId: PROJECT_ID }, USER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('正常: チャネルを作成し SpaceDto を返す', async () => {
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockSpaceRepo.createChannel.mockResolvedValue(makeSpaceRow());

      const result = await service.create(
        { kind: SpaceKind.CHANNEL, name: 'general', projectId: PROJECT_ID },
        USER_ID,
      );

      expect(mockSpaceRepo.createChannel).toHaveBeenCalledWith(PROJECT_ID, 'general');
      expect(result.data.kind).toBe(SpaceKind.CHANNEL);
    });
  });

  describe('create – GROUP', () => {
    it('名前未指定なら BadRequestException', async () => {
      await expect(service.create({ kind: SpaceKind.GROUP }, USER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('正常: グループと creator の GROUP ADMIN membership を共創し SpaceDto を返す', async () => {
      const groupRow = makeSpaceRow({ kind: 'GROUP', projectId: null });
      mockSpaceRepo.createGroupWithMembership.mockResolvedValue(groupRow);

      const result = await service.create({ kind: SpaceKind.GROUP, name: 'チームA' }, USER_ID);

      expect(mockSpaceRepo.createGroupWithMembership).toHaveBeenCalledWith('チームA', USER_ID);
      expect(result.data.kind).toBe(SpaceKind.GROUP);
      // creator は GROUP ADMIN 共創済みのためメンバー設定可（dsk-0354）。
      expect(result.data.canManageMembers).toBe(true);
    });
  });

  describe('create – PERSONAL_MEMO', () => {
    it('正常: PERSONAL_MEMO を作成し SpaceDto を返す（名前省略時はデフォルト）', async () => {
      const memoRow = makeSpaceRow({ kind: 'PERSONAL_MEMO', projectId: null, ownerId: USER_ID });
      mockSpaceRepo.createPersonalMemo.mockResolvedValue(memoRow);

      const result = await service.create({ kind: SpaceKind.PERSONAL_MEMO }, USER_ID);

      expect(mockSpaceRepo.createPersonalMemo).toHaveBeenCalledWith(USER_ID, '個人メモ');
      expect(result.data.kind).toBe(SpaceKind.PERSONAL_MEMO);
    });

    it('name 指定があればその名前で作成する', async () => {
      const memoRow = makeSpaceRow({
        kind: 'PERSONAL_MEMO',
        projectId: null,
        ownerId: USER_ID,
        name: 'マイメモ',
      });
      mockSpaceRepo.createPersonalMemo.mockResolvedValue(memoRow);

      await service.create({ kind: SpaceKind.PERSONAL_MEMO, name: 'マイメモ' }, USER_ID);

      expect(mockSpaceRepo.createPersonalMemo).toHaveBeenCalledWith(USER_ID, 'マイメモ');
    });

    it('空白のみの name はデフォルト「個人メモ」へフォールバック（rete-common-0011）', async () => {
      const memoRow = makeSpaceRow({ kind: 'PERSONAL_MEMO', projectId: null, ownerId: USER_ID });
      mockSpaceRepo.createPersonalMemo.mockResolvedValue(memoRow);

      await service.create({ kind: SpaceKind.PERSONAL_MEMO, name: '   ' }, USER_ID);

      expect(mockSpaceRepo.createPersonalMemo).toHaveBeenCalledWith(USER_ID, '個人メモ');
    });
  });

  describe('create – PERSONAL_DM', () => {
    it('peerAccountId 未指定なら BadRequestException', async () => {
      await expect(service.create({ kind: SpaceKind.PERSONAL_DM }, USER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('自分自身との DM は BadRequestException（self-DM ガード / rete-common-0011）', async () => {
      await expect(
        service.create({ kind: SpaceKind.PERSONAL_DM, peerAccountId: USER_ID }, USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockSpaceRepo.findExistingDm).not.toHaveBeenCalled();
    });

    it('peerAccountId が実在しなければ NotFoundException（cmn-0074）', async () => {
      mockAccountRepo.findById.mockResolvedValue(null);

      await expect(
        service.create({ kind: SpaceKind.PERSONAL_DM, peerAccountId: 'ghost-id' }, USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockSpaceRepo.findExistingDm).not.toHaveBeenCalled();
      expect(mockSpaceRepo.createPersonalDm).not.toHaveBeenCalled();
    });

    it('同一ペアの DM が既に存在すれば ConflictException（無向ペア重複防止）', async () => {
      const existingDm = makeSpaceRow({
        kind: 'PERSONAL_DM',
        projectId: null,
        ownerId: USER_ID,
        peerAccountId: PEER_ID,
      });
      mockSpaceRepo.findExistingDm.mockResolvedValue(existingDm);

      await expect(
        service.create({ kind: SpaceKind.PERSONAL_DM, peerAccountId: PEER_ID }, USER_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('逆順ペア（peer→owner）も重複と見なす（無向）', async () => {
      const existingDm = makeSpaceRow({
        kind: 'PERSONAL_DM',
        projectId: null,
        ownerId: PEER_ID,
        peerAccountId: USER_ID,
      });
      mockSpaceRepo.findExistingDm.mockResolvedValue(existingDm);

      await expect(
        service.create({ kind: SpaceKind.PERSONAL_DM, peerAccountId: PEER_ID }, USER_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('重複なし: PERSONAL_DM を作成し SpaceDto を返す', async () => {
      mockSpaceRepo.findExistingDm.mockResolvedValue(null);
      const dmRow = makeSpaceRow({
        kind: 'PERSONAL_DM',
        projectId: null,
        ownerId: USER_ID,
        peerAccountId: PEER_ID,
      });
      mockSpaceRepo.createPersonalDm.mockResolvedValue(dmRow);

      const result = await service.create(
        { kind: SpaceKind.PERSONAL_DM, peerAccountId: PEER_ID },
        USER_ID,
      );

      expect(mockSpaceRepo.createPersonalDm).toHaveBeenCalledWith(USER_ID, PEER_ID);
      expect(result.data.kind).toBe(SpaceKind.PERSONAL_DM);
    });

    it('事前チェックをすり抜けた並行作成が P2002 と専用の案内文を共通filterへ渡す', async () => {
      mockSpaceRepo.findExistingDm.mockResolvedValue(null);
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
      mockSpaceRepo.createPersonalDm.mockRejectedValue(error);

      await expect(
        service.create({ kind: SpaceKind.PERSONAL_DM, peerAccountId: PEER_ID }, USER_ID),
      ).rejects.toBe(error);
      expect(getUniqueConflictMessage(error)).toBe('この相手との DM は既に存在します');
    });

    it('P2002 以外の Prisma エラーは握らず再 throw する', async () => {
      mockSpaceRepo.findExistingDm.mockResolvedValue(null);
      const otherError = new Prisma.PrismaClientKnownRequestError('other', {
        code: 'P2003',
        clientVersion: 'test',
      });
      mockSpaceRepo.createPersonalDm.mockRejectedValue(otherError);

      await expect(
        service.create({ kind: SpaceKind.PERSONAL_DM, peerAccountId: PEER_ID }, USER_ID),
      ).rejects.toBe(otherError);
    });
  });

  describe('findAll – CHANNEL', () => {
    it('projectId 未指定なら BadRequestException', async () => {
      await expect(service.findAll(USER_ID, SpaceKind.CHANNEL)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('プロジェクト非メンバーなら ForbiddenException（存在ごと見せない）', async () => {
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue(null);
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockVisibility.resolveVisibleSpaceIds.mockResolvedValue([]);
      mockSpaceRepo.findChannelsByProject.mockResolvedValue([makeSpaceRow()]);
      await expect(service.findAll(USER_ID, SpaceKind.CHANNEL, PROJECT_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it.each(['MEMBER', 'ADMIN'])('親組織の実効 %s 所属で配下チャネルを閲覧できる', async (role) => {
      const project = makeProjectRow();
      mockProjRepo.findById.mockResolvedValue(project);
      mockMembershipRepo.findEffectiveMembership.mockImplementation(
        async (_userId: string, scopeType: string) =>
          scopeType === 'ORGANIZATION' ? { role } : null,
      );
      mockSpaceRepo.findChannelsByProject.mockResolvedValue([makeSpaceRow()]);

      const result = await service.findAll(USER_ID, SpaceKind.CHANNEL, PROJECT_ID, undefined, true);

      expect(result.data).toHaveLength(1);
      expect(mockMembershipRepo.findEffectiveMembership).toHaveBeenCalledWith(
        USER_ID,
        'ORGANIZATION',
        project.organizationId,
      );
      expect(mockSpaceRepo.findChannelsByProject).toHaveBeenCalledWith(PROJECT_ID, true);
      expect(mockVisibility.resolveVisibleSpaceIds).not.toHaveBeenCalled();
    });

    it('直接 CHANNEL の可視性だけなら兄弟チャネルとアーカイブを返さない', async () => {
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue(null);
      mockVisibility.resolveVisibleSpaceIds.mockResolvedValue(['visible-channel', 'other-project']);
      mockSpaceRepo.findChannelsByProject.mockResolvedValue([
        makeSpaceRow({ id: 'visible-channel' }),
        makeSpaceRow({ id: 'hidden-sibling' }),
      ]);

      const result = await service.findAll(USER_ID, SpaceKind.CHANNEL, PROJECT_ID, undefined, true);

      expect(result.data).toEqual([expect.objectContaining({ id: 'visible-channel' })]);
      expect(mockSpaceRepo.findChannelsByProject).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('他 PJ の可視チャネルがあっても対象 PJ は閲覧できない', async () => {
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue(null);
      mockVisibility.resolveVisibleSpaceIds.mockResolvedValue(['other-project']);
      mockSpaceRepo.findChannelsByProject.mockResolvedValue([makeSpaceRow()]);

      await expect(service.findAll(USER_ID, SpaceKind.CHANNEL, PROJECT_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('メンバー（MEMBER でも）ならチャネル一覧を返す', async () => {
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'MEMBER' });
      mockSpaceRepo.findChannelsByProject.mockResolvedValue([makeSpaceRow()]);

      const result = await service.findAll(USER_ID, SpaceKind.CHANNEL, PROJECT_ID);

      expect(mockMembershipRepo.findEffectiveMembership).toHaveBeenCalledWith(
        USER_ID,
        'PROJECT',
        PROJECT_ID,
      );
      expect(mockSpaceRepo.findChannelsByProject).toHaveBeenCalledWith(PROJECT_ID, undefined);
      expect(result.data).toHaveLength(1);
    });

    it('includeArchived=true はリポジトリへそのまま渡す（アーカイブ済チャネル表示）', async () => {
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'MEMBER' });
      mockSpaceRepo.findChannelsByProject.mockResolvedValue([makeSpaceRow()]);

      await service.findAll(USER_ID, SpaceKind.CHANNEL, PROJECT_ID, undefined, true);

      expect(mockSpaceRepo.findChannelsByProject).toHaveBeenCalledWith(PROJECT_ID, true);
    });
  });

  describe('findAll – その他 kind', () => {
    it('GROUP: 自分が membership を持つグループのみ返す', async () => {
      const groupRow = makeSpaceRow({ id: 'g-member', kind: 'GROUP', projectId: null });
      mockSpaceRepo.findGroupsForUser.mockResolvedValue([groupRow]);
      mockMembershipRepo.findEffectiveAdminScopeIds.mockResolvedValue([]);
      const result = await service.findAll(USER_ID, SpaceKind.GROUP);
      expect(mockSpaceRepo.findGroupsForUser).toHaveBeenCalledWith(USER_ID);
      expect(result.data).toHaveLength(1);
      // kind=GROUP 時 data は SpaceDto[]（kind 未指定時のみ string[]）。
      expect((result.data as { canManageMembers: boolean }[])[0].canManageMembers).toBe(false);
    });

    it('GROUP: scope-ADMIN のグループだけ canManageMembers=true（dsk-0354）', async () => {
      const adminG = makeSpaceRow({ id: 'g-admin', kind: 'GROUP', projectId: null });
      const memberG = makeSpaceRow({ id: 'g-member', kind: 'GROUP', projectId: null });
      mockSpaceRepo.findGroupsForUser.mockResolvedValue([adminG, memberG]);
      mockMembershipRepo.findEffectiveAdminScopeIds.mockResolvedValue([{ scopeId: 'g-admin' }]);

      const result = await service.findAll(USER_ID, SpaceKind.GROUP, undefined, Role.MEMBER);

      expect(mockMembershipRepo.findEffectiveAdminScopeIds).toHaveBeenCalledWith(USER_ID, 'GROUP');
      const rows = result.data as { id: string; canManageMembers: boolean }[];
      const byId = Object.fromEntries(rows.map((s) => [s.id, s]));
      expect(byId['g-admin']?.canManageMembers).toBe(true);
      expect(byId['g-member']?.canManageMembers).toBe(false);
    });

    it('GROUP: システム ADMIN は全 GROUP で canManageMembers=true（dsk-0354）', async () => {
      const g1 = makeSpaceRow({ id: 'g1', kind: 'GROUP', projectId: null });
      const g2 = makeSpaceRow({ id: 'g2', kind: 'GROUP', projectId: null });
      mockSpaceRepo.findGroupsForUser.mockResolvedValue([g1, g2]);

      const result = await service.findAll(USER_ID, SpaceKind.GROUP, undefined, Role.ADMIN);

      // システム ADMIN は membership 一括取得をスキップして全 true。
      expect(mockMembershipRepo.findEffectiveAdminScopeIds).not.toHaveBeenCalled();
      const rows = result.data as { canManageMembers: boolean }[];
      expect(rows.every((s) => s.canManageMembers)).toBe(true);
    });

    it('kind 未指定: 可視 space ID リストを返す', async () => {
      mockVisibility.resolveVisibleSpaceIds.mockResolvedValue([SPACE_ID]);
      const result = await service.findAll(USER_ID);
      expect(mockVisibility.resolveVisibleSpaceIds).toHaveBeenCalledWith(USER_ID);
      expect(result.data).toEqual([SPACE_ID]);
    });
  });

  describe('findAll – PERSONAL_DM（dsk-0325）', () => {
    /**
     * SpaceDmRow 相当のヘルパ。SpaceRow に owner / peer を加えただけ。
     * Prisma 上の relation semantics に従い、row.peer は peerAccountId 側の Account、
     * row.owner は ownerId 側の Account を返す。
     */
    function makeDmRow(
      overrides: Partial<Parameters<typeof makeSpaceRow>[0]>,
      peer: { id: string; name: string } | null,
      owner: { id: string; name: string } | null,
    ) {
      return {
        ...makeSpaceRow({ kind: 'PERSONAL_DM', projectId: null, ...overrides }),
        peer,
        owner,
      };
    }

    it('viewer=owner の場合: peerAccountId 側の Account.name を peerName に返す', async () => {
      // viewer = ownerId 側。partnerId = peerAccountId。row.peer が相手を指す。
      mockSpaceRepo.findPersonalDmsForUserWithPeer.mockResolvedValue([
        makeDmRow(
          { ownerId: USER_ID, peerAccountId: PEER_ID },
          { id: PEER_ID, name: '相手 太郎' },
          { id: USER_ID, name: '自分' },
        ),
      ]);

      const result = await service.findAll(USER_ID, SpaceKind.PERSONAL_DM);
      const spaces = result.data as Array<{ peerName: string | null }>;

      expect(spaces).toHaveLength(1);
      expect(spaces[0].peerName).toBe('相手 太郎');
    });

    it('viewer=peer の場合: ownerId 側の Account.name を peerName に返す（閲覧者相対）', async () => {
      // viewer = peerAccountId 側。partnerId = ownerId。row.owner が相手を指す。
      // Prisma 仕様上 row.peer は peerAccountId 経由 = viewer 自身を指すので、peerName の正解は
      // row.owner.name（dsk-0325 code-review 指摘で確定・双方 join 必須）。
      mockSpaceRepo.findPersonalDmsForUserWithPeer.mockResolvedValue([
        makeDmRow(
          { ownerId: PEER_ID, peerAccountId: USER_ID },
          { id: USER_ID, name: '自分' },
          { id: PEER_ID, name: '相手 花子' },
        ),
      ]);

      const result = await service.findAll(USER_ID, SpaceKind.PERSONAL_DM);
      const spaces = result.data as Array<{ peerName: string | null }>;

      expect(spaces).toHaveLength(1);
      expect(spaces[0].peerName).toBe('相手 花子');
    });

    it('退会・ロック済み相手（viewer=owner・peer が結合で null）: peerName は null = 表示側でフォールバック責務', async () => {
      mockSpaceRepo.findPersonalDmsForUserWithPeer.mockResolvedValue([
        makeDmRow({ ownerId: USER_ID, peerAccountId: PEER_ID }, null, {
          id: USER_ID,
          name: '自分',
        }),
      ]);

      const result = await service.findAll(USER_ID, SpaceKind.PERSONAL_DM);
      const spaces = result.data as Array<{ peerName: string | null }>;

      expect(spaces).toHaveLength(1);
      // backend は null を返し、frontend の dmPartnerName 等のフォールバック責務に委ねる（dsk-0325 設計）。
      expect(spaces[0].peerName).toBeNull();
    });

    it('空文字の partner.name（退会直後など name が空に更新されたケース）: 空文字を素通し・"DM" に置換しない', async () => {
      // dsk-0325: 旧実装は空文字を「フォールバック: DM」に置換していた（誤動作の温床）。
      // backend は空文字を peerName として素通しし、frontend 側で未定義チェックを行う。
      mockSpaceRepo.findPersonalDmsForUserWithPeer.mockResolvedValue([
        makeDmRow(
          { ownerId: USER_ID, peerAccountId: PEER_ID },
          { id: PEER_ID, name: '' },
          { id: USER_ID, name: '自分' },
        ),
      ]);

      const result = await service.findAll(USER_ID, SpaceKind.PERSONAL_DM);
      const spaces = result.data as Array<{ peerName: string | null }>;

      expect(spaces[0].peerName).toBe('');
    });
  });

  describe('update', () => {
    it('スペース不在なら NotFoundException', async () => {
      mockSpaceRepo.findById.mockResolvedValue(null);
      await expect(service.update(SPACE_ID, { name: '新名' }, USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('PERSONAL_MEMO/DM は update 対象外（BadRequestException）', async () => {
      mockSpaceRepo.findById.mockResolvedValue(
        makeSpaceRow({ kind: 'PERSONAL_MEMO', projectId: null, ownerId: USER_ID }),
      );
      await expect(service.update(SPACE_ID, { name: '新名' }, USER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('CHANNEL: プロジェクト ADMIN でなければ ForbiddenException', async () => {
      mockSpaceRepo.findById.mockResolvedValue(
        makeSpaceRow({ kind: 'CHANNEL', projectId: PROJECT_ID }),
      );
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue(null);
      await expect(service.update(SPACE_ID, { name: '新名' }, USER_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('GROUP: GROUP ADMIN でなければ ForbiddenException', async () => {
      mockSpaceRepo.findById.mockResolvedValue(makeSpaceRow({ kind: 'GROUP', projectId: null }));
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue(null);
      await expect(service.update(SPACE_ID, { name: '新名' }, USER_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('CHANNEL: 正常更新', async () => {
      mockSpaceRepo.findById.mockResolvedValue(
        makeSpaceRow({ kind: 'CHANNEL', projectId: PROJECT_ID }),
      );
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockSpaceRepo.update.mockResolvedValue(makeSpaceRow({ name: '新名' }));

      const result = await service.update(SPACE_ID, { name: '新名' }, USER_ID);

      // 権限チェックは PROJECT membership で
      expect(mockMembershipRepo.findEffectiveMembership).toHaveBeenCalledWith(
        USER_ID,
        'PROJECT',
        PROJECT_ID,
      );
      expect(result.data.name).toBe('新名');
    });

    it('アーカイブ済みチャネルの改名は BadRequestException（rete-common-0011）', async () => {
      mockSpaceRepo.findById.mockResolvedValue(
        makeSpaceRow({ kind: 'CHANNEL', projectId: PROJECT_ID, archivedAt: FIXED_DATE }),
      );
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });

      await expect(service.update(SPACE_ID, { name: '新名' }, USER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockSpaceRepo.update).not.toHaveBeenCalled();
    });

    it('アーカイブ済みチャネルの復元（archived:false・改名なし）は許可する', async () => {
      mockSpaceRepo.findById.mockResolvedValue(
        makeSpaceRow({ kind: 'CHANNEL', projectId: PROJECT_ID, archivedAt: FIXED_DATE }),
      );
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockSpaceRepo.update.mockResolvedValue(makeSpaceRow({ archivedAt: null }));

      const result = await service.update(SPACE_ID, { archived: false }, USER_ID);

      expect(mockSpaceRepo.update).toHaveBeenCalled();
      expect(result.data.archived).toBe(false);
    });
  });

  describe('findAllAdmin（dsk-0319）', () => {
    it('kind=GROUP: 全 GROUP を canManageMembers=true で返す（membership 非依存）', async () => {
      const g1 = makeSpaceRow({ id: 'g-1', kind: 'GROUP', projectId: null });
      const g2 = makeSpaceRow({ id: 'g-2', kind: 'GROUP', projectId: null });
      mockSpaceRepo.findAllGroupsAdmin.mockResolvedValue([g1, g2]);

      const result = await service.findAllAdmin(SpaceKind.GROUP);

      expect(mockSpaceRepo.findAllGroupsAdmin).toHaveBeenCalledWith(undefined);
      // membership 絞りを一切介さない（findGroupsForUser / findMembershipRepo は呼ばれない）。
      expect(mockSpaceRepo.findGroupsForUser).not.toHaveBeenCalled();
      expect(mockMembershipRepo.findEffectiveMembership).not.toHaveBeenCalled();
      expect(mockMembershipRepo.findEffectiveAdminScopeIds).not.toHaveBeenCalled();
      const rows = result.data as Array<{ id: string; canManageMembers: boolean }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.canManageMembers)).toBe(true);
    });

    it('includeArchived=true を repository へ正しく伝搬する', async () => {
      mockSpaceRepo.findAllGroupsAdmin.mockResolvedValue([]);

      await service.findAllAdmin(SpaceKind.GROUP, undefined, true);

      expect(mockSpaceRepo.findAllGroupsAdmin).toHaveBeenCalledWith(true);
    });

    it('kind=CHANNEL は projectId 必須（未指定は BadRequestException）', async () => {
      await expect(service.findAllAdmin(SpaceKind.CHANNEL)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockSpaceRepo.findAllGroupsAdmin).not.toHaveBeenCalled();
    });

    it('kind=CHANNEL + projectId で配下チャネル一覧を返す（set-0162 admin 経路）', async () => {
      const ch = makeSpaceRow({
        id: 'ch-1',
        projectId: 'proj-1',
        name: '雑談',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      mockSpaceRepo.findChannelsByProject.mockResolvedValue([ch as never]);

      const result = await service.findAllAdmin(SpaceKind.CHANNEL, 'proj-1', true);

      expect(mockSpaceRepo.findChannelsByProject).toHaveBeenCalledWith('proj-1', true);
      expect(mockSpaceRepo.findAllGroupsAdmin).not.toHaveBeenCalled();
      const rows = result.data as Array<{ id: string; name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('ch-1');
    });

    it('kind=PERSONAL_MEMO は BadRequestException（dsk-0319: GROUP のみ対応）', async () => {
      await expect(service.findAllAdmin(SpaceKind.PERSONAL_MEMO)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockSpaceRepo.findAllGroupsAdmin).not.toHaveBeenCalled();
    });

    it('kind 未指定も BadRequestException（明示必須）', async () => {
      await expect(service.findAllAdmin(undefined)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockSpaceRepo.findAllGroupsAdmin).not.toHaveBeenCalled();
    });

    it('空配列のとき canManageMembers=true 設定なしで空を返す（mapper が個別適用）', async () => {
      mockSpaceRepo.findAllGroupsAdmin.mockResolvedValue([]);
      const result = await service.findAllAdmin(SpaceKind.GROUP);
      expect(result.data).toEqual([]);
    });
  });

  describe('admin CRUD（set-0162・system ADMIN 専用経路）', () => {
    describe('createAdmin', () => {
      it('kind=CHANNEL で projectId+name が揃っていれば作成し ok を返す（membership 非依存）', async () => {
        mockProjRepo.findById.mockResolvedValue(makeProjectRow());
        mockSpaceRepo.createChannel.mockResolvedValue(makeSpaceRow());

        const result = await service.createAdmin({
          kind: SpaceKind.CHANNEL,
          projectId: PROJECT_ID,
          name: 'general',
        });

        expect(mockSpaceRepo.createChannel).toHaveBeenCalledWith(PROJECT_ID, 'general');
        expect(mockMembershipRepo.findEffectiveMembership).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
      });

      it('kind=CHANNEL 以外は BadRequestException（GROUP は通常経路で足りる）', async () => {
        await expect(
          service.createAdmin({ kind: SpaceKind.GROUP, name: 'g' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mockSpaceRepo.createChannel).not.toHaveBeenCalled();
      });

      it('projectId 未指定は BadRequestException', async () => {
        await expect(
          service.createAdmin({ kind: SpaceKind.CHANNEL, name: 'ch' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('プロジェクト不在は NotFoundException', async () => {
        mockProjRepo.findById.mockResolvedValue(null);
        await expect(
          service.createAdmin({ kind: SpaceKind.CHANNEL, projectId: PROJECT_ID, name: 'ch' }),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('adminUpdate', () => {
      it('CHANNEL を改名できる（membership チェックなし）', async () => {
        mockSpaceRepo.findById.mockResolvedValue(makeSpaceRow());
        mockSpaceRepo.update.mockResolvedValue(makeSpaceRow({ name: '改名' }));

        const result = await service.adminUpdate(SPACE_ID, { name: '改名' });

        expect(mockMembershipRepo.findEffectiveMembership).not.toHaveBeenCalled();
        expect(mockSpaceRepo.update).toHaveBeenCalledWith(SPACE_ID, { name: '改名' });
        expect(result.success).toBe(true);
      });

      it('PERSONAL_MEMO は BadRequestException', async () => {
        mockSpaceRepo.findById.mockResolvedValue(
          makeSpaceRow({ kind: 'PERSONAL_MEMO', projectId: null, ownerId: USER_ID }),
        );
        await expect(service.adminUpdate(SPACE_ID, { name: 'x' })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('不在は NotFoundException', async () => {
        mockSpaceRepo.findById.mockResolvedValue(null);
        await expect(service.adminUpdate(SPACE_ID, { name: 'x' })).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    });

    describe('adminDelete', () => {
      it('紐づきなしなら削除し ok を返す', async () => {
        mockSpaceRepo.findById.mockResolvedValue(makeSpaceRow());
        mockSpaceRepo.deleteChannelIfNoChildren.mockResolvedValue(true);

        const result = await service.adminDelete(SPACE_ID);

        expect(mockSpaceRepo.deleteChannelIfNoChildren).toHaveBeenCalledWith(SPACE_ID);
        expect(result.success).toBe(true);
      });

      it('紐づきあり（false）は ConflictException（アーカイブを促す）', async () => {
        mockSpaceRepo.findById.mockResolvedValue(makeSpaceRow());
        mockSpaceRepo.deleteChannelIfNoChildren.mockResolvedValue(false);

        await expect(service.adminDelete(SPACE_ID)).rejects.toBeInstanceOf(ConflictException);
      });

      it('kind=GROUP は BadRequestException（本画面の対象外）', async () => {
        mockSpaceRepo.findById.mockResolvedValue(makeSpaceRow({ kind: 'GROUP', projectId: null }));
        await expect(service.adminDelete(SPACE_ID)).rejects.toBeInstanceOf(BadRequestException);
        expect(mockSpaceRepo.deleteChannelIfNoChildren).not.toHaveBeenCalled();
      });

      it('不在は NotFoundException', async () => {
        mockSpaceRepo.findById.mockResolvedValue(null);
        await expect(service.adminDelete(SPACE_ID)).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });
});
