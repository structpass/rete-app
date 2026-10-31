import toast from 'react-hot-toast';
import { createRescheduleAction } from './calendar-reschedule';
import type { CalendarEventDetail, CalendarEventSummary, HomePermissions } from '@rete/shared';
import { extractErrorMessage } from '@/lib/error-utils';
import { deleteCalendarEvent, fetchCalendarEvent, saveCalendarEvent } from './calendar-api';
import { addDays, localInput, overlaps, toInstant } from './calendar-dates';
import type {
  CalendarEditorOptions,
  CalendarEditorState,
  CalendarFormValues,
} from './use-calendar-editor';
type Permissions = HomePermissions & { refresh: () => Promise<void> };
export function calendarForm(event: CalendarEventDetail): CalendarFormValues {
  return {
    title: event.title,
    allDay: event.allDay,
    start: localInput(event.startAt),
    end: event.allDay
      ? `${addDays(localInput(event.endAt).slice(0, 10), -1)}T10:00`
      : localInput(event.endAt),
    memo: event.memo,
    tagIds: event.tags.map((t) => t.id),
  };
}
export function createEditorActions(
  s: CalendarEditorState,
  options: CalendarEditorOptions,
  permissions: Permissions,
  leave: (action: () => void) => void,
) {
  const refreshView = createRefreshAction(s, options);
  return {
    ...createSelectionActions(s, options, permissions, leave),
    save: createSaveAction(s, permissions, refreshView),
    remove: createDeleteAction(s, permissions, refreshView),
    reschedule: createRescheduleAction(s, permissions, leave, refreshView, (row) =>
      commitDetail(s, row),
    ),
    refreshView,
  };
}
function commitDetail(s: CalendarEditorState, row: CalendarEventDetail) {
  s.setDetail(row);
  const values = calendarForm(row);
  s.setForm(values);
  s.setInitial(values);
}
function createSelectionActions(
  s: CalendarEditorState,
  options: CalendarEditorOptions,
  permissions: Permissions,
  leave: (action: () => void) => void,
) {
  async function open(event: CalendarEventSummary, edit: boolean, key?: string) {
    leave(() => {
      void (async () => {
        const request = ++s.selection.current;
        s.setBusy(true);
        s.setError('');
        try {
          const row = await fetchCalendarEvent(event.id);
          if (request !== s.selection.current) return;
          commitDetail(s, row);
          s.setFocusTitle(true);
          s.setPanel(edit && permissions.calendarEdit ? 'edit' : 'view');
          if (key) options.selectDate(key);
        } catch (err) {
          s.setError(extractErrorMessage(err, '予定の取得に失敗しました'));
        } finally {
          if (request === s.selection.current) s.setBusy(false);
        }
      })();
    });
  }
  function create(day = options.active, preserveCalendarFocus = false) {
    if (!permissions.calendarEdit) return;
    leave(() => {
      const values = {
        title: '',
        allDay: false,
        start: day + 'T09:00',
        end: day + 'T10:00',
        memo: '',
        tagIds: [],
      };
      s.setForm(values);
      s.setInitial(values);
      s.setDetail(null);
      s.setError('');
      s.setFocusTitle(!preserveCalendarFocus);
      s.setPanel('create');
      if (!preserveCalendarFocus || day !== options.active) options.selectDate(day);
    });
  }
  return { open, create };
}
function createRefreshAction(s: CalendarEditorState, options: CalendarEditorOptions) {
  return async () => {
    const rows = await options.refresh();
    if (!rows) return false;
    s.setError('');
    if (
      s.saved.current &&
      !rows.some((e) => e.id === s.saved.current && overlaps(e, options.listFrom, options.listTo))
    )
      toast('表示条件の対象外です');
    s.saved.current = null;
    return true;
  };
}
function createSaveAction(
  s: CalendarEditorState,
  permissions: Permissions,
  refreshView: () => Promise<boolean>,
) {
  return async () => {
    if (s.busy || !permissions.calendarEdit) return;
    if (!s.form.title.trim()) {
      s.setError('件名を入力してください');
      return;
    }
    if (
      !s.form.start ||
      !s.form.end ||
      (s.form.allDay
        ? s.form.end.slice(0, 10) < s.form.start.slice(0, 10)
        : s.form.end <= s.form.start)
    ) {
      s.setError('終了日時は開始日時より後にしてください');
      return;
    }
    s.setBusy(true);
    s.setError('');
    try {
      const form = s.form;
      const input = {
        title: form.title.trim(),
        allDay: form.allDay,
        startAt: toInstant(form.allDay ? `${form.start.slice(0, 10)}T00:00` : form.start),
        endAt: toInstant(form.allDay ? `${addDays(form.end.slice(0, 10), 1)}T00:00` : form.end),
        memo: form.memo,
        tagIds: form.tagIds,
        ...(s.panel === 'edit' ? { revision: s.detail!.revision } : {}),
      };
      const row = await saveCalendarEvent(input, s.panel === 'edit' ? s.detail!.id : undefined);
      commitDetail(s, row);
      s.setPanel('view');
      s.saved.current = row.id;
      if (!(await refreshView())) s.setError('保存済み・表示更新に失敗しました');
    } catch (err) {
      s.setError(extractErrorMessage(err, '保存に失敗しました'));
      void permissions.refresh();
    } finally {
      s.setBusy(false);
    }
  };
}
function createDeleteAction(
  s: CalendarEditorState,
  permissions: Permissions,
  refreshView: () => Promise<boolean>,
) {
  return async () => {
    if (!s.detail || s.busy || !permissions.calendarEdit) return;
    s.setBusy(true);
    s.setError('');
    try {
      await deleteCalendarEvent(s.detail.id, s.detail.revision);
      s.setDeleteOpen(false);
      s.setPanel('list');
      s.setDetail(null);
      s.setInitial(s.form);
      s.saved.current = null;
      if (!(await refreshView())) s.setError('削除済み・表示更新に失敗しました');
    } catch (err) {
      s.setError(extractErrorMessage(err, '削除に失敗しました'));
      s.setDeleteOpen(false);
      void permissions.refresh();
    } finally {
      s.setBusy(false);
    }
  };
}
