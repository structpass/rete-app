import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ok } from '../../common/dto';
import { withUniqueConflictMessage } from '../../common/filters/unique-conflict-context';
import { CalendarHolidaysRepository } from './calendar-holidays.repository';
import type { SaveCalendarHolidayDto } from './calendar-holidays.dto';
import { toCalendarHolidayDate, toCalendarHolidayResponse } from './calendar-holidays.mapper';

// 祝日は同じ日付を 1 行しか持てない（日付が主キー）。理由は他の一覧系と同じく 404・409 で返す。
// 文言はこの service の 1 か所だけに置く（Repository は文言を持たない・d1047）。
const NOT_FOUND_MESSAGE = '祝日が見つかりません';
const DUPLICATE_MESSAGE = 'その日付の祝日は既に登録されています';

@Injectable()
export class CalendarHolidaysService {
  constructor(private readonly repository: CalendarHolidaysRepository) {}
  async findAll() {
    return ok((await this.repository.findAll()).map(toCalendarHolidayResponse));
  }
  async create(dto: SaveCalendarHolidayDto) {
    // 同時登録の競争で出る一意制約違反（P2002）も、同じ案内文で 409 にする。
    const result = await withUniqueConflictMessage(
      () => this.repository.create(toCalendarHolidayDate(dto.date), dto.name),
      DUPLICATE_MESSAGE,
    );
    if ('error' in result) throw new ConflictException(DUPLICATE_MESSAGE);
    return ok(toCalendarHolidayResponse(result.row));
  }
  async update(original: string, dto: SaveCalendarHolidayDto) {
    const result = await withUniqueConflictMessage(
      () =>
        this.repository.update(
          toCalendarHolidayDate(original),
          toCalendarHolidayDate(dto.date),
          dto.name,
        ),
      DUPLICATE_MESSAGE,
    );
    if ('error' in result && result.error === 'missing')
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    if ('error' in result) throw new ConflictException(DUPLICATE_MESSAGE);
    return ok(toCalendarHolidayResponse(result.row));
  }
  async remove(date: string): Promise<void> {
    const result = await this.repository.remove(toCalendarHolidayDate(date));
    if (result === 'missing') throw new NotFoundException(NOT_FOUND_MESSAGE);
  }
}
