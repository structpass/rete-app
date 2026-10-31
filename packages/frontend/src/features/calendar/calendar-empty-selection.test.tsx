import { useEffect } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarGrid } from './calendar-grid';
import { calendarBlankSelection } from './calendar-blank-selection';
import { useCalendarPeriod } from './use-calendar-period';
import { useCalendarEditor } from './use-calendar-editor';
import { toInstant } from './calendar-dates';
vi.mock('@/features/dashboard/hooks/home-permissions-context', () => ({
  useHomePermissions: () => ({ calendarEdit: true, refresh: vi.fn() }),
}));
const event = {
  id: 'event',
  title: '選択テスト',
  startAt: toInstant('2026-10-25T11:00'),
  endAt: toInstant('2026-10-25T12:00'),
  allDay: false,
  revision: 1,
  tags: [],
};
const refresh = vi.fn().mockResolvedValue([]);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T03:00:00Z'));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
}
function Harness({ mode }: { mode: 'month' | 'week' }) {
  const period = useCalendarPeriod();
  const editor = useCalendarEditor({
    active: period.active,
    selectDate: period.selectDate,
    listFrom: period.from,
    listTo: period.to,
    refresh,
  });
  useEffect(() => {
    if (mode === 'week') period.switchMode('week');
  }, []);
  return (
    <>
      <output aria-label="表示中パネル">{editor.panel}</output>
      <CalendarGrid
        period={period}
        events={[event]}
        loading={false}
        blocked={false}
        busy={editor.busy}
        {...calendarBlankSelection(period, editor, () => {})}
        onOpen={() => editor.setPanel('view')}
        onCreate={(day) => editor.create(day)}
        onMore={() => {}}
        onMode={period.switchMode}
        onTurn={period.turn}
      />
    </>
  );
}
describe('blank selection returns to the list', () => {
  it('selects exactly one half-hour block and returns from details in weekly mode', () => {
    setup();
    render(<Harness mode="week" />);
    fireEvent.click(screen.getByRole('button', { name: /選択テスト/ }));
    expect(screen.getByLabelText('表示中パネル')).toHaveTextContent('view');
    const slot = screen.getByRole('button', { name: '2026-10-25 9:30 ～ 10:00' });
    fireEvent.click(slot);
    expect(screen.getByLabelText('表示中パネル')).toHaveTextContent('list');
    expect(slot).toHaveAttribute('aria-pressed', 'true');
    expect(slot).toHaveFocus();
    // 要件: 週の時間領域は選んだ 30 分ブロックだけを強調する。同時に、次に足す予定の日付
    // （選択日）も選んだ枠の日に揃える。揃えないと 25 日の枠を選んだ後でも「新規登録」が
    // 19 日 09:00 で開く（実測 2026-10-26）。
    expect(document.querySelectorAll('.calendar-time-slot[aria-pressed="true"]')).toHaveLength(1);
    expect(slot.closest('.calendar-time-day')).toHaveClass('is-selected');
    expect(screen.getByRole('button', { name: '2026-10-25' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const next = screen.getByRole('button', { name: '2026-10-25 10:00 ～ 10:30' });
    fireEvent.click(next);
    expect(slot).toHaveAttribute('aria-pressed', 'false');
    expect(next).toHaveAttribute('aria-pressed', 'true');
  });
  it('returns from details when a monthly empty date cell is clicked', () => {
    setup();
    const { container } = render(<Harness mode="month" />);
    fireEvent.click(screen.getByRole('button', { name: /選択テスト/ }));
    expect(screen.getByLabelText('表示中パネル')).toHaveTextContent('view');
    fireEvent.click(container.querySelector('.calendar-day-background')!);
    expect(screen.getByLabelText('表示中パネル')).toHaveTextContent('list');
  });
  it('returns to the list when a weekly empty time frame is clicked', () => {
    setup();
    const { container } = render(<Harness mode="week" />);
    fireEvent.click(screen.getByRole('button', { name: /選択テスト/ }));
    expect(screen.getByLabelText('表示中パネル')).toHaveTextContent('view');
    // 週の時間枠は月表示の週と同じ7日を並べる。選択日（25日）より後ろにある26日の枠を
    // 選び、日付を跨いだ枠も一覧へ戻ることを確かめる。
    const week = container.querySelector('.calendar-time-body')!;
    // 時間枠は日を跨いで同じ番号が並ぶので、日と枠の組で引く（単独で一意に指せる）。
    expect(week.querySelectorAll('[data-slot-key]')).toHaveLength(48 * 7);
    const target = [...week.querySelectorAll<HTMLButtonElement>('[data-slot="30"]')].find(
      (node) => node.getAttribute('data-slot-day') !== '2026-10-25',
    )!;
    expect(
      week.querySelectorAll(`[data-slot-key="${target.getAttribute('data-slot-key')}"]`),
    ).toHaveLength(1);
    fireEvent.click(target);
    expect(screen.getByLabelText('表示中パネル')).toHaveTextContent('list');
    expect(container.querySelectorAll('.calendar-time-slot[aria-pressed="true"]')).toHaveLength(1);
    expect(container.querySelector('.calendar-time-slot[aria-pressed="true"]')).toHaveAttribute(
      'data-slot-day',
      target.getAttribute('data-slot-day'),
    );
  });
  it('retains dirty input on cancel and applies selection only after discard confirmation', () => {
    setup();
    const { result } = renderHook(() => {
      const period = useCalendarPeriod();
      const editor = useCalendarEditor({
        active: period.active,
        selectDate: period.selectDate,
        listFrom: period.from,
        listTo: period.to,
        refresh,
      });
      return { period, editor };
    });
    act(() => result.current.editor.create('2026-10-25'));
    act(() => result.current.editor.setForm({ ...result.current.editor.form, title: '未保存' }));
    const focus = vi.fn(),
      clear = vi.fn();
    act(() =>
      calendarBlankSelection(result.current.period, result.current.editor, clear).onSelectSlot(
        '2026-10-26',
        20,
        focus,
      ),
    );
    expect(result.current.editor.discard.open).toBe(true);
    expect(result.current.period.selectedSlot).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    act(() => result.current.editor.discard.onCancel());
    expect(result.current.editor.panel).toBe('create');
    expect(result.current.editor.form.title).toBe('未保存');
    act(() =>
      calendarBlankSelection(result.current.period, result.current.editor, clear).onSelectSlot(
        '2026-10-26',
        20,
        focus,
      ),
    );
    act(() => result.current.editor.discard.onConfirm());
    expect(result.current.editor.panel).toBe('list');
    expect(result.current.period.selectedSlot).toEqual({ day: '2026-10-26', slot: 20 });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
