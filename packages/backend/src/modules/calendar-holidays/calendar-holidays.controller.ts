import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@rete/shared';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CalendarHolidayDateDto, SaveCalendarHolidayDto } from './calendar-holidays.dto';
import { CalendarHolidaysService } from './calendar-holidays.service';

@Controller('calendar-holidays')
@UseGuards(AuthenticatedGuard, RolesGuard)
export class CalendarHolidaysController {
  constructor(private readonly service: CalendarHolidaysService) {}
  @Get()
  findAll() {
    return this.service.findAll();
  }
  @Post()
  @Roles(Role.ADMIN)
  create(@Body() dto: SaveCalendarHolidayDto) {
    return this.service.create(dto);
  }
  @Patch(':date')
  @Roles(Role.ADMIN)
  update(@Param() params: CalendarHolidayDateDto, @Body() dto: SaveCalendarHolidayDto) {
    return this.service.update(params.date, dto);
  }
  @Delete(':date')
  @Roles(Role.ADMIN)
  @HttpCode(204)
  remove(@Param() params: CalendarHolidayDateDto) {
    return this.service.remove(params.date);
  }
}
