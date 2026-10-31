import type { CSSProperties } from 'react';
import type { CalendarEventSummary } from '@rete/shared';
import { resolveTagColorHex } from '@/components/tags/tag-icon';
export function calendarEventColor(event: Pick<CalendarEventSummary, 'tags'>): CSSProperties {
  const tag = event.tags[0];
  const color = tag ? resolveTagColorHex(tag.color) : '#bdd5eb';
  return {
    backgroundColor: `${color}33`,
    borderColor: tag ? color : '#647fa4',
    color: '#000000',
  };
}
