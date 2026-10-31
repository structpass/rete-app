import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateCalendarEventDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;
  @IsISO8601({ strict: true }) startAt!: string;
  @IsISO8601({ strict: true }) endAt!: string;
  @ValidateIf((_, value: unknown) => value !== undefined) @IsBoolean() allDay?: boolean;
  @IsOptional() @IsString() @MaxLength(20000) memo?: string;
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(1)
  @IsUUID('all', { each: true })
  tagIds?: string[];
}
export class UpdateCalendarEventDto extends PartialType(CreateCalendarEventDto, {
  skipNullProperties: false,
}) {
  @IsInt() @Min(1) revision!: number;
}
export class CalendarRevisionDto {
  @Type(() => Number) @IsInt() @Min(1) revision!: number;
}
export class FindCalendarEventsDto {
  @IsISO8601({ strict: true }) from!: string;
  @IsISO8601({ strict: true }) to!: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  tagIds?: string[];
}
