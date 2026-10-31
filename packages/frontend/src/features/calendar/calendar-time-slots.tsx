'use client';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { CalendarGridProps } from './calendar-grid';
import { addDays } from './calendar-dates';
const time = (slot: number) => `${Math.floor(slot / 2)}:${slot % 2 ? '30' : '00'}`;
export function CalendarTimeSlots({
  props,
  day,
  hourHeight,
}: {
  props: CalendarGridProps;
  day: string;
  hourHeight: number;
}) {
  const choose = (key: string, slot: number, focus: () => void) => {
    if (props.busy) return;
    if (props.onSelectSlot) props.onSelectSlot(key, slot, focus);
    else {
      props.period.selectSlot?.(key, slot);
      focus();
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, slot: number) => {
    const vertical = { ArrowUp: -1, ArrowDown: 1 }[event.key],
      horizontal = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (vertical === undefined && horizontal === undefined) return;
    event.preventDefault();
    const nextSlot = Math.max(0, Math.min(47, slot + (vertical ?? 0))),
      key = addDays(day, horizontal ?? 0);
    const root = event.currentTarget.closest('.calendar-time-week');
    choose(key, nextSlot, () =>
      requestAnimationFrame(() =>
        root
          ?.querySelector<HTMLButtonElement>(`[data-slot-key="${key}#${nextSlot}"]`)
          ?.focus({ preventScroll: true }),
      ),
    );
  };
  const selected = props.period.selectedSlot;
  const visible = selected && props.period.dates[0].includes(selected.day);
  return (
    <>
      {Array.from({ length: 48 }, (_, slot) => {
        const active = selected?.day === day && selected.slot === slot;
        return (
          <button
            type="button"
            key={slot}
            // 日を跨いで同じ番号が並ぶため、属する日は名前付きの組で持つ（単独でも一意）。
            data-slot-key={`${day}#${slot}`}
            data-slot-day={day}
            data-slot={slot}
            className={`calendar-time-slot${active ? ' is-selected' : ''}`}
            aria-label={`${day} ${time(slot)} ～ ${time(slot + 1)}`}
            aria-pressed={active}
            tabIndex={visible ? (active ? 0 : -1) : slot === 18 ? 0 : -1}
            disabled={props.busy}
            style={{ top: (slot * hourHeight) / 2, height: hourHeight / 2 } as CSSProperties}
            onKeyDown={(event) => keyboard(event, slot)}
            onClick={(event) => {
              const button = event.currentTarget;
              choose(day, slot, () => button.focus({ preventScroll: true }));
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (!props.busy) props.onCreate?.(day);
            }}
          />
        );
      })}
    </>
  );
}
