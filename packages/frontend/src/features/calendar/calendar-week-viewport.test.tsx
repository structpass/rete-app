import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CalendarTimeWeek } from './calendar-time-week';
import type { CalendarGridProps } from './calendar-grid';
import { addDays } from './calendar-dates';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('remeasures viewport and sticky header on resize and keeps 8–20 initially visible with all 48 slots', () => {
  let available = 600,
    header = 70;
  const observers: ResizeObserverCallback[] = [];
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('calendar-time-scroll')
      ? available
      : this.classList.contains('calendar-time-header')
        ? header
        : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const period = {
    active: '2026-10-26',
    today: '2026-10-28',
    dates: [Array.from({ length: 7 }, (_, i) => addDays('2026-10-26', i))],
    selectDate: vi.fn(),
  } as unknown as CalendarGridProps['period'];
  const { container } = render(
    <CalendarTimeWeek
      period={period}
      events={[]}
      busy={false}
      blocked={false}
      loading={false}
      onOpen={() => {}}
      onMode={() => {}}
      onTurn={() => {}}
      onMore={() => {}}
    />,
  );
  const grid = container.querySelector<HTMLElement>('.calendar-time-week')!,
    scroll = container.querySelector<HTMLElement>('.calendar-time-scroll')!;
  const check = () => {
    const hour = parseFloat(grid.style.getPropertyValue('--calendar-hour'));
    expect(12 * hour + header + 24).toBeCloseTo(available);
    expect(scroll.scrollTop).toBeCloseTo(12 + hour * 8);
  };
  check();
  available = 420;
  header = 100;
  act(() => observers.forEach((callback) => callback([], {} as ResizeObserver)));
  check();
  expect(container.querySelectorAll('.calendar-time-slot')).toHaveLength(7 * 48);
});
