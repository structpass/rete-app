import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import { CalendarGrid, type CalendarGridProps } from './calendar-grid';
import { monthDays, shiftMonth, toInstant } from './calendar-dates';

function setup(month = '2026-10-01', events: CalendarEventSummary[] = []) {
  const onOpen = vi.fn(),
    onCreate = vi.fn(),
    selectDate = vi.fn();
  const next = shiftMonth(month, 1);
  const period = {
    mode: 'month',
    month,
    today: '2026-10-26',
    active: '2026-10-26',
    dates: [monthDays(month), monthDays(next)],
    selectDate,
  } as unknown as CalendarGridProps['period'];
  const result = render(
    <CalendarGrid
      period={period}
      events={events}
      holidays={[
        { date: '2026-10-26', name: '前月祝日' },
        { date: '2026-11-01', name: '当月祝日' },
      ]}
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
  const months = result.container.querySelectorAll<HTMLElement>('.calendar-month');
  return { months, onOpen, onCreate, selectDate, next };
}
function event(id: string, start: string, end: string): CalendarEventSummary {
  return {
    id,
    title: id,
    startAt: toInstant(start),
    endAt: toInstant(end),
    allDay: false,
    revision: 1,
    tags: [],
  };
}
describe('second month leading blanks', () => {
  it('hides previous dates, holidays, selection and events only in the second calendar', () => {
    const previous = Array.from({ length: 5 }, (_, i) =>
      event(`前月予定${i}`, '2026-10-26T09:00', '2026-10-29T10:00'),
    );
    const { months, selectDate, onCreate } = setup('2026-10-01', previous);
    expect(within(months[0]).getByRole('button', { name: '2026-09-28' })).toBeInTheDocument();
    expect(within(months[0]).getByRole('button', { name: '2026-10-26' })).toBeInTheDocument();
    expect(within(months[0]).getByText('前月祝日')).toBeInTheDocument();
    expect(within(months[1]).queryByRole('button', { name: '2026-10-26' })).not.toBeInTheDocument();
    expect(within(months[1]).queryByText('前月祝日')).not.toBeInTheDocument();
    expect(months[1].querySelectorAll('.calendar-event, .calendar-more')).toHaveLength(0);
    const blanks = months[1].querySelectorAll('.calendar-day-empty');
    expect(blanks).toHaveLength(6);
    blanks.forEach((blank) => {
      expect(blank).toHaveStyle({ backgroundColor: '#ffffff' });
      expect(blank).not.toHaveClass('is-selected', 'is-weekend', 'is-outside');
      expect(blank).toHaveAttribute('aria-hidden', 'true');
      expect(blank.textContent).toBe('');
      fireEvent.click(blank);
      fireEvent.doubleClick(blank);
    });
    expect(selectDate).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(within(months[1]).getByText('当月祝日')).toBeInTheDocument();
  });
  it('clips crossing bars at the new month while preserving their day columns and opening date', () => {
    const crossing = event('月跨ぎ予定', '2026-10-30T09:00', '2026-11-03T10:00');
    const { months, onOpen } = setup('2026-10-01', [crossing]);
    const bars = within(months[1]).getAllByRole('button', { name: /月跨ぎ予定/ });
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveStyle({ gridColumn: '7 / 8' });
    expect(bars[1]).toHaveStyle({ gridColumn: '1 / 3' });
    fireEvent.click(bars[0]);
    expect(onOpen).toHaveBeenLastCalledWith(crossing, '2026-11-01');
  });
  it.each([
    ['2026-05-01', 0],
    ['2026-07-01', 5],
  ])('keeps weekday alignment after %s', (month, count) => {
    const { months, next } = setup(month);
    expect(months[1].querySelectorAll('.calendar-day-empty')).toHaveLength(count);
    expect(within(months[1]).getByRole('button', { name: next }).parentElement).toHaveStyle({
      gridColumn: `${count + 1}`,
    });
  });
});
