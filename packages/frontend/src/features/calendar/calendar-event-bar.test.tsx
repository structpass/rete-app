import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import { CalendarEventBar } from './calendar-event-bar';
import { toInstant } from './calendar-dates';
const event: CalendarEventSummary = {
  id: 'e',
  title: '予定',
  startAt: toInstant('2026-10-26T09:00'),
  endAt: toInstant('2026-10-27T10:00'),
  revision: 2,
  allDay: false,
  tags: [],
};
function setup({
  view = 'month',
  editable = true,
  allDay = false,
  disabled = false,
}: { view?: 'month' | 'week'; editable?: boolean; allDay?: boolean; disabled?: boolean } = {}) {
  const save = vi.fn(),
    open = vi.fn(),
    row = allDay
      ? {
          ...event,
          allDay: true,
          startAt: toInstant('2026-10-26T00:00'),
          endAt: toInstant('2026-10-28T00:00'),
        }
      : event;
  const { container, unmount } = render(
    <div className="calendar-left">
      {['2026-10-26', '2026-10-27'].map((day, i) => (
        <div
          key={day}
          data-calendar-drop-day={day}
          data-calendar-drop-time={view === 'week' && !allDay ? 'true' : undefined}
          data-index={i}
        />
      ))}
      <CalendarEventBar
        eventRow={row}
        view={view}
        onReschedule={editable ? save : undefined}
        disabled={disabled}
        onClick={open}
        onDoubleClick={open}
      >
        予定
      </CalendarEventBar>
    </div>,
  );
  container.querySelector('.calendar-left')!.getBoundingClientRect = () =>
    ({ left: 0, right: 200, top: 0, bottom: 1008, width: 200, height: 1008 }) as DOMRect;
  container.querySelectorAll<HTMLElement>('[data-calendar-drop-day]').forEach((element, index) => {
    element.getBoundingClientRect = () =>
      ({
        left: index * 100,
        right: (index + 1) * 100,
        top: 0,
        bottom: 1008,
        width: 100,
        height: 1008,
      }) as DOMRect;
  });
  const bar = screen.getByRole('button', { name: '予定' });
  return { save, open, bar, row, unmount };
}
const pointer = (x: number, y = 400) => ({
  pointerId: 1,
  button: 0,
  clientX: x,
  clientY: y,
  isPrimary: true,
});
beforeEach(() =>
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId: number;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
      }
    },
  ),
);
afterEach(() => vi.unstubAllGlobals());
describe('event drag gestures', () => {
  it('ignores other pointer IDs while a primary gesture is active', () => {
    const { bar, save } = setup();
    fireEvent.pointerDown(bar, pointer(20));
    fireEvent.pointerMove(document, { ...pointer(120), pointerId: 2 });
    fireEvent.pointerCancel(document, { ...pointer(120), pointerId: 2 });
    fireEvent.pointerUp(document, { ...pointer(120), pointerId: 2 });
    expect(save).not.toHaveBeenCalled();
    fireEvent.pointerMove(document, pointer(120));
    fireEvent.pointerUp(document, pointer(120));
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('preserves clicks but moves only once on drop and suppresses the following click/doubleclick', () => {
    const { bar, save, open, row } = setup();
    fireEvent.pointerDown(bar, pointer(20));
    fireEvent.pointerUp(document, pointer(20));
    fireEvent.click(bar);
    expect(open).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    fireEvent.pointerDown(bar, pointer(20));
    fireEvent.pointerMove(document, pointer(120));
    expect(screen.getByRole('status')).toHaveTextContent('10/27 9:00 ～ 10/28 10:00');
    expect(bar).toHaveStyle({ transform: 'translate(100px, 0px)' });
    expect(save).not.toHaveBeenCalled();
    fireEvent.pointerUp(document, pointer(120));
    fireEvent.click(bar, { detail: 1 });
    fireEvent.doubleClick(bar, { detail: 2 });
    expect(save).toHaveBeenCalledExactlyOnceWith(row, {
      startAt: toInstant('2026-10-27T09:00'),
      endAt: toInstant('2026-10-28T10:00'),
    });
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(bar, { detail: 0 });
    expect(open).toHaveBeenCalledTimes(2);
  });
  it.each(['start', 'end'] as const)(
    'resizes the %s endpoint horizontally in month mode',
    (edge) => {
      const { bar, save, row } = setup();
      fireEvent.pointerDown(bar.querySelector(`[data-calendar-resize="${edge}"]`)!, pointer(20));
      fireEvent.pointerMove(document, pointer(120));
      fireEvent.pointerUp(document, pointer(120));
      expect(save).toHaveBeenCalledWith(row, {
        startAt: edge === 'start' ? toInstant('2026-10-27T09:00') : row.startAt,
        endAt: edge === 'end' ? toInstant('2026-10-28T10:00') : row.endAt,
      });
    },
  );
  it('moves across weekday columns and half-hour rows in week mode', () => {
    const { bar, save, row } = setup({ view: 'week' });
    fireEvent.pointerDown(bar, pointer(20, 378));
    fireEvent.pointerMove(document, pointer(120, 399));
    fireEvent.pointerUp(document, pointer(120, 399));
    expect(save).toHaveBeenCalledWith(row, {
      startAt: toInstant('2026-10-27T09:30'),
      endAt: toInstant('2026-10-28T10:30'),
    });
  });
  it('resizes weekly timed events vertically in half-hour steps', () => {
    const { bar, save, row } = setup({ view: 'week' });
    fireEvent.pointerDown(bar.querySelector('[data-calendar-resize="end"]')!, pointer(20, 378));
    fireEvent.pointerMove(document, pointer(20, 420));
    fireEvent.pointerUp(document, pointer(20, 420));
    expect(save).toHaveBeenCalledWith(row, {
      startAt: row.startAt,
      endAt: toInstant('2026-10-27T11:00'),
    });
  });
  it('resizes weekly all-day events in whole days with a vertical edge gesture', () => {
    const { bar, save, row } = setup({ view: 'week', allDay: true });
    fireEvent.pointerDown(bar.querySelector('[data-calendar-resize="end"]')!, pointer(20, 20));
    fireEvent.pointerMove(document, pointer(20, 44));
    fireEvent.pointerUp(document, pointer(20, 44));
    expect(save).toHaveBeenCalledWith(row, {
      startAt: row.startAt,
      endAt: toInstant('2026-10-29T00:00'),
    });
  });
  it('can extend the start of an 18px all-day bar upwards into space without a date hit', () => {
    const { bar, save, row } = setup({ view: 'week', allDay: true });
    document.querySelectorAll<HTMLElement>('[data-calendar-drop-day]').forEach((element, index) => {
      element.getBoundingClientRect = () =>
        ({
          left: index * 100,
          right: (index + 1) * 100,
          top: 80,
          bottom: 98,
          width: 100,
          height: 18,
        }) as DOMRect;
    });
    fireEvent.pointerDown(bar.querySelector('[data-calendar-resize="start"]')!, pointer(20, 80));
    fireEvent.pointerMove(document, pointer(20, 32));
    fireEvent.pointerUp(document, pointer(20, 32));
    expect(save).toHaveBeenCalledWith(row, {
      startAt: toInstant('2026-10-24T00:00'),
      endAt: row.endAt,
    });
  });
  it.each(['escape', 'cancel', 'outside', 'unchanged', 'unmount'])(
    'does not save after %s',
    (action) => {
      const { bar, save, unmount } = setup();
      fireEvent.pointerDown(bar, pointer(20));
      fireEvent.pointerMove(document, pointer(120));
      if (action === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
      if (action === 'cancel') fireEvent.pointerCancel(document, pointer(120));
      if (action === 'unmount') unmount();
      fireEvent.pointerUp(
        document,
        pointer(action === 'outside' ? 220 : action === 'unchanged' ? 20 : 120),
      );
      expect(save).not.toHaveBeenCalled();
    },
  );
  it.each([{ editable: false }, { disabled: true }])(
    'does not allow dragging when %j',
    (options) => {
      const { bar, save } = setup(options);
      expect(bar.querySelector('[data-calendar-resize]')).toBeNull();
      fireEvent.pointerDown(bar, pointer(20));
      fireEvent.pointerMove(document, pointer(120));
      fireEvent.pointerUp(document, pointer(120));
      expect(save).not.toHaveBeenCalled();
    },
  );
});
