import { HOME_PERMISSIONS } from '@rete/shared';
import { toUserGroupDto } from './user-groups.mapper';
import type { UserGroupRow } from './repositories/user-groups.repository';

const row = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    canEditHomeBoard: false,
    canEditHomeCalendar: false,
    canEditHomeFaq: false,
    canManageHomeTags: false,
    id: 'grp-1',
    name: '営業グループ',
    sortOrder: 0,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...over,
  }) as unknown as UserGroupRow;

describe('toUserGroupDto', () => {
  it('Home の設定値を応答へ移す（正本の名前をすべて含む）', () => {
    const dto = toUserGroupDto(
      row({
        canEditHomeBoard: true,
        canEditHomeCalendar: false,
        canEditHomeFaq: true,
        canManageHomeTags: false,
      }),
    );

    // 正本（HOME_PERMISSIONS）の設定値を 1 つも落とさずに応答へ写す（d874）。
    for (const { groupFlagKey } of Object.values(HOME_PERMISSIONS)) {
      expect(dto).toHaveProperty(groupFlagKey);
      expect(typeof dto[groupFlagKey as keyof typeof dto]).toBe('boolean');
    }
    expect(dto.canEditHomeBoard).toBe(true);
    expect(dto.canEditHomeCalendar).toBe(false);
    expect(dto.canEditHomeFaq).toBe(true);
    expect(dto.canManageHomeTags).toBe(false);
  });

  it('名前と日時は従前どおりの形で返す', () => {
    const dto = toUserGroupDto(row({ name: '新名称' }));

    expect(dto.name).toBe('新名称');
    expect(dto.id).toBe('grp-1');
    expect(dto.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(dto.updatedAt).toBe('2026-08-01T00:00:00.000Z');
  });
});
