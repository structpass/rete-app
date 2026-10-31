import { Reflector } from '@nestjs/core';
import { AnnouncementTagsController } from './announcement-tags.controller';
import type { AnnouncementTagsService } from './announcement-tags.service';
import { HomeWriteGuard } from '../home-permissions/home-write.guard';
describe('AnnouncementTagsController', () => {
  const service = { findAll: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() };
  const controller = new AnnouncementTagsController(service as unknown as AnnouncementTagsService);
  it('delegates calendar tag queries and protected archive queries', async () => {
    await controller.findAll({ kind: 'calendar', includeArchived: true });
    expect(service.findAll).toHaveBeenCalledWith({ kind: 'calendar', includeArchived: true });
  });
  it('uses HomeWriteGuard with tags scope on every endpoint', () => {
    const reflector = new Reflector();
    expect(reflector.get('home-write', AnnouncementTagsController)).toBe('tags');
    expect(reflector.get('__guards__', AnnouncementTagsController)).toContain(HomeWriteGuard);
  });
  it('delegates mutations without altering their payload', async () => {
    const dto = { name: '工程', icon: 'Tag', color: 'slate', kind: 'calendar' as const };
    await controller.create(dto);
    expect(service.create).toHaveBeenCalledWith(dto);
    await controller.update('tag-id', { archived: true });
    expect(service.update).toHaveBeenCalledWith('tag-id', { archived: true });
    await controller.delete('tag-id');
    expect(service.delete).toHaveBeenCalledWith('tag-id');
  });
});
