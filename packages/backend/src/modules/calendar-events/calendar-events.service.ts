import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import { AUDIT_RETE_SYSTEM_NAME } from '../audit-logs/audit-logs.constants';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ok, okMessage } from '../../common/dto';
import { CalendarEventsRepository } from './calendar-events.repository';
import {
  CreateCalendarEventDto,
  FindCalendarEventsDto,
  UpdateCalendarEventDto,
} from './calendar-events.dto';
import { toCalendarEventDetail, toCalendarEventSummary } from './calendar-events.mapper';

export function calendarInstant(value: string) {
  const date = new Date(value);
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(+date) ||
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0
  )
    throw new BadRequestException('日時を分単位で指定してください');
  return date;
}
// 予定に付けるタグの上限はここ 1 か所で判定する（d924）。Repository の判定は取引の中の最終防衛で、
// 理由（件数超え／タグが無い／アーカイブ済み）を分けて返し、応答の文言はこの Service が決める。
function validateCalendarTagSelection(tagIds: unknown) {
  if (tagIds !== undefined && (!Array.isArray(tagIds) || tagIds.length > 1))
    throw new BadRequestException('予定に設定できるタグは1つまでです');
}
@Injectable()
export class CalendarEventsService {
  constructor(
    private readonly repo: CalendarEventsRepository,
    private readonly audit: AuditRecorderService,
  ) {}
  async findAll(query: FindCalendarEventsDto) {
    const from = calendarInstant(query.from),
      to = calendarInstant(query.to);
    if (+from >= +to || +to - +from > 100 * 86400000)
      throw new BadRequestException('表示期間を100日以内で指定してください');
    // 端ちょうどの予定を落とさないよう、前後を 1 ミリ秒広げて問い合わせる（d883）。
    const rows = await this.repo.findRange(
      new Date(+from - 1),
      new Date(+to + 1),
      query.q?.trim() ?? '',
      query.tagIds ?? [],
    );
    if (rows.length > 2000)
      throw new UnprocessableEntityException(
        '予定が多いため、週表示または検索で絞り込んでください',
      );
    return ok(rows.map(toCalendarEventSummary));
  }
  async findOne(id: string) {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('予定が見つかりません');
    return ok(toCalendarEventDetail(row));
  }
  async save(
    actor: AuthenticatedUser,
    dto: CreateCalendarEventDto | UpdateCalendarEventDto,
    id?: string,
  ) {
    validateCalendarTagSelection(dto.tagIds);
    const existing = id ? (await this.findOne(id)).data : undefined;
    const startAt = calendarInstant(dto.startAt ?? existing!.startAt),
      endAt = calendarInstant(dto.endAt ?? existing!.endAt);
    if (+endAt <= +startAt) throw new BadRequestException('終了日時は開始日時より後にしてください');
    if (dto.allDay !== undefined && typeof dto.allDay !== 'boolean')
      throw new BadRequestException('終日は真偽値で指定してください');
    const allDay = dto.allDay ?? existing?.allDay ?? false;
    if (typeof allDay !== 'boolean')
      throw new BadRequestException('終日は真偽値で指定してください');
    if (
      allDay &&
      [startAt, endAt].some((date) => date.getUTCHours() !== 15 || date.getUTCMinutes() !== 0)
    )
      throw new BadRequestException('終日の開始・終了日時は日本時間の0時で指定してください');
    const title = (dto.title ?? existing!.title).trim();
    if (!title) throw new BadRequestException('件名を入力してください');
    const result = await this.repo.save(
      id,
      actor.id,
      { title, startAt, endAt, allDay, memo: dto.memo ?? existing?.memo ?? '', tagIds: dto.tagIds },
      'revision' in dto ? dto.revision : undefined,
    );
    if (result.error === 'missing') throw new NotFoundException('予定が見つかりません');
    if (result.error === 'conflict')
      throw new ConflictException('他のユーザーが更新しました。最新の予定を確認してください');
    if (result.error === 'tag-limit')
      throw new BadRequestException('予定に設定できるタグは1つまでです');
    if (result.error === 'tag-missing' || result.error === 'tag-archived')
      throw new BadRequestException('選択できないタグが含まれています');
    await this.audit.record({
      actorAccountId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      feature: 'カレンダー',
      actionType: id ? 'update' : 'create',
      summary: id ? '予定を更新' : '予定を登録',
      details: {
        eventId: result.row!.id,
        changedFields: Object.keys(dto).filter((k) => k !== 'revision'),
      },
    });
    return ok(toCalendarEventDetail(result.row!));
  }
  async remove(id: string, revision: number, actor: AuthenticatedUser) {
    const result = await this.repo.remove(id, revision);
    if (result === 'missing') throw new NotFoundException('予定が見つかりません');
    if (result === 'conflict')
      throw new ConflictException('他のユーザーが更新しました。最新の予定を確認してください');
    await this.audit.record({
      actorAccountId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      feature: 'カレンダー',
      actionType: 'delete',
      summary: '予定を削除',
      details: { eventId: id },
    });
    return okMessage('予定を削除しました');
  }
}
