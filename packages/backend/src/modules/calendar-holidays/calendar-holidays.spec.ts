import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Role } from '@rete/shared';
import { CalendarHolidaysController } from './calendar-holidays.controller';
import { CalendarHolidayDateDto, SaveCalendarHolidayDto } from './calendar-holidays.dto';
import { CalendarHolidaysRepository } from './calendar-holidays.repository';
import { CalendarHolidaysService } from './calendar-holidays.service';
import { toCalendarHolidayDate } from './calendar-holidays.mapper';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaExceptionFilter } from '../../common/filters/prisma-exception.filter';
import { getUniqueConflictMessage } from '../../common/filters/unique-conflict-context';
import type { PrismaService } from '../../database/prisma.service';

function prismaDouble() {
  return {
    calendarHoliday: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
  };
}
function repository(prisma: ReturnType<typeof prismaDouble>) {
  return new CalendarHolidaysRepository(prisma as unknown as PrismaService);
}
const holiday = (date: string, name: string) => ({ date: toCalendarHolidayDate(date), name });

describe('祝日の登録・変更・削除の理由分け（d974）', () => {
  // 頼まれた 3 つの理由（存在しない日付・既存日への変更・同時更新）が、500 ではなく 400・404・409 で返る。
  it('既にある日付の登録は 409 で理由を返し、DB へは書かない', async () => {
    const prisma = prismaDouble();
    prisma.calendarHoliday.findUnique.mockResolvedValue(holiday('2026-01-01', '元日'));
    const service = new CalendarHolidaysService(repository(prisma));

    await expect(service.create({ date: '2026-01-01', name: '元日' })).rejects.toThrow(
      new ConflictException('その日付の祝日は既に登録されています'),
    );
    expect(prisma.calendarHoliday.create).not.toHaveBeenCalled();
  });

  it('同時に同じ日付を登録した競争は、一意制約の例外が同じ案内文の 409 になる', async () => {
    const prisma = prismaDouble();
    prisma.calendarHoliday.findUnique.mockResolvedValue(null);
    const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['date'] },
    });
    prisma.calendarHoliday.create.mockRejectedValue(error);

    // 文言を添えるのは service（d1047）なので、repository ではなく service を通して確かめる。
    await expect(
      new CalendarHolidaysService(repository(prisma)).create({
        date: '2026-01-01',
        name: '元日',
      }),
    ).rejects.toBe(error);
    // 共通 filter はこの案内文を 409 の応答へ載せる（DB の制約名は出さない）。
    expect(getUniqueConflictMessage(error)).toBe('その日付の祝日は既に登録されています');
  });

  it('存在しない日付の変更は 404 で返し、DB を書き換えない', async () => {
    const prisma = prismaDouble();
    prisma.calendarHoliday.findUnique.mockResolvedValue(null);
    const service = new CalendarHolidaysService(repository(prisma));

    await expect(
      service.update('2026-02-01', { date: '2026-02-02', name: '振替休日' }),
    ).rejects.toThrow(new NotFoundException('祝日が見つかりません'));
    expect(prisma.calendarHoliday.update).not.toHaveBeenCalled();
  });

  it('既に祝日の日付へ変える変更は 409 で返し、元の行を書き換えない', async () => {
    const prisma = prismaDouble();
    prisma.calendarHoliday.findUnique
      .mockResolvedValueOnce(holiday('2026-02-01', '旧'))
      .mockResolvedValueOnce(holiday('2026-01-01', '元日'));
    const service = new CalendarHolidaysService(repository(prisma));

    await expect(
      service.update('2026-02-01', { date: '2026-01-01', name: '元日' }),
    ).rejects.toThrow(new ConflictException('その日付の祝日は既に登録されています'));
    expect(prisma.calendarHoliday.update).not.toHaveBeenCalled();
  });

  it('変更の最中に別の行が同じ日付で入った競争も、同じ案内文の 409 になる', async () => {
    // 事前の読み取りでは変更先が空いていて、書き込む直前に別の行が入る競争（d1047 の独立の目の指摘）。
    // 登録（create）と同じく、案内文を添えるのは service。
    const prisma = prismaDouble();
    prisma.calendarHoliday.findUnique
      .mockResolvedValueOnce(holiday('2026-02-01', '旧'))
      .mockResolvedValueOnce(null);
    const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['date'] },
    });
    prisma.calendarHoliday.update.mockRejectedValue(error);

    await expect(
      new CalendarHolidaysService(repository(prisma)).update('2026-02-01', {
        date: '2026-01-01',
        name: '元日',
      }),
    ).rejects.toBe(error);
    expect(getUniqueConflictMessage(error)).toBe('その日付の祝日は既に登録されています');
  });

  it('元と変更先が同じ日付なら、その行の名前の変更として通す', async () => {
    const prisma = prismaDouble();
    prisma.calendarHoliday.findUnique.mockResolvedValue(holiday('2026-01-01', '元日'));
    prisma.calendarHoliday.update.mockResolvedValue(holiday('2026-01-01', '元日・改'));
    const service = new CalendarHolidaysService(repository(prisma));

    await expect(
      service.update('2026-01-01', { date: '2026-01-01', name: '元日・改' }),
    ).resolves.toMatchObject({ data: { date: '2026-01-01', name: '元日・改' } });
  });

  it('存在しない日付の削除は 404 で返す', async () => {
    const prisma = prismaDouble();
    prisma.calendarHoliday.deleteMany.mockResolvedValue({ count: 0 });
    const service = new CalendarHolidaysService(repository(prisma));

    await expect(service.remove('2026-03-01')).rejects.toThrow(
      new NotFoundException('祝日が見つかりません'),
    );
    expect(prisma.calendarHoliday.deleteMany).toHaveBeenCalledWith({
      where: { date: toCalendarHolidayDate('2026-03-01') },
    });
  });

  it('ある日付の削除は何も投げずに終わる', async () => {
    const prisma = prismaDouble();
    prisma.calendarHoliday.deleteMany.mockResolvedValue({ count: 1 });
    const service = new CalendarHolidaysService(repository(prisma));

    await expect(service.remove('2026-03-01')).resolves.toBeUndefined();
  });
});

