import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  runInSerializableTransaction,
  INTERACTIVE_SAVE_TX_OPTIONS,
} from '../../common/database/serializable-tx';
import { calendarTagSelect, type CalendarSummarySource } from './calendar-events.mapper';

const detailInclude = {
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
  // タグは DTO に要る列だけ read し、形づくりは calendar-events.mapper に委ねる（d814）。
  tagAssignments: { select: { tag: { select: calendarTagSelect } } },
} as const;
export type CalendarDetailRow = Prisma.CalendarEventGetPayload<{ include: typeof detailInclude }>;
/** 一覧の行（応答の形は mapper が組む・d814）。 */
export type CalendarSummaryRow = CalendarSummarySource;
export interface CalendarSaveData {
  title: string;
  startAt: Date;
  endAt: Date;
  /** 終日の印。渡さない呼び出し（従来の登録・更新）では今の値を保つ。 */
  allDay?: boolean;
  memo: string;
  tagIds?: string[];
}

@Injectable()
export class CalendarEventsRepository {
  constructor(private readonly prisma: PrismaService) {}
  /**
   * 表示期間に入る予定を、付与タグ（DTO に要る列だけ）と一緒に返す。
   * 応答の形はここで組まず、タグは付与行（tagAssignments[].tag）のまま渡す（形づくりは
   * calendar-events.mapper・d814）。予定とタグは 1 つの問い合わせで取るので、行とタグが
   * 食い違わず、タグの並びもここで決める（DTO の並びを安定させるため name 昇順）。
   * 上限 2001 件は従来と同じ（超えた時の案内は Service が返す）。
   * 期間の絞りは 2 本の条件に分け、それぞれ索引で読める形にする（d883）: 「期間の中で始まる
   * 予定」は start_at の範囲、「期間より前に始まり、期間の中でも続いている予定」は end_at の
   * 範囲で引く。1 つの AND（start_at < to かつ end_at > from）にすると B-tree の索引が
   * 片端しか効かず、件数が増えると表の全走査に近づく。
   * 前後は Service が 1 ミリ秒広げて渡す（端ちょうどの予定がどちらの条件からも落ちないように）。
   */
  findRange(from: Date, to: Date, q: string, tagIds: string[]): Promise<CalendarSummaryRow[]> {
    const text = q.trim();
    return this.prisma.calendarEvent.findMany({
      where: {
        OR: [{ startAt: { gte: from, lt: to } }, { startAt: { lt: from }, endAt: { gt: from } }],
        ...(text
          ? {
              AND: [
                {
                  OR: [
                    { title: { contains: text, mode: 'insensitive' } },
                    { memo: { contains: text, mode: 'insensitive' } },
                  ],
                },
              ],
            }
          : {}),
        ...(tagIds.length ? { tagAssignments: { some: { tagId: { in: tagIds } } } } : {}),
      },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        allDay: true,
        revision: true,
        tagAssignments: {
          select: { tag: { select: calendarTagSelect } },
          orderBy: { tag: { name: 'asc' } },
        },
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      take: 2001,
    });
  }
  findById(id: string) {
    return this.prisma.calendarEvent.findUnique({ where: { id }, include: detailInclude });
  }
  save(id: string | undefined, accountId: string, data: CalendarSaveData, revision?: number) {
    return runInSerializableTransaction(
      this.prisma,
      async (tx) => {
        const existing = id
          ? await tx.calendarEvent.findUnique({ where: { id }, include: { tagAssignments: true } })
          : null;
        if (id && !existing) return { error: 'missing' as const };
        if (existing && existing.revision !== revision) return { error: 'conflict' as const };
        const tagIds = data.tagIds ?? existing?.tagAssignments.map((a) => a.tagId) ?? [];
        // 上限の判定は Service の入り口が持つ（d924）。ここは取引の中の最終防衛で、理由を分けて返し、
        // 件数超えと選べないタグが同じ文言の 400 にならないようにする。
        if (tagIds.length > 1) return { error: 'tag-limit' as const };
        const tags = await tx.announcementTag.findMany({
          where: { id: { in: tagIds }, kind: 'calendar' },
        });
        const keepable = new Set(existing?.tagAssignments.map((a) => a.tagId) ?? []);
        // 選べないタグを理由ごとに分けて返す（d924）。アーカイブは仕様どおり「非 null = アーカイブ済」
        // で判定し、時刻の値は見ない（schema.prisma のコメント）。
        if (tags.some((t) => t.archivedAt !== null && !keepable.has(t.id)))
          return { error: 'tag-archived' as const };
        if (tags.length !== tagIds.length) return { error: 'tag-missing' as const };
        const values = {
          title: data.title,
          startAt: data.startAt,
          endAt: data.endAt,
          // 終日の印は渡された時だけ書く（渡さない更新で今の値を消さない）。
          ...(data.allDay !== undefined ? { allDay: data.allDay } : {}),
          memo: data.memo,
          updatedById: accountId,
        };
        if (existing) {
          const changed = await tx.calendarEvent.updateMany({
            where: { id, revision },
            data: { ...values, revision: { increment: 1 } },
          });
          if (!changed.count) return { error: 'conflict' as const };
          await tx.calendarEventTagAssignment.deleteMany({ where: { eventId: id } });
          await tx.calendarEventTagAssignment.createMany({
            data: tagIds.map((tagId) => ({ eventId: id!, tagId })),
          });
          return {
            row: await tx.calendarEvent.findUniqueOrThrow({
              where: { id },
              include: detailInclude,
            }),
          };
        }
        return {
          row: await tx.calendarEvent.create({
            data: {
              ...values,
              createdById: accountId,
              tagAssignments: { create: tagIds.map((tagId) => ({ tagId })) },
            },
            include: detailInclude,
          }),
        };
      },
      INTERACTIVE_SAVE_TX_OPTIONS,
    );
  }
  remove(id: string, revision: number) {
    return runInSerializableTransaction(
      this.prisma,
      async (tx) => {
        const existing = await tx.calendarEvent.findUnique({
          where: { id },
          select: { revision: true },
        });
        if (!existing) return 'missing' as const;
        if (existing.revision !== revision) return 'conflict' as const;
        const deleted = await tx.calendarEvent.deleteMany({ where: { id, revision } });
        return deleted.count ? ('ok' as const) : ('conflict' as const);
      },
      INTERACTIVE_SAVE_TX_OPTIONS,
    );
  }
}
