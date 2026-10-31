'use client';
import type { CalendarFormValues } from './use-calendar-editor';
import { CalendarDateTimeField } from './calendar-datetime-field';
export function CalendarFormDates({
  form,
  busy,
  setForm,
}: {
  form: CalendarFormValues;
  busy: boolean;
  setForm: (value: CalendarFormValues) => void;
}) {
  return (
    <>
      <label className="calendar-all-day-control">
        <input
          type="checkbox"
          checked={form.allDay}
          disabled={busy}
          onChange={(event) => setForm({ ...form, allDay: event.target.checked })}
        />
        終日
      </label>
      {(['start', 'end'] as const).map((field) =>
        form.allDay ? (
          <label key={field}>
            {field === 'start' ? '開始日' : '終了日'}
            <input
              className="sp-input"
              type="date"
              required
              value={form[field].slice(0, 10)}
              disabled={busy}
              onChange={(event) =>
                setForm({
                  ...form,
                  [field]: event.target.value
                    ? `${event.target.value}T${form[field].slice(11) || (field === 'start' ? '09:00' : '10:00')}`
                    : '',
                })
              }
            />
          </label>
        ) : (
          <CalendarDateTimeField
            key={field}
            label={field === 'start' ? '開始日時' : '終了日時'}
            value={form[field]}
            disabled={busy}
            onChange={(value) => setForm({ ...form, [field]: value })}
          />
        ),
      )}
    </>
  );
}
