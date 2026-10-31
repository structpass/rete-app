import { useState } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEventDetail } from '@rete/shared';
import { CalendarPanel } from './calendar-panel';
import { fetchCalendarEvent } from './calendar-api';
import { useCalendarEditor } from './use-calendar-editor';
vi.mock('./calendar-api', () => ({
  saveCalendarEvent: vi.fn(),
  fetchCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}));
vi.mock('@/features/dashboard/hooks/home-permissions-context', () => ({
  useHomePermissions: () => ({ calendarEdit: true, refresh: vi.fn() }),
}));
const day = '2026-10-28';
function options(selectDate: (key: string) => void = vi.fn()) {
  return {
    active: day,
    selectDate,
    listFrom: '2026-10-01',
    listTo: '2026-12-01',
    refresh: vi.fn(),
  };
}
function Harness() {
  const [selectedSlot, setSelectedSlot] = useState('');
  const editor = useCalendarEditor(options(() => setSelectedSlot('')));
  return (
    <>
      <button
        onClick={() => setSelectedSlot('11:00')}
        onDoubleClick={() => editor.create(day, true)}
      >
        時間枠
      </button>
      <output aria-label="選択時間">{selectedSlot}</output>
      <CalendarPanel
        editor={editor}
        canEdit
        blocked={false}
        events={[]}
        dayFilter={null}
        onClearDay={() => {}}
        onRetry={() => {}}
        filtered={false}
        loading={false}
        error=""
        tags={{ tags: [] } as never}
      />
    </>
  );
}
describe('calendar creation focus', () => {
  it('keeps the clicked week slot selected and focused while opening registration', () => {
    render(<Harness />);
    const slot = screen.getByRole('button', { name: '時間枠' });
    slot.focus();
    fireEvent.click(slot);
    fireEvent.click(slot);
    fireEvent.doubleClick(slot);
    expect(screen.getByLabelText('選択時間')).toHaveTextContent('11:00');
    expect(slot).toHaveFocus();
    expect(screen.getByLabelText('件名')).not.toHaveFocus();
    expect(screen.getByLabelText('開始日時')).toHaveValue(day + 'T09:00');
  });
  it('retains title autofocus for the normal new-registration button', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '新規登録' }));
    expect(screen.getByLabelText('件名')).toHaveFocus();
  });
  it('still selects a different day and restores normal creation focus afterward', () => {
    const selectDate = vi.fn();
    const { result } = renderHook(() => useCalendarEditor(options(selectDate)));
    act(() => result.current.create('2026-11-01', true));
    expect(selectDate).toHaveBeenCalledWith('2026-11-01');
    expect(result.current.form.start).toBe('2026-11-01T09:00');
    expect(result.current.focusTitle).toBe(false);
    act(() => result.current.back());
    act(() => result.current.create());
    expect(result.current.focusTitle).toBe(true);
    expect(selectDate).toHaveBeenLastCalledWith(day);
  });
  it('retains dirty discard confirmation and cancel behavior for slot creation', () => {
    const selectDate = vi.fn();
    const { result } = renderHook(() => useCalendarEditor(options(selectDate)));
    act(() => result.current.create());
    act(() => result.current.setForm({ ...result.current.form, title: '未保存' }));
    selectDate.mockClear();
    act(() => result.current.create(day, true));
    expect(result.current.discard.open).toBe(true);
    expect(result.current.focusTitle).toBe(true);
    act(() => result.current.discard.onCancel());
    expect(result.current.form.title).toBe('未保存');
    act(() => result.current.create(day, true));
    act(() => result.current.discard.onConfirm());
    expect(result.current.focusTitle).toBe(false);
    expect(result.current.form.title).toBe('');
    expect(selectDate).not.toHaveBeenCalled();
  });
  it('keeps busy creation blocked', () => {
    const selectDate = vi.fn();
    const { result } = renderHook(() => useCalendarEditor(options(selectDate)));
    act(() => result.current.setBusy(true));
    act(() => result.current.create(day, true));
    expect(result.current.panel).toBe('list');
    expect(selectDate).not.toHaveBeenCalled();
  });
  it('restores title focus preference when an existing event is opened for editing', async () => {
    const row: CalendarEventDetail = {
      id: 'e',
      title: '予定',
      allDay: false,
      startAt: '2026-10-28T00:00:00Z',
      endAt: '2026-10-28T01:00:00Z',
      revision: 1,
      tags: [],
      memo: '',
      createdBy: { id: 'u', name: 'user' },
      updatedBy: { id: 'u', name: 'user' },
      createdAt: '2026-10-28T00:00:00Z',
      updatedAt: '2026-10-28T00:00:00Z',
    };
    vi.mocked(fetchCalendarEvent).mockResolvedValue(row);
    const { result } = renderHook(() => useCalendarEditor(options()));
    act(() => result.current.create(day, true));
    await act(async () => {
      await result.current.open(row, true);
    });
    expect(result.current.panel).toBe('edit');
    expect(result.current.focusTitle).toBe(true);
  });
});
