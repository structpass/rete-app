'use client';
import { addDays } from './calendar-dates';
import { selectCalendarDay } from './calendar-day-selection';
import { calendarMonthLayout } from './calendar-month-layout';
import { calendarEventColor } from './calendar-event-color';
import { calendarEventRange } from './calendar-event-presentation';
import type { CalendarGridProps } from './calendar-grid';
import './calendar-week-header.css';
import { CalendarEventBar } from './calendar-event-bar';

const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
export function CalendarWeekHeader(props: CalendarGridProps) {
  return (
    <div className="calendar-time-header calendar-separated-header">
      <div className="calendar-weekday-row">
        <div aria-hidden="true" />
        {weekdays.map((day) => (
          <div key={day} className="calendar-weekday">
            {day}
          </div>
        ))}
      </div>
      <div className="calendar-date-row">
        <div aria-hidden="true" />
        {props.period.dates[0].map((day) => (
          <CalendarWeekDate key={day} day={day} {...props} />
        ))}
      </div>
      <CalendarWeekAllDay {...props} />
    </div>
  );
}

function CalendarWeekDate({ day, ...props }: CalendarGridProps & { day: string }) {
  const { period: p, busy } = props;
  const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
  return (
    <div
      className={`calendar-week-date${weekend ? ' is-weekend' : ''}${day === p.active ? ' is-selected' : ''}`}
      data-calendar-drop-day={day}
      onClick={(event) => selectCalendarDay(event, day, p.selectDate, busy, props.onSelectDay)}
      onDoubleClick={(event) => {
        if (!(event.target as Element).closest('.calendar-event') && !busy) props.onCreate?.(day);
      }}
    >
      <button
        className={`calendar-date${day === p.today ? ' is-today' : ''}`}
        data-day={day}
        aria-label={day}
        aria-current={day === p.today ? 'date' : undefined}
        aria-pressed={day === p.active}
        disabled={busy}
        onKeyDown={(event) => {
          const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
          if (delta) {
            event.preventDefault();
            const key = addDays(day, delta);
            const root = event.currentTarget.closest('.calendar-time-week');
            if (props.onSelectDay)
              props.onSelectDay(key, () =>
                requestAnimationFrame(() =>
                  root
                    ?.querySelector<HTMLButtonElement>(`[data-day="${key}"]`)
                    ?.focus({ preventScroll: true }),
                ),
              );
            else p.selectDate(key, true);
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
  );
}

function CalendarWeekAllDay({
  events,
  period,
  blocked,
  busy,
  onOpen,
  onCreate,
  onSelectDay,
  onReschedule,
}: CalendarGridProps) {
  const days = period.dates[0];
  const { segments } = calendarMonthLayout(
    events.filter((event) => event.allDay),
    days,
    Infinity,
  );
  if (!segments.length) return null;
  const rows = Math.max(...segments.map((segment) => segment.lane)) + 1;
  return (
    <div
      className="calendar-week-all-day-scroll"
      role="region"
      aria-label="終日の予定"
      tabIndex={0}
    >
      <div
        className="calendar-week-all-day-grid"
        style={{ gridTemplateRows: `repeat(${rows}, 18px)` }}
      >
        {days.map((day, index) => (
          <div
            key={day}
            data-day-background={day}
            data-calendar-drop-day={day}
            className={`calendar-week-all-day-background${[0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()) ? ' is-weekend' : ''}${day === period.active ? ' is-selected' : ''}`}
            style={{ gridColumn: index + 2, gridRow: '1 / -1' }}
            onClick={(event) => selectCalendarDay(event, day, period.selectDate, busy, onSelectDay)}
            onDoubleClick={() => {
              if (!busy) onCreate?.(day);
            }}
          />
        ))}
        <div className="calendar-week-all-day-gutter" style={{ gridRow: '1 / -1' }}>
          終日
        </div>
        {segments.map(({ event, start, end, lane }) => (
          <CalendarEventBar
            key={event.id}
            eventRow={event}
            view="week"
            onReschedule={onReschedule}
            className="calendar-event calendar-week-all-day-band"
            disabled={blocked}
            style={{
              ...calendarEventColor(event),
              gridColumn: `${start + 2} / ${end + 2}`,
              gridRow: lane + 1,
            }}
            onClick={(mouseEvent) => {
              mouseEvent.stopPropagation();
              onOpen(event, days[start]);
            }}
            onDoubleClick={(mouseEvent) => {
              mouseEvent.stopPropagation();
              if (!blocked) onOpen(event, days[start]);
            }}
            aria-label={`${event.title} ${calendarEventRange(event)}`}
            title={event.title}
          >
            {event.title}
          </CalendarEventBar>
        ))}
      </div>
    </div>
  );
}
