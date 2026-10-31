import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CalendarGrid, type CalendarGridProps } from './calendar-grid';
import { monthDays, toInstant } from './calendar-dates';
describe('Monday month calendar and holiday master', () => {
  it('places weekends correctly, marks adjacent months, and displays holidays separately from events', () => {
    const selectDate = vi.fn(),
      onCreate = vi.fn(),
      onOpen = vi.fn(),
      onToday = vi.fn();
    const event = {
      id: 'event',
      title: '既存予定',
      startAt: toInstant('2026-09-22T09:00'),
      endAt: toInstant('2026-09-22T10:00'),
      tags: [],
      allDay: false,
      revision: 1,
    };
    const period = {
      mode: 'month',
      month: '2026-09-01',
      active: '2026-09-15',
      today: '2026-09-15',
      dates: [monthDays('2026-09-01')],
      selectDate,
    } as unknown as CalendarGridProps['period'];
    const { container } = render(
      <CalendarGrid
        period={period}
        events={[event]}
        onCreate={onCreate}
        onToday={onToday}
        holidays={[{ date: '2026-09-22', name: '国民の休日' }]}
        loading={false}
        blocked={false}
        busy={false}
        onTurn={() => {}}
        onMode={() => {}}
        onOpen={onOpen}
        onMore={() => {}}
      />,
    );
    expect(container.querySelector('.calendar-weekdays')?.textContent).toBe('月火水木金土日');
    expect(container.querySelector('.calendar-week-select')).toBeNull();
    expect(
      screen.getByRole('button', { name: '2026-08-31' }).closest('.calendar-cell'),
    ).toHaveClass('is-outside');
    expect(
      screen.getByRole('button', { name: '2026-09-05' }).closest('.calendar-cell'),
    ).toHaveClass('is-weekend');
    expect(
      screen.getByRole('button', { name: '2026-09-06' }).closest('.calendar-cell'),
    ).toHaveClass('is-weekend');
    expect(
      screen.getByRole('button', { name: '2026-09-07' }).closest('.calendar-cell'),
    ).not.toHaveClass('is-weekend');
    expect(screen.getByText('国民の休日')).toHaveClass('calendar-holiday');
    expect(screen.queryByRole('button', { name: '国民の休日' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2026-09-22' }));
    expect(selectDate).toHaveBeenCalledWith('2026-09-22');
    expect(screen.getByRole('button', { name: '2026-09-22' })).toHaveTextContent(/^22$/);
    expect(screen.getByRole('button', { name: '2026-09-22' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '2026-09-07' }).closest('.calendar-cell')!);
    expect(selectDate).toHaveBeenLastCalledWith('2026-09-07');
    expect(screen.getByRole('button', { name: '2026-09-07' })).toHaveFocus();
    selectDate.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /既存予定/ }));
    expect(selectDate).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole('button', { name: '2026-08-31' }));
    expect(onCreate).toHaveBeenLastCalledWith('2026-08-31');
    onCreate.mockClear();
    fireEvent.doubleClick(screen.getByRole('button', { name: /既存予定/ }));
    expect(onOpen).toHaveBeenCalledWith(event, '2026-09-22');
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.click(container.querySelectorAll('.calendar-day-background')[7]);
    expect(screen.getByRole('button', { name: '2026-09-07' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '今日へ移動' }));
    expect(onToday).toHaveBeenCalledTimes(1);
  });
});
