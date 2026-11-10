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
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Role } from '@rete/shared';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CalendarHolidayDateDto, SaveCalendarHolidayDto } from './calendar-holidays.dto';
import { CalendarHolidaysService } from './calendar-holidays.service';

// 日付は入力の形（YYYY-MM-DD）でも @Param でも同じ検証を通す。形の違う日付は DB まで渡さず 400、
// 存在しない日付は 404 で返す（検証も分岐も無いと 500 になり、画面には理由が伝わらない）。
//
// @Param の DTO は URL から作られるため、クラス単位で新しい検証設定を張ると、グローバル（main.ts の
// whitelist + forbidNonWhitelisted + transform）より先に走って受け付けのルールが場所ごとに変わる
// （d1023。ここで whitelist だけを張ると、この配下では未知キーを 400 にしない弱い検証になる）。
// そのため受け付けのルールはグローバルに任せ、この controller は何も上書きしない。
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
  // パラメータの DTO 検証だけを、受け付けのルールを変えない素の形で行う（変換もしない）。
  @Patch(':date')
  @Roles(Role.ADMIN)
  @UsePipes(new ValidationPipe())
  update(@Param() params: CalendarHolidayDateDto, @Body() dto: SaveCalendarHolidayDto) {
    return this.service.update(params.date, dto);
  }
  // 同上（d1023）。グローバルの変換・未知キーの拒否はそのまま効く。
  @Delete(':date')
  @Roles(Role.ADMIN)
  @HttpCode(204)
  @UsePipes(new ValidationPipe())
  remove(@Param() params: CalendarHolidayDateDto) {
    return this.service.remove(params.date);
  }
}
