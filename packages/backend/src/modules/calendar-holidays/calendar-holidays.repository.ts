import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { CalendarHolidaySource } from './calendar-holidays.mapper';

/** 保存の結果。理由は Repository が返し、応答（404・409）の文言は Service が決める。 */
export type CalendarHolidaySaveResult =
  | { row: CalendarHolidaySource }
  | { error: 'missing' | 'duplicate' };

@Injectable()
export class CalendarHolidaysRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.calendarHoliday.findMany({ orderBy: { date: 'asc' } });
  }
  /**
   * 同じ日付が既にあれば `duplicate`。先に読めば DB へ書かずに返せるが、同時に登録した
   * 競争では日付の一意制約（主キー）が P2002 で止める。その例外はここで握りつぶさず
   * そのまま投げ、案内文は呼び手（Service）が withUniqueConflictMessage で添える
   * （文言を持つのは Service の 1 か所だけにする・d1047）。
   */
  async create(date: Date, name: string): Promise<CalendarHolidaySaveResult> {
    const existing = await this.prisma.calendarHoliday.findUnique({ where: { date } });
    if (existing) return { error: 'duplicate' };
    return { row: await this.prisma.calendarHoliday.create({ data: { date, name } }) };
  }
  /**
   * 元の日付の行が無ければ `missing`、変更先の日付に別の行があれば `duplicate`。
   * 保存は 1 回の更新で行い、元の行を消してから作り直さない（途中で失敗しても元を失わない）。
   * 変更先が同時に埋まった時の P2002 は create と同じく呼び手が案内文を添える。
   */
  async update(original: Date, date: Date, name: string): Promise<CalendarHolidaySaveResult> {
    const existing = await this.prisma.calendarHoliday.findUnique({ where: { date: original } });
    if (!existing) return { error: 'missing' };
    if (+date !== +original) {
      const taken = await this.prisma.calendarHoliday.findUnique({ where: { date } });
      if (taken) return { error: 'duplicate' };
    }
    return {
      row: await this.prisma.calendarHoliday.update({
        where: { date: original },
        data: { date, name },
      }),
    };
  }
  /** 行が無ければ `missing`（Prisma の未検出例外を投げない）。 */
  async remove(date: Date): Promise<'ok' | 'missing'> {
    const deleted = await this.prisma.calendarHoliday.deleteMany({ where: { date } });
    return deleted.count ? 'ok' : 'missing';
  }
}
