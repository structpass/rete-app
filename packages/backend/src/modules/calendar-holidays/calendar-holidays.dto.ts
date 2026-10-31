import { Transform } from 'class-transformer';
import { IsISO8601, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CalendarHolidayDateDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  date!: string;
}

export class SaveCalendarHolidayDto extends CalendarHolidayDateDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
