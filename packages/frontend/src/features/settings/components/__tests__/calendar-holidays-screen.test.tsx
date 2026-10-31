import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Role } from '@rete/shared';

const api = vi.hoisted(() => ({
  fetchCalendarHolidays: vi.fn(),
  saveCalendarHoliday: vi.fn(),
  deleteCalendarHoliday: vi.fn(),
}));
const session = vi.hoisted(() => ({ role: 'ADMIN' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));
vi.mock('../../lib/calendar-holidays-api', () => api);
vi.mock('@/features/auth', () => ({ useSession: () => ({ user: session, loading: false }) }));
import { CalendarHolidaysScreen } from '../calendar-holidays-screen';

beforeEach(() => {
  vi.resetAllMocks();
  session.role = Role.ADMIN;
  api.fetchCalendarHolidays.mockResolvedValue([{ date: '2026-01-01', name: '元日' }]);
});
describe('Holiday settings', () => {
  it('combines name and year filters, reports filtered counts, and clears both', async () => {
    api.fetchCalendarHolidays.mockResolvedValueOnce([
      { date: '2026-01-01', name: '元日' },
      { date: '2026-07-20', name: '海の日' },
      { date: '2027-01-01', name: '元日' },
      { date: '2027-03-21', name: '春分の日' },
    ]);
    render(<CalendarHolidaysScreen />);
    await screen.findByText('全 4 件');
    fireEvent.change(screen.getByRole('searchbox', { name: '祝日の名称で検索' }), {
      target: { value: ' 元日 ' },
    });
    expect(screen.getByText('全 2 件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '年で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: '2027年' }));
    expect(screen.getByText('全 1 件')).toBeInTheDocument();
    expect(screen.queryByText('2026/01/01')).not.toBeInTheDocument();
    expect(screen.getByText('2027/01/01')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '海' } });
    expect(screen.getByText('該当する祝日がありません')).toBeInTheDocument();
    expect(screen.getByText('全 0 件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'フィルタをクリア' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByText('全 4 件')).toBeInTheDocument();
    expect(api.fetchCalendarHolidays).toHaveBeenCalledTimes(1);
  });

  it('does not mount the editor or read data for a member', () => {
    session.role = Role.MEMBER;
    render(<CalendarHolidaysScreen />);
    expect(api.fetchCalendarHolidays).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('祝日の日付')).not.toBeInTheDocument();
  });
  it('edits date/name without leaving an old row, and preserves the editor on save failure', async () => {
    render(<CalendarHolidaysScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '2026-01-01 元日を編集' }));
    fireEvent.change(screen.getByLabelText('祝日の日付'), { target: { value: '2026-01-02' } });
    fireEvent.change(screen.getByLabelText('祝日の名称'), { target: { value: '変更祝日' } });
    api.saveCalendarHoliday.mockRejectedValueOnce(new Error('failed'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByLabelText('祝日の名称')).toHaveValue('変更祝日');
    api.saveCalendarHoliday.mockResolvedValueOnce({ date: '2026-01-02', name: '変更祝日' });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(api.saveCalendarHoliday).toHaveBeenLastCalledWith(
        { date: '2026-01-02', name: '変更祝日' },
        '2026-01-01',
      ),
    );
    await screen.findByText('2026/01/02');
    expect(screen.queryByText('2026/01/01')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a separate create dialog and trims the new name', async () => {
    render(<CalendarHolidaysScreen />);
    await screen.findByText('2026/01/01');
    expect(screen.queryByLabelText('祝日の日付')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '新規作成' }));
    expect(screen.getByRole('dialog', { name: '祝日を新規作成' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '追加' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('祝日の日付'), { target: { value: '2026-01-02' } });
    fireEvent.change(screen.getByLabelText('祝日の名称'), { target: { value: '  休日  ' } });
    api.saveCalendarHoliday.mockResolvedValueOnce({ date: '2026-01-02', name: '休日' });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    await screen.findByText('2026/01/02');
    expect(api.saveCalendarHoliday).toHaveBeenCalledWith(
      { date: '2026-01-02', name: '休日' },
      undefined,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('distinguishes fetch failure from empty and retries', async () => {
    api.fetchCalendarHolidays.mockRejectedValueOnce(new Error('読み込み失敗'));
    api.fetchCalendarHolidays.mockResolvedValueOnce([]);
    render(<CalendarHolidaysScreen />);
    await screen.findByRole('alert');
    expect(screen.queryByText('祝日がありません')).not.toBeInTheDocument();
    expect(screen.getByText('全 — 件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await screen.findByText('祝日がありません');
    expect(screen.getByText('全 0 件')).toBeInTheDocument();
  });

  it('requires confirmation before deleting and updates the count', async () => {
    api.deleteCalendarHoliday.mockResolvedValueOnce(undefined);
    render(<CalendarHolidaysScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '2026-01-01 元日を削除' }));
    expect(api.deleteCalendarHoliday).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await screen.findByText('祝日がありません');
    expect(api.deleteCalendarHoliday).toHaveBeenCalledWith('2026-01-01');
    expect(screen.getByText('全 0 件')).toBeInTheDocument();
  });

  it('traps keyboard focus inside the editor and submits Enter without submitting during IME', async () => {
    render(<CalendarHolidaysScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '2026-01-01 元日を編集' }));
    const date = screen.getByLabelText('祝日の日付');
    const name = screen.getByLabelText('祝日の名称');
    const save = screen.getByRole('button', { name: '保存' });
    date.focus();
    fireEvent.keyDown(date, { key: 'Tab', shiftKey: true });
    expect(save).toHaveFocus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(date).toHaveFocus();
    fireEvent.keyDown(name, { key: 'Enter', isComposing: true });
    expect(api.saveCalendarHoliday).not.toHaveBeenCalled();
    api.saveCalendarHoliday.mockResolvedValueOnce({ date: '2026-01-01', name: '元日' });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.saveCalendarHoliday).toHaveBeenCalledWith(
      { date: '2026-01-01', name: '元日' },
      '2026-01-01',
    );
  });
});
