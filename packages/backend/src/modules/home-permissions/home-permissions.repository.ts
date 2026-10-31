import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class HomePermissionsRepository {
  constructor(private readonly prisma: PrismaService) {}
  account(id: string) {
    return this.prisma.account.findUnique({
      where: { id },
      select: {
        role: true,
        isActive: true,
        userGroupMembers: {
          select: {
            group: {
              select: {
                canEditHomeBoard: true,
                canEditHomeCalendar: true,
                canEditHomeFaq: true,
                canManageHomeTags: true,
              },
            },
          },
        },
      },
    });
  }
  announcement(id: string) {
    return this.prisma.announcement.findUnique({ where: { id }, select: { kind: true } });
  }
}
