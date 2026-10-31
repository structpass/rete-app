import { HomePermissionsModule } from '../home-permissions/home-permissions.module';
import { Module } from '@nestjs/common';
import { AnnouncementTagsController } from './announcement-tags.controller';
import { AnnouncementTagsService } from './announcement-tags.service';
import { AnnouncementTagsRepository } from './repositories/announcement-tags.repository';

@Module({
  imports: [HomePermissionsModule],
  controllers: [AnnouncementTagsController],
  providers: [AnnouncementTagsService, AnnouncementTagsRepository],
  exports: [AnnouncementTagsService, AnnouncementTagsRepository],
})
export class AnnouncementTagsModule {}
