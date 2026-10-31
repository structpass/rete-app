import type { AuthenticatedUser } from '../auth/auth.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { HomeWrite, HomeWriteGuard } from '../home-permissions/home-write.guard';
import { CalendarEventsService } from './calendar-events.service';
import {
  CalendarRevisionDto,
  CreateCalendarEventDto,
  FindCalendarEventsDto,
  UpdateCalendarEventDto,
} from './calendar-events.dto';

@Controller('calendar-events')
@HomeWrite('calendar')
@UseGuards(AuthenticatedGuard, HomeWriteGuard)
export class CalendarEventsController {
  constructor(private readonly service: CalendarEventsService) {}
  @Get() findAll(@Query() query: FindCalendarEventsDto) {
    return this.service.findAll(query);
  }
  @Get(':id') findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }
  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateCalendarEventDto) {
    return this.service.save(actor, dto);
  }
  @Patch(':id')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdateCalendarEventDto,
  ) {
    return this.service.save(actor, dto, id);
  }
  @Delete(':id')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CalendarRevisionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.remove(id, query.revision, actor);
  }
}
