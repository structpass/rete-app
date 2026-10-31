import toast from 'react-hot-toast';
import type { CalendarEventDetail, CalendarEventSummary, HomePermissions } from '@rete/shared';
import { extractErrorMessage } from '@/lib/error-utils';
import { saveCalendarEvent } from './calendar-api';
import type { CalendarEditorState } from './use-calendar-editor';

export interface CalendarRescheduleRange {
  startAt: string;
  endAt: string;
}
type Key = CalendarEditorState['selection'];
type Permissions = HomePermissions & { refresh: () => Promise<void> };
type Context = {
  state: CalendarEditorState;
  permissions: Permissions;
  leave: (action: () => void) => void;
  refreshView: () => Promise<boolean>;
  commit: (row: CalendarEventDetail) => void;
};
// The selection ref survives editor rerenders; the lock also blocks two drops in one React batch.
const contexts = new WeakMap<Key, Context>();
const pending = new WeakSet<Key>();
function permitted(key: Key) {
  const current = contexts.get(key)!;
  return !pending.has(key) && !current.state.busy && current.permissions.calendarEdit;
}
function validRange(range: CalendarRescheduleRange) {
  const start = Date.parse(range.startAt),
    end = Date.parse(range.endAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}
function report(context: Context, message: string) {
  context.state.setError(message);
  toast.error(message);
}
export function createRescheduleAction(
  state: CalendarEditorState,
  permissions: Permissions,
  leave: Context['leave'],
  refreshView: Context['refreshView'],
  commit: Context['commit'],
) {
  const key = state.selection;
  contexts.set(key, { state, permissions, leave, refreshView, commit });
  return (event: CalendarEventSummary, range: CalendarRescheduleRange) => {
    if (!permitted(key)) return;
    if (!validRange(range)) {
      report(contexts.get(key)!, '終了日時は開始日時より後にしてください');
      return;
    }
    if (
      Date.parse(event.startAt) === Date.parse(range.startAt) &&
      Date.parse(event.endAt) === Date.parse(range.endAt)
    )
      return;
    const request = {
      id: event.id,
      revision: event.revision,
      startAt: range.startAt,
      endAt: range.endAt,
    };
    contexts.get(key)!.leave(() => {
      void reschedule(key, request);
    });
  };
}
async function reschedule(
  key: Key,
  request: CalendarRescheduleRange & { id: string; revision: number },
) {
  if (!permitted(key)) return;
  pending.add(key);
  const current = contexts.get(key)!;
  current.state.selection.current++;
  current.state.setBusy(true);
  current.state.setError('');
  try {
    const { id, ...patch } = request;
    const row = await saveCalendarEvent(patch, id);
    const latest = contexts.get(key)!;
    latest.commit(row);
    latest.state.setPanel('list');
    latest.state.saved.current = row.id;
    if (!(await latest.refreshView().catch(() => false)))
      report(contexts.get(key)!, '日時変更済み・表示更新に失敗しました');
  } catch (error) {
    const latest = contexts.get(key)!;
    await latest.refreshView().catch(() => false);
    contexts.get(key)!.state.setPanel('list');
    report(contexts.get(key)!, extractErrorMessage(error, '予定の日時変更に失敗しました'));
    void contexts
      .get(key)!
      .permissions.refresh()
      .catch(() => undefined);
  } finally {
    pending.delete(key);
    contexts.get(key)!.state.setBusy(false);
  }
}
