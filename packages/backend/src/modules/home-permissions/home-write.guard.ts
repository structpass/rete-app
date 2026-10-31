import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { HomePermissionKey } from '@rete/shared';
import { HomePermissionsService } from './home-permissions.service';

export type HomeWriteScope = 'announcement' | 'tags' | 'calendar';

/**
 * 書き込みの入口ごとに必要な許可（d816）。通知は保存済みの種別で決まるため assertAnnouncement が
 * 持ち、それ以外はここで決める。許可の名前は shared の正本（HOME_PERMISSIONS）と同じ語を使う。
 */
const HOME_WRITE_PERMISSIONS: Record<Exclude<HomeWriteScope, 'announcement'>, HomePermissionKey> = {
  calendar: 'calendarEdit',
  tags: 'tagManage',
};

export const HomeWrite = (scope: HomeWriteScope) => SetMetadata('home-write', scope);
@Injectable()
export class HomeWriteGuard implements CanActivate {
  constructor(
    private readonly permissions: HomePermissionsService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request & { user: { id: string } }>();
    const scope = this.reflector.getAllAndOverride<string>('home-write', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (req.method === 'GET' && !(scope === 'tags' && req.query.includeArchived === 'true'))
      return true;
    if (scope === 'announcement') {
      await this.permissions.assertAnnouncement(
        req.user.id,
        req.params.id as string | undefined,
        req.body?.kind ?? 'board',
      );
    } else if (scope === 'calendar' || scope === 'tags') {
      await this.permissions.assert(req.user.id, HOME_WRITE_PERMISSIONS[scope]);
    } else {
      throw new ForbiddenException('対象外の書き込みです');
    }
    return true;
  }
}
