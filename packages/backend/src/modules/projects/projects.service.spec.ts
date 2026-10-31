import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsRepository } from './repositories/projects.repository';
import { OrganizationsRepository } from '../organizations/repositories/organizations.repository';
import { MembershipsRepository } from '../memberships/repositories/memberships.repository';
import { makeOrganizationRow, makeProjectRow } from '../../__tests__/factories';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const PROJECT_ID = 'proj-1';

const mockProjRepo = {
  createWithMemberships: jest.fn(),
  findVisibleForUser: jest.fn(),
  findById: jest.fn(),
  update: jest.fn(),
  findAllAdmin: jest.fn(),
  adminUpdateWithCascade: jest.fn(),
  // set-0162: 物理削除（配下チャネル検査 + membership 掃除 + 削除を同一 tx）。
  deleteIfNoChannels: jest.fn(),
};

const mockOrgRepo = {
  findVisibleForUser: jest.fn(),
  findById: jest.fn(),
};

const mockMembershipRepo = {
  findMembership: jest.fn(),
  findEffectiveMembership: jest.fn(),
  findAdminScopeIds: jest.fn(),
  findEffectiveAdminScopeIds: jest.fn(),
};

describe('ProjectsService', () => {
  let service: ProjectsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: ProjectsRepository, useValue: mockProjRepo },
        { provide: OrganizationsRepository, useValue: mockOrgRepo },
        { provide: MembershipsRepository, useValue: mockMembershipRepo },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  describe('create', () => {
    it('組織が不在なら NotFoundException（権限チェック前）', async () => {
      mockOrgRepo.findById.mockResolvedValue(null);

      await expect(
        service.create({ organizationId: ORG_ID, name: 'PJ' }, USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockProjRepo.createWithMemberships).not.toHaveBeenCalled();
    });

    it('組織の ADMIN membership がない場合は ForbiddenException', async () => {
      mockOrgRepo.findById.mockResolvedValue(makeOrganizationRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue(null);

      await expect(
        service.create({ organizationId: ORG_ID, name: 'PJ' }, USER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockProjRepo.createWithMemberships).not.toHaveBeenCalled();
    });

    it('adminAccountIds 未指定時は作成者のみ ADMIN', async () => {
      mockOrgRepo.findById.mockResolvedValue(makeOrganizationRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockProjRepo.createWithMemberships.mockResolvedValue(makeProjectRow());

      await service.create({ organizationId: ORG_ID, name: 'PJ' }, USER_ID);

      expect(mockProjRepo.createWithMemberships).toHaveBeenCalledWith(
        { organizationId: ORG_ID, name: 'PJ' },
        [USER_ID],
      );
    });

    it('adminAccountIds 指定時は作成者 + 指定 ID（dedup）が ADMIN になる', async () => {
      mockOrgRepo.findById.mockResolvedValue(makeOrganizationRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockProjRepo.createWithMemberships.mockResolvedValue(makeProjectRow());

      await service.create(
        { organizationId: ORG_ID, name: 'PJ', adminAccountIds: [USER_ID, 'user-2'] },
        USER_ID,
      );

      const adminIds = mockProjRepo.createWithMemberships.mock.calls[0][1] as string[];
      // USER_ID は重複するので dedup されるべき
      expect(adminIds).toContain(USER_ID);
      expect(adminIds).toContain('user-2');
      // 重複なし
      expect(new Set(adminIds).size).toBe(adminIds.length);
    });

    it('正常: ProjectDto を返す', async () => {
      mockOrgRepo.findById.mockResolvedValue(makeOrganizationRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockProjRepo.createWithMemberships.mockResolvedValue(makeProjectRow({ name: 'PJ' }));

      const result = await service.create({ organizationId: ORG_ID, name: 'PJ' }, USER_ID);

      expect(result.success).toBe(true);
      expect(result.data.name).toBe('PJ');
      expect(result.data.organizationId).toBe(ORG_ID);
      expect(result.data.archived).toBe(false);
      // 作成者は ADMIN ＝ チャネル管理可
      expect(result.data.canManageChannels).toBe(true);
    });
  });

  describe('findAll', () => {
    it('自分が可視な組織配下のプロジェクト一覧を返す', async () => {
      mockOrgRepo.findVisibleForUser.mockResolvedValue([makeOrganizationRow()]);
      mockProjRepo.findVisibleForUser.mockResolvedValue([makeProjectRow()]);
      mockMembershipRepo.findEffectiveAdminScopeIds.mockResolvedValue([]);

      const result = await service.findAll(USER_ID);

      expect(mockOrgRepo.findVisibleForUser).toHaveBeenCalledWith(USER_ID);
      expect(mockProjRepo.findVisibleForUser).toHaveBeenCalledWith([ORG_ID], undefined, USER_ID);
      expect(result.data).toHaveLength(1);
    });

    it('organizationId 指定時はそのスコープで絞る', async () => {
      mockOrgRepo.findVisibleForUser.mockResolvedValue([makeOrganizationRow()]);
      mockProjRepo.findVisibleForUser.mockResolvedValue([]);
      mockMembershipRepo.findEffectiveAdminScopeIds.mockResolvedValue([]);

      await service.findAll(USER_ID, ORG_ID);

      expect(mockProjRepo.findVisibleForUser).toHaveBeenCalledWith([ORG_ID], ORG_ID, USER_ID);
    });

    it('PROJECT ADMIN を持つプロジェクトだけ canManageChannels=true になる', async () => {
      mockOrgRepo.findVisibleForUser.mockResolvedValue([makeOrganizationRow()]);
      mockProjRepo.findVisibleForUser.mockResolvedValue([
        makeProjectRow({ id: 'proj-admin' }),
        makeProjectRow({ id: 'proj-member' }),
      ]);
      // proj-admin のみ ADMIN scope を保有
      mockMembershipRepo.findEffectiveAdminScopeIds.mockResolvedValue([{ scopeId: 'proj-admin' }]);

      const result = await service.findAll(USER_ID);

      expect(mockMembershipRepo.findEffectiveAdminScopeIds).toHaveBeenCalledWith(
        USER_ID,
        'PROJECT',
      );
      const admin = result.data.find((p) => p.id === 'proj-admin');
      const member = result.data.find((p) => p.id === 'proj-member');
      expect(admin?.canManageChannels).toBe(true);
      expect(member?.canManageChannels).toBe(false);
    });
  });

  describe('update', () => {
    it('プロジェクト不在なら NotFoundException', async () => {
      mockProjRepo.findById.mockResolvedValue(null);

      await expect(service.update(PROJECT_ID, { name: '新名称' }, USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('PROJECT ADMIN membership がない場合は ForbiddenException（write しない）', async () => {
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue(null);

      await expect(service.update(PROJECT_ID, { name: '新名称' }, USER_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockProjRepo.update).not.toHaveBeenCalled();
      expect(mockProjRepo.adminUpdateWithCascade).not.toHaveBeenCalled();
    });

    it('name のみ: 単純 update を使い、配下 CHANNEL の連鎖更新を呼ばない', async () => {
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockProjRepo.update.mockResolvedValue(makeProjectRow({ name: '新名称' }));

      const result = await service.update(PROJECT_ID, { name: '新名称' }, USER_ID);

      expect(mockProjRepo.update).toHaveBeenCalledWith(PROJECT_ID, { name: '新名称' });
      expect(mockProjRepo.adminUpdateWithCascade).not.toHaveBeenCalled();
      expect(result.data.name).toBe('新名称');
      // update に到達＝ADMIN ＝ チャネル管理可
      expect(result.data.canManageChannels).toBe(true);
    });

    it('archived=true: 連鎖 archive をトリガーする（単純 update は使わない）', async () => {
      const FIXED_DATE = new Date('2026-06-14T00:00:00.000Z');
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockProjRepo.adminUpdateWithCascade.mockResolvedValue(
        makeProjectRow({ archivedAt: FIXED_DATE }),
      );

      const result = await service.update(PROJECT_ID, { archived: true }, USER_ID);

      const [, data, archived] = mockProjRepo.adminUpdateWithCascade.mock.calls[0];
      expect(data.archivedAt).toBeInstanceOf(Date);
      expect(archived).toBe(true);
      expect(mockProjRepo.update).not.toHaveBeenCalled();
      expect(result.data.archived).toBe(true);
    });

    it('archived=false: 連鎖復元をトリガーする（単純 update は使わない）', async () => {
      const FIXED_DATE = new Date('2026-06-14T00:00:00.000Z');
      mockProjRepo.findById.mockResolvedValue(makeProjectRow({ archivedAt: FIXED_DATE }));
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockProjRepo.adminUpdateWithCascade.mockResolvedValue(makeProjectRow());

      await service.update(PROJECT_ID, { archived: false }, USER_ID);

      const [, data, archived] = mockProjRepo.adminUpdateWithCascade.mock.calls[0];
      expect(data.archivedAt).toBeNull();
      expect(archived).toBe(false);
      expect(mockProjRepo.update).not.toHaveBeenCalled();
    });

    it('archived 指定は管理経路（adminUpdate）と同じ repository 呼び出しへ収束する', async () => {
      const FIXED_DATE = new Date('2026-06-14T00:00:00.000Z');
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockMembershipRepo.findEffectiveMembership.mockResolvedValue({ role: 'ADMIN' });
      mockProjRepo.adminUpdateWithCascade.mockResolvedValue(
        makeProjectRow({ archivedAt: FIXED_DATE }),
      );

      await service.update(PROJECT_ID, { archived: true }, USER_ID);
      const ordinary = mockProjRepo.adminUpdateWithCascade.mock.calls[0];
      await service.adminUpdate(PROJECT_ID, { archived: true });
      const admin = mockProjRepo.adminUpdateWithCascade.mock.calls[1];

      expect(ordinary[0]).toBe(admin[0]);
      // どちらも同じ形の更新値（archivedAt の Date）を作る。時刻そのものは呼び出し時点で決まる。
      expect(Object.keys(ordinary[1])).toEqual(Object.keys(admin[1]));
      expect(ordinary[1].archivedAt).toBeInstanceOf(Date);
      expect(admin[1].archivedAt).toBeInstanceOf(Date);
      expect(ordinary[2]).toBe(admin[2]);
    });
  });

  // ============================================================
  // findAllAdmin（set-0027 テナント管理 ADMIN 向け一覧）
  // ============================================================
  describe('findAllAdmin', () => {
    it('membership 非依存で repo.findAllAdmin を呼び ProjectDto 配列を返す（canManageChannels=true 固定）', async () => {
      mockProjRepo.findAllAdmin.mockResolvedValue([makeProjectRow()]);

      const result = await service.findAllAdmin();

      expect(mockProjRepo.findAllAdmin).toHaveBeenCalledWith(undefined, undefined);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].canManageChannels).toBe(true);
    });

    it('organizationId で絞り込む場合は引数を repo へ伝達する', async () => {
      mockProjRepo.findAllAdmin.mockResolvedValue([]);

      await service.findAllAdmin(ORG_ID, false);

      expect(mockProjRepo.findAllAdmin).toHaveBeenCalledWith(false, ORG_ID);
    });

    it('includeArchived=true を repo へ伝達する', async () => {
      mockProjRepo.findAllAdmin.mockResolvedValue([]);

      await service.findAllAdmin(undefined, true);

      expect(mockProjRepo.findAllAdmin).toHaveBeenCalledWith(true, undefined);
    });
  });

  // ============================================================
  // adminUpdate（set-0027 cascade archive/restore）
  // ============================================================
  describe('adminUpdate', () => {
    it('プロジェクトが不在なら NotFoundException', async () => {
      mockProjRepo.findById.mockResolvedValue(null);

      await expect(service.adminUpdate(PROJECT_ID, { name: '新名称' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockProjRepo.adminUpdateWithCascade).not.toHaveBeenCalled();
    });

    it('membership チェックなし（system ADMIN gate はコントローラ層）: 存在なら更新し ProjectDto を返す', async () => {
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      const updatedRow = makeProjectRow({ name: '新名称' });
      mockProjRepo.adminUpdateWithCascade.mockResolvedValue(updatedRow);

      const result = await service.adminUpdate(PROJECT_ID, { name: '新名称' });

      expect(mockMembershipRepo.findEffectiveMembership).not.toHaveBeenCalled();
      expect(mockProjRepo.adminUpdateWithCascade).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({ name: '新名称' }),
        undefined,
      );
      expect(result.data.name).toBe('新名称');
      expect(result.data.canManageChannels).toBe(true);
    });

    it('archived=true は adminUpdateWithCascade に archived=true を渡して連鎖 archive をトリガーする', async () => {
      const FIXED_DATE = new Date('2026-06-14T00:00:00.000Z');
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockProjRepo.adminUpdateWithCascade.mockResolvedValue(
        makeProjectRow({ archivedAt: FIXED_DATE }),
      );

      const result = await service.adminUpdate(PROJECT_ID, { archived: true });

      const [, data, archived] = mockProjRepo.adminUpdateWithCascade.mock.calls[0];
      expect(data.archivedAt).toBeInstanceOf(Date);
      expect(archived).toBe(true);
      expect(result.data.archived).toBe(true);
    });

    it('archived=false は adminUpdateWithCascade に archived=false を渡して連鎖復元をトリガーする', async () => {
      const FIXED_DATE = new Date('2026-06-14T00:00:00.000Z');
      mockProjRepo.findById.mockResolvedValue(makeProjectRow({ archivedAt: FIXED_DATE }));
      mockProjRepo.adminUpdateWithCascade.mockResolvedValue(makeProjectRow());

      await service.adminUpdate(PROJECT_ID, { archived: false });

      const [, data, archived] = mockProjRepo.adminUpdateWithCascade.mock.calls[0];
      expect(data.archivedAt).toBeNull();
      expect(archived).toBe(false);
    });
  });

  // ============================================================
  // createAdmin（set-0162・system ADMIN 専用経路）
  // ============================================================
  describe('createAdmin', () => {
    it('組織が不在なら NotFoundException（権限チェック前）', async () => {
      mockOrgRepo.findById.mockResolvedValue(null);

      await expect(
        service.createAdmin({ organizationId: ORG_ID, name: 'PJ' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockProjRepo.createWithMemberships).not.toHaveBeenCalled();
    });

    it('membership チェックなしで PJ を作成する（system ADMIN が非所属組織にも追加可）', async () => {
      mockOrgRepo.findById.mockResolvedValue(makeOrganizationRow());
      mockProjRepo.createWithMemberships.mockResolvedValue(makeProjectRow({ name: 'PJ' }));

      const result = await service.createAdmin({ organizationId: ORG_ID, name: 'PJ' });

      expect(mockMembershipRepo.findEffectiveMembership).not.toHaveBeenCalled();
      expect(mockProjRepo.createWithMemberships).toHaveBeenCalledWith(
        { organizationId: ORG_ID, name: 'PJ' },
        [],
      );
      expect(result.success).toBe(true);
      expect(result.data.canManageChannels).toBe(true);
    });

    it('adminAccountIds 指定時はそのまま渡す（作成者は membership 共創しない）', async () => {
      mockOrgRepo.findById.mockResolvedValue(makeOrganizationRow());
      mockProjRepo.createWithMemberships.mockResolvedValue(makeProjectRow());

      await service.createAdmin({ organizationId: ORG_ID, name: 'PJ', adminAccountIds: ['u2'] });

      expect(mockProjRepo.createWithMemberships).toHaveBeenCalledWith(
        { organizationId: ORG_ID, name: 'PJ' },
        ['u2'],
      );
    });
  });

  // ============================================================
  // adminDelete（set-0162・物理削除）
  // ============================================================
  describe('adminDelete', () => {
    it('プロジェクトが不在なら NotFoundException', async () => {
      mockProjRepo.findById.mockResolvedValue(null);

      await expect(service.adminDelete(PROJECT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockProjRepo.deleteIfNoChannels).not.toHaveBeenCalled();
    });

    it('配下チャネルが無ければ削除し ok を返す（membership 掃除は repo の同一 tx）', async () => {
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockProjRepo.deleteIfNoChannels.mockResolvedValue(true);

      const result = await service.adminDelete(PROJECT_ID);

      expect(mockProjRepo.deleteIfNoChannels).toHaveBeenCalledWith(PROJECT_ID);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: PROJECT_ID });
    });

    it('配下チャネルが在れば ConflictException（アーカイブを促す）', async () => {
      mockProjRepo.findById.mockResolvedValue(makeProjectRow());
      mockProjRepo.deleteIfNoChannels.mockResolvedValue(false);

      await expect(service.adminDelete(PROJECT_ID)).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
