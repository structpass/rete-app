import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarTimeWeek } from './calendar-time-week';
import type { CalendarGridProps } from './calendar-grid';
import { addDays, toInstant } from './calendar-dates';

afterEach(() => vi.unstubAllGlobals());
describe('weekly calendar presentation', () => {
  it('shows a title-only time band and separate day labels without losing accessible times', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const onOpen = vi.fn(),
      onCreate = vi.fn();
    const event = {
      id: 'event',
      title: '決算対応処理',
      startAt: toInstant('2026-10-25T09:00'),
      endAt: toInstant('2026-10-25T10:45'),
      allDay: false,
      revision: 1,
      tags: [{ id: 'green', name: '緑', color: 'green', icon: 'Tag', archived: false }],
    };
    const allDayEvent = {
      ...event,
      id: 'all-day',
      title: '終日予定',
      allDay: true,
      startAt: toInstant('2026-10-23T00:00'),
      endAt: toInstant('2026-10-26T00:00'),
    };
    const period = {
      active: '2026-10-25',
      today: '2026-10-25',
      dates: [Array.from({ length: 7 }, (_, i) => addDays('2026-10-19', i))],
      selectDate: vi.fn(),
    } as unknown as CalendarGridProps['period'];
    render(
      <CalendarTimeWeek
        period={period}
        events={[event, allDayEvent]}
        holidays={[{ date: '2026-10-19', name: '検証祝日' }]}
        busy={false}
        blocked={false}
        loading={false}
        onOpen={onOpen}
        onCreate={onCreate}
        onMode={() => {}}
        onTurn={() => {}}
        onMore={() => {}}
      />,
    );
    const band = screen.getByRole('button', {
      name: '決算対応処理 2026-10-25 09:00 〜 2026-10-25 10:45',
    });
    const allDayBand = screen.getByRole('button', { name: '終日予定 10/23 ～ 10/25 終日' });
    expect(allDayBand.closest('[aria-label="終日の予定"]')).not.toBeNull();
    expect(document.querySelectorAll('.calendar-time-event')).toHaveLength(1);
    expect(allDayBand.style.gridColumn).toBe('6 / 9');
    fireEvent.click(allDayBand);
    expect(onOpen).toHaveBeenCalledWith(allDayEvent, '2026-10-23');
    expect(band.textContent).toBe('決算対応処理');
    expect(band).toHaveStyle({ backgroundColor: '#16a34a33', color: '#000000' });
    expect(Number.parseFloat(band.style.height)).toBeCloseTo(49.45);
    expect(screen.getByRole('button', { name: '2026-10-25' }).textContent).toBe('25');
    expect(screen.getByText('日', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('検証祝日')).toHaveClass('calendar-holiday');
    expect(screen.getByRole('button', { name: '2026-10-24' }).closest('div')).toHaveClass(
      'is-weekend',
    );
    expect(screen.getByRole('button', { name: '2026-10-19' }).closest('div')).not.toHaveClass(
      'is-weekend',
    );
    // 1 段目（曜日）は左の余白の後に月〜日が並ぶ。見出しの行を作り直したので、
    // 見出し全体の最初の要素ではなく曜日そのものの並びを見る。
    expect(
      [...document.querySelectorAll('.calendar-weekday-row .calendar-weekday')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['月', '火', '水', '木', '金', '土', '日']);
    band.click();
    expect(onOpen).toHaveBeenCalledWith(event, '2026-10-25');
    expect(period.selectDate).not.toHaveBeenCalled();
    // 日付の選択は見出しの日付（data-day）。時間の枠が各日の列に重なったため、
    // 列の空き地は枠が受け持つ。列そのものは「その日の日付を選ぶ」道として残す。
    fireEvent.click(screen.getByRole('button', { name: '2026-10-25' }).parentElement!);
    expect(period.selectDate).toHaveBeenLastCalledWith('2026-10-25');
    expect(screen.getByRole('button', { name: '2026-10-25' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '2026-10-19' }).parentElement!);
    expect(period.selectDate).toHaveBeenLastCalledWith('2026-10-19');
    expect(screen.getByRole('button', { name: '2026-10-19' })).toHaveFocus();
    fireEvent.doubleClick(band);
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole('button', { name: '2026-10-25' }).parentElement!);
    expect(onCreate).toHaveBeenLastCalledWith('2026-10-25');
    fireEvent.doubleClick(screen.getByRole('button', { name: '2026-10-19' }));
    expect(onCreate).toHaveBeenLastCalledWith('2026-10-19');
  });
});
