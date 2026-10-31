import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import { CalendarGrid, type CalendarGridProps } from './calendar-grid';
import { monthDays, toInstant } from './calendar-dates';
const event: CalendarEventSummary = {
  id: 'long',
  title: '跨週予定',
  startAt: toInstant('2026-10-24T09:00'),
  endAt: toInstant('2026-10-27T10:00'),
  allDay: false,
  revision: 1,
  tags: [{ id: 'red', name: '赤', color: 'red', icon: 'Tag', archived: false }],
};
describe('month week-spanning bars', () => {
  it('renders one connected tagged bar in each week with the label repeated only after Sunday', () => {
    const onOpen = vi.fn();
    const period = {
      mode: 'month',
      month: '2026-10-01',
      today: '2026-10-25',
      active: '2026-10-25',
      dates: [monthDays('2026-10-01')],
      selectDate: vi.fn(),
    } as unknown as CalendarGridProps['period'];
    render(
      <CalendarGrid
        period={period}
        events={[event]}
        loading={false}
        blocked={false}
        busy={false}
        onTurn={() => {}}
        onMode={() => {}}
        onOpen={onOpen}
        onMore={() => {}}
      />,
    );
    const bars = screen.getAllByRole('button', { name: /跨週予定/ });
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveStyle({
      gridColumn: '6 / 8',
      backgroundColor: '#dc262633',
      color: '#000000',
    });
    expect(bars[1]).toHaveStyle({
      gridColumn: '1 / 3',
      backgroundColor: '#dc262633',
      color: '#000000',
    });
    expect(bars[0].textContent).toBe('跨週予定');
    expect(bars[1].textContent).toBe('跨週予定');
    fireEvent.doubleClick(bars[1]);
    expect(onOpen).toHaveBeenLastCalledWith(event, '2026-10-26');
  });
});
