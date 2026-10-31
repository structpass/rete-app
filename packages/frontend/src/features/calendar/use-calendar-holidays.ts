'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  fetchCalendarHolidays,
  type CalendarHoliday,
} from '@/features/settings/lib/calendar-holidays-api';
export function useCalendarHolidays() {
  const [holidays, setHolidays] = useState<CalendarHoliday[]>([]);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    fetchCalendarHolidays()
      .then((response) => {
        if (active) {
          setHolidays(response);
          setError('');
        }
      })
      .catch(() => {
        if (active) setError('祝日を取得できませんでした。');
      });
    return () => {
      active = false;
    };
  }, [generation]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  return { holidays, error, refresh };
}
