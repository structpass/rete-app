import type { AuthenticatedUser } from '../auth/auth.service';
import type { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { calendarInstant, CalendarEventsService } from './calendar-events.service';
import type { CalendarEventsRepository } from './calendar-events.repository';
describe('CalendarEventsService', () => {
  const repo = { findRange: jest.fn(), findById: jest.fn(), save: jest.fn(), remove: jest.fn() };
  let service: CalendarEventsService;
  beforeEach(() => {
    service = new CalendarEventsService(
      repo as unknown as CalendarEventsRepository,
      { record: jest.fn() } as unknown as AuditRecorderService,
    );
  });
  it.each(['2026-10-24T09:00', '2026-10-24T09:00:01+09:00', '2026-10-24T09:00:00.001Z', 'invalid'])(
    'rejects ambiguous/non-minute instant %s',
    (value) => {
      expect(() => calendarInstant(value)).toThrow(BadRequestException);
    },
  );
  it('accepts a minute instant with a zero millisecond ISO suffix', () => {
    expect(calendarInstant('2026-10-24T00:00:00.000Z').toISOString()).toBe(
      '2026-10-24T00:00:00.000Z',
    );
  });
  it('does not silently return a truncated range', async () => {
    repo.findRange.mockResolvedValue(new Array(2001));
    await expect(
      service.findAll({ from: '2026-10-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }),
    ).rejects.toThrow(UnprocessableEntityException);
  });
  it('rejects invalid and excessive ranges before querying', async () => {
    await expect(
      service.findAll({ from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.findAll({ from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }),
    ).rejects.toThrow(BadRequestException);
    expect(repo.findRange).not.toHaveBeenCalled();
  });
  it('rejects reversed dates before saving', async () => {
    await expect(
      service.save(
        { id: 'actor', name: 'tester', email: 'test@example.com' } as AuthenticatedUser,
        {
          title: 'test',
          startAt: '2026-10-24T10:00:00+09:00',
          endAt: '2026-10-24T09:00:00+09:00',
        },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });
  it('does not retry or overwrite a conflicting delete', async () => {
    repo.remove.mockResolvedValue('conflict');
    await expect(
      service.remove('id', 1, {
        id: 'actor',
        name: 'tester',
        email: 'test@example.com',
      } as AuthenticatedUser),
    ).rejects.toThrow(ConflictException);
    expect(repo.remove).toHaveBeenCalledTimes(1);
  });
});
