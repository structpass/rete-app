import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCalendarPeriod } from './use-calendar-period';
afterEach(() => vi.useRealTimers());
describe('today navigation', () => {
  it('returns to the current month and selected date from another year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T03:00:00Z'));
    const { result } = renderHook(() => useCalendarPeriod());
    act(() => result.current.turn(-12));
    expect(result.current.month).toBe('2025-10-01');
    act(() => result.current.goToday());
    expect(result.current.mode).toBe('month');
    expect(result.current.month).toBe('2026-10-01');
    expect(result.current.active).toBe('2026-10-25');
    expect(result.current.todayNavigation).toBe(1);
    act(() => result.current.goToday());
    expect(result.current.todayNavigation).toBe(2);
  });
  it('preserves weekly mode and computes today again across JST midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T14:59:00Z'));
    const { result } = renderHook(() => useCalendarPeriod());
    act(() => result.current.switchMode('week'));
    act(() => result.current.turn(-8));
    act(() => result.current.goToday());
    expect(result.current.dates[0][0]).toBe('2026-10-19');
    expect(result.current.active).toBe('2026-10-25');
    act(() => result.current.turn(-8));
    vi.setSystemTime(new Date('2026-10-25T15:01:00Z'));
    act(() => result.current.goToday());
    expect(result.current.mode).toBe('week');
    expect(result.current.today).toBe('2026-10-26');
    expect(result.current.active).toBe('2026-10-26');
    expect(result.current.dates[0][0]).toBe('2026-10-26');
    expect(result.current.dates[0][6]).toBe('2026-11-01');
  });
});
