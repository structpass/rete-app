import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEscapeConsume } from '@/hooks/use-escape-consume';
import { CalendarDateTimeField } from './calendar-datetime-field';

function Field({
  initial = '2026-10-25T09:00',
  back = () => {},
}: {
  initial?: string;
  back?: () => void;
}) {
  const [value, setValue] = useState(initial);
  useEscapeConsume(back);
  return (
    <CalendarDateTimeField label="開始日時" value={value} disabled={false} onChange={setValue} />
  );
}
describe('calendar date and quarter-hour selection', () => {
  it('focuses the selected day on opening and returns to the trigger on completion', () => {
    render(<Field />);
    fireEvent.click(screen.getByRole('button', { name: '開始日時を選択' }));
    expect(screen.getByRole('dialog').querySelector('button[aria-pressed="true"]')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '完了' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '開始日時を選択' })).toHaveFocus();
  });
  it('offers only four selectable minute values and updates the original datetime field', () => {
    render(<Field />);
    fireEvent.click(screen.getByRole('button', { name: '開始日時を選択' }));
    const minute = screen.getByLabelText('開始日時の分') as HTMLSelectElement;
    expect(
      Array.from(minute.options)
        .filter((option) => !option.disabled)
        .map((option) => option.value),
    ).toEqual(['00', '15', '30', '45']);
    fireEvent.change(minute, { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('開始日時の時'), { target: { value: '10' } });
    expect(screen.getByLabelText('開始日時')).toHaveValue('2026-10-25T10:45');
  });
  it('preserves existing precise minutes when choosing a new date', () => {
    render(<Field initial="2026-10-25T09:07" />);
    fireEvent.click(screen.getByRole('button', { name: '開始日時を選択' }));
    const dialog = screen.getByRole('dialog', { name: '開始日時を選択' });
    fireEvent.click(within(dialog).getByRole('button', { name: '2026-10-26' }));
    expect(screen.getByLabelText('開始日時')).toHaveValue('2026-10-26T09:07');
    const options = Array.from(
      (screen.getByLabelText('開始日時の分') as HTMLSelectElement).options,
    );
    expect(options.find((option) => option.value === '07')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('開始日時の分'), { target: { value: '15' } });
    expect(screen.getByLabelText('開始日時')).toHaveValue('2026-10-26T09:15');
  });
  it('closes only the date picker on Escape and returns focus to its trigger', () => {
    const back = vi.fn();
    render(<Field back={back} />);
    fireEvent.click(screen.getByRole('button', { name: '開始日時を選択' }));
    screen.getByLabelText('開始日時の分').focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(back).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '開始日時を選択' })).toHaveFocus();
  });
});
