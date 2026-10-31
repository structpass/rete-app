import { describe, expect, it } from 'vitest';
import { TAG_COLOR_HEX } from '@/components/tags/tag-icon';
import { calendarEventColor } from './calendar-event-color';
describe('calendar tag colors', () => {
  it('uses a translucent default and black text for an untagged event', () =>
    expect(calendarEventColor({ tags: [] })).toEqual({
      backgroundColor: '#bdd5eb33',
      borderColor: '#647fa4',
      color: '#000000',
    }));
  it.each(Object.entries(TAG_COLOR_HEX))(
    'uses the registered %s color for the bar',
    (color, hex) => {
      const style = calendarEventColor({
        tags: [{ id: 'tag', name: 'tag', color, icon: 'Tag', archived: false }],
      });
      expect(style?.backgroundColor).toBe(`${hex}33`);
      expect(style?.borderColor).toBe(hex);
      expect(style?.color).toBe('#000000');
    },
  );
});
