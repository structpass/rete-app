import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { CalendarEventSummary } from '@rete/shared';
import { DAY } from './calendar-dates';
import {
  calendarDragDelta,
  calendarDragRange,
  calendarDropPoint,
  type CalendarDragMode,
  type CalendarDropPoint,
  type CalendarRange,
} from './calendar-drag-range';

export type CalendarDragPreview = {
  range: CalendarRange | null;
  x: number;
  y: number;
  visual: CSSProperties;
};
type Options = {
  row: CalendarEventSummary;
  view: 'month' | 'week';
  preview: (value: CalendarDragPreview | null) => void;
  dragged: () => void;
  save: (row: CalendarEventSummary, range: CalendarRange) => void;
};
type Session = Options & {
  root: Element;
  origin: CalendarDropPoint;
  bounds: DOMRect;
  mode: CalendarDragMode;
  x: number;
  y: number;
  pointer: number;
  timed: boolean;
  moved: boolean;
  range: CalendarRange | null;
};
function visual(s: Session, dx: number, dy: number): CSSProperties {
  if (s.mode === 'move') return { transform: `translate(${dx}px, ${dy}px)`, zIndex: 5 };
  if (s.view === 'month')
    return {
      width: Math.max(18, s.bounds.width + (s.mode === 'end' ? dx : -dx)),
      transform:
        s.mode === 'start' ? `translateX(${Math.min(dx, s.bounds.width - 18)}px)` : undefined,
      zIndex: 5,
    };
  if (s.row.allDay) return {};
  return {
    height: Math.max(18, s.bounds.height + (s.mode === 'end' ? dy : -dy)),
    transform:
      s.mode === 'start' ? `translateY(${Math.min(dy, s.bounds.height - 18)}px)` : undefined,
    zIndex: 5,
  };
}
function inside(root: Element, event: PointerEvent) {
  const area = root.getBoundingClientRect();
  return (
    event.clientX >= area.left &&
    event.clientX < area.right &&
    event.clientY >= area.top &&
    event.clientY < area.bottom
  );
}
function update(s: Session, event: PointerEvent) {
  if (event.pointerId !== s.pointer) return;
  const dx = event.clientX - s.x,
    dy = event.clientY - s.y;
  if (!s.moved && Math.hypot(dx, dy) < 5) return;
  s.moved = true;
  s.dragged();
  event.preventDefault();
  const target = calendarDropPoint(s.root, event.clientX, event.clientY, s.timed);
  const allDayResize = s.view === 'week' && s.row.allDay && s.mode !== 'move';
  const valid = !!target || (allDayResize && inside(s.root, event));
  const delta = allDayResize
    ? Math.round(dy / 24) * DAY
    : target
      ? calendarDragDelta(s.origin, target, s.timed)
      : 0;
  s.range = valid ? calendarDragRange(s.row, s.mode, delta, s.timed ? 30 * 60000 : DAY) : null;
  s.preview({ range: s.range, x: event.clientX, y: event.clientY, visual: visual(s, dx, dy) });
}
function changed(s: Session) {
  return (
    s.range &&
    (Date.parse(s.range.startAt) !== Date.parse(s.row.startAt) ||
      Date.parse(s.range.endAt) !== Date.parse(s.row.endAt))
  );
}
function listen(s: Session) {
  const move = (event: PointerEvent) => update(s, event);
  const stop = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', cancel);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('blur', stop);
    s.preview(null);
  };
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === s.pointer) stop();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stop();
  };
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== s.pointer) return;
    if (s.moved) update(s, event);
    stop();
    if (s.moved && changed(s)) s.save(s.row, s.range!);
  };
  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', cancel);
  document.addEventListener('keydown', escape, true);
  window.addEventListener('blur', stop);
  return stop;
}
export function beginCalendarGesture(
  event: ReactPointerEvent<HTMLButtonElement>,
  options: Options,
) {
  if (event.button !== 0 || event.isPrimary === false) return null;
  const root = event.currentTarget.closest('.calendar-left');
  if (!root) return null;
  const timed = options.view === 'week' && !options.row.allDay;
  const origin = calendarDropPoint(root, event.clientX, event.clientY, timed);
  if (!origin) return null;
  const mode = (event.target as HTMLElement).closest<HTMLElement>('[data-calendar-resize]')?.dataset
    .calendarResize as CalendarDragMode | undefined;
  return listen({
    ...options,
    root,
    origin,
    timed,
    mode: mode ?? 'move',
    bounds: event.currentTarget.getBoundingClientRect(),
    x: event.clientX,
    y: event.clientY,
    pointer: event.pointerId,
    moved: false,
    range: null,
  });
}