describe('祝日の対照試験（予定と同じ形で返るか）', () => {
  const pipe = new ValidationPipe({ whitelist: true });
  const paramMeta = { type: 'param' as const, metatype: CalendarHolidayDateDto, data: 'date' };
  // @Param() で受ける DTO は、呼び名（data）付きの日付が 1 つのオブジェクトとして渡る（{ date } の形）。
  const params = (date: string) => ({ [paramMeta.data]: date });

  it('形の違う URL の日付（2026-02-30）は 400 になり、DB まで渡らない', async () => {
    await expect(pipe.transform(params('2026-02-30'), paramMeta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('形の正しい URL の日付は通る', async () => {
    await expect(pipe.transform(params('2026-02-28'), paramMeta)).resolves.toMatchObject({
      date: '2026-02-28',
    });
  });

  it('一意制約の例外は、共通 filter が 409 の統一応答に載せる', async () => {
    const prisma = prismaDouble();
    prisma.calendarHoliday.findUnique.mockResolvedValue(null);
    const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.calendarHoliday.create.mockRejectedValue(error);
    // service を通す（案内文を添えるのは service・d1047）。
    const caught = await new CalendarHolidaysService(repository(prisma))
      .create({ date: '2026-01-01', name: '元日' })
      .catch((e: unknown) => e);
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
    new PrismaExceptionFilter().catch(
      caught as Prisma.PrismaClientKnownRequestError,
      {
        switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ url: '/x' }) }),
      } as unknown as ExecutionContext,
    );
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'CONFLICT', message: 'その日付の祝日は既に登録されています' },
    });
  });
});

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
  // 検証の配線（d1023）: 受け付けのルールはグローバル（whitelist + forbidNonWhitelisted + transform）に
  // 任せ、コントローラでは上書きしない。URL の日付を受けるハンドラだけに、ルールを変えない素の pipe を掛ける。
  it('コントローラ全体では検証のルールを上書きしない（グローバルに任せる）', () => {
    const pipes = Reflect.getMetadata('__pipes__', CalendarHolidaysController) ?? [];
    expect(pipes.some((p: unknown) => p instanceof ValidationPipe)).toBe(false);
  });

  it('URL の日付を受けるハンドラ（変更・削除）は素の検証の pipe を持つ', () => {
    const raw = readFileSync(join(__dirname, 'calendar-holidays.controller.ts'), 'utf8');
    const plainPipe = /@UsePipes\(new ValidationPipe\(\)\)/g;
    expect(raw.match(plainPipe)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // ルールを弱める設定（whitelist だけの上書き）が controller へ戻っていないこと。
    expect(raw.includes('new ValidationPipe({ whitelist: true })')).toBe(false);
  });
});
