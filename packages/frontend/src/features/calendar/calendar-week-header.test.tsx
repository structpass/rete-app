import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarWeekHeader } from './calendar-week-header';
import type { CalendarGridProps } from './calendar-grid';
import { addDays, toInstant } from './calendar-dates';
const style = document.createElement('style');
style.textContent = readFileSync('src/features/calendar/calendar-week-header.css', 'utf8');
afterEach(() => style.remove());
const period = {
  active: '2026-10-25',
  today: '2026-10-25',
  dates: [Array.from({ length: 7 }, (_, index) => addDays('2026-10-19', index))],
  selectDate: vi.fn(),
} as unknown as CalendarGridProps['period'];
const props: CalendarGridProps = {
  period,
  events: [],
  loading: false,
  blocked: false,
  busy: false,
  onTurn: vi.fn(),
  onMode: vi.fn(),
  onOpen: vi.fn(),
  onMore: vi.fn(),
  onCreate: vi.fn(),
};
describe('separated weekly header', () => {
  it('keeps digits-only dates aligned and the today marker a24px circle', () => {
    document.head.append(style);
    const { container } = render(
      <CalendarWeekHeader {...props} holidays={[{ date: '2026-10-19', name: '検証祝日' }]} />,
    );
    expect(container.querySelector('.calendar-weekday-row')?.children).toHaveLength(8);
    expect(container.querySelector('.calendar-date-row')?.children).toHaveLength(8);
    const today = screen.getByRole('button', { name: '2026-10-25' });
    const regular = screen.getByRole('button', { name: '2026-10-19' });
    expect(today.textContent).toBe('25');
    expect(regular.textContent).toBe('19');
    expect(getComputedStyle(today).width).toBe('24px');
    expect(getComputedStyle(today).height).toBe('24px');
    expect(getComputedStyle(regular).height).toBe('24px');
    expect(getComputedStyle(today).borderRadius).toBe('50%');
    expect(getComputedStyle(today).padding).toBe('0px');
    expect(container.querySelector('.calendar-week-all-day-scroll')).toBeNull();
  });
  it('connects a multi-day all-day appointment across columns and confines it to the current week', () => {
    const event = {
      id: 'event',
      title: '終日連続',
      allDay: true,
      startAt: toInstant('2026-10-23T00:00'),
      endAt: toInstant('2026-10-27T00:00'),
      revision: 1,
      tags: [],
    };
    const onSelectDay = vi.fn((_day: string, focus: () => void) => focus());
    const { container } = render(
      <div className="calendar-time-week">
        <CalendarWeekHeader {...props} events={[event]} onSelectDay={onSelectDay} />
      </div>,
    );
    const bar = screen.getByRole('button', { name: '終日連続 10/23 ～ 10/26 終日' });
    expect(container.querySelectorAll('.calendar-week-all-day-band')).toHaveLength(1);
    expect(bar.style.gridColumn).toBe('6 / 9');
    fireEvent.doubleClick(bar);
    expect(props.onOpen).toHaveBeenCalledWith(event, '2026-10-23');
    expect(props.onCreate).not.toHaveBeenCalled();
    const blank = container.querySelector('[data-day-background="2026-10-20"]')!;
    fireEvent.click(blank);
    expect(onSelectDay).toHaveBeenCalledWith('2026-10-20', expect.any(Function));
    expect(screen.getByRole('button', { name: '2026-10-20' })).toHaveFocus();
    fireEvent.doubleClick(blank);
    expect(props.onCreate).toHaveBeenCalledWith('2026-10-20');
  });
  it('passes day selection through the guarded callback before applying focus', () => {
    const onSelectDay = vi.fn((_day: string, focus: () => void) => focus());
    render(<CalendarWeekHeader {...props} onSelectDay={onSelectDay} />);
    const date = screen.getByRole('button', { name: '2026-10-25' });
    fireEvent.click(date);
    expect(onSelectDay).toHaveBeenCalledWith('2026-10-25', expect.any(Function));
    expect(date).toHaveFocus();
  });
});
