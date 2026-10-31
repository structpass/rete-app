import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Role } from '@rete/shared';
import { CalendarHolidaysController } from './calendar-holidays.controller';
import { CalendarHolidayDateDto, SaveCalendarHolidayDto } from './calendar-holidays.dto';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

describe('Calendar holidays API boundary', () => {
  const roles = new RolesGuard(new Reflector());
  function context(method: keyof CalendarHolidaysController, role?: Role): ExecutionContext {
    return {
      getHandler: () => CalendarHolidaysController.prototype[method],
      getClass: () => CalendarHolidaysController,
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { role } : undefined, isAuthenticated: () => !!role }),
      }),
    } as unknown as ExecutionContext;
  }
  it('requires authentication while allowing members to read the master', () => {
    expect(() => new AuthenticatedGuard().canActivate(context('findAll'))).toThrow(
      UnauthorizedException,
    );
    expect(new AuthenticatedGuard().canActivate(context('findAll', Role.MEMBER))).toBe(true);
    expect(roles.canActivate(context('findAll', Role.MEMBER))).toBe(true);
  });
  it.each(['create', 'update', 'remove'] as const)('%s requires ADMIN', (method) => {
    expect(() => roles.canActivate(context(method, Role.MEMBER))).toThrow(ForbiddenException);
    expect(roles.canActivate(context(method, Role.ADMIN))).toBe(true);
  });
  it.each(['2026-02-30', '2026-13-01', '2026-1-1', '2026-01-01T00:00:00Z'])(
    'rejects invalid date-only input %s',
    async (date) => {
      expect(
        (await validate(plainToInstance(CalendarHolidayDateDto, { date }))).length,
      ).toBeGreaterThan(0);
    },
  );
  it('trims names and rejects blank names', async () => {
    const good = plainToInstance(SaveCalendarHolidayDto, { date: '2026-01-01', name: ' 元日 ' });
    expect(await validate(good)).toHaveLength(0);
    expect(good.name).toBe('元日');
    expect(
      (await validate(plainToInstance(SaveCalendarHolidayDto, { date: '2026-01-01', name: '　 ' })))
        .length,
    ).toBeGreaterThan(0);
  });
});
