'use client';
import type { MouseEvent } from 'react';
import type { CalendarGridProps } from './calendar-grid';
import { addDays } from './calendar-dates';
import { selectCalendarDay } from './calendar-day-selection';
import { calendarMonthLayout } from './calendar-month-layout';
import { calendarEventRange } from './calendar-event-presentation';
import { calendarEventColor } from './calendar-event-color';
import { CalendarEventBar } from './calendar-event-bar';
type Props = CalendarGridProps & {
  days: string[];
  month: string;
  hideBeforeMonth?: boolean;
  hideAfterMonth?: boolean;
};
export function CalendarMonthWeek(props: Props) {
  const { period: p, days, month } = props;
  const skipped = props.hideBeforeMonth ? days.filter((day) => day < month).length : 0;
  const end = props.hideAfterMonth
    ? days.filter((day) => day.slice(0, 7) <= month.slice(0, 7)).length
    : days.length;
  const blank = (index: number) => index < skipped || index >= end;
  const layout = calendarMonthLayout(props.events, days.slice(skipped, end));
  const segments = layout.segments.map((segment) => ({
    ...segment,
    start: segment.start + skipped,
    end: segment.end + skipped,
  }));
  const hidden = [
    ...Array<number>(skipped).fill(0),
    ...layout.hidden,
    ...Array<number>(days.length - end).fill(0),
  ];
  const state = (day: string) =>
    `${[0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()) ? ' is-weekend' : ''}${day === p.active ? ' is-selected' : ''}${day.slice(0, 7) !== month.slice(0, 7) ? ' is-outside' : ''}`;
  const create = (event: MouseEvent<HTMLElement>, day: string) => {
    if (!props.busy && !(event.target as Element).closest('.calendar-event, .calendar-more'))
      props.onCreate?.(day);
  };
  return (
    <div className="calendar-week">
      {days.map((day, index) => (
        <div
          key={`background-${day}`}
          data-calendar-drop-day={blank(index) ? undefined : day}
          className={`calendar-cell calendar-day-background${blank(index) ? ' calendar-day-empty' : state(day)}`}
          aria-hidden={blank(index) ? true : undefined}
          style={{
            gridColumn: index + 1,
            gridRow: '1 / -1',
            ...(blank(index) ? { backgroundColor: '#ffffff' } : {}),
          }}
          onClick={
            blank(index)
              ? undefined
              : (event) =>
                  selectCalendarDay(event, day, p.selectDate, props.busy, props.onSelectDay)
          }
          onDoubleClick={blank(index) ? undefined : (event) => create(event, day)}
        />
      ))}
      {days.map((day, index) =>
        blank(index) ? null : (
          <div
            key={day}
            className={`calendar-cell calendar-day-heading${state(day)}`}
            style={{ gridColumn: index + 1, gridRow: 1 }}
            onClick={(event) =>
              selectCalendarDay(event, day, p.selectDate, props.busy, props.onSelectDay)
            }
            onDoubleClick={(event) => create(event, day)}
          >
            <button
              disabled={props.busy}
              data-day={day}
              aria-label={day}
              aria-current={day === p.today ? 'date' : undefined}
              aria-pressed={day === p.active}
              className={`calendar-date${day === p.today ? ' is-today' : ''}`}
              onKeyDown={(event) => {
                const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[
                  event.key
                ];
                if (delta) {
                  event.preventDefault();
                  p.selectDate(addDays(day, delta), true);
                }
              }}
            >
              {Number(day.slice(8))}
            </button>
            {props.holidays
              ?.filter((holiday) => holiday.date === day)
              .map((holiday) => (
                <span key={holiday.date} className="calendar-holiday" title={holiday.name}>
                  {holiday.name}
                </span>
              ))}
          </div>
        ),
      )}
      {segments.map(({ event, start, end, lane }) => (
        <CalendarEventBar
          key={event.id}
          eventRow={event}
          view="month"
          onReschedule={props.onReschedule}
          className="calendar-event calendar-month-event"
          disabled={props.blocked}
          style={{
            ...calendarEventColor(event),
            gridColumn: `${start + 1} / ${end + 1}`,
            gridRow: lane + 2,
          }}
          onClick={() => props.onOpen(event, days[start])}
          onDoubleClick={(mouseEvent) => {
            mouseEvent.stopPropagation();
            if (!props.blocked) props.onOpen(event, days[start]);
          }}
          aria-label={`${event.title} ${calendarEventRange(event)}`}
          title={event.title}
        >
          {event.title}
        </CalendarEventBar>
      ))}
      {hidden.map((count, index) =>
        count > 0 ? (
          <button
            key={days[index]}
            className="calendar-more"
            style={{ gridColumn: index + 1, gridRow: 5 }}
            disabled={props.busy}
            onClick={() => props.onMore(days[index])}
          >
            ほか{count}件
          </button>
        ) : null,
      )}
    </div>
  );
}
