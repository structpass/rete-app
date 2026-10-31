import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MembershipScopeType, Role } from '@rete/shared';
import type { AuthenticatedUser } from '../auth/auth.service';
import { UserGroupsService } from './user-groups.service';
import { UserGroupsController } from './user-groups.controller';
import { UpdateUserGroupDto } from './dto/user-groups.dto';
import { UserGroupsRepository } from './repositories/user-groups.repository';
import { AuditRecorderService } from '../audit-logs/audit-recorder.service';

const REQUESTER: AuthenticatedUser = {
  id: 'req-1',
  name: '管理者',
  email: 'admin@example.com',
  role: Role.ADMIN,
};

const mockRepo = {
  findAll: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  deleteWithDependents: jest.fn(),
  findMembers: jest.fn(),
  addMember: jest.fn(),
  removeMemberGuarded: jest.fn(),
  findGrants: jest.fn(),
  upsertGrant: jest.fn(),
  removeGrantGuarded: jest.fn(),
  findAccountSummary: jest.fn(),
  findScopeForGrant: jest.fn(),
};

const mockAudit = {
  record: jest.fn(),
};

describe('UserGroupsService', () => {
  let service: UserGroupsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserGroupsService,
        { provide: UserGroupsRepository, useValue: mockRepo },
        { provide: AuditRecorderService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<UserGroupsService>(UserGroupsService);
    jest.resetAllMocks();
    // 既定: グループ実在（メンバー / grant 系は ensureGroupExists を通る）
    mockRepo.findById.mockResolvedValue(row());
  });

  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'grp-1',
    name: '営業グループ',
    sortOrder: 0,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...over,
  });

  describe('create', () => {
    it('repo.create を呼び監査を記録して DTO を返す', async () => {
      mockRepo.create.mockResolvedValue(row());
      const result = await service.create({ name: '営業グループ' }, REQUESTER, {});
      expect(mockRepo.create).toHaveBeenCalledWith('営業グループ', {});
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'create', feature: '管理グループ' }),
      );
      expect(result.name).toBe('営業グループ');
    });

    it('Home の設定値を repo.create へ渡す（正本に無いキーは捨てる）', async () => {
      mockRepo.create.mockResolvedValue(row());
      await service.create(
        {
          name: '営業グループ',
          canEditHomeBoard: true,
          canManageHomeTags: false,
          ...({ グループ名: '細工' } as Record<string, unknown>),
        },
        REQUESTER,
        {},
      );

      expect(mockRepo.create).toHaveBeenCalledWith('営業グループ', {
        canEditHomeBoard: true,
        canManageHomeTags: false,
      });
    });
  });

  describe('update', () => {
    it('改名は repo.update を name だけで呼ぶ', async () => {
      mockRepo.update.mockResolvedValue(row({ name: '新名称' }));
      mockRepo.findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ name: '新名称' }));

      const result = await service.update('grp-1', { name: '新名称' }, REQUESTER, {});

      expect(mockRepo.update).toHaveBeenCalledWith('grp-1', { name: '新名称' });
      expect(result.name).toBe('新名称');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'update',
          summary: '管理グループを更新（新名称）',
          details: { groupId: 'grp-1', name: '新名称', before: {}, after: {} },
        }),
      );
    });

    it('存在しない ID は NotFoundException（repo.update を呼ばない）', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(
        service.update('grp-x', { name: '新名称' }, REQUESTER, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('Home の設定値は現れた分だけ書き、監査に前後の設定値を残す', async () => {
      mockRepo.update.mockResolvedValue(row());
      mockRepo.findById
        .mockResolvedValueOnce(row({ canEditHomeBoard: false, canEditHomeFaq: false }))
        .mockResolvedValueOnce(row({ canEditHomeBoard: true, canEditHomeFaq: false }));

      await service.update('grp-1', { canEditHomeBoard: true }, REQUESTER, {});

      // 入力に現れていない設定値（canEditHomeFaq）は送らない（DB の今の値が残る）。
      expect(mockRepo.update).toHaveBeenCalledWith('grp-1', { canEditHomeBoard: true });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'update',
          details: {
            groupId: 'grp-1',
            name: '営業グループ',
            before: { canEditHomeBoard: false, canEditHomeFaq: false },
            after: { canEditHomeBoard: true, canEditHomeFaq: false },
          },
        }),
      );
    });

    it('正本に無いキーは保存へ回さない', async () => {
      mockRepo.update.mockResolvedValue(row());
      mockRepo.findById.mockResolvedValueOnce(row()).mockResolvedValueOnce(row());

      await service.update(
        'grp-1',
        { グループ名: '細工' } as unknown as UpdateUserGroupDto,
        REQUESTER,
        {},
      );

      expect(mockRepo.update).toHaveBeenCalledWith('grp-1', {});
    });
  });

  describe('removeGroup（物理削除・set-0188）', () => {
    it('所属設定とメンバーの連鎖削除を repo に委ね、削除と件数を監査へ残す', async () => {
      mockRepo.findById.mockResolvedValue(row());
      mockRepo.deleteWithDependents.mockResolvedValue({
        deletedGrantCount: 2,
        deletedMemberCount: 3,
      });

      await service.removeGroup('grp-1', REQUESTER, {});

      expect(mockRepo.deleteWithDependents).toHaveBeenCalledWith('grp-1');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'delete',
          feature: '管理グループ',
          summary: expect.stringContaining('メンバー 3 件'),
          details: expect.objectContaining({
            groupId: 'grp-1',
            name: '営業グループ',
            deletedMemberCount: 3,
            deletedGrantCount: 2,
          }),
        }),
      );
    });

    it('repository が blocked を返したら ConflictException とし監査を記録しない', async () => {
      mockRepo.findById.mockResolvedValue(row());
      mockRepo.deleteWithDependents.mockResolvedValue({
        blocked: true,
        deletedGrantCount: 0,
        deletedMemberCount: 0,
      });

      await expect(service.removeGroup('grp-1', REQUESTER, {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('存在しない ID は NotFoundException（削除を実行しない）', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.removeGroup('grp-x', REQUESTER, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockRepo.deleteWithDependents).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });
  });

  describe('アーカイブ API の不在（撤去の固定）', () => {
    it('service にアーカイブ/復元のメソッドが無い', () => {
      const methods = Object.getOwnPropertyNames(UserGroupsService.prototype);
      expect(methods.filter((name) => /archive|restore/i.test(name))).toEqual([]);
    });

    it('controller にアーカイブ/復元が無く、DELETE :id の removeGroup を持つ', () => {
      const methods = Object.getOwnPropertyNames(UserGroupsController.prototype);
      expect(methods.filter((name) => /archive|restore/i.test(name))).toEqual([]);
      expect(methods).toContain('removeGroup');
    });

    it('更新 DTO に archived フィールドが無い', () => {
      expect(new UpdateUserGroupDto()).not.toHaveProperty('archived');
    });
  });

  describe('addMember', () => {
    it('アカウント実在 cross-check 後に追加し監査を記録する', async () => {
      mockRepo.findAccountSummary.mockResolvedValue({ id: 'acc-1', name: '太郎' });
      mockRepo.addMember.mockResolvedValue({ created: true });
      const result = await service.addMember('grp-1', { accountId: 'acc-1' }, REQUESTER, {});
      expect(mockRepo.addMember).toHaveBeenCalledWith('grp-1', 'acc-1');
      expect(result).toEqual({ created: true });
    });

    it('アカウントが存在しなければ NotFoundException', async () => {
      mockRepo.findAccountSummary.mockResolvedValue(null);
      await expect(
        service.addMember('grp-1', { accountId: 'acc-x' }, REQUESTER, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('removeMember', () => {
    it('通常削除は repo.removeMemberGuarded を呼び監査を記録する', async () => {
      mockRepo.removeMemberGuarded.mockResolvedValue({ blocked: false, deleted: true });
      const result = await service.removeMember('grp-1', 'acc-1', REQUESTER, {});
      expect(mockRepo.removeMemberGuarded).toHaveBeenCalledWith('grp-1', 'acc-1');
      expect(result).toEqual({ deleted: true });
    });

    it('全消失ガード blocked なら ConflictException', async () => {
      mockRepo.removeMemberGuarded.mockResolvedValue({ blocked: true, deleted: false });
      await expect(service.removeMember('grp-1', 'acc-1', REQUESTER, {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('メンバー不在なら NotFoundException', async () => {
      mockRepo.removeMemberGuarded.mockResolvedValue({ blocked: false, deleted: false });
      await expect(service.removeMember('grp-1', 'acc-x', REQUESTER, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('addGrant', () => {
    it('ORGANIZATION grant 付与は実在 cross-check 後に upsert し監査を記録する', async () => {
      mockRepo.findScopeForGrant.mockResolvedValue({ archivedAt: null });
      mockRepo.upsertGrant.mockResolvedValue({ created: true });
      const result = await service.addGrant(
        'grp-1',
        { scopeType: MembershipScopeType.ORGANIZATION, scopeId: 'org-1', role: 'ADMIN' },
        REQUESTER,
        {},
      );
      expect(mockRepo.upsertGrant).toHaveBeenCalledWith('grp-1', 'ORGANIZATION', 'org-1', 'ADMIN');
      expect(result).toEqual({ created: true });
    });

    it('GROUP scopeType は BadRequestException（チャットグループは grant 対象外）', async () => {
      await expect(
        service.addGrant(
          'grp-1',
          { scopeType: MembershipScopeType.GROUP, scopeId: 'sp-1', role: 'MEMBER' },
          REQUESTER,
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CHANNEL grant は CHANNEL Space 実在確認後に upsert する', async () => {
      mockRepo.findScopeForGrant.mockResolvedValue({
        kind: 'CHANNEL',
        archivedAt: null,
      });
      mockRepo.upsertGrant.mockResolvedValue({ created: true, blocked: false });

      await expect(
        service.addGrant(
          'grp-1',
          {
            scopeType: MembershipScopeType.CHANNEL,
            scopeId: 'channel-1',
            role: 'MEMBER',
          },
          REQUESTER,
          {},
        ),
      ).resolves.toEqual({ created: true });
      expect(mockRepo.upsertGrant).toHaveBeenCalledWith(
        'grp-1',
        MembershipScopeType.CHANNEL,
        'channel-1',
        'MEMBER',
      );
    });

    it('CHANNEL scopeId が GROUP Space を指すと BadRequestException', async () => {
      mockRepo.findScopeForGrant.mockResolvedValue({
        kind: 'GROUP',
        archivedAt: null,
      });

      await expect(
        service.addGrant(
          'grp-1',
          {
            scopeType: MembershipScopeType.CHANNEL,
            scopeId: 'group-1',
            role: 'MEMBER',
          },
          REQUESTER,
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('アーカイブ済み組織への grant は BadRequestException', async () => {
      mockRepo.findScopeForGrant.mockResolvedValue({ archivedAt: new Date() });
      await expect(
        service.addGrant(
          'grp-1',
          { scopeType: MembershipScopeType.ORGANIZATION, scopeId: 'org-1', role: 'MEMBER' },
          REQUESTER,
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // §2 で Repository へ寄せた後も、scope 種別ごとの文言が保たれることを固定する
    // （projects / organizations / spaces の各 service と同じ語＝UX 契約）。
    it.each([
      [MembershipScopeType.ORGANIZATION, '組織'],
      [MembershipScopeType.PROJECT, 'プロジェクト'],
      [MembershipScopeType.CHANNEL, 'チャネル'],
    ])('scope 不在時の文言は %s で「%sが見つかりません」', async (scopeType, label) => {
      mockRepo.findScopeForGrant.mockResolvedValue(null);
      await expect(
        service.addGrant('grp-1', { scopeType, scopeId: 'x-1', role: 'MEMBER' }, REQUESTER, {}),
      ).rejects.toThrow(`${label}が見つかりません`);
    });

    it('アーカイブ済みスコープの文言は種別名と次の一手（復元）を含む', async () => {
      mockRepo.findScopeForGrant.mockResolvedValue({ archivedAt: new Date() });
      await expect(
        service.addGrant(
          'grp-1',
          { scopeType: MembershipScopeType.PROJECT, scopeId: 'pj-1', role: 'MEMBER' },
          REQUESTER,
          {},
        ),
      ).rejects.toMatchObject({
        message: 'アーカイブ済みのプロジェクトへ grant を付与できません（先に復元してください）',
      });
    });

    it('grant 付与前に Repository の scope 照会を通る（Service は Prisma を直読みしない）', async () => {
      mockRepo.findScopeForGrant.mockResolvedValue({ archivedAt: null });
      mockRepo.upsertGrant.mockResolvedValue({ created: true });
      await service.addGrant(
        'grp-1',
        { scopeType: MembershipScopeType.ORGANIZATION, scopeId: 'org-1', role: 'ADMIN' },
        REQUESTER,
        {},
      );
      expect(mockRepo.findScopeForGrant).toHaveBeenCalledWith('ORGANIZATION', 'org-1');
    });

    it('ADMIN→MEMBER 降格が全消失ガードで blocked なら ConflictException（監査は記録しない）', async () => {
      mockRepo.findScopeForGrant.mockResolvedValue({ archivedAt: null });
      mockRepo.upsertGrant.mockResolvedValue({ created: false, blocked: true });
      await expect(
        service.addGrant(
          'grp-1',
          { scopeType: MembershipScopeType.ORGANIZATION, scopeId: 'org-1', role: 'MEMBER' },
          REQUESTER,
          {},
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.record).not.toHaveBeenCalled();
    });
  });

  describe('removeGrant', () => {
    it('通常剥奪は repo.removeGrantGuarded を呼び監査を記録する', async () => {
      mockRepo.removeGrantGuarded.mockResolvedValue({
        blocked: false,
        deleted: true,
        role: 'MEMBER',
      });
      const result = await service.removeGrant(
        'grp-1',
        MembershipScopeType.ORGANIZATION,
        'org-1',
        REQUESTER,
        {},
      );
      expect(mockRepo.removeGrantGuarded).toHaveBeenCalledWith('grp-1', 'ORGANIZATION', 'org-1');
      expect(result).toEqual({ deleted: true });
    });

    it('全消失ガード blocked なら ConflictException', async () => {
      mockRepo.removeGrantGuarded.mockResolvedValue({ blocked: true, deleted: false });
      await expect(
        service.removeGrant('grp-1', MembershipScopeType.ORGANIZATION, 'org-1', REQUESTER, {}),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  /**
   * v2-231: ガードで拒否した時の文言は「理由」だけでなく「回収手順」を操作者へ示す。
   * 唯一の ADMIN 源になっているグループから抜ける画面到達可能な手段は「先に別の管理グループへ
   * メンバーを追加し、同じスコープの管理者を付ける」だけ（grant だけでは実効 ADMIN 源にならない）。
   * 要求版2の修正依頼（表示メッセージをシンプルに）で、内部の呼び名（実効 ADMIN 全消失ガード）・
   * 操作名の繰り返し（「…から削除してください」）・アーカイブの注記は 409 から外した。アーカイブ済みの
   * スコープでは注記の代わりに、次の操作である付与の 400「アーカイブ済みの◯◯へ grant を付与できません
   * （先に復元してください）」が次の一手を示す（独立レビューの指摘で 400 側にも復元の一文を足した）。
   * 文言は設定画面のトーストへ apiErrorMessage 経由でそのまま出る＝操作者が読む唯一の案内なので、
   * 手順が消えていないかをここで固定する（toThrow(文字列) は部分一致なので完全一致で見る）。
   */
  /**
   * v2-232: grant の監査行は「どの管理グループが・どのスコープに・どの role を」まで
   * 一覧から読めることを固定する。操作ログ一覧は feature と summary をそのまま描画するため、
   * summary が画面に出る文言そのもの、details は構造化の控えになる。
   */
  describe('grant 監査行の表示（v2-232）', () => {
    it('付与はグループ名・スコープ名・role を summary と details へ残す', async () => {
      mockRepo.findScopeForGrant.mockResolvedValue({ name: '営業本部', archivedAt: null });
      mockRepo.upsertGrant.mockResolvedValue({ created: true, blocked: false });

      await service.addGrant(
        'grp-1',
        { scopeType: MembershipScopeType.ORGANIZATION, scopeId: 'org-1', role: 'ADMIN' },
        REQUESTER,
        {},
      );

      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'create',
          feature: '管理グループ',
          summary:
            'グループ grant を付与（管理グループ「営業グループ」→ 組織「営業本部」を 管理者）',
          details: {
            groupId: 'grp-1',
            groupName: '営業グループ',
            scopeType: MembershipScopeType.ORGANIZATION,
            scopeId: 'org-1',
            scopeName: '営業本部',
            role: 'ADMIN',
          },
        }),
      );
    });

    it('剥奪は削除した grant の role まで summary と details へ残す', async () => {
      mockRepo.removeGrantGuarded.mockResolvedValue({
        blocked: false,
        deleted: true,
        role: 'ADMIN',
      });
      mockRepo.findScopeForGrant.mockResolvedValue({ name: '営業本部', archivedAt: null });

      await service.removeGrant('grp-1', MembershipScopeType.ORGANIZATION, 'org-1', REQUESTER, {});

      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'delete',
          summary:
            'グループ grant を剥奪（管理グループ「営業グループ」→ 組織「営業本部」を 管理者）',
          details: expect.objectContaining({
            groupName: '営業グループ',
            scopeName: '営業本部',
            role: 'ADMIN',
          }),
        }),
      );
    });

    it('スコープが消えていても剥奪行は ID で残す（名前が引けた時だけ名前を使う）', async () => {
      mockRepo.removeGrantGuarded.mockResolvedValue({
        blocked: false,
        deleted: true,
        role: 'MEMBER',
      });
      mockRepo.findScopeForGrant.mockResolvedValue(null);

      await service.removeGrant('grp-1', MembershipScopeType.ORGANIZATION, 'org-1', REQUESTER, {});

      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: 'グループ grant を剥奪（管理グループ「営業グループ」→ 組織「org-1」を 一般）',
        }),
      );
    });
  });

  describe('実効 ADMIN 全消失ガードの 409 文言（v2-231）', () => {
    const expectExactMessage = async (promise: Promise<unknown>, message: string) => {
      await expect(promise).rejects.toMatchObject({ message });
    };

    it('グループ削除は回収手順つきで拒否する', async () => {
      mockRepo.deleteWithDependents.mockResolvedValue({
        blocked: true,
        deletedGrantCount: 0,
        deletedMemberCount: 0,
      });
      await expectExactMessage(
        service.removeGroup('grp-1', REQUESTER, {}),
        '管理者がいなくなるため、このグループを削除できません。先に別の管理グループへメンバーを追加し、同じスコープの管理者を付けてください',
      );
    });

    it('メンバー削除は回収手順つきで拒否する', async () => {
      mockRepo.removeMemberGuarded.mockResolvedValue({ blocked: true, deleted: false });
      await expectExactMessage(
        service.removeMember('grp-1', 'acc-1', REQUESTER, {}),
        '管理者がいなくなるため、このメンバーを削除できません。先に別の管理グループへメンバーを追加し、同じスコープの管理者を付けてください',
      );
    });

    it('grant 降格は回収手順つきで拒否する', async () => {
      mockRepo.findScopeForGrant.mockResolvedValue({ archivedAt: null });
      mockRepo.upsertGrant.mockResolvedValue({ created: false, blocked: true });
      await expectExactMessage(
        service.addGrant(
          'grp-1',
          { scopeType: MembershipScopeType.ORGANIZATION, scopeId: 'org-1', role: 'MEMBER' },
          REQUESTER,
          {},
        ),
        '管理者がいなくなるため、この grant を降格できません。先に別の管理グループへメンバーを追加し、同じスコープの管理者を付けてください',
      );
    });

    it('grant 剥奪は回収手順つきで拒否する', async () => {
      mockRepo.removeGrantGuarded.mockResolvedValue({ blocked: true, deleted: false });
      await expectExactMessage(
        service.removeGrant('grp-1', MembershipScopeType.ORGANIZATION, 'org-1', REQUESTER, {}),
        '管理者がいなくなるため、この grant を剥奪できません。先に別の管理グループへメンバーを追加し、同じスコープの管理者を付けてください',
      );
    });
  });
});
