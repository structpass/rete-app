import { describe, expect, it } from 'vitest';
import {
  calendarFloorHourHeight,
  calendarHourHeight,
  calendarInitialScroll,
  calendarMinHourHeight,
  calendarWorkEnd,
  calendarWorkStart,
} from './calendar-hour-height';
describe('weekly initial 8:00–20:00 viewport', () => {
  it.each([
    [600, 76],
    [420, 100],
    [800, 54],
    [308, 140],
  ])('fits twelve hours below the header (%s px / %s px)', (available, header) => {
    const hour = calendarHourHeight(available, header)!;
    expect(hour * 12 + header + 24).toBeCloseTo(available);
    expect(
      calendarInitialScroll({ available, scrollHeight: hour * 24 + header + 36, hourHeight: hour }),
    ).toBeCloseTo(12 + hour * 8);
  });
  it('starts at 8 and ends at 20, with an unmeasured 70% fallback', () => {
    expect([calendarWorkStart, calendarWorkEnd]).toEqual([8, 20]);
    expect(calendarMinHourHeight).toBeCloseTo(42 * 0.7);
  });
  it('prioritizes the requested range when a tall header leaves little room', () => {
    expect(calendarHourHeight(120, 76)! * 12 + 76 + 24).toBeCloseTo(120);
    expect(calendarHourHeight(120, 140)).toBe(calendarFloorHourHeight);
  });
  it('does not invent a size before measurement or overflow scroll limits', () => {
    expect(calendarHourHeight(0)).toBeNull();
    expect(calendarHourHeight(-12)).toBeNull();
    expect(calendarInitialScroll({ available: 600, scrollHeight: 500, hourHeight: 30 })).toBe(0);
  });
});
