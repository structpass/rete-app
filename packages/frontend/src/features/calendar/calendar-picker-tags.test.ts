import { describe, expect, it } from 'vitest';
import type { TagDto } from '@rete/shared';
import { calendarPickerTags } from './calendar-picker-tags';

const tag = (id: string, archived = false): TagDto => ({
  id,
  name: id,
  icon: 'Tag',
  color: 'gray',
  archived,
});
describe('calendar tag selection recovery', () => {
  it('keeps selected deleted and archived tags visible for removal without duplicate choices', () => {
    const choices = calendarPickerTags(
      [tag('active'), tag('archived', true)],
      [tag('active'), tag('deleted')],
      ['active', 'deleted', 'archived', 'deleted-new'],
    );
    expect(choices.map((item) => item.id)).toEqual([
      'active',
      'deleted',
      'archived',
      'deleted-new',
    ]);
    expect(choices.find((item) => item.id === 'deleted')?.name).toBe('deleted');
  });
  it('does not offer unselected archived tags', () => {
    expect(calendarPickerTags([tag('archived', true)], [], [])).toEqual([]);
  });
});
