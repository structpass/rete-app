import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { InviteStatus } from '@prisma/client';
import { InviteRepository } from './invite.repository';
import { PrismaService } from '../../../database/prisma.service';

const mockPrisma = {
  invite: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  },
  account: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
  },
  passwordPolicy: {
    findFirst: jest.fn(),
  },
  space: {
    findFirst: jest.fn(),
  },
  membership: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('InviteRepository', () => {
  let repo: InviteRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InviteRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repo = module.get<InviteRepository>(InviteRepository);
    // $transaction はコールバック形式（interactive tx）= cb(mockPrisma) で即実行。
    mockPrisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(mockPrisma));
  });

  describe('findAll', () => {
    it('作成日時降順で tokenHash を含まない select を渡す', async () => {
      const rows = [{ id: 'inv-1' }];
      mockPrisma.invite.findMany.mockResolvedValue(rows);

      const result = await repo.findAll();

      expect(mockPrisma.invite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
      const call = mockPrisma.invite.findMany.mock.calls[0][0];
      expect(call.select).not.toHaveProperty('tokenHash');
      expect(result).toBe(rows);
    });
  });

  describe('findById', () => {
    it('id で findUnique し tokenHash を含まない select を渡す', async () => {
      const row = { id: 'inv-1' };
      mockPrisma.invite.findUnique.mockResolvedValue(row);

      const result = await repo.findById('inv-1');

      const call = mockPrisma.invite.findUnique.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'inv-1' });
      expect(call.select).not.toHaveProperty('tokenHash');
      expect(result).toBe(row);
    });
  });

  describe('findByTokenHash', () => {
    it('tokenHash で findUnique し tokenHash を含む select を渡す', async () => {
      const row = { id: 'inv-1', tokenHash: 'hash-1' };
      mockPrisma.invite.findUnique.mockResolvedValue(row);

      const result = await repo.findByTokenHash('hash-1');

      const call = mockPrisma.invite.findUnique.mock.calls[0][0];
      expect(call.where).toEqual({ tokenHash: 'hash-1' });
      expect(call.select).toHaveProperty('tokenHash', true);
      expect(result).toBe(row);
    });
  });

  describe('findPendingByEmail', () => {
    it('email・PENDING・期限内で findFirst する', async () => {
      mockPrisma.invite.findFirst.mockResolvedValue(null);

      await repo.findPendingByEmail('a@example.com');

      const call = mockPrisma.invite.findFirst.mock.calls[0][0];
      expect(call.where.email).toBe('a@example.com');
      expect(call.where.status).toBe(InviteStatus.PENDING);
      expect(call.where.expiresAt).toHaveProperty('gt');
    });
  });

  describe('findAccountByEmail', () => {
    it('email で account.findUnique し id のみ select する', async () => {
      const row = { id: 'acc-1' };
      mockPrisma.account.findUnique.mockResolvedValue(row);

      const result = await repo.findAccountByEmail('a@example.com');

      expect(mockPrisma.account.findUnique).toHaveBeenCalledWith({
        where: { email: 'a@example.com' },
        select: { id: true },
      });
      expect(result).toBe(row);
    });
  });

  describe('findPendingEmails（rete-settings-0010・一括プリフェッチ）', () => {
    it('空配列は findMany を呼ばず空Setを返す', async () => {
      const result = await repo.findPendingEmails([]);
      expect(mockPrisma.invite.findMany).not.toHaveBeenCalled();
      expect(result).toEqual(new Set());
    });

    it('重複排除した email 群を IN 一括引きし PENDING/期限内の email を Set で返す', async () => {
      mockPrisma.invite.findMany.mockResolvedValue([{ email: 'a@example.com' }]);

      const result = await repo.findPendingEmails([
        'a@example.com',
        'a@example.com',
        'b@example.com',
      ]);

      const call = mockPrisma.invite.findMany.mock.calls[0][0];
      expect(call.where.email.in).toEqual(['a@example.com', 'b@example.com']);
      expect(call.where.status).toBe(InviteStatus.PENDING);
      expect(result).toEqual(new Set(['a@example.com']));
    });
  });

  describe('findExistingAccountEmails（rete-settings-0010・一括プリフェッチ）', () => {
    it('空配列は findMany を呼ばず空Setを返す', async () => {
      const result = await repo.findExistingAccountEmails([]);
      expect(mockPrisma.account.findMany).not.toHaveBeenCalled();
      expect(result).toEqual(new Set());
    });

    it('重複排除した email 群を IN 一括引きし既存 email を Set で返す', async () => {
      mockPrisma.account.findMany.mockResolvedValue([{ email: 'a@example.com' }]);

      const result = await repo.findExistingAccountEmails(['a@example.com', 'a@example.com']);

      const call = mockPrisma.account.findMany.mock.calls[0][0];
      expect(call.where.email.in).toEqual(['a@example.com']);
      expect(result).toEqual(new Set(['a@example.com']));
    });
  });

  describe('findPasswordPolicy', () => {
    it('singleton のパスワードポリシーを取得する', async () => {
      const policy = { minLength: 8 };
      mockPrisma.passwordPolicy.findFirst.mockResolvedValue(policy);

      const result = await repo.findPasswordPolicy();

      expect(mockPrisma.passwordPolicy.findFirst).toHaveBeenCalled();
      expect(result).toBe(policy);
    });
  });

  describe('findGroupSpaceById', () => {
    it('id・kind=GROUP・archivedAt:null で space を検索する', async () => {
      mockPrisma.space.findFirst.mockResolvedValue({ id: 'space-1' });

      await repo.findGroupSpaceById('space-1');

      expect(mockPrisma.space.findFirst).toHaveBeenCalledWith({
        where: { id: 'space-1', kind: 'GROUP', archivedAt: null },
        select: { id: true },
      });
    });
  });

  describe('create', () => {
    it('spaceId 省略時は null で invite.create する（tokenHash を含まない select）', async () => {
      const row = { id: 'inv-1' };
      mockPrisma.invite.create.mockResolvedValue(row);

      const result = await repo.create({
        email: 'a@example.com',
        tokenHash: 'hash-1',
        expiresAt: new Date('2026-07-12T00:00:00.000Z'),
        invitedById: 'acc-1',
      });

      const call = mockPrisma.invite.create.mock.calls[0][0];
      expect(call.data).toEqual({
        email: 'a@example.com',
        tokenHash: 'hash-1',
        expiresAt: new Date('2026-07-12T00:00:00.000Z'),
        invitedById: 'acc-1',
        spaceId: null,
      });
      expect(call.select).not.toHaveProperty('tokenHash');
      expect(result).toBe(row);
    });
  });

  describe('update', () => {
    it('tokenHash/expiresAt/status を invite.update し tokenHash を含む select を渡す', async () => {
      const row = { id: 'inv-1', tokenHash: 'hash-2' };
      mockPrisma.invite.update.mockResolvedValue(row);

      const result = await repo.update('inv-1', {
        tokenHash: 'hash-2',
        expiresAt: new Date('2026-07-12T00:00:00.000Z'),
        status: InviteStatus.PENDING,
      });

      const call = mockPrisma.invite.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'inv-1' });
      expect(call.data).toEqual({
        tokenHash: 'hash-2',
        expiresAt: new Date('2026-07-12T00:00:00.000Z'),
        status: InviteStatus.PENDING,
      });
      expect(call.select).toHaveProperty('tokenHash', true);
      expect(result).toBe(row);
    });
  });

  // d622: 再送の書き換えは「読んだ時の tokenHash のまま PENDING」を条件にする。
  // 受諾済み・同時再送のどちらも巻き戻さない。
  describe('renewPendingByTokenHash（再送の条件付き書き換え）', () => {
    const renewData = {
      tokenHash: 'hash-new',
      expiresAt: new Date('2026-07-20T00:00:00.000Z'),
      status: InviteStatus.PENDING,
    };

    it('id・読んだ時の tokenHash・PENDING を条件に新しい token と期限へ書き換える', async () => {
      mockPrisma.invite.updateMany.mockResolvedValue({ count: 1 });

      const outcome = await repo.renewPendingByTokenHash('inv-1', 'hash-old', renewData);

      expect(outcome).toBe('renewed');
      expect(mockPrisma.invite.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', tokenHash: 'hash-old', status: InviteStatus.PENDING },
        data: {
          tokenHash: 'hash-new',
          expiresAt: new Date('2026-07-20T00:00:00.000Z'),
          status: InviteStatus.PENDING,
        },
      });
    });

    it('対象が無く、招待が受諾済みなら accepted を返す（未受諾へ戻さない）', async () => {
      mockPrisma.invite.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.invite.findUnique.mockResolvedValue({ status: InviteStatus.ACCEPTED });

      const outcome = await repo.renewPendingByTokenHash('inv-1', 'hash-old', renewData);

      expect(outcome).toBe('accepted');
    });

    it('対象が無く、招待が PENDING のままなら pending_mismatch を返す（同時再送で譲る）', async () => {
      mockPrisma.invite.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.invite.findUnique.mockResolvedValue({ status: InviteStatus.PENDING });

      const outcome = await repo.renewPendingByTokenHash('inv-1', 'hash-old', renewData);

      expect(outcome).toBe('pending_mismatch');
    });
  });

  describe('delete', () => {
    it('id で invite.delete する', async () => {
      mockPrisma.invite.delete.mockResolvedValue({});
      await repo.delete('inv-1');
      expect(mockPrisma.invite.delete).toHaveBeenCalledWith({ where: { id: 'inv-1' } });
    });
  });

  describe('acceptInTransaction（TX 内 再検証）', () => {
    const acceptData = { tokenHash: 'hash-1', name: '新規太郎', passwordHash: 'hashed' };

    it('招待が存在しないと BadRequestException を投げる', async () => {
      mockPrisma.invite.findUnique.mockResolvedValue(null);
      await expect(repo.acceptInTransaction(acceptData)).rejects.toThrow(
        '招待が無効か期限切れです',
      );
      expect(mockPrisma.account.create).not.toHaveBeenCalled();
    });

    it('status が PENDING でないと BadRequestException を投げる', async () => {
      mockPrisma.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        status: InviteStatus.ACCEPTED,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        email: 'a@example.com',
        spaceId: null,
      });
      await expect(repo.acceptInTransaction(acceptData)).rejects.toThrow(
        '招待が無効か期限切れです',
      );
    });

    it('期限切れだと BadRequestException を投げる', async () => {
      mockPrisma.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        status: InviteStatus.PENDING,
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        email: 'a@example.com',
        spaceId: null,
      });
      await expect(repo.acceptInTransaction(acceptData)).rejects.toThrow(
        '招待が無効か期限切れです',
      );
    });

    it('email の Account が既に存在すると BadRequestException を投げる（並行登録対策）', async () => {
      mockPrisma.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        status: InviteStatus.PENDING,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        email: 'a@example.com',
        spaceId: null,
      });
      mockPrisma.account.findUnique.mockResolvedValue({ id: 'existing-acc' });
      await expect(repo.acceptInTransaction(acceptData)).rejects.toThrow(
        '招待が無効か期限切れです',
      );
      expect(mockPrisma.account.create).not.toHaveBeenCalled();
    });

    it('spaceId が null の招待は Membership 作成をスキップして account を作成する', async () => {
      mockPrisma.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        status: InviteStatus.PENDING,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        email: 'a@example.com',
        spaceId: null,
      });
      mockPrisma.account.findUnique.mockResolvedValue(null);
      mockPrisma.account.create.mockResolvedValue({ id: 'new-acc' });
      mockPrisma.invite.update.mockResolvedValue({});

      await repo.acceptInTransaction(acceptData);

      const createCall = mockPrisma.account.create.mock.calls[0][0];
      expect(createCall.data).toEqual(
        expect.objectContaining({
          email: 'a@example.com',
          name: '新規太郎',
          passwordHash: 'hashed',
          role: 'MEMBER',
          isActive: true,
        }),
      );
      expect(mockPrisma.membership.create).not.toHaveBeenCalled();
      const updateCall = mockPrisma.invite.update.mock.calls[0][0];
      expect(updateCall).toEqual(
        expect.objectContaining({
          where: { id: 'inv-1' },
          data: expect.objectContaining({
            status: InviteStatus.ACCEPTED,
            acceptedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('spaceId が TX 内再検証を通過すると GROUP Membership を作成する', async () => {
      mockPrisma.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        status: InviteStatus.PENDING,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        email: 'a@example.com',
        spaceId: 'space-1',
      });
      mockPrisma.account.findUnique.mockResolvedValue(null);
      mockPrisma.space.findFirst.mockResolvedValue({ id: 'space-1' });
      mockPrisma.account.create.mockResolvedValue({ id: 'new-acc' });
      mockPrisma.membership.create.mockResolvedValue({});
      mockPrisma.invite.update.mockResolvedValue({});

      await repo.acceptInTransaction(acceptData);

      const createCall = mockPrisma.account.create.mock.calls[0][0];
      expect(createCall.data).toEqual(
        expect.objectContaining({
          email: 'a@example.com',
          name: '新規太郎',
          passwordHash: 'hashed',
          role: 'MEMBER',
          isActive: true,
        }),
      );
      expect(mockPrisma.membership.create).toHaveBeenCalledWith({
        data: { accountId: 'new-acc', scopeType: 'GROUP', scopeId: 'space-1', role: 'MEMBER' },
      });
      const updateCall = mockPrisma.invite.update.mock.calls[0][0];
      expect(updateCall).toEqual(
        expect.objectContaining({
          where: { id: 'inv-1' },
          data: expect.objectContaining({
            status: InviteStatus.ACCEPTED,
            acceptedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('space が TX 内でアーカイブ済み等（見つからない）なら Membership 作成をスキップする', async () => {
      mockPrisma.invite.findUnique.mockResolvedValue({
        id: 'inv-1',
        status: InviteStatus.PENDING,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        email: 'a@example.com',
        spaceId: 'space-1',
      });
      mockPrisma.account.findUnique.mockResolvedValue(null);
      mockPrisma.space.findFirst.mockResolvedValue(null);
      mockPrisma.account.create.mockResolvedValue({ id: 'new-acc' });
      mockPrisma.invite.update.mockResolvedValue({});

      await repo.acceptInTransaction(acceptData);

      expect(mockPrisma.membership.create).not.toHaveBeenCalled();
    });
  });
});
