import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service';
import type { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import {
  CreateCalendarEventDto,
  UpdateCalendarEventDto,
  FindCalendarEventsDto,
} from './calendar-events.dto';
import { CalendarEventsRepository } from './calendar-events.repository';
import { CalendarEventsService } from './calendar-events.service';
import type { PrismaService } from '../../database/prisma.service';
jest.mock('../../common/database/serializable-tx', () => ({
  INTERACTIVE_SAVE_TX_OPTIONS: {},
  runInSerializableTransaction: (tx: unknown, work: (tx: unknown) => unknown) => work(tx),
}));
const first = '00000000-0000-4000-8000-000000000001',
  second = '00000000-0000-4000-8000-000000000002';
const fields = {
  title: '予定',
  startAt: '2026-10-25T09:00:00+09:00',
  endAt: '2026-10-25T10:00:00+09:00',
};
const actor = { id: 'actor', name: 'tester', email: 'test@example.com' } as AuthenticatedUser;
describe('one calendar tag contract', () => {
  it.each([undefined, [], [first]])('accepts zero or one tag %s', (tagIds) => {
    expect(
      validateSync(plainToInstance(CreateCalendarEventDto, { ...fields, tagIds })),
    ).toHaveLength(0);
    expect(
      validateSync(plainToInstance(UpdateCalendarEventDto, { tagIds, revision: 1 })),
    ).toHaveLength(0);
  });
  it.each([[first, second], null, 'invalid'])('rejects invalid assignment %s', (tagIds) => {
    expect(
      validateSync(plainToInstance(CreateCalendarEventDto, { ...fields, tagIds })).some(
        (e) => e.property === 'tagIds',
      ),
    ).toBe(true);
    expect(
      validateSync(plainToInstance(UpdateCalendarEventDto, { tagIds, revision: 1 })).some(
        (e) => e.property === 'tagIds',
      ),
    ).toBe(true);
  });
  it('keeps the multi-tag search filter independent from the assignment limit', () => {
    expect(
      validateSync(
        plainToInstance(FindCalendarEventsDto, {
          from: fields.startAt,
          to: fields.endAt,
          tagIds: [first, second],
        }),
      ),
    ).toHaveLength(0);
  });
  it('rejects multiple tags before reaching the repository even without DTO validation', async () => {
    const repo = { save: jest.fn(), findById: jest.fn() };
    const service = new CalendarEventsService(
      repo as unknown as CalendarEventsRepository,
      { record: jest.fn() } as unknown as AuditRecorderService,
    );
    await expect(service.save(actor, { ...fields, tagIds: [first, second] })).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });
  function fixture() {
    const tx = {
      calendarEvent: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ revision: 1, tagAssignments: [{ tagId: first }] }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'event' }),
      },
      // 問い合わせた id のうち、登録に在るものを返す。既定は 2 タグとも「選べる」。
      announcementTag: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
          [
            { id: first, archivedAt: null },
            { id: second, archivedAt: null },
          ].filter((t) => where.id.in.includes(t.id)),
        ),
      },
      calendarEventTagAssignment: { deleteMany: jest.fn(), createMany: jest.fn() },
    };
    const repo = new CalendarEventsRepository(tx as unknown as PrismaService);
    const data = {
      title: '変更',
      startAt: new Date(fields.startAt),
      endAt: new Date(fields.endAt),
      allDay: false,
      memo: '',
    };
    return { tx, repo, data };
  }
  it('retains the existing one-tag assignment for a partial update', async () => {
    const { tx, repo, data } = fixture();
    await expect(repo.save('event', 'actor', data, 1)).resolves.toEqual({ row: { id: 'event' } });
    expect(tx.calendarEventTagAssignment.createMany).toHaveBeenCalledWith({
      data: [{ eventId: 'event', tagId: first }],
    });
  });
  it('rejects a direct repository write of multiple tags before any mutation', async () => {
    const { tx, repo, data } = fixture();
    await expect(
      repo.save('event', 'actor', { ...data, tagIds: [first, second] }, 1),
    ).resolves.toEqual({ error: 'tag-limit' });
    expect(tx.calendarEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.calendarEventTagAssignment.deleteMany).not.toHaveBeenCalled();
  });
  // 上限の判定は Service の入り口 1 か所に寄せる（d924）。Repository の失敗は理由を分けて返し、
  // 件数超えと選べないタグが同じ文言の 400 にならないようにする。
  async function saveWithRepoError(error: string) {
    const repo = {
      save: jest.fn().mockResolvedValue({ error }),
      findById: jest.fn(),
    };
    const service = new CalendarEventsService(
      repo as unknown as CalendarEventsRepository,
      { record: jest.fn() } as unknown as AuditRecorderService,
    );
    const thrown = await service.save(actor, { ...fields }).catch((e: unknown) => e);
    return { repo, thrown };
  }
  it('件数超えと選べないタグで、同じ文言の 400 を返さない', async () => {
    const limit = await saveWithRepoError('tag-limit');
    const missing = await saveWithRepoError('tag-missing');
    const archived = await saveWithRepoError('tag-archived');
    expect(limit.repo.save).toHaveBeenCalled();
    for (const { thrown } of [limit, missing, archived])
      expect(thrown).toBeInstanceOf(BadRequestException);
    const message = (thrown: unknown) => (thrown as BadRequestException).message;
    expect(message(limit.thrown)).toBe('予定に設定できるタグは1つまでです');
    expect(message(missing.thrown)).toBe('選択できないタグが含まれています');
    expect(message(archived.thrown)).toBe('選択できないタグが含まれています');
    expect(message(limit.thrown)).not.toBe(message(missing.thrown));
  });
  it('1 タグでも登録に無いタグは tag-missing を返す（上限の防衛はここより前の Service が持つ）', async () => {
    const { tx, repo, data } = fixture();
    tx.announcementTag.findMany.mockResolvedValue([]);
    await expect(repo.save('event', 'actor', { ...data, tagIds: [first] }, 1)).resolves.toEqual({
      error: 'tag-missing',
    });
  });
  // アーカイブ済みでも、既に付いているタグは外さずに更新できる（例外）。新しく付けることはできない。
  const archivedTag = { id: first, archivedAt: new Date('2026-10-01T00:00:00Z') };
  it('既に付いているアーカイブ済みタグは外さずに更新できる（tag-archived にしない）', async () => {
    const { tx, repo, data } = fixture();
    tx.announcementTag.findMany.mockResolvedValue([archivedTag]);
    await expect(repo.save('event', 'actor', data, 1)).resolves.toEqual({ row: { id: 'event' } });
    expect(tx.calendarEventTagAssignment.createMany).toHaveBeenCalledWith({
      data: [{ eventId: 'event', tagId: first }],
    });
  });
  it('新しく付けるアーカイブ済みタグは、タグ不在と区別して tag-archived を返す', async () => {
    const { tx, repo, data } = fixture();
    tx.calendarEvent.findUnique.mockResolvedValue({ revision: 1, tagAssignments: [] });
    tx.announcementTag.findMany.mockResolvedValue([archivedTag]);
    await expect(repo.save('event', 'actor', { ...data, tagIds: [first] }, 1)).resolves.toEqual({
      error: 'tag-archived',
    });
    expect(tx.calendarEvent.updateMany).not.toHaveBeenCalled();
  });
  // アーカイブの仕様は非 null = アーカイブ済（schema.prisma のコメント）で、時刻の値ではない。
  // 時刻が持つ情報なら偽扱いになり得る最小値（1970-01-01T00:00:00.000Z）でも判定が変わらないことを固定する。
  const epochArchived = { id: second, archivedAt: new Date(0) };
  it('エポックのアーカイブ（1970-01-01T00:00:00.000Z）も、非 null なら選べないタグとして扱う', async () => {
    const { tx, repo, data } = fixture();
    tx.announcementTag.findMany.mockResolvedValue([epochArchived]);
    await expect(repo.save('event', 'actor', { ...data, tagIds: [second] }, 1)).resolves.toEqual({
      error: 'tag-archived',
    });
    expect(tx.calendarEvent.updateMany).not.toHaveBeenCalled();
  });
  it('エポックのアーカイブでも、既に付いているタグは外さずに更新できる', async () => {
    const { tx, repo, data } = fixture();
    tx.calendarEvent.findUnique.mockResolvedValue({
      revision: 1,
      tagAssignments: [{ tagId: second }],
    });
    tx.announcementTag.findMany.mockResolvedValue([epochArchived]);
    await expect(repo.save('event', 'actor', data, 1)).resolves.toEqual({ row: { id: 'event' } });
  });
});
