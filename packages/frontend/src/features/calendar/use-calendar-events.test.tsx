import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import { fetchCalendarEvents } from './calendar-api';
import { useCalendarEvents } from './use-calendar-events';
vi.mock('./calendar-api', () => ({ fetchCalendarEvents: vi.fn() }));
const event = (id: string): CalendarEventSummary => ({
  id,
  title: id,
  startAt: '2026-10-24T00:00:00.000Z',
  endAt: '2026-10-24T01:00:00.000Z',
  tags: [],
  allDay: false,
  revision: 1,
});
describe('period response consistency', () => {
  beforeEach(() => vi.resetAllMocks());
  it('uses current filters when a pending save retains an earlier refresh', async () => {
    vi.mocked(fetchCalendarEvents).mockResolvedValue([event('matching')]);
    const { result, rerender } = renderHook(
      ({ query, tagIds }) =>
        useCalendarEvents('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z', query, tagIds),
      { initialProps: { query: 'old', tagIds: ['old-tag'] } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const saveRefresh = result.current.refresh;
    rerender({ query: 'new', tagIds: ['new-tag'] });
    await waitFor(() => expect(fetchCalendarEvents).toHaveBeenCalledTimes(2));
    await act(async () => {
      await saveRefresh();
    });
    expect(fetchCalendarEvents).toHaveBeenLastCalledWith(
      '2026-10-01T00:00:00Z',
      '2026-12-01T00:00:00Z',
      'new',
      ['new-tag'],
    );
    expect(result.current.events[0].id).toBe('matching');
  });
  it('does not replace a newer period with a late response', async () => {
    let resolveOld!: (rows: CalendarEventSummary[]) => void;
    vi.mocked(fetchCalendarEvents)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce([event('new')]);
    const { result, rerender } = renderHook(
      ({ from }) => useCalendarEvents(from, '2026-12-01T00:00:00Z', '', []),
      { initialProps: { from: '2026-10-01T00:00:00Z' } },
    );
    await waitFor(() => expect(fetchCalendarEvents).toHaveBeenCalledTimes(1));
    rerender({ from: '2026-11-01T00:00:00Z' });
    await waitFor(() => expect(result.current.events[0]?.id).toBe('new'));
    await act(async () => resolveOld([event('old')]));
    expect(result.current.events[0].id).toBe('new');
  });
  it('retains the last confirmed data on failure and clears the error after retry', async () => {
    vi.mocked(fetchCalendarEvents).mockResolvedValueOnce([event('confirmed')]);
    const { result } = renderHook(() =>
      useCalendarEvents('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z', '', []),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(fetchCalendarEvents).mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).not.toBe('');
    expect(result.current.events[0].id).toBe('confirmed');
    vi.mocked(fetchCalendarEvents).mockResolvedValueOnce([event('updated')]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe('');
    expect(result.current.events[0].id).toBe('updated');
  });
});
