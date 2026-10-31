import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { HomePermissionsService } from './home-permissions.service';
import { HomeWriteGuard } from './home-write.guard';
describe('HomeWriteGuard', () => {
  const permissions = { assert: jest.fn(), assertAnnouncement: jest.fn() };
  const reflector = { getAllAndOverride: jest.fn() };
  const guard = new HomeWriteGuard(
    permissions as unknown as HomePermissionsService,
    reflector as unknown as Reflector,
  );
  function context(method: string, params = {}, query = {}, body = {}) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method, params, query, body, user: { id: 'member' } }),
      }),
      getHandler: () => null,
      getClass: () => null,
    } as unknown as ExecutionContext;
  }
  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
    'checks every announcement mutation %s with the actual id',
    async (method) => {
      reflector.getAllAndOverride.mockReturnValue('announcement');
      await guard.canActivate(context(method, { id: 'saved-id' }, {}, { kind: 'board' }));
      expect(permissions.assertAnnouncement).toHaveBeenCalledWith('member', 'saved-id', 'board');
    },
  );
  it('allows read access but protects archived master data', async () => {
    reflector.getAllAndOverride.mockReturnValue('tags');
    expect(await guard.canActivate(context('GET'))).toBe(true);
    expect(permissions.assert).not.toHaveBeenCalled();
    permissions.assert.mockRejectedValue(new ForbiddenException());
    await expect(
      guard.canActivate(context('GET', {}, { includeArchived: 'true' })),
    ).rejects.toThrow(ForbiddenException);
    expect(permissions.assert).toHaveBeenCalledWith('member', 'tagManage');
  });
  it('does not let tag management substitute for calendar edit permission', async () => {
    reflector.getAllAndOverride.mockReturnValue('calendar');
    await guard.canActivate(context('PATCH'));
    expect(permissions.assert).toHaveBeenCalledWith('member', 'calendarEdit');
  });
});
