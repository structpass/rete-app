import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class CalendarHolidaysRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.calendarHoliday.findMany({ orderBy: { date: 'asc' } });
  }
  create(date: Date, name: string) {
    return this.prisma.calendarHoliday.create({ data: { date, name } });
  }
  update(original: Date, date: Date, name: string) {
    return this.prisma.calendarHoliday.update({ where: { date: original }, data: { date, name } });
  }
  remove(date: Date) {
    return this.prisma.calendarHoliday.delete({ where: { date } });
  }
}
