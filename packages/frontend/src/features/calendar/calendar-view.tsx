'use client';
import { useEffect, useState } from 'react';
import { Search, RotateCcw } from 'lucide-react';
import { PageTitle } from '@/components/shared/page-title';
import { Button } from '@/components/ui/button';
import { DiscardConfirmDialog } from '@/components/ui/discard-confirm-dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TagFilterDropdown } from '@/components/tags/tag-filter-dropdown';
import { TagPickerOverlay } from '@/components/tags/tag-picker-overlay';
import { useHomePermissions } from '@/features/dashboard/hooks/home-permissions-context';
import { useAnnouncementTagMasterContext } from '@/features/dashboard/hooks/announcement-tag-master-context';
import { useCalendarEvents } from './use-calendar-events';
import { useCalendarEditor, type CalendarEditor } from './use-calendar-editor';
import { useCalendarPeriod } from './use-calendar-period';
import { useCalendarHolidays } from './use-calendar-holidays';
import { calendarBlankSelection } from './calendar-blank-selection';
import { CalendarGrid } from './calendar-grid';
import { CalendarPanel } from './calendar-panel';
import { addDays, dayInstant, overlaps, shiftMonth, weekStart } from './calendar-dates';
import { calendarPickerTags } from './calendar-picker-tags';
import './calendar.css';

function useCalendarSearch() {
  const [query, setQuery] = useState(''),
    [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timeout);
  }, [query]);
  return { query, setQuery, debouncedQuery };
}
export function CalendarView() {
  const permissions = useHomePermissions(),
    tags = useAnnouncementTagMasterContext().calendar;
  const period = useCalendarPeriod();
  const holidayData = useCalendarHolidays();
  const { query, setQuery, debouncedQuery } = useCalendarSearch();
  const [filter, setFilter] = useState<Set<string>>(new Set()),
    [dayFilter, setDayFilter] = useState<string | null>(null);
  const data = useCalendarEvents(
    dayInstant(period.from),
    dayInstant(period.to),
    debouncedQuery,
    [...filter].sort(),
  );
  const listFrom = dayFilter ?? (period.mode === 'month' ? period.month : weekStart(period.active));
  const listTo = dayFilter
    ? addDays(dayFilter, 1)
    : period.mode === 'month'
      ? shiftMonth(period.month, 2)
      : addDays(weekStart(period.active), 7);
  const editor = useCalendarEditor({
    active: period.active,
    selectDate: period.selectDate,
    listFrom,
    listTo,
    refresh: data.refresh,
  });
  const blocked = editor.busy || data.loading || !!data.error;
  const visible = data.events.filter((event) => overlaps(event, listFrom, listTo));
  const error = editor.error || data.error || holidayData.error;
  const navigate = (action: () => void) =>
    editor.leave(() => {
      setDayFilter(null);
      action();
    });
  return (
    <main className="sp-page calendar-page">
      <PageTitle title="カレンダー" />
      <div className="calendar-filter">
        <Search size={16} />
        <input
          aria-label="件名・メモを検索"
          placeholder="件名・メモで検索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="sp-input"
        />
        <TagFilterDropdown
          tags={tags.tags.filter((t) => !t.archived)}
          active={filter}
          loading={tags.loading}
          onToggle={(id) =>
            setFilter((old) => {
              const next = new Set(old);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onClear={() => setFilter(new Set())}
        />
        <button
          type="button"
          className="desk-filter-clear home-filter-clear"
          title="フィルタをクリア"
          aria-label="検索・タグ絞り込みをクリア"
          onClick={() => {
            setQuery('');
            setFilter(new Set());
            setDayFilter(null);
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="desk-filter-icon-label">クリア</span>
        </button>
      </div>
      <CalendarError
        error={error}
        retryable={!!data.error || !!holidayData.error}
        onRetry={() => {
          holidayData.refresh();
          void editor.refreshView();
        }}
      />
      <div className="calendar-workspace">
        <CalendarGrid
          {...calendarBlankSelection(period, editor, () => setDayFilter(null))}
          period={period}
          holidays={holidayData.holidays}
          events={data.events}
          loading={data.loading}
          blocked={blocked}
          busy={editor.busy}
          onToday={() => navigate(period.goToday)}
          {...eventActions(editor, permissions.calendarEdit, blocked, period.mode === 'week')}
          onTurn={(direction) => navigate(() => period.turn(direction))}
          onMode={(mode) => navigate(() => period.switchMode(mode))}
          onOpen={(event, day) => void editor.open(event, true, day)}
          onMore={(day) =>
            editor.leave(() => {
              setDayFilter(day);
              period.selectDate(day);
              editor.setPanel('list');
            })
          }
        />
        <CalendarPanel
          editor={editor}
          canEdit={permissions.calendarEdit}
          blocked={blocked}
          events={visible}
          dayFilter={dayFilter}
          onClearDay={() => setDayFilter(null)}
          onRetry={() => void editor.refreshView()}
          filtered={!!query || filter.size > 0}
          loading={data.loading}
          error={data.error}
          tags={tags}
        />
      </div>
      <DiscardConfirmDialog
        open={editor.discard.open}
        onConfirm={editor.discard.onConfirm}
        onCancel={editor.discard.onCancel}
      />
      <ConfirmDialog
        open={editor.deleteOpen}
        message="この予定を削除しますか？"
        destructive
        busy={editor.busy}
        onConfirm={() => void editor.remove()}
        onCancel={() => editor.setDeleteOpen(false)}
      />
      {editor.picker && (
        <TagPickerOverlay
          selectionMode="single"
          tags={calendarPickerTags(tags.tags, editor.detail?.tags ?? [], editor.form.tagIds)}
          initialSelected={editor.form.tagIds}
          onConfirm={(tagIds) => {
            editor.setForm({ ...editor.form, tagIds });
            editor.setPicker(false);
          }}
          onClose={() => editor.setPicker(false)}
        />
      )}
    </main>
  );
}

function eventActions(
  editor: CalendarEditor,
  canEdit: boolean,
  blocked: boolean,
  preserveFocus: boolean,
) {
  if (!canEdit) return {};
  return {
    onCreate: (day: string) => editor.create(day, preserveFocus),
    onReschedule: blocked ? undefined : editor.reschedule,
  };
}

function CalendarError({
  error,
  retryable,
  onRetry,
}: {
  error: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  if (!error) return null;
  return (
    <div role="alert" className="calendar-error">
      {error}
      {retryable && (
        <Button variant="ghost" onClick={onRetry}>
          再読込
        </Button>
      )}
    </div>
  );
}
