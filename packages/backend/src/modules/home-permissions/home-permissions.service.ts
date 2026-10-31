import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  HOME_PERMISSIONS,
  type HomeGroupPermissions,
  type HomePermissionKey,
  type HomePermissions,
} from '@rete/shared';
import { HomePermissionsRepository } from './home-permissions.repository';

/**
 * 許可の一覧は shared の HOME_PERMISSIONS を正本とし、許可 → 管理グループの設定値 の対応を
 * ここでは書き写さない（d816）。許可を足す時は正本の 1 か所だけを直す。
 */
const PERMISSION_KEYS = Object.keys(HOME_PERMISSIONS) as HomePermissionKey[];

function grantAll(value: boolean): HomePermissions {
  return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, value])) as HomePermissions;
}

/** 所属グループの設定値の OR（どれか 1 つでも持っていれば許可）。 */
function foldGroups(groups: Partial<HomeGroupPermissions>[]): HomePermissions {
  return Object.fromEntries(
    PERMISSION_KEYS.map((key) => [
      key,
      groups.some((group) => group[HOME_PERMISSIONS[key].groupFlagKey] === true),
    ]),
  ) as HomePermissions;
}

@Injectable()
export class HomePermissionsService {
  constructor(private readonly repo: HomePermissionsRepository) {}
  async resolve(accountId: string): Promise<HomePermissions> {
    const account = await this.repo.account(accountId);
    if (!account?.isActive) return grantAll(false);
    if (account.role === 'ADMIN') return grantAll(true);
    return foldGroups(account.userGroupMembers.map((m) => m.group));
  }
  async assert(accountId: string, permission: HomePermissionKey) {
    if (!(await this.resolve(accountId))[permission])
      throw new ForbiddenException('編集権限がありません');
  }
  async assertAnnouncement(accountId: string, id: string | undefined, kind: string) {
    if (id) {
      const row = await this.repo.announcement(id);
      if (!row) throw new NotFoundException('通知が見つかりません');
      kind = row.kind;
    }
    if (kind !== 'board' && kind !== 'faq') throw new ForbiddenException('編集できない種別です');
    await this.assert(accountId, kind === 'board' ? 'boardEdit' : 'faqEdit');
  }
}
