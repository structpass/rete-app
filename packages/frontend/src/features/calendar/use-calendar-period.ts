'use client';
import { useEffect, useMemo, useState } from 'react';
import { addDays, monthDays, monthStart, shiftMonth, todayKey, weekStart } from './calendar-dates';
export function useCalendarPeriod() {
  const { today, setToday } = useCalendarToday();
  const [active, setActive] = useState(todayKey);
  const [month, setMonth] = useState(() => monthStart(todayKey()));
  const [selectedSlot, setSelectedSlot] = useState<{ day: string; slot: number } | null>(null);
  const [todayNavigation, setTodayNavigation] = useState(0);
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const dates = useMemo(
    () =>
      mode === 'month'
        ? [monthDays(month), monthDays(shiftMonth(month, 1))]
        : [Array.from({ length: 7 }, (_, i) => addDays(weekStart(active), i))],
    [mode, month, active],
  );
  const from = dates[0][0],
    to = addDays(dates.at(-1)!.at(-1)!, 1);
  function selectDate(key: string, focus = false) {
    setActive(key);
    setSelectedSlot(null);
    if (focus) {
      if (mode === 'month' && (key < from || key >= to)) setMonth(monthStart(key));
      requestAnimationFrame(() =>
        document.querySelector<HTMLButtonElement>(`[data-day="${key}"]`)?.focus(),
      );
    }
  }
  function selectSlot(day: string, slot: number) {
    setActive(day);
    setSelectedSlot({ day, slot: Math.max(0, Math.min(47, slot)) });
  }
  function turn(direction: number) {
    setSelectedSlot(null);
    if (mode === 'week') setActive(addDays(active, 7 * direction));
    else {
      const first = shiftMonth(month, direction),
        end = shiftMonth(first, 2),
        selected = shiftMonth(active, direction);
      setMonth(first);
      setActive(selected < first ? first : selected >= end ? addDays(end, -1) : selected);
    }
  }
  function goToday() {
    setSelectedSlot(null);
    const key = todayKey();
    setToday(key);
    setActive(key);
    setMonth(monthStart(key));
    setTodayNavigation((value) => value + 1);
  }
  function switchMode(next: 'month' | 'week') {
    setSelectedSlot(null);
    if (next === 'month') setMonth(monthStart(active));
    setMode(next);
  }
  const navigation = { selectDate, selectSlot, turn, switchMode, goToday, todayNavigation };
  return { today, active, month, mode, dates, from, to, selectedSlot, ...navigation };
}

function useCalendarToday() {
  const [today, setToday] = useState(todayKey);
  useEffect(() => {
    const tick = () => setToday(todayKey());
    const interval = setInterval(tick, 30000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', tick);
    };
  }, []);
  return { today, setToday };
}
