import { Injectable } from '@nestjs/common';
import { ok } from '../../common/dto';
import { CalendarHolidaysRepository } from './calendar-holidays.repository';
import type { SaveCalendarHolidayDto } from './calendar-holidays.dto';
import { toCalendarHolidayDate, toCalendarHolidayResponse } from './calendar-holidays.mapper';

@Injectable()
export class CalendarHolidaysService {
  constructor(private readonly repository: CalendarHolidaysRepository) {}
  async findAll() {
    return ok((await this.repository.findAll()).map(toCalendarHolidayResponse));
  }
  async create(dto: SaveCalendarHolidayDto) {
    return ok(
      toCalendarHolidayResponse(
        await this.repository.create(toCalendarHolidayDate(dto.date), dto.name),
      ),
    );
  }
  async update(original: string, dto: SaveCalendarHolidayDto) {
    return ok(
      toCalendarHolidayResponse(
        await this.repository.update(
          toCalendarHolidayDate(original),
          toCalendarHolidayDate(dto.date),
          dto.name,
        ),
      ),
    );
  }
  async remove(date: string): Promise<void> {
    await this.repository.remove(toCalendarHolidayDate(date));
  }
}
