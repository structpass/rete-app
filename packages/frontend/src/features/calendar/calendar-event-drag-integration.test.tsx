import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarGrid, type CalendarGridProps } from './calendar-grid';
import { addDays, monthDays, toInstant } from './calendar-dates';
afterEach(() => vi.unstubAllGlobals());
describe('calendar event drag wiring', () => {
  it.each(['month', 'week', 'allDay'] as const)(
    'connects %s bars and day targets to the date save callback',
    (kind) => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        },
      );
      vi.stubGlobal('PointerEvent', MouseEvent);
      const weekly = kind !== 'month',
        allDay = kind === 'allDay';
      const row = {
        id: 'e',
        title: '移動対象',
        startAt: toInstant(allDay ? '2026-10-26T00:00' : '2026-10-26T09:00'),
        endAt: toInstant(allDay ? '2026-10-28T00:00' : '2026-10-27T10:00'),
        allDay,
        revision: 2,
        tags: [],
      };
      const save = vi.fn();
      const period = {
        mode: weekly ? 'week' : 'month',
        month: '2026-10-01',
        today: '2026-10-26',
        active: '2026-10-26',
        dates: [
          weekly
            ? Array.from({ length: 7 }, (_, i) => addDays('2026-10-26', i))
            : monthDays('2026-10-01'),
        ],
        selectDate: vi.fn(),
      } as unknown as CalendarGridProps['period'];
      const { container } = render(
        <CalendarGrid
          period={period}
          events={[row]}
          loading={false}
          busy={false}
          blocked={false}
          onReschedule={save}
          onOpen={() => {}}
          onTurn={() => {}}
          onMode={() => {}}
          onMore={() => {}}
        />,
      );
      const rect = (left: number, top: number, height: number, width = 100) =>
        ({ left, right: left + width, top, bottom: top + height, width, height }) as DOMRect;
      container
        .querySelectorAll<HTMLElement>(
          '.calendar-left, .calendar-time-scroll, .calendar-week-all-day-scroll',
        )
        .forEach((node) => {
          node.getBoundingClientRect = () => rect(0, 0, 1100, 700);
        });
      container.querySelectorAll<HTMLElement>('[data-calendar-drop-day]').forEach((node) => {
        const day = node.dataset.calendarDropDay!;
        const index = Math.round((Date.parse(day) - Date.parse('2026-10-26')) / 86400000);
        const top = node.dataset.calendarDropTime
          ? 50
          : node.classList.contains('calendar-week-all-day-background')
            ? 18
            : 0;
        node.getBoundingClientRect = () =>
          rect(index * 100, top, weekly && !node.dataset.calendarDropTime ? 18 : 1008);
      });
      const bar = screen.getAllByRole('button', { name: /移動対象/ })[0];
      expect(bar.querySelectorAll('[data-calendar-resize]')).toHaveLength(2);
      const y = allDay ? 22 : weekly ? 428 : 20;
      fireEvent.pointerDown(bar, { button: 0, clientX: 20, clientY: y });
      fireEvent.pointerMove(document, { clientX: 120, clientY: y });
      fireEvent.pointerUp(document, { clientX: 120, clientY: y });
      expect(save).toHaveBeenCalledExactlyOnceWith(row, {
        startAt: toInstant(allDay ? '2026-10-27T00:00' : '2026-10-27T09:00'),
        endAt: toInstant(allDay ? '2026-10-29T00:00' : '2026-10-28T10:00'),
      });
    },
  );
});
