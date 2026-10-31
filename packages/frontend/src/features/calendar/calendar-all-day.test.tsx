import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import { CalendarFormDates } from './calendar-form-dates';
import { CalendarPanel } from './calendar-panel';
import { calendarEventRange } from './calendar-event-presentation';
import type { CalendarEditor, CalendarFormValues } from './use-calendar-editor';
import { toInstant } from './calendar-dates';
const event: CalendarEventSummary = {
  id: 'e',
  title: '予定テスト',
  allDay: false,
  startAt: toInstant('2026-10-12T12:00'),
  endAt: toInstant('2026-10-14T13:15'),
  revision: 1,
  tags: [],
};
describe('event range and all-day dates', () => {
  it('formats timed start and end above the title, without list column headings', () => {
    const create = vi.fn();
    const { container } = render(
      <CalendarPanel
        editor={{ panel: 'list', create } as unknown as CalendarEditor}
        canEdit={true}
        blocked={false}
        events={[event]}
        dayFilter={null}
        onClearDay={() => {}}
        onRetry={() => {}}
        filtered={false}
        loading={false}
        error=""
        tags={{ tags: [] } as never}
      />,
    );
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^スケジュール$/ })).toBeInTheDocument();
    expect(
      screen.getByText('10/12（12:00） ～ 10/14（13:15）').nextElementSibling,
    ).toHaveTextContent('予定テスト');
    const button = screen.getByRole('button', { name: '新規登録' });
    expect(container.querySelector('.calendar-list-scroll')?.contains(button)).toBe(false);
    fireEvent.click(button);
    expect(create).toHaveBeenCalledWith();
  });
  it.each([
    ['2026-10-13T00:00', '10/12 終日'],
    ['2026-10-15T00:00', '10/12 ～ 10/14 終日'],
  ])('displays inclusive all-day end for %s', (end, label) => {
    expect(
      calendarEventRange({
        ...event,
        allDay: true,
        startAt: toInstant('2026-10-12T00:00'),
        endAt: toInstant(end),
      }),
    ).toBe(label);
  });
  it('replaces time entry with date-only fields while all-day is checked', () => {
    function Form() {
      const [form, setForm] = useState<CalendarFormValues>({
        title: '',
        start: '2026-10-12T12:00',
        end: '2026-10-14T13:15',
        allDay: false,
        memo: '',
        tagIds: [],
      });
      return <CalendarFormDates form={form} setForm={setForm} busy={false} />;
    }
    render(<Form />);
    fireEvent.click(screen.getByRole('checkbox', { name: '終日' }));
    expect(screen.queryByLabelText('開始日時')).not.toBeInTheDocument();
    expect(screen.getByLabelText('開始日')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('終了日')).toHaveAttribute('type', 'date');
    fireEvent.change(screen.getByLabelText('開始日'), { target: { value: '2026-10-13' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '終日' }));
    expect(screen.getByLabelText('開始日時')).toHaveValue('2026-10-13T12:00');
    expect(screen.getByLabelText('終了日時')).toHaveValue('2026-10-14T13:15');
  });
});
