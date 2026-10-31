'use client';
import { ChevronLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import type { CalendarEventSummary } from '@rete/shared';
import { Button } from '@/components/ui/button';
import type { UseTagMasterResult } from '@/hooks/use-tag-master';
import type { CalendarEditor } from './use-calendar-editor';
import { localInput } from './calendar-dates';
import { calendarEventRange, calendarEventListRange } from './calendar-event-presentation';
import { CalendarTagChips, CalendarTagField } from './calendar-tag-field';
import { CalendarFormDates } from './calendar-form-dates';
interface Props {
  editor: CalendarEditor;
  canEdit: boolean;
  blocked: boolean;
  events: CalendarEventSummary[];
  dayFilter: string | null;
  onClearDay: () => void;
  /** 予定の取得を取り直す（d757）。取得失敗の行を一覧の領域内で戻せるようにする。 */
  onRetry: () => void;
  filtered: boolean;
  loading: boolean;
  error: string;
  tags: UseTagMasterResult;
}
export function CalendarPanel(props: Props) {
  const { editor: e } = props;
  return (
    <section className="calendar-right" aria-label="予定">
      <CalendarList {...props} />
      {e.panel !== 'list' && (
        <div className="calendar-detail">
          <header>
            <Button variant="ghost" onClick={e.back} disabled={e.busy}>
              <ChevronLeft size={16} />
              予定一覧
            </Button>
            <div>
              {e.detail && props.canEdit && (
                <Button
                  variant="ghost"
                  aria-label="予定を削除"
                  disabled={e.busy}
                  onClick={() => e.setDeleteOpen(true)}
                >
                  <Trash2 size={16} />
                </Button>
              )}
              {e.panel === 'view' && props.canEdit && (
                <Button
                  variant="ghost"
                  disabled={e.busy}
                  onClick={() => {
                    e.setFocusTitle(true);
                    e.setPanel('edit');
                  }}
                >
                  <Pencil size={16} />
                  編集
                </Button>
              )}
            </div>
          </header>
          {e.editing ? (
            <CalendarForm editor={e} canEdit={props.canEdit} tags={props.tags} />
          ) : (
            e.detail && (
              <article>
                <div className="calendar-author">
                  {e.detail.createdBy.name}　{localInput(e.detail.createdAt).replace('T', ' ')}
                </div>
                <h2>{e.detail.title}</h2>
                <p>{calendarEventRange(e.detail)}</p>
                <div className="calendar-memo">{e.detail.memo}</div>
                <div className="calendar-detail-tags">
                  <CalendarTagChips tags={e.detail.tags} />
                </div>
              </article>
            )
          )}
        </div>
      )}
    </section>
  );
}
function CalendarList({
  editor: e,
  canEdit,
  blocked,
  events,
  dayFilter,
  onClearDay,
  onRetry,
  filtered,
  loading,
  error,
}: Props) {
  return (
    <div hidden={e.panel !== 'list'} className="calendar-list-panel">
      <div className="calendar-list-actions">
        <h2 className="calendar-list-heading">スケジュール</h2>
        {dayFilter && (
          <Button variant="ghost" onClick={onClearDay}>
            {dayFilter.replaceAll('-', '/')} ×
          </Button>
        )}
        {canEdit && (
          <Button variant="ghost" onClick={() => e.create()} disabled={e.busy}>
            <Plus size={16} />
            新規登録
          </Button>
        )}
      </div>
      <div className="calendar-list-scroll">
        <table className="sp-table calendar-list">
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>
                  <span className="calendar-list-time">{calendarEventListRange(event)}</span>
                  <button onClick={() => void e.open(event, false)} disabled={blocked}>
                    {event.title}
                  </button>
                </td>
                <td className="calendar-list-edit">
                  {canEdit && (
                    <button
                      aria-label={`${event.title}を編集`}
                      onClick={() => void e.open(event, true)}
                      disabled={blocked}
                    >
                      <Pencil size={16} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!events.length && !loading && error && (
              <tr>
                <td colSpan={2}>
                  {/*
                    d757: 取得に失敗した時に「この期間の予定はありません」と出すと、本当に 0 件なのか
                    読めなかったのかが見分けられない（settings の一覧と同じ扱いへ揃える）。
                  */}
                  <span role="alert" className="calendar-error-text">
                    {error}
                  </span>
                  <Button variant="ghost" onClick={onRetry}>
                    再読込
                  </Button>
                </td>
              </tr>
            )}
            {!events.length && !loading && !error && (
              <tr>
                <td colSpan={2}>
                  {/*
                    d753: 日付の帯で絞っている時は、期間の 0 件と同じ文言だと
                    「その日を選んだ結果が 0 件」だと読めないので、日付を言葉に出す。
                  */}
                  {dayFilter
                    ? `${dayFilter.replaceAll('-', '/')}の予定はありません`
                    : filtered
                      ? '該当する予定はありません'
                      : 'この期間の予定はありません'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function CalendarForm({
  editor: e,
  canEdit,
  tags,
}: {
  editor: CalendarEditor;
  canEdit: boolean;
  tags: UseTagMasterResult;
}) {
  const { form, busy, setForm } = e;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void e.save();
      }}
    >
      <div className="calendar-form-body">
        {!canEdit && <p role="alert">編集権限がありません</p>}
        <label>
          件名
          <input
            className="sp-input"
            autoFocus={e.focusTitle !== false}
            required
            maxLength={200}
            value={form.title}
            disabled={busy}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
        </label>
        <CalendarFormDates form={form} busy={busy} setForm={setForm} />
        <label>
          メモ
          <textarea
            className="sp-input"
            rows={6}
            maxLength={20000}
            value={form.memo}
            disabled={busy}
            onChange={(event) => setForm({ ...form, memo: event.target.value })}
          />
        </label>
        <CalendarTagField
          disabled={busy || !canEdit}
          onEdit={() => e.setPicker(true)}
          tags={form.tagIds.map(
            (id) =>
              tags.tags.find((tag) => tag.id === id) ??
              e.detail?.tags.find((tag) => tag.id === id) ?? {
                id,
                name: '削除されたタグ',
                icon: 'Tag',
                color: 'slate',
              },
          )}
        />
      </div>
      <footer>
        <Button type="button" variant="ghost" onClick={e.back} disabled={busy}>
          キャンセル
        </Button>
        <Button type="submit" disabled={busy || !canEdit}>
          保存
        </Button>
      </footer>
    </form>
  );
}
