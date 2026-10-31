import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEventDetail } from '@rete/shared';
import { saveCalendarEvent } from './calendar-api';
import { useCalendarEditor } from './use-calendar-editor';
vi.mock('./calendar-api', () => ({
  saveCalendarEvent: vi.fn(),
  fetchCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}));
vi.mock('@/features/dashboard/hooks/home-permissions-context', () => ({
  useHomePermissions: () => ({ calendarEdit: true, refresh: vi.fn() }),
}));
const row: CalendarEventDetail = {
  id: 'saved',
  title: '確認',
  startAt: '2026-10-24T00:00:00.000Z',
  endAt: '2026-10-24T01:00:00.000Z',
  tags: [],
  allDay: false,
  revision: 1,
  memo: '',
  createdBy: { id: 'u', name: 'user' },
  updatedBy: { id: 'u', name: 'user' },
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
};
describe('calendar save and display recovery', () => {
  it('saves an all-day event with an exclusive end and reopens its inclusive end date', async () => {
    const allDayRow = {
      ...row,
      allDay: true,
      startAt: '2026-10-11T15:00:00.000Z',
      endAt: '2026-10-14T15:00:00.000Z',
    };
    vi.mocked(saveCalendarEvent).mockResolvedValue(allDayRow);
    const { result } = renderHook(() =>
      useCalendarEditor({
        active: '2026-10-12',
        selectDate: vi.fn(),
        listFrom: '2026-10-01',
        listTo: '2026-12-01',
        refresh: vi.fn().mockResolvedValue([allDayRow]),
      }),
    );
    act(() => result.current.create());
    act(() =>
      result.current.setForm({
        ...result.current.form,
        title: '終日予定',
        allDay: true,
        end: '2026-10-14T10:00',
      }),
    );
    await act(async () => {
      await result.current.save();
    });
    expect(saveCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        allDay: true,
        startAt: '2026-10-11T15:00:00.000Z',
        endAt: '2026-10-14T15:00:00.000Z',
      }),
      undefined,
    );
    expect(result.current.form.allDay).toBe(true);
    expect(result.current.form.end.slice(0, 10)).toBe('2026-10-14');
  });
  it('initializes a new event from the double-clicked day rather than the previous selection', () => {
    const selectDate = vi.fn();
    const { result } = renderHook(() =>
      useCalendarEditor({
        active: '2026-10-24',
        selectDate,
        listFrom: '2026-10-01',
        listTo: '2026-12-01',
        refresh: vi.fn(),
      }),
    );
    act(() => result.current.create('2026-11-03'));
    expect(result.current.panel).toBe('create');
    expect(result.current.form.start).toBe('2026-11-03T09:00');
    expect(result.current.form.end).toBe('2026-11-03T10:00');
    expect(selectDate).toHaveBeenCalledWith('2026-11-03');
  });
  it('preserves unsaved input when a new date is canceled and uses that date after confirmation', () => {
    const selectDate = vi.fn();
    const { result } = renderHook(() =>
      useCalendarEditor({
        active: '2026-10-24',
        selectDate,
        listFrom: '2026-10-01',
        listTo: '2026-12-01',
        refresh: vi.fn(),
      }),
    );
    act(() => result.current.create());
    act(() => result.current.setForm({ ...result.current.form, title: '編集中' }));
    selectDate.mockClear();
    act(() => result.current.create('2026-11-03'));
    expect(result.current.discard.open).toBe(true);
    expect(result.current.form.title).toBe('編集中');
    expect(selectDate).not.toHaveBeenCalled();
    act(() => result.current.discard.onCancel());
    expect(result.current.form.title).toBe('編集中');
    act(() => result.current.create('2026-11-03'));
    act(() => result.current.discard.onConfirm());
    expect(result.current.form.title).toBe('');
    expect(result.current.form.start).toBe('2026-11-03T09:00');
    expect(selectDate).toHaveBeenCalledWith('2026-11-03');
  });
  it('keeps a successful save when refresh fails and retries only the read', async () => {
    const refresh = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce([row]);
    vi.mocked(saveCalendarEvent).mockResolvedValue(row);
    const { result } = renderHook(() =>
      useCalendarEditor({
        active: '2026-10-24',
        selectDate: vi.fn(),
        listFrom: '2026-10-01',
        listTo: '2026-12-01',
        refresh,
      }),
    );
    act(() => result.current.create());
    act(() => result.current.setForm({ ...result.current.form, title: '確認' }));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.panel).toBe('view');
    expect(result.current.detail?.id).toBe('saved');
    expect(result.current.error).toContain('保存済み');
    await act(async () => {
      await result.current.refreshView();
    });
    expect(result.current.error).toBe('');
    expect(saveCalendarEvent).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('retains typed values when saving fails', async () => {
    vi.mocked(saveCalendarEvent).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() =>
      useCalendarEditor({
        active: '2026-10-24',
        selectDate: vi.fn(),
        listFrom: '2026-10-01',
        listTo: '2026-12-01',
        refresh: vi.fn(),
      }),
    );
    act(() => result.current.create());
    act(() => result.current.setForm({ ...result.current.form, title: '未保存入力' }));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.panel).toBe('create');
    expect(result.current.form.title).toBe('未保存入力');
    expect(result.current.error).not.toBe('');
  });
});
