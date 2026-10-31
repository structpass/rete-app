import { HomePermissionsModule } from '../home-permissions/home-permissions.module';
import { Module } from '@nestjs/common';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';
import { AnnouncementRepository } from './repositories/announcement.repository';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  // hom-0143: 通知先（targetRoles / targetBusinessRoles）撤去に伴い RolesModule 依存も撤去
  // （RolesService.findNamesByIds は詳細 DTO の id→name 解決専用だった）。
  imports: [AttachmentsModule, HomePermissionsModule],
  controllers: [AnnouncementController],
  providers: [AnnouncementService, AnnouncementRepository],
  exports: [AnnouncementService],
})
export class AnnouncementModule {}
