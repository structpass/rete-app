import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service';
import type { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import { CalendarEventsService } from './calendar-events.service';
import { CreateCalendarEventDto, UpdateCalendarEventDto } from './calendar-events.dto';
import type { CalendarEventsRepository } from './calendar-events.repository';
const actor = { id: 'actor', name: 'test', email: 'test@example.com' } as AuthenticatedUser;
const row = {
  id: 'event',
  title: '終日',
  allDay: true,
  startAt: new Date('2026-10-11T15:00:00Z'),
  endAt: new Date('2026-10-14T15:00:00Z'),
  memo: '',
  revision: 1,
  createdBy: { id: 'actor', name: 'test' },
  updatedBy: { id: 'actor', name: 'test' },
  createdAt: new Date(),
  updatedAt: new Date(),
  tagAssignments: [],
};
describe('all-day calendar persistence and input', () => {
  const repo = { findById: jest.fn(), save: jest.fn(), findRange: jest.fn() };
  let service: CalendarEventsService;
  beforeEach(() => {
    repo.findById.mockResolvedValue(row);
    repo.save.mockImplementation((_id, _actor, data) => ({ row: { ...row, ...data } }));
    service = new CalendarEventsService(
      repo as unknown as CalendarEventsRepository,
      { record: jest.fn() } as unknown as AuditRecorderService,
    );
  });
  it('saves and returns all-day midnight boundaries', async () => {
    const response = await service.save(actor, {
      title: '終日',
      allDay: true,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
    });
    expect(response.data.allDay).toBe(true);
    expect(response.data.endAt).toBe('2026-10-14T15:00:00.000Z');
    expect(repo.save).toHaveBeenCalledWith(
      undefined,
      'actor',
      expect.objectContaining({ allDay: true, startAt: row.startAt, endAt: row.endAt }),
      undefined,
    );
  });
  it('preserves all-day status on a title-only partial update', async () => {
    const response = await service.save(actor, { title: '変更', revision: 1 }, 'event');
    expect(response.data.allDay).toBe(true);
    expect(repo.save).toHaveBeenCalledWith(
      'event',
      'actor',
      expect.objectContaining({ allDay: true, startAt: row.startAt, endAt: row.endAt }),
      1,
    );
  });
  it('defaults an old timed client to false', async () => {
    const response = await service.save(actor, {
      title: '時刻指定',
      startAt: '2026-10-12T09:00:00+09:00',
      endAt: '2026-10-12T10:00:00+09:00',
    });
    expect(response.data.allDay).toBe(false);
  });
  it('allows changing all-day back to a timed appointment', async () => {
    const response = await service.save(
      actor,
      {
        allDay: false,
        startAt: '2026-10-12T09:00:00+09:00',
        endAt: '2026-10-12T10:00:00+09:00',
        revision: 1,
      },
      'event',
    );
    expect(response.data.allDay).toBe(false);
  });
  it.each(['2026-10-12T00:00:00Z', '2026-10-12T00:15:00+09:00'])(
    'rejects a non-midnight JST boundary %s',
    async (startAt) => {
      await expect(
        service.save(actor, {
          title: '不正',
          allDay: true,
          startAt,
          endAt: row.endAt.toISOString(),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    },
  );
  it.each([null, 'true', 1])('rejects an invalid flag %s on create and update', async (allDay) => {
    const fields = {
      title: '不正',
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      allDay,
    };
    expect(
      validateSync(plainToInstance(CreateCalendarEventDto, fields)).some(
        (error) => error.property === 'allDay',
      ),
    ).toBe(true);
    expect(
      validateSync(plainToInstance(UpdateCalendarEventDto, { ...fields, revision: 1 })).some(
        (error) => error.property === 'allDay',
      ),
    ).toBe(true);
    await expect(service.save(actor, fields as unknown as CreateCalendarEventDto)).rejects.toThrow(
      BadRequestException,
    );
  });
});
