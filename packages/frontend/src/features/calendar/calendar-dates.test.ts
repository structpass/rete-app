import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayInstant,
  localInput,
  monthDays,
  overlaps,
  shiftMonth,
  weekStart,
} from './calendar-dates';
describe('calendar dates in JST, independent of the device timezone', () => {
  it('clamps month ends and preserves leap years', () => {
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonth('2028-01-31', 1)).toBe('2028-02-29');
    expect(shiftMonth('2026-12-31', 1)).toBe('2027-01-31');
  });
  it('uses Monday weeks across the year boundary', () => {
    expect(weekStart('2027-01-01')).toBe('2026-12-28');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
  });
  it.each(['2026-02-01', '2026-08-01', '2026-10-01'])(
    'covers the complete %s month with whole weeks',
    (key) => {
      const days = monthDays(key);
      expect(days.length % 7).toBe(0);
      expect(days).toContain(key);
      expect(days.length).toBeGreaterThanOrEqual(28);
      expect(days.length).toBeLessThanOrEqual(42);
    },
  );
  it('does not add a midnight ending event to the following day', () => {
    const event = { startAt: '2026-10-23T00:00:00.000Z', endAt: '2026-10-23T15:00:00.000Z' };
    expect(overlaps(event, '2026-10-23', '2026-10-24')).toBe(true);
    expect(overlaps(event, '2026-10-24', '2026-10-25')).toBe(false);
  });
  it('converts JST boundaries and input values without local timezone inference', () => {
    expect(dayInstant('2026-10-24')).toBe('2026-10-23T15:00:00.000Z');
    expect(localInput('2026-10-23T16:30:00.000Z')).toBe('2026-10-24T01:30');
  });
});
