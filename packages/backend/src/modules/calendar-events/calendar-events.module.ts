import { AuditLogsModule } from '../audit-logs';
import { Module } from '@nestjs/common';
import { HomePermissionsModule } from '../home-permissions/home-permissions.module';
import { CalendarEventsRepository } from './calendar-events.repository';
import { CalendarEventsService } from './calendar-events.service';
import { CalendarEventsController } from './calendar-events.controller';
@Module({
  imports: [HomePermissionsModule, AuditLogsModule],
  controllers: [CalendarEventsController],
  providers: [CalendarEventsRepository, CalendarEventsService],
})
export class CalendarEventsModule {}
