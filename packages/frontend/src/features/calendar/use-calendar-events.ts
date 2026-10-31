'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CalendarEventSummary } from '@rete/shared';
import { extractErrorMessage } from '@/lib/error-utils';
import { fetchCalendarEvents } from './calendar-api';
export function useCalendarEvents(from: string, to: string, q: string, tagIds: string[]) {
  const [events, setEvents] = useState<CalendarEventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const tags = tagIds.join(',');
  const currentQuery = useRef({ from, to, q, tags });
  useLayoutEffect(() => {
    currentQuery.current = { from, to, q, tags };
  }, [from, to, q, tags]);
  const refresh = useCallback(async () => {
    // A save can finish after the filters change. Its retained refresh must use
    // the committed screen conditions rather than restoring the previous query.
    const { from, to, q, tags } = currentQuery.current;
    const request = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const items = await fetchCalendarEvents(from, to, q, tags ? tags.split(',') : []);
      if (request !== generation.current) return null;
      setEvents(items);
      return items;
    } catch (err) {
      if (request === generation.current)
        setError(extractErrorMessage(err, '予定の取得に失敗しました'));
      return false;
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let canceled = false;
    const requests = generation;
    void Promise.resolve().then(() => {
      if (!canceled) void refresh();
    });
    return () => {
      canceled = true;
      requests.current++;
    };
  }, [refresh, from, to, q, tags]);
  useEffect(() => {
    const onFocus = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);
  return { events, loading, error, refresh };
}
