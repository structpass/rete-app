'use client';

import { useRef, useState } from 'react';
import { CalendarDays, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { Role } from '@rete/shared';
import { useSession } from '@/features/auth';
import { useMountedFetch } from '@/hooks/use-mounted-fetch';
import { extractErrorMessage } from '@/lib/error-utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { OverlayDialog } from '@/components/ui/overlay-dialog';
import {
  FilterBar,
  FilterSearchInput,
  FilterChipSelect,
  FilterClear,
} from '@/components/shared/filter-bar';
import styles from './calendar-holidays-screen.module.css';
import {
  ActionButton,
  FormActions,
  FormButton,
  FormCard,
  FormLabel,
  ListActionRow,
  OverlayCancelButton,
  PageTitle,
  Pagination,
  RowDeleteButton,
  RowEditButton,
  TableCard,
} from './primitives';
import { TableStatusRows } from './table-status-rows';
import {
  fetchCalendarHolidays,
  saveCalendarHoliday,
  deleteCalendarHoliday,
  type CalendarHoliday,
} from '../lib/calendar-holidays-api';

export function CalendarHolidaysScreen() {
  const { user, loading } = useSession();
  if (loading) return null;
  if (user?.role !== Role.ADMIN)
    return (
      <main className="sp-page">
        <PageTitle title="祝日設定" />
      </main>
    );
  return <CalendarHolidaysBody />;
}

function CalendarHolidaysBody() {
  const [holidays, setHolidays] = useState<CalendarHoliday[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [initial, setInitial] = useState<CalendarHoliday>();
  const original = initial?.date;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<CalendarHoliday | null>(null);
  useMountedFetch(
    async (alive) => {
      setLoading(true);
      setError('');
      try {
        const rows = await fetchCalendarHolidays();
        if (alive()) setHolidays(rows);
      } catch (err) {
        if (alive()) setError(extractErrorMessage(err, '祝日を読み込めませんでした'));
      } finally {
        if (alive()) setLoading(false);
      }
    },
    [reload],
  );

  function reset() {
    setEditing(false);
    setInitial(undefined);
  }
  async function save(form: CalendarHoliday) {
    if (busy || !form.date || !form.name.trim()) return;
    setBusy(true);
    try {
      const saved = await saveCalendarHoliday({ ...form, name: form.name.trim() }, original);
      setHolidays((rows) =>
        [...rows.filter((row) => row.date !== (original ?? saved.date)), saved].sort((a, b) =>
          a.date.localeCompare(b.date),
        ),
      );
      reset();
      toast.success(original ? '祝日を保存しました' : '祝日を追加しました');
    } catch (err) {
      toast.error(extractErrorMessage(err, '祝日を保存できませんでした'));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy || !deleting) return;
    setBusy(true);
    try {
      await deleteCalendarHoliday(deleting.date);
      setHolidays((rows) => rows.filter((row) => row.date !== deleting.date));
      if (original === deleting.date) reset();
      setDeleting(null);
      toast.success('祝日を削除しました');
    } catch (err) {
      toast.error(extractErrorMessage(err, '祝日を削除できませんでした'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={`sp-page ${styles.page}`}>
      <PageTitle title="祝日設定" className="shrink-0" />
      <HolidayList
        holidays={holidays}
        loading={loading}
        error={error}
        busy={busy}
        onRetry={() => setReload((value) => value + 1)}
        onCreate={() => {
          setInitial(undefined);
          setEditing(true);
        }}
        onEdit={(holiday) => {
          setInitial(holiday);
          setEditing(true);
        }}
        onDelete={setDeleting}
      />
      {editing && <HolidayEditor initial={initial} busy={busy} onSave={save} onCancel={reset} />}
      <ConfirmDialog
        open={!!deleting}
        message={`${deleting?.date ?? ''}「${deleting?.name ?? ''}」を削除しますか？`}
        destructive
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => {
          if (!busy) setDeleting(null);
        }}
      />
    </main>
  );
}

function HolidayList({
  holidays,
  loading,
  error,
  busy,
  onRetry,
  onCreate,
  onEdit,
  onDelete,
}: {
  holidays: CalendarHoliday[];
  loading: boolean;
  error: string;
  busy: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (holiday: CalendarHoliday) => void;
  onDelete: (holiday: CalendarHoliday) => void;
}) {
  const [query, setQuery] = useState('');
  const [year, setYear] = useState('all');
  const years = [...new Set(holidays.map((holiday) => holiday.date.slice(0, 4)))].sort();
  const keyword = query.trim().toLocaleLowerCase();
  const filtered = holidays.filter(
    (holiday) =>
      holiday.name.toLocaleLowerCase().includes(keyword) &&
      (year === 'all' || holiday.date.startsWith(year + '-')),
  );
  return (
    <div className={styles.list}>
      <div className={styles.toolbar}>
        <FilterBar>
          <FilterSearchInput
            placeholder="名称で検索..."
            ariaLabel="祝日の名称で検索"
            value={query}
            onChange={setQuery}
          />
          <FilterChipSelect
            icon={CalendarDays}
            label="年"
            ariaLabel="年で絞り込み"
            value={year}
            onChange={setYear}
            options={[
              { value: 'all', label: 'すべての年' },
              ...years.map((value) => ({ value, label: value + '年' })),
            ]}
          />
          <FilterClear
            onClick={() => {
              setQuery('');
              setYear('all');
            }}
          />
        </FilterBar>
        <ListActionRow>
          <ActionButton
            icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            disabled={busy || loading || !!error}
            onClick={onCreate}
          >
            新規作成
          </ActionButton>
        </ListActionRow>
      </div>
      <div className={styles.frame}>
        <TableCard hoverBand>
          <HolidayTable
            holidays={loading || error ? [] : filtered}
            loading={loading}
            error={error}
            emptyLabel={keyword || year !== 'all' ? '該当する祝日がありません' : '祝日がありません'}
            onRetry={onRetry}
            busy={busy}
            onEdit={onEdit}
            onDelete={onDelete}
          />
          <Pagination
            total={loading || error ? '全 — 件' : `全 ${filtered.length} 件`}
            pageLabel={loading || error ? '' : undefined}
          />
        </TableCard>
      </div>
    </div>
  );
}

function HolidayEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial?: CalendarHoliday;
  busy: boolean;
  onSave: (value: CalendarHoliday) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<CalendarHoliday>(initial ?? { date: '', name: '' });
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <OverlayDialog
      open
      ariaLabel={initial ? '祝日を編集' : '祝日を新規作成'}
      onClose={() => {
        if (!busy) onCancel();
      }}
      dirty={!busy && (form.date !== (initial?.date ?? '') || form.name !== (initial?.name ?? ''))}
    >
      <FormCard
        icon={<CalendarDays className="h-4 w-4" aria-hidden="true" />}
        title={initial ? '祝日を編集' : '祝日を新規作成'}
      >
        <form
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(form);
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              event.target instanceof HTMLInputElement
            ) {
              event.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
        >
          <div className="mb-3">
            <FormLabel htmlFor="holiday-date" required>
              日付
            </FormLabel>
            <input
              id="holiday-date"
              type="date"
              required
              aria-required="true"
              className="sp-input"
              aria-label="祝日の日付"
              value={form.date}
              disabled={busy}
              autoFocus
              onChange={(event) => setForm({ ...form, date: event.target.value })}
            />
          </div>
          <div className="mb-3">
            <FormLabel htmlFor="holiday-name" required>
              名称
            </FormLabel>
            <input
              id="holiday-name"
              required
              aria-required="true"
              maxLength={100}
              className="sp-input"
              aria-label="祝日の名称"
              value={form.name}
              disabled={busy}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <FormActions>
            <OverlayCancelButton disabled={busy} />
            <FormButton
              loading={busy}
              disabled={!form.date || !form.name.trim()}
              onClick={() => formRef.current?.requestSubmit()}
            >
              {initial ? '保存' : '追加'}
            </FormButton>
          </FormActions>
        </form>
      </FormCard>
    </OverlayDialog>
  );
}

function HolidayTable({
  emptyLabel,
  holidays,
  loading,
  error,
  onRetry,
  busy,
  onEdit,
  onDelete,
}: {
  emptyLabel: string;
  holidays: CalendarHoliday[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  busy: boolean;
  onEdit: (holiday: CalendarHoliday) => void;
  onDelete: (holiday: CalendarHoliday) => void;
}) {
  return (
    <table className="sp-table sp-table--hoverband">
      <thead>
        <tr>
          <th style={{ width: '30%' }}>日付</th>
          <th style={{ width: '40%' }}>名称</th>
          <th style={{ width: '30%', textAlign: 'right' }}>
            <span className="sr-only">操作</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {holidays.map((holiday) => (
          <tr key={holiday.date} className="sp-row-pillable">
            <td>{holiday.date.replaceAll('-', '/')}</td>
            <td className="truncate" title={holiday.name}>
              {holiday.name}
            </td>
            <td style={{ textAlign: 'right' }}>
              <div className="inline-flex items-center justify-end gap-1.5">
                <RowEditButton
                  disabled={busy}
                  label={`${holiday.date} ${holiday.name}を編集`}
                  onClick={() => {
                    onEdit(holiday);
                  }}
                />
                <RowDeleteButton
                  disabled={busy}
                  label={`${holiday.date} ${holiday.name}を削除`}
                  onClick={() => onDelete(holiday)}
                />
              </div>
            </td>
          </tr>
        ))}
        <TableStatusRows
          colSpan={3}
          isLoading={loading}
          empty={holidays.length === 0}
          emptyLabel={emptyLabel}
          errorLabel={error}
          onRetry={onRetry}
        />
      </tbody>
    </table>
  );
}
