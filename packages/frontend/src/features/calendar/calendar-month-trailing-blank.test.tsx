import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import { CalendarGrid, type CalendarGridProps } from './calendar-grid';
import { monthDays, shiftMonth, toInstant } from './calendar-dates';

function setup(month = '2026-11-01') {
  const next = shiftMonth(month, 1);
  const crossing: CalendarEventSummary = {
    id: 'crossing',
    title: '対応予定',
    startAt: toInstant('2026-11-30T09:00'),
    endAt: toInstant('2026-12-05T00:00'),
    allDay: false,
    revision: 1,
    tags: [],
  };
  const events = [
    crossing,
    ...Array.from({ length: 5 }, (_, i) => ({
      ...crossing,
      id: `next${i}`,
      title: `翌月のみ${i}`,
      startAt: toInstant('2026-12-01T09:00'),
    })),
  ];
  const selectDate = vi.fn(),
    onCreate = vi.fn(),
    onOpen = vi.fn();
  const period = {
    mode: 'month',
    month,
    today: '2026-12-01',
    active: '2026-12-01',
    dates: [monthDays(month), monthDays(next)],
    selectDate,
  } as unknown as CalendarGridProps['period'];
  const { container } = render(
    <CalendarGrid
      period={period}
      events={events}
      holidays={[{ date: '2026-12-01', name: '翌月祝日' }]}
      loading={false}
      blocked={false}
      busy={false}
      onOpen={onOpen}
      onCreate={onCreate}
      onTurn={() => {}}
      onMode={() => {}}
      onMore={() => {}}
    />,
  );
  return {
    months: container.querySelectorAll<HTMLElement>('.calendar-month'),
    crossing,
    selectDate,
    onCreate,
    onOpen,
  };
}
describe('first month trailing blanks', () => {
  it('leaves next-month dates white and inactive, clips bars at month end and keeps next-month content below', () => {
    const { months, crossing, selectDate, onCreate, onOpen } = setup();
    const first = within(months[0]),
      second = within(months[1]);
    expect(first.queryByRole('button', { name: '2026-12-01' })).not.toBeInTheDocument();
    expect(first.queryByText('翌月祝日')).not.toBeInTheDocument();
    expect(first.queryByText(/翌月のみ/)).not.toBeInTheDocument();
    expect(months[0].querySelectorAll('.calendar-more')).toHaveLength(0);
    const blanks = months[0].querySelectorAll('.calendar-day-empty');
    expect(blanks).toHaveLength(6);
    blanks.forEach((blank) => {
      expect(blank).toHaveStyle({ backgroundColor: '#ffffff' });
      expect(blank).not.toHaveClass('is-selected', 'is-weekend', 'is-outside');
      expect(blank.textContent).toBe('');
      fireEvent.click(blank);
      fireEvent.doubleClick(blank);
    });
    expect(selectDate).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    const bar = first.getByRole('button', { name: /対応予定/ });
    expect(bar).toHaveStyle({ gridColumn: '1 / 2' });
    fireEvent.click(bar);
    expect(onOpen).toHaveBeenLastCalledWith(crossing, '2026-11-30');
    expect(second.getByRole('button', { name: '2026-12-01' })).toBeInTheDocument();
    expect(second.getByText('翌月祝日')).toBeInTheDocument();
    expect(second.getByRole('button', { name: /対応予定/ })).toHaveStyle({ gridColumn: '2 / 6' });
    expect(first.getByRole('button', { name: '2026-10-26' })).toBeInTheDocument();
  });
  it.each([
    ['2026-05-01', 0],
    ['2026-07-01', 2],
    ['2026-10-01', 1],
  ])('blanks the correct trailing count for %s', (month, count) => {
    const { months } = setup(month);
    expect(months[0].querySelectorAll('.calendar-day-empty')).toHaveLength(count);
  });
});
