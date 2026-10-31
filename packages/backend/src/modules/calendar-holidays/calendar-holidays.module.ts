import { Module } from '@nestjs/common';
import { CalendarHolidaysController } from './calendar-holidays.controller';
import { CalendarHolidaysService } from './calendar-holidays.service';
import { CalendarHolidaysRepository } from './calendar-holidays.repository';

@Module({
  controllers: [CalendarHolidaysController],
  providers: [CalendarHolidaysService, CalendarHolidaysRepository],
})
export class CalendarHolidaysModule {}
