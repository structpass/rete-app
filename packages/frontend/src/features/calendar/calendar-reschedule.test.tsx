import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEventDetail } from '@rete/shared';
import { fetchCalendarEvent, saveCalendarEvent } from './calendar-api';
import { useCalendarEditor } from './use-calendar-editor';
const access = vi.hoisted(() => ({ calendarEdit: true, refresh: vi.fn() }));
const notices = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('./calendar-api', () => ({
  saveCalendarEvent: vi.fn(),
  fetchCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}));
vi.mock('@/features/dashboard/hooks/home-permissions-context', () => ({
  useHomePermissions: () => ({ ...access }),
}));
vi.mock('react-hot-toast', () => ({
  default: Object.assign(notices.info, { error: notices.error }),
}));
const row: CalendarEventDetail = {
  id: 'event',
  title: '元の予定',
  startAt: '2026-10-24T00:00:00.000Z',
  endAt: '2026-10-24T01:00:00.000Z',
  allDay: false,
  memo: '保持するメモ',
  tags: [{ id: 'tag', name: '分類', color: 'green', icon: 'Tag', archived: false }],
  revision: 3,
  createdBy: { id: 'u', name: 'user' },
  updatedBy: { id: 'u', name: 'user' },
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
};
const range = { startAt: '2026-10-25T02:00:00.000Z', endAt: '2026-10-25T03:00:00.000Z' };
const saved = { ...row, ...range, revision: 4 };
function setup(refresh = vi.fn().mockResolvedValue([saved])) {
  const hook = renderHook(() =>
    useCalendarEditor({
      active: '2026-10-24',
      selectDate: vi.fn(),
      listFrom: '2026-10-01',
      listTo: '2026-12-01',
      refresh,
    }),
  );
  return { ...hook, refresh };
}
beforeEach(() => {
  access.calendarEdit = true;
  access.refresh.mockResolvedValue(undefined);
  vi.mocked(fetchCalendarEvent).mockResolvedValue(row);
  vi.mocked(saveCalendarEvent).mockResolvedValue(saved);
});
describe('drag reschedule persistence', () => {
  it('patches only times plus the displayed revision and waits for the server before changing detail', async () => {
    let finish!: (value: CalendarEventDetail) => void;
    vi.mocked(saveCalendarEvent).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, refresh } = setup();
    await act(async () => {
      await result.current.open(row, false);
    });
    const extraRange = { ...range, title: '上書き不可', memo: '上書き不可', revision: 99 };
    act(() => result.current.reschedule(row, extraRange));
    expect(result.current.busy).toBe(true);
    expect(result.current.detail).toEqual(row);
    expect(refresh).not.toHaveBeenCalled();
    expect(saveCalendarEvent).toHaveBeenCalledWith({ ...range, revision: 3 }, 'event');
    await act(async () => {
      finish(saved);
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.panel).toBe('list');
    expect(result.current.detail).toEqual(saved);
    expect(result.current.form.memo).toBe('保持するメモ');
    expect(result.current.form.tagIds).toEqual(['tag']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('deduplicates same-batch drops and stale retained callbacks during an in-flight save', async () => {
    let finish!: (value: CalendarEventDetail) => void;
    vi.mocked(saveCalendarEvent).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = setup();
    const retained = result.current.reschedule;
    act(() => {
      retained(row, range);
      retained(row, range);
    });
    act(() => retained(row, range));
    expect(saveCalendarEvent).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(saved);
    });
  });
  it('asks before discarding a dirty editor and cancels without writing', async () => {
    const { result } = setup();
    act(() => result.current.create());
    act(() => result.current.setForm({ ...result.current.form, title: '未保存' }));
    act(() => result.current.reschedule(row, range));
    expect(result.current.discard.open).toBe(true);
    expect(saveCalendarEvent).not.toHaveBeenCalled();
    act(() => result.current.discard.onCancel());
    expect(result.current.form.title).toBe('未保存');
    act(() => result.current.reschedule(row, range));
    await act(async () => {
      result.current.discard.onConfirm();
    });
    expect(saveCalendarEvent).toHaveBeenCalledTimes(1);
    expect(result.current.panel).toBe('list');
  });
  it('rejects a retained callback after busy or permissions change', () => {
    const { result, rerender } = setup();
    const retained = result.current.reschedule;
    act(() => result.current.setBusy(true));
    act(() => retained(row, range));
    act(() => result.current.setBusy(false));
    access.calendarEdit = false;
    rerender();
    act(() => retained(row, range));
    expect(saveCalendarEvent).not.toHaveBeenCalled();
  });
  it('rechecks permissions after a dirty-editor confirmation is deferred', () => {
    const { result, rerender } = setup();
    act(() => result.current.create());
    act(() => result.current.setForm({ ...result.current.form, title: '未保存' }));
    act(() => result.current.reschedule(row, range));
    access.calendarEdit = false;
    rerender();
    act(() => result.current.discard.onConfirm());
    expect(saveCalendarEvent).not.toHaveBeenCalled();
  });
  it.each([
    { startAt: range.endAt, endAt: range.startAt },
    { startAt: range.startAt, endAt: range.startAt },
    { startAt: 'invalid', endAt: range.endAt },
  ])('rejects invalid/reversed ranges without a request %s', (invalid) => {
    const { result } = setup();
    act(() => result.current.reschedule(row, invalid));
    expect(saveCalendarEvent).not.toHaveBeenCalled();
    expect(result.current.error).toContain('終了日時');
    expect(notices.error).toHaveBeenCalledTimes(1);
  });
  it('does not write a drop onto the original range', () => {
    const { result } = setup();
    act(() => result.current.reschedule(row, { startAt: row.startAt, endAt: row.endAt }));
    expect(saveCalendarEvent).not.toHaveBeenCalled();
  });
});
describe('reschedule failure and read recovery', () => {
  it('reports a revision conflict, refreshes reads/permissions, and never retries the patch', async () => {
    const message = '他のユーザーが更新しました';
    vi.mocked(saveCalendarEvent).mockRejectedValue({
      response: { status: 409, data: { error: { message } } },
    });
    const { result, refresh } = setup();
    await act(async () => {
      await result.current.open(row, false);
    });
    await act(async () => {
      result.current.reschedule(row, range);
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.detail).toEqual(row);
    expect(result.current.panel).toBe('list');
    expect(result.current.error).toBe(message);
    expect(notices.error).toHaveBeenCalledWith(message);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(access.refresh).toHaveBeenCalledTimes(1);
    expect(saveCalendarEvent).toHaveBeenCalledTimes(1);
  });
  it('unlocks after an unavailable API and failed read without claiming a save', async () => {
    vi.mocked(saveCalendarEvent).mockRejectedValue(new Error('offline'));
    const refresh = vi.fn().mockRejectedValue(new Error('offline'));
    const { result } = setup(refresh);
    await act(async () => {
      result.current.reschedule(row, range);
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe('予定の日時変更に失敗しました');
    expect(result.current.detail).toBeNull();
    expect(notices.error).toHaveBeenCalledWith('予定の日時変更に失敗しました');
    expect(saveCalendarEvent).toHaveBeenCalledTimes(1);
    expect(access.refresh).toHaveBeenCalledTimes(1);
  });
  it.each([false, 'reject'])(
    'keeps a successful write when refreshing the display fails: %s',
    async (failure) => {
      const refresh = vi.fn();
      if (failure === false) refresh.mockResolvedValueOnce(false);
      else refresh.mockRejectedValueOnce(new Error('offline'));
      refresh.mockResolvedValueOnce([saved]);
      const { result } = setup(refresh);
      await act(async () => {
        result.current.reschedule(row, range);
      });
      expect(result.current.detail).toEqual(saved);
      expect(result.current.error).toContain('日時変更済み');
      await act(async () => {
        await result.current.refreshView();
      });
      expect(result.current.error).toBe('');
      expect(saveCalendarEvent).toHaveBeenCalledTimes(1);
    },
  );
});
