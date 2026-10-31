'use client';
import { useEffect } from 'react';
import { NAVIGATION_INTENT } from '@/lib/navigation-intent';
export function useCalendarNavigation(
  dirty: boolean,
  busy: boolean,
  request: (dirty: boolean, proceed: () => void) => void,
) {
  useEffect(() => {
    if (!dirty && !busy) return;
    let approved = false;
    const unload = (e: BeforeUnloadEvent) => {
      if (!approved) e.preventDefault();
    };
    const intent = (e: Event) => {
      e.preventDefault();
      if (!busy)
        request(true, () => {
          approved = true;
          (e as CustomEvent<{ proceed: () => void }>).detail.proceed();
        });
    };
    const navigate = (e: MouseEvent) => {
      const link = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
      if (!link || link.href === location.href || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (!busy)
        request(true, () => {
          approved = true;
          window.location.assign(link.href);
        });
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener(NAVIGATION_INTENT, intent);
    document.addEventListener('click', navigate, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener(NAVIGATION_INTENT, intent);
      document.removeEventListener('click', navigate, true);
    };
  }, [dirty, busy, request]);
}
