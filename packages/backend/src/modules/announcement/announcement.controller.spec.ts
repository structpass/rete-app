import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';
import { HomeWriteGuard } from '../home-permissions/home-write.guard';

const mockService = {
  findAll: jest.fn(),
  findOne: jest.fn(),
  countUnread: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  reorder: jest.fn(),
  setTags: jest.fn(),
  addAttachment: jest.fn(),
  removeAttachment: jest.fn(),
};

describe('AnnouncementController', () => {
  let controller: AnnouncementController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnnouncementController],
      providers: [{ provide: AnnouncementService, useValue: mockService }],
    })
      .overrideGuard(HomeWriteGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AnnouncementController>(AnnouncementController);
  });

  it('findAll は query・session userId を service.findAll へ委譲する（未読フラグ算出・hom-0143 で可視性フィルタ撤去）', async () => {
    const expected = { success: true, data: [], meta: { total: 0, page: 1, limit: 20 } };
    mockService.findAll.mockResolvedValue(expected);

    expect(await controller.findAll({ page: 1, limit: 20 }, 'acc-1')).toBe(expected);
    expect(mockService.findAll).toHaveBeenCalledWith({ page: 1, limit: 20 }, 'acc-1');
  });

  it('unreadCount は query.kind・session userId を service.countUnread へ委譲する（hom-0143 で可視性フィルタ撤去）', async () => {
    const expected = { success: true, data: { count: 2 } };
    mockService.countUnread.mockResolvedValue(expected);

    expect(await controller.unreadCount({ kind: 'board' }, 'acc-1')).toBe(expected);
    expect(mockService.countUnread).toHaveBeenCalledWith('acc-1', 'board');
  });

  it('findOne は id と session userId を service.findOne へ委譲する（開いた時点で既読化）', async () => {
    const expected = { success: true, data: { id: 'a1' } };
    mockService.findOne.mockResolvedValue(expected);

    expect(await controller.findOne('a1', 'acc-1')).toBe(expected);
    expect(mockService.findOne).toHaveBeenCalledWith('a1', 'acc-1');
  });

  it('create は authorId（session）と dto を service.create へ委譲する', async () => {
    const dto = { title: '新規', body: '<p>x</p>' };
    const expected = { success: true, data: { id: 'new-1' } };
    mockService.create.mockResolvedValue(expected);

    expect(await controller.create('acc-9', dto)).toBe(expected);
    expect(mockService.create).toHaveBeenCalledWith('acc-9', dto);
  });

  it('update は id と dto を service.update へ委譲する', async () => {
    const dto = { title: '改題' };
    const expected = { success: true, data: { id: 'a1' } };
    mockService.update.mockResolvedValue(expected);

    expect(await controller.update('a1', dto)).toBe(expected);
    expect(mockService.update).toHaveBeenCalledWith('a1', dto);
  });

  it('remove は id を service.remove へ委譲する', async () => {
    const expected = { success: true, message: '通知を削除しました' };
    mockService.remove.mockResolvedValue(expected);

    expect(await controller.remove('a1')).toBe(expected);
    expect(mockService.remove).toHaveBeenCalledWith('a1');
  });

  it('reorder は session userId と dto を service.reorder へ委譲する（H0021・unread 算出用）', async () => {
    const dto = { orderedIds: ['a2', 'a1'] };
    const expected = { success: true, data: [] };
    mockService.reorder.mockResolvedValue(expected);

    expect(await controller.reorder('acc-1', dto)).toBe(expected);
    expect(mockService.reorder).toHaveBeenCalledWith('acc-1', dto);
  });

  it('setTags は id と dto を service.setTags へ委譲する（cmn-0039 / rete-home-0043）', async () => {
    const dto = { tagIds: ['11111111-1111-4111-8111-111111111111'] };
    const expected = { success: true, data: { id: 'a1', tags: [] } };
    mockService.setTags.mockResolvedValue(expected);

    expect(await controller.setTags('a1', dto)).toBe(expected);
    expect(mockService.setTags).toHaveBeenCalledWith('a1', dto);
  });

  it('addAttachment は id・fileId・session accountId を service.addAttachment へ委譲する（H0022）', async () => {
    const expected = { success: true, data: { id: 'att-1' } };
    mockService.addAttachment.mockResolvedValue(expected);

    expect(await controller.addAttachment('a1', { fileId: 'file-1' }, 'acc-9')).toBe(expected);
    expect(mockService.addAttachment).toHaveBeenCalledWith('a1', 'file-1', 'acc-9');
  });

  it('removeAttachment は id と attachmentId を service.removeAttachment へ委譲する（H0022）', async () => {
    const expected = { success: true, data: { id: 'att-1' } };
    mockService.removeAttachment.mockResolvedValue(expected);

    expect(await controller.removeAttachment('a1', 'att-1')).toBe(expected);
    expect(mockService.removeAttachment).toHaveBeenCalledWith('a1', 'att-1');
  });
});
