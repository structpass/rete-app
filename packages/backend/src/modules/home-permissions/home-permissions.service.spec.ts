import { ForbiddenException } from '@nestjs/common';
import { HOME_PERMISSIONS } from '@rete/shared';
import { HomePermissionsService } from './home-permissions.service';
import type { HomePermissionsRepository } from './home-permissions.repository';
describe('HomePermissionsService', () => {
  const repo = { account: jest.fn(), announcement: jest.fn() };
  let service: HomePermissionsService;
  beforeEach(() => {
    service = new HomePermissionsService(repo as unknown as HomePermissionsRepository);
  });
  it('resolves every permission listed in the shared source of truth (d816)', async () => {
    // 正本（HOME_PERMISSIONS）に許可が増えても、解決結果に同じ名前で必ず現れる。
    // 2 か所に書き分けているとここで 1 本目が欠けて落ちる。
    const keys = Object.keys(HOME_PERMISSIONS);
    repo.account.mockResolvedValue({ isActive: true, role: 'ADMIN', userGroupMembers: [] });
    expect(Object.keys(await service.resolve('admin')).sort()).toEqual([...keys].sort());
    repo.account.mockResolvedValue({ isActive: true, role: 'MEMBER', userGroupMembers: [] });
    expect(Object.keys(await service.resolve('member')).sort()).toEqual([...keys].sort());
  });
  it('resolves each permission only from its own group flag', async () => {
    // 許可ごとの設定値の対応が 1 か所（正本）から来ていることを、1 つずつ確かめる。
    for (const key of Object.keys(HOME_PERMISSIONS) as (keyof typeof HOME_PERMISSIONS)[]) {
      const flag = HOME_PERMISSIONS[key].groupFlagKey;
      repo.account.mockResolvedValue({
        isActive: true,
        role: 'MEMBER',
        userGroupMembers: [{ group: { [flag]: true } }],
      });
      const resolved = await service.resolve('member');
      const granted = Object.entries(resolved)
        .filter(([, value]) => value)
        .map(([name]) => name);
      expect(granted).toEqual([key]);
    }
  });
  it('merges independent group grants with OR', async () => {
    repo.account.mockResolvedValue({
      isActive: true,
      role: 'MEMBER',
      userGroupMembers: [
        { group: { canEditHomeBoard: true } },
        { group: { canEditHomeCalendar: true, canManageHomeTags: true } },
      ],
    });
    expect(await service.resolve('member')).toEqual({
      boardEdit: true,
      calendarEdit: true,
      faqEdit: false,
      tagManage: true,
    });
  });
  it('does not give a member without a group any editing permission', async () => {
    repo.account.mockResolvedValue({ isActive: true, role: 'MEMBER', userGroupMembers: [] });
    expect(Object.values(await service.resolve('member')).some(Boolean)).toBe(false);
  });
  it('allows an active system admin and rejects an inactive admin', async () => {
    repo.account.mockResolvedValue({ isActive: true, role: 'ADMIN', userGroupMembers: [] });
    expect(Object.values(await service.resolve('admin')).every(Boolean)).toBe(true);
    repo.account.mockResolvedValue({ isActive: false, role: 'ADMIN' });
    await expect(service.assert('admin', 'calendarEdit')).rejects.toThrow(ForbiddenException);
  });
  it('uses persisted announcement kind and reloads permissions after revocation', async () => {
    repo.announcement.mockResolvedValue({ kind: 'faq' });
    repo.account.mockResolvedValue({
      isActive: true,
      role: 'MEMBER',
      userGroupMembers: [{ group: { canEditHomeBoard: true } }],
    });
    await expect(service.assertAnnouncement('member', 'faq-id', 'board')).rejects.toThrow(
      ForbiddenException,
    );
    repo.account.mockResolvedValue({
      isActive: true,
      role: 'MEMBER',
      userGroupMembers: [{ group: { canEditHomeCalendar: true } }],
    });
    await service.assert('member', 'calendarEdit');
    repo.account.mockResolvedValue({ isActive: true, role: 'MEMBER', userGroupMembers: [] });
    await expect(service.assert('member', 'calendarEdit')).rejects.toThrow(ForbiddenException);
  });
});
