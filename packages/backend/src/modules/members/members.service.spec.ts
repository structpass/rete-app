import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getUniqueConflictMessage } from '../../common/filters/unique-conflict-context';
import { Role } from '@rete/shared';
import { MembersService } from './members.service';
import { MembersRepository } from './repositories/members.repository';
import { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import { AUDIT_RETE_SYSTEM_NAME } from '../audit-logs/audit-logs.constants';
import { MfaService } from '../mfa/mfa.service';
import { makeMemberWithRelations } from '../../__tests__/factories';
import type { AuthenticatedUser } from '../auth/auth.service';

const mockRepo = {
  findAll: jest.fn(),
  findById: jest.fn(),
  findOtherAccountByEmail: jest.fn(),
  update: jest.fn(),
  clearLockout: jest.fn(),
  findAccountRole: jest.fn(),
  updateSystemRole: jest.fn(),
  demoteSystemRoleAtomic: jest.fn(),
};

const mockAudit = {
  record: jest.fn(),
};

const mockMfa = {
  adminResetMfa: jest.fn(),
};

const SELF_ID = 'self-account';
const OTHER_ID = 'other-account';

/** システム ADMIN の actor（昇格/降格 API はコントローラ @Roles で ADMIN 限定済み）。 */
const ACTOR: AuthenticatedUser = {
  id: SELF_ID,
  email: 'admin@rete.local',
  name: 'システム管理者',
  role: Role.ADMIN,
};

describe('MembersService', () => {
  let service: MembersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MembersService,
        { provide: MembersRepository, useValue: mockRepo },
        { provide: AuditRecorderService, useValue: mockAudit },
        { provide: MfaService, useValue: mockMfa },
      ],
    }).compile();

    service = module.get<MembersService>(MembersService);
  });

  describe('findAll', () => {
    it('全メンバーを MemberDto 配列で返す', async () => {
      mockRepo.findAll.mockResolvedValue([makeMemberWithRelations({ id: 'a1' }, ['SYS-001'])]);

      const result = await service.findAll();

      expect(result.success).toBe(true);
      expect(result.data[0].id).toBe('a1');
    });
  });

  describe('findOne', () => {
    it('対象不在なら NotFound', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('exportCsv', () => {
    it('メンバーの CSV 文字列（BOM 付き）を返す', async () => {
      mockRepo.findAll.mockResolvedValue([
        makeMemberWithRelations({ id: 'a1', name: '山田 太郎', email: 'taro@rete.local' }),
      ]);

      const csv = await service.exportCsv();

      expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM
      expect(csv).toContain('表示名,メールアドレス,状態,作成日時,最終更新日時');
      expect(csv).toContain('山田 太郎,taro@rete.local,有効');
    });

    it('service では記録しない（出力の記録は横断 interceptor が担う・二重記録の防止）', async () => {
      mockRepo.findAll.mockResolvedValue([
        makeMemberWithRelations({ id: 'a1', name: '山田 太郎', email: 'taro@rete.local' }),
      ]);

      await service.exportCsv();

      expect(mockAudit.record).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('全項目未指定なら BadRequest（存在確認もしない）', async () => {
      await expect(service.update(OTHER_ID, {}, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockRepo.findById).not.toHaveBeenCalled();
    });

    it('対象不在なら NotFound', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.update('missing', { isActive: false }, ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('自分自身をロック（isActive=false）しようとしたら BadRequest（自己ロックアウト防止）', async () => {
      mockRepo.findById.mockResolvedValue(makeMemberWithRelations({ id: SELF_ID }));
      await expect(service.update(SELF_ID, { isActive: false }, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('自分自身でもロック解除（isActive=true）は許可する', async () => {
      mockRepo.findById.mockResolvedValue(makeMemberWithRelations({ id: SELF_ID }));
      mockRepo.update.mockResolvedValue(makeMemberWithRelations({ id: SELF_ID }));
      await service.update(SELF_ID, { isActive: true }, ACTOR);
      expect(mockRepo.update).toHaveBeenCalledWith(SELF_ID, {
        isActive: true,
      });
    });

    it('姓・名を更新すると name を再組み立てて repo へ渡す（set-0096）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeMemberWithRelations({
          id: OTHER_ID,
          familyName: '田中',
          givenName: '太郎',
          name: '田中 太郎',
        }),
      );
      mockRepo.update.mockResolvedValue(
        makeMemberWithRelations({
          id: OTHER_ID,
          familyName: '山田',
          givenName: '太郎',
          name: '山田 太郎',
        }),
      );
      await service.update(OTHER_ID, { familyName: '山田', givenName: '太郎' }, ACTOR);
      expect(mockRepo.update).toHaveBeenCalledWith(OTHER_ID, {
        familyName: '山田',
        givenName: '太郎',
        name: '山田 太郎',
        isActive: undefined,
      });
    });

    it('姓が空なら BadRequest（set-0096）', async () => {
      mockRepo.findById.mockResolvedValue(makeMemberWithRelations({ id: OTHER_ID }));
      await expect(service.update(OTHER_ID, { familyName: '  ' }, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('他人のロックは許可する', async () => {
      mockRepo.findById.mockResolvedValue(makeMemberWithRelations({ id: OTHER_ID }));
      mockRepo.update.mockResolvedValue(makeMemberWithRelations({ id: OTHER_ID, isActive: false }));
      await service.update(OTHER_ID, { isActive: false }, ACTOR);
      expect(mockRepo.update).toHaveBeenCalledWith(OTHER_ID, {
        isActive: false,
      });
    });

    // set-0097: email 変更のテスト群
    describe('email 変更', () => {
      it('既存値と同じ email なら差分なし＝repo.update に email を渡さず監査も残さない', async () => {
        mockRepo.findById.mockResolvedValue(
          makeMemberWithRelations({ id: OTHER_ID, email: 'existing@rete.local' }),
        );
        mockRepo.update.mockResolvedValue(makeMemberWithRelations({ id: OTHER_ID }));
        await service.update(OTHER_ID, { email: 'existing@rete.local' }, ACTOR);
        expect(mockRepo.findOtherAccountByEmail).not.toHaveBeenCalled();
        expect(mockRepo.update).toHaveBeenCalledWith(OTHER_ID, {
          isActive: undefined,
        });
        expect(mockAudit.record).not.toHaveBeenCalled();
      });

      it('email を変更すると trim+小文字正規化して repo へ渡し、監査ログ（変更前/変更後・actor 込み）を残す', async () => {
        mockRepo.findById.mockResolvedValue(
          makeMemberWithRelations({ id: OTHER_ID, email: 'old@rete.local' }),
        );
        mockRepo.findOtherAccountByEmail.mockResolvedValue(null);
        mockRepo.update.mockResolvedValue(makeMemberWithRelations({ id: OTHER_ID }));
        await service.update(OTHER_ID, { email: '  NEW@RETE.LOCAL  ' }, ACTOR);
        expect(mockRepo.findOtherAccountByEmail).toHaveBeenCalledWith(OTHER_ID, 'new@rete.local');
        expect(mockRepo.update).toHaveBeenCalledWith(OTHER_ID, {
          isActive: undefined,
          email: 'new@rete.local',
        });
        expect(mockAudit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            actionType: 'admin',
            feature: 'members',
            // 記録側 SSOT の定数（'共通操作'）を使う。set-0079 の是正時に本 service だけ
            // ローカル定数 'rete' が取り残されていたので、値の追随をここで固定する（fil-0106）。
            systemName: AUDIT_RETE_SYSTEM_NAME,
            actorAccountId: ACTOR.id,
            actorName: ACTOR.name,
            actorEmail: ACTOR.email,
            summary: expect.stringMatching(/old@rete\.local.*new@rete\.local/),
            details: {
              targetId: OTHER_ID,
              before: 'old@rete.local',
              after: 'new@rete.local',
            },
          }),
        );
      });

      it('email が他 Account と重複するなら ConflictException（重複チェックが小文字正規化後で走る）', async () => {
        mockRepo.findById.mockResolvedValue(
          makeMemberWithRelations({ id: OTHER_ID, email: 'old@rete.local' }),
        );
        mockRepo.findOtherAccountByEmail.mockResolvedValue({ id: 'someone-else' });
        await expect(
          service.update(OTHER_ID, { email: 'TAKEN@RETE.LOCAL' }, ACTOR),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(mockRepo.update).not.toHaveBeenCalled();
        expect(mockAudit.record).not.toHaveBeenCalled();
      });

      it('email が空文字（trim 後）なら BadRequest', async () => {
        mockRepo.findById.mockResolvedValue(makeMemberWithRelations({ id: OTHER_ID }));
        await expect(service.update(OTHER_ID, { email: '   ' }, ACTOR)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(mockRepo.findOtherAccountByEmail).not.toHaveBeenCalled();
        expect(mockRepo.update).not.toHaveBeenCalled();
        expect(mockAudit.record).not.toHaveBeenCalled();
      });

      it('email が null（DTO ValidationPipe を bypass）でも BadRequest で 500 にしない', async () => {
        mockRepo.findById.mockResolvedValue(makeMemberWithRelations({ id: OTHER_ID }));
        await expect(
          service.update(OTHER_ID, { email: null as unknown as string }, ACTOR),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mockRepo.update).not.toHaveBeenCalled();
        expect(mockAudit.record).not.toHaveBeenCalled();
      });

      it('並行更新（TOCTOU）で他 Admin が同じ email を書いた直後の P2002 と専用の案内文を共通filterへ渡す', async () => {
        mockRepo.findById.mockResolvedValue(
          makeMemberWithRelations({ id: OTHER_ID, email: 'old@rete.local' }),
        );
        mockRepo.findOtherAccountByEmail.mockResolvedValue(null);
        // PrismaClientKnownRequestError P2002 を模倣
        const p2002 = new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`email`)',
          { code: 'P2002', clientVersion: 'test', meta: { target: ['email'] } },
        );
        mockRepo.update.mockRejectedValue(p2002);
        await expect(service.update(OTHER_ID, { email: 'taken@rete.local' }, ACTOR)).rejects.toBe(
          p2002,
        );
        expect(getUniqueConflictMessage(p2002)).toBe(
          'メールアドレス「taken@rete.local」は既に使用されています',
        );
        expect(mockAudit.record).not.toHaveBeenCalled();
      });

      it('email のみの変更でも他項目の BadRequest ガードに引っかからない（email 単独で PATCH 可能）', async () => {
        mockRepo.findById.mockResolvedValue(
          makeMemberWithRelations({ id: OTHER_ID, email: 'old@rete.local' }),
        );
        mockRepo.findOtherAccountByEmail.mockResolvedValue(null);
        mockRepo.update.mockResolvedValue(makeMemberWithRelations({ id: OTHER_ID }));
        const result = await service.update(OTHER_ID, { email: 'new@rete.local' }, ACTOR);
        expect(result.success).toBe(true);
        expect(mockRepo.update).toHaveBeenCalledWith(OTHER_ID, {
          isActive: undefined,
          email: 'new@rete.local',
        });
      });
    });
  });

  describe('unlockLockout', () => {
    it('対象不在なら NotFound（clearLockout も監査もしない）', async () => {
      mockRepo.findById.mockResolvedValue(null);

      await expect(service.unlockLockout('missing', ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockRepo.clearLockout).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('ロックアウトを clearLockout で即時解除し、解除後の MemberDto を返す', async () => {
      mockRepo.findById.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: new Date(Date.now() + 600_000) }),
      );
      mockRepo.clearLockout.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: null }),
      );

      const result = await service.unlockLockout(OTHER_ID, ACTOR);

      expect(mockRepo.clearLockout).toHaveBeenCalledWith(OTHER_ID);
      expect(result.success).toBe(true);
      expect(result.data.id).toBe(OTHER_ID);
      expect(result.data.lockedUntil).toBeNull();
    });

    it('手動解除を監査ログ（actionType=admin / feature=members / actor 込み）へ残す', async () => {
      mockRepo.findById.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: new Date(Date.now() + 600_000) }),
      );
      mockRepo.clearLockout.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: null }),
      );

      await service.unlockLockout(OTHER_ID, ACTOR);

      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'admin',
          feature: 'members',
          actorAccountId: ACTOR.id,
          details: { targetId: OTHER_ID },
        }),
      );
    });

    it('未ロック対象（lockedUntil 無し）の unlock は no-op＝clearLockout も監査も残さない（監査汚染防止・set-0038）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: null }),
      );

      const result = await service.unlockLockout(OTHER_ID, ACTOR);

      expect(result.success).toBe(true);
      expect(result.data.id).toBe(OTHER_ID);
      expect(mockRepo.clearLockout).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('ロック期限切れ（lockedUntil が過去）の unlock も no-op（監査汚染防止・set-0038）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: new Date(Date.now() - 600_000) }),
      );

      await service.unlockLockout(OTHER_ID, ACTOR);

      expect(mockRepo.clearLockout).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });
  });

  describe('resetMfa（管理者強制リセット・set-0033）', () => {
    it('対象不在なら NotFound（adminResetMfa も監査もしない）', async () => {
      mockRepo.findById.mockResolvedValue(null);

      await expect(service.resetMfa('missing', ACTOR)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockMfa.adminResetMfa).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('自分自身の MFA リセットは BadRequest（self-service disable 迂回防止・findById も adminResetMfa もしない）', async () => {
      await expect(service.resetMfa(SELF_ID, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockRepo.findById).not.toHaveBeenCalled();
      expect(mockMfa.adminResetMfa).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('MFA 有効な対象をリセットし、監査ログ（actionType=admin / feature=members / actor 込み）を残す', async () => {
      mockRepo.findById
        .mockResolvedValueOnce(
          makeMemberWithRelations({ id: OTHER_ID, mfaSetting: { enabled: true } }),
        )
        .mockResolvedValueOnce(makeMemberWithRelations({ id: OTHER_ID, mfaSetting: null }));
      mockMfa.adminResetMfa.mockResolvedValue(true);

      const result = await service.resetMfa(OTHER_ID, ACTOR);

      expect(mockMfa.adminResetMfa).toHaveBeenCalledWith(OTHER_ID);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'admin',
          feature: 'members',
          actorAccountId: ACTOR.id,
          details: { targetId: OTHER_ID },
        }),
      );
      expect(result.success).toBe(true);
      expect(result.data.mfaEnabled).toBe(false);
    });

    it('対象が MFA 未設定なら no-op（監査を残さず冪等に現状を返す・監査汚染防止）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, mfaSetting: null }),
      );
      mockMfa.adminResetMfa.mockResolvedValue(false);

      const result = await service.resetMfa(OTHER_ID, ACTOR);

      expect(mockMfa.adminResetMfa).toHaveBeenCalledWith(OTHER_ID);
      expect(mockAudit.record).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data.mfaEnabled).toBe(false);
    });
  });

  describe('setSystemRole', () => {
    it('対象不在なら NotFound', async () => {
      mockRepo.findAccountRole.mockResolvedValue(null);

      await expect(service.setSystemRole(OTHER_ID, Role.ADMIN, ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockRepo.updateSystemRole).not.toHaveBeenCalled();
    });

    it('既に同ロールなら冪等に現状を返す（DB 更新も監査もしない）', async () => {
      mockRepo.findAccountRole.mockResolvedValue({ id: OTHER_ID, role: Role.ADMIN });

      const result = await service.setSystemRole(OTHER_ID, Role.ADMIN, ACTOR);

      expect(result.success).toBe(true);
      expect(result.data.role).toBe(Role.ADMIN);
      expect(mockRepo.updateSystemRole).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('MEMBER → ADMIN 昇格を実行し監査ログ（actionType=admin）を残す', async () => {
      mockRepo.findAccountRole.mockResolvedValue({ id: OTHER_ID, role: Role.MEMBER });
      mockRepo.updateSystemRole.mockResolvedValue({ id: OTHER_ID, role: Role.ADMIN });

      const result = await service.setSystemRole(OTHER_ID, Role.ADMIN, ACTOR);

      expect(mockRepo.demoteSystemRoleAtomic).not.toHaveBeenCalled(); // 昇格はガード無関係
      expect(mockRepo.updateSystemRole).toHaveBeenCalledWith(OTHER_ID, Role.ADMIN);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'admin',
          feature: 'members',
          actorAccountId: ACTOR.id,
        }),
      );
      expect(result.data.role).toBe(Role.ADMIN);
    });

    it('自分自身の降格は BadRequest（自己権限喪失防止・アトミックガードに到達しない）', async () => {
      mockRepo.findAccountRole.mockResolvedValue({ id: SELF_ID, role: Role.ADMIN });

      await expect(service.setSystemRole(SELF_ID, Role.MEMBER, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockRepo.demoteSystemRoleAtomic).not.toHaveBeenCalled();
    });

    it('最後のシステム管理者は降格できない（アトミックガードが blocked→BadRequest）', async () => {
      mockRepo.findAccountRole.mockResolvedValue({ id: OTHER_ID, role: Role.ADMIN });
      mockRepo.demoteSystemRoleAtomic.mockResolvedValue({ blocked: true });

      await expect(service.setSystemRole(OTHER_ID, Role.MEMBER, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockRepo.demoteSystemRoleAtomic).toHaveBeenCalledWith(OTHER_ID);
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('システム管理者が複数いれば他者を ADMIN → MEMBER へ降格でき、監査を残す', async () => {
      mockRepo.findAccountRole.mockResolvedValue({ id: OTHER_ID, role: Role.ADMIN });
      mockRepo.demoteSystemRoleAtomic.mockResolvedValue({
        blocked: false,
        row: { id: OTHER_ID, role: Role.MEMBER },
      });

      const result = await service.setSystemRole(OTHER_ID, Role.MEMBER, ACTOR);

      expect(mockRepo.demoteSystemRoleAtomic).toHaveBeenCalledWith(OTHER_ID);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'admin', feature: 'members' }),
      );
      expect(result.data.role).toBe(Role.MEMBER);
    });
  });

  /**
   * 明示監査行へアクセス元（IP・UA）が載ることの固定（rete-members-0001＝fil-0106 項目3 の横展開）。
   * controller が clientIp / clientUserAgent で取り出した値をそのまま record へ通す＝渡し漏れは赤くなる。
   */
  describe('明示監査行のアクセス元（IP・UA）', () => {
    const CLIENT = { ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0 (test)' };

    it('update（email 変更）の監査行にアクセス元が載る', async () => {
      mockRepo.findById.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, email: 'old@rete.local' }),
      );
      mockRepo.findOtherAccountByEmail.mockResolvedValue(null);
      mockRepo.update.mockResolvedValue(makeMemberWithRelations({ id: OTHER_ID }));

      await service.update(OTHER_ID, { email: 'new@rete.local' }, ACTOR, CLIENT);

      expect(mockAudit.record).toHaveBeenCalledWith(expect.objectContaining(CLIENT));
    });

    it('unlockLockout の監査行にアクセス元が載る', async () => {
      mockRepo.findById.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: new Date(Date.now() + 600_000) }),
      );
      mockRepo.clearLockout.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: null }),
      );

      await service.unlockLockout(OTHER_ID, ACTOR, CLIENT);

      expect(mockAudit.record).toHaveBeenCalledWith(expect.objectContaining(CLIENT));
    });

    it('resetMfa の監査行にアクセス元が載る', async () => {
      mockRepo.findById
        .mockResolvedValueOnce(
          makeMemberWithRelations({ id: OTHER_ID, mfaSetting: { enabled: true } }),
        )
        .mockResolvedValueOnce(makeMemberWithRelations({ id: OTHER_ID, mfaSetting: null }));
      mockMfa.adminResetMfa.mockResolvedValue(true);

      await service.resetMfa(OTHER_ID, ACTOR, CLIENT);

      expect(mockAudit.record).toHaveBeenCalledWith(expect.objectContaining(CLIENT));
    });

    it('setSystemRole の監査行にアクセス元が載る', async () => {
      mockRepo.findAccountRole.mockResolvedValue({ id: OTHER_ID, role: Role.MEMBER });
      mockRepo.updateSystemRole.mockResolvedValue({ id: OTHER_ID, role: Role.ADMIN });

      await service.setSystemRole(OTHER_ID, Role.ADMIN, ACTOR, CLIENT);

      expect(mockAudit.record).toHaveBeenCalledWith(expect.objectContaining(CLIENT));
    });

    it('アクセス元が取れない（未指定）でも記録は失敗せず undefined のまま渡る（記録側で null へ寄る）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: new Date(Date.now() + 600_000) }),
      );
      mockRepo.clearLockout.mockResolvedValue(
        makeMemberWithRelations({ id: OTHER_ID, lockedUntil: null }),
      );

      const result = await service.unlockLockout(OTHER_ID, ACTOR);

      expect(result.success).toBe(true);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ ipAddress: undefined, userAgent: undefined }),
      );
    });
  });
});
