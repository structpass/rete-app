'use client';
import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import type { CalendarEventSummary } from '@rete/shared';
import { calendarEventRange } from './calendar-event-presentation';
import type { CalendarRange } from './calendar-drag-range';
import { beginCalendarGesture, type CalendarDragPreview } from './calendar-event-gesture';
import './calendar-event-drag.css';

export type CalendarReschedule = (event: CalendarEventSummary, range: CalendarRange) => void;
type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  eventRow: CalendarEventSummary;
  view: 'month' | 'week';
  onReschedule?: CalendarReschedule;
};

export function CalendarEventBar({ eventRow, view, onReschedule, children, ...props }: Props) {
  const [preview, setPreview] = useState<CalendarDragPreview | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressed = useRef(false);
  useEffect(() => () => cleanup.current?.(), []);
  return (
    <>
      <button
        {...props}
        style={{ ...props.style, ...preview?.visual }}
        className={`${props.className ?? ''}${onReschedule ? ` calendar-draggable calendar-drag-${view}` : ''}${preview ? ' is-dragging' : ''}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.isPrimary === false) return;
          suppressed.current = false;
          if (!onReschedule || props.disabled) return;
          cleanup.current?.();
          cleanup.current = beginCalendarGesture(event, {
            row: eventRow,
            view,
            preview: setPreview,
            dragged: () => {
              suppressed.current = true;
            },
            save: onReschedule,
          });
        }}
        onClick={(event) => {
          if (suppressed.current && event.detail > 0) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          props.onClick?.(event);
        }}
        onDoubleClick={(event) => {
          if (suppressed.current && event.detail > 0) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          props.onDoubleClick?.(event);
        }}
      >
        {children}
        {onReschedule && !props.disabled && (
          <>
            <span
              aria-hidden="true"
              title="開始を変更"
              className="calendar-resize calendar-resize-start"
              data-calendar-resize="start"
            />
            <span
              aria-hidden="true"
              title="終了を変更"
              className="calendar-resize calendar-resize-end"
              data-calendar-resize="end"
            />
          </>
        )}
      </button>
      {preview && (
        <div
          className="calendar-drag-preview"
          role="status"
          style={{ left: preview.x + 12, top: preview.y + 12 }}
        >
          {preview.range
            ? `${eventRow.title} ${calendarEventRange({ ...eventRow, ...preview.range })}`
            : 'この場所には移動できません'}
        </div>
      )}
    </>
  );
}
