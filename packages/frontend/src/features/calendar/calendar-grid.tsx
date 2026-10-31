'use client';
import { useEffect, useRef } from 'react';
import type { CalendarEventSummary, CalendarHoliday } from '@rete/shared';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { addDays, monthLabel, shiftMonth, weekStart } from './calendar-dates';
import type { useCalendarPeriod } from './use-calendar-period';
import { CalendarMonthWeek } from './calendar-month-week';
import { CalendarTimeWeek } from './calendar-time-week';
import type { CalendarReschedule } from './calendar-event-bar';
type Period = ReturnType<typeof useCalendarPeriod>;
export interface CalendarGridProps {
  period: Period;
  events: CalendarEventSummary[];
  holidays?: CalendarHoliday[];
  loading: boolean;
  blocked: boolean;
  busy: boolean;
  onToday?: () => void;
  onReschedule?: CalendarReschedule;
  onSelectDay?: (day: string, focus: () => void) => void;
  onSelectSlot?: (day: string, slot: number, focus: () => void) => void;
  onCreate?: (day: string) => void;
  onTurn: (direction: number) => void;
  onMode: (mode: 'month' | 'week') => void;
  onOpen: (event: CalendarEventSummary, day: string) => void;
  onMore: (day: string) => void;
}
export function CalendarGrid(props: CalendarGridProps) {
  const { period: p } = props;
  const months = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (months.current) months.current.scrollTop = 0;
  }, [p.todayNavigation]);
  return (
    <section className="calendar-left" aria-busy={props.loading}>
      <div className="calendar-toolbar">
        <strong>
          {p.mode === 'month'
            ? monthLabel(p.month)
            : `${weekStart(p.active).replaceAll('-', '/')} 〜 ${addDays(weekStart(p.active), 6).slice(5).replace('-', '/')}`}
        </strong>
        <Button
          variant="ghost"
          aria-label={p.mode === 'month' ? '前の月' : '前の週'}
          onClick={() => props.onTurn(-1)}
          disabled={props.busy}
        >
          <ChevronLeft size={18} />
        </Button>
        <Button
          variant="ghost"
          aria-label={p.mode === 'month' ? '次の月' : '次の週'}
          onClick={() => props.onTurn(1)}
          disabled={props.busy}
        >
          <ChevronRight size={18} />
        </Button>
        <Button
          variant="ghost"
          aria-label="今日へ移動"
          title="今日へ移動"
          onClick={props.onToday}
          disabled={props.busy}
        >
          <CalendarDays size={18} />
        </Button>
        <div className="calendar-mode" role="group" aria-label="表示期間">
          {(['week', 'month'] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={p.mode === mode}
              disabled={props.busy}
              onClick={() => props.onMode(mode)}
            >
              {mode === 'week' ? '週' : '月'}
            </button>
          ))}
        </div>
      </div>
      {p.mode === 'week' ? (
        <CalendarTimeWeek {...props} />
      ) : (
        <div className="calendar-months" ref={months}>
          {p.dates.map((days, index) => (
            <CalendarMonth
              key={p.mode === 'month' ? shiftMonth(p.month, index) : 'week'}
              {...props}
              days={days}
              month={shiftMonth(p.month, index)}
              showHeading={p.mode === 'month' && index > 0}
            />
          ))}
        </div>
      )}
    </section>
  );
}
function CalendarMonth({
  days,
  month,
  showHeading,
  ...props
}: CalendarGridProps & { days: string[]; month: string; showHeading: boolean }) {
  return (
    <section className="calendar-month">
      {showHeading && <h3>{monthLabel(month)}</h3>}
      <div className="calendar-weekdays">
        {['月', '火', '水', '木', '金', '土', '日'].map((day) => (
          <div key={day}>{day}</div>
        ))}
      </div>
      {Array.from({ length: days.length / 7 }, (_, week) => (
        <CalendarMonthWeek
          key={days[week * 7]}
          {...props}
          month={month}
          hideBeforeMonth={showHeading}
          hideAfterMonth={!showHeading}
          days={days.slice(week * 7, week * 7 + 7)}
        />
      ))}
    </section>
  );
}
