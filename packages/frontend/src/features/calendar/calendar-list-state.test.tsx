import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarEventSummary } from '@rete/shared';
import type { CalendarEditor } from './use-calendar-editor';
import { CalendarPanel } from './calendar-panel';

/**
 * d757: 予定一覧の取得に失敗した時、画面が「この期間の予定はありません」とだけ出すと、
 * 本当に 0 件なのか読めなかったのかが見分けられない（settings の一覧と同じ扱いへ揃える）。
 * 一覧の領域内に失敗の文言と再読込を出し、押すと取り直す経路を呼ぶことを固定する。
 *
 * 一覧は予定を開いていない間 (panel === 'list') だけ表示される（hidden で隠れた領域は読み上げの対象外）。
 */
const renderPanel = (over: {
  panel?: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  filtered?: boolean;
  dayFilter?: string | null;
}) => {
  const editor = { panel: over.panel ?? 'list' } as CalendarEditor;
  const onRetry = over.onRetry ?? (() => {});
  const view = render(
    <CalendarPanel
      editor={editor}
      canEdit={false}
      blocked={false}
      events={[] as CalendarEventSummary[]}
      dayFilter={over.dayFilter ?? null}
      onClearDay={() => {}}
      onRetry={onRetry}
      filtered={over.filtered ?? false}
      loading={over.loading ?? false}
      error={over.error ?? ''}
      tags={{ tags: [] } as never}
    />,
  );
  return { ...view, list: within(view.getByRole('region', { name: '予定' })) };
};

describe('予定一覧の取得失敗と 0 件（d757）', () => {
  it('取得に失敗した時は 0 件の文言を出さず、失敗の文言と再読込を領域内に出す', () => {
    const onRetry = vi.fn();
    const { list } = renderPanel({ error: '予定を取得できませんでした', onRetry });
    expect(list.getByRole('alert')).toHaveTextContent('予定を取得できませんでした');
    expect(list.queryByText('この期間の予定はありません')).not.toBeInTheDocument();
    list.getByRole('button', { name: '再読込' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('取得できて 0 件の時は今までどおり 0 件の文言を出す（失敗の行は出さない）', () => {
    const { list } = renderPanel({});
    expect(list.getByText('この期間の予定はありません')).toBeInTheDocument();
    expect(list.queryByRole('alert')).not.toBeInTheDocument();
    expect(list.queryByRole('button', { name: '再読込' })).not.toBeInTheDocument();
  });

  it('読み込み中は失敗も 0 件も出さない', () => {
    const { list } = renderPanel({ loading: true, error: '予定を取得できませんでした' });
    expect(list.queryByText('この期間の予定はありません')).not.toBeInTheDocument();
    expect(list.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/**
 * d753: 絞り込みに当てた後の 0 件は「期間内に予定なし」と読めると、絞り込みの結果だと分からない。
 * 日付の帯で絞っている間は、選んだ日付を言葉に出した 0 件文言にする。
 */
describe('絞り込みに当てた後の 0 件文言（d753）', () => {
  it('日付の帯で絞っていたら、その日付の 0 件文言を出す', () => {
    const { list } = renderPanel({ dayFilter: '2026-10-24', filtered: true });
    expect(list.getByText('2026/10/24の予定はありません')).toBeInTheDocument();
    expect(list.queryByText('この期間の予定はありません')).not.toBeInTheDocument();
    expect(list.queryByText('該当する予定はありません')).not.toBeInTheDocument();
  });

  it('日付の帯が無く、検索語かタグで絞っていたら今までどおりの文言を出す', () => {
    const { list } = renderPanel({ filtered: true });
    expect(list.getByText('該当する予定はありません')).toBeInTheDocument();
  });

  it('絞っていなければ期間の 0 件文言を出す', () => {
    const { list } = renderPanel({});
    expect(list.getByText('この期間の予定はありません')).toBeInTheDocument();
  });
});
