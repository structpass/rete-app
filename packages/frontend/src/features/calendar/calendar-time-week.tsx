'use client';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { localInput } from './calendar-dates';
import type { CalendarGridProps } from './calendar-grid';
import {
  calendarHourHeight,
  calendarInitialScroll,
  calendarMinHourHeight,
} from './calendar-hour-height';
import { CalendarWeekHeader } from './calendar-week-header';
import { CalendarTimeSlots } from './calendar-time-slots';
import { calendarEventColor } from './calendar-event-color';
import { calendarWeekLayout } from './calendar-week-layout';
import { CalendarEventBar } from './calendar-event-bar';
import './calendar-week-presentation.css';

export function CalendarTimeWeek(props: CalendarGridProps) {
  const { period: p, events, blocked, onOpen } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const [hourHeight, setHourHeight] = useState(calendarMinHourHeight);
  const firstDay = p.dates[0][0];
  const measure = () => {
    const element = viewport.current;
    if (!element) return null;
    return { element, viewHeight: element.clientHeight };
  };
  useLayoutEffect(() => {
    const measured = measure();
    if (!measured) return;
    const { element } = measured;
    // Measure the constrained wrapper, never the content whose height depends on hourHeight.
    const source = element.parentElement!;
    const resize = () => {
      const headerHeight = (element.firstElementChild as HTMLElement | null)?.clientHeight;
      const height = calendarHourHeight(element.clientHeight, headerHeight);
      if (height === null) return;
      setHourHeight((prev) => (Math.abs(prev - height) < 0.05 ? prev : height));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(source);
    observer.observe(element);
    const header = element.firstElementChild as HTMLElement | null;
    if (header) observer.observe(header);
    return () => observer.disconnect();
  }, [firstDay]);
  // Start at 8:00 below the sticky header; the measured tick fits through 20:00.
  useLayoutEffect(() => {
    const measured = measure();
    if (!measured) return;
    const { element, viewHeight } = measured;
    element.scrollTop = calendarInitialScroll({
      available: viewHeight,
      scrollHeight: element.scrollHeight,
      hourHeight,
    });
  }, [hourHeight, firstDay, p.todayNavigation]);
  const timedEvents = events.filter((event) => !event.allDay);
  return (
    <div
      className="calendar-time-week"
      style={{ '--calendar-hour': `${hourHeight}px` } as CSSProperties}
    >
      <div
        className="calendar-time-scroll"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="週の時間帯"
      >
        <CalendarWeekHeader {...props} />
        <div className="calendar-time-body">
          <div className="calendar-time-labels" aria-hidden="true">
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} style={{ top: hour * hourHeight }}>
                {hour}:00
              </span>
            ))}
          </div>
          {p.dates[0].map((day) => (
            <div
              key={day}
              data-calendar-drop-day={day}
              data-calendar-drop-time="true"
              className={`calendar-time-day${[0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()) ? ' is-weekend' : ''}${day === p.active ? ' is-selected' : ''}`}
              style={{
                backgroundImage:
                  'linear-gradient(to bottom, var(--calendar-off-hours) 0% 37.5%, var(--calendar-work-hours) 37.5% 75%, var(--calendar-off-hours) 75% 100%)',
              }}
            >
              <CalendarTimeSlots props={props} day={day} hourHeight={hourHeight} />
              {Array.from({ length: 49 }, (_, slot) => (
                <div
                  key={slot}
                  aria-hidden="true"
                  className={`calendar-time-line${slot % 2 === 0 ? ' is-hour' : ''}`}
                  style={{ top: (slot * hourHeight) / 2 }}
                />
              ))}
              {calendarWeekLayout(timedEvents, day, (20 * 60) / hourHeight).map(
                ({ event, start, end, column, columns }) => (
                  <CalendarEventBar
                    key={event.id}
                    eventRow={event}
                    view="week"
                    onReschedule={props.onReschedule}
                    className="calendar-event calendar-time-event calendar-week-band"
                    disabled={blocked}
                    onClick={() => onOpen(event, day)}
                    onDoubleClick={(mouseEvent) => {
                      mouseEvent.stopPropagation();
                      if (!blocked) onOpen(event, day);
                    }}
                    aria-label={`${event.title} ${localInput(event.startAt).replace('T', ' ')} 〜 ${localInput(event.endAt).replace('T', ' ')}`}
                    title={`${event.title}\n${localInput(event.startAt).replace('T', ' ')} 〜 ${localInput(event.endAt).replace('T', ' ')}`}
                    style={{
                      ...calendarEventColor(event),
                      top: (start / 60) * hourHeight,
                      height: Math.max(18, ((end - start) / 60) * hourHeight - 2),
                      left: `calc(${(column / columns) * 100}% + 2px)`,
                      width: `calc(${100 / columns}% - 4px)`,
                    }}
                  >
                    {event.title}
                  </CalendarEventBar>
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
