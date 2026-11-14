import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen } from '@testing-library/react';
import { CalendarPanel } from './calendar-panel';
import type { CalendarEditor } from './use-calendar-editor';

/**
 * d1273: カレンダー予定一覧の右上アクション行を一覧共通部品へ揃えた回帰ガード。
 * 見出し「スケジュール」を左に残し、操作は右寄せの共通グループへ置く。
 * 権限が無くても行は残り、予定一覧（.calendar-list-scroll）の開始位置が動かない。
 */
function renderPanel(canEdit: boolean) {
  return render(
    <CalendarPanel
      editor={{ panel: 'list', create: vi.fn() } as unknown as CalendarEditor}
      canEdit={canEdit}
      blocked={false}
      events={[]}
      dayFilter={null}
      onClearDay={() => {}}
      onRetry={() => {}}
      filtered={false}
      loading={false}
      error=""
      tags={{ tags: [] } as never}
    />,
  );
}

describe('CalendarPanel の右上アクション行（d1273）', () => {
  it('見出しは左・操作は右寄せの共通グループに置く（Desk・掲示板と同じ行構成）', () => {
    const { container } = renderPanel(true);
    const row = container.querySelector('.sp-list-action-row');
    expect(row).not.toBeNull();
    const group = row!.querySelector('.sp-list-action-row-actions');
    expect(group).not.toBeNull();
    // 見出し（スケジュール）は行の中・グループの外＝左に残る。
    expect(row!.querySelector('.calendar-list-heading')).not.toBeNull();
    expect(group!.contains(row!.querySelector('.calendar-list-heading'))).toBe(false);
    // 新規登録は共通ボタン（.sp-action-btn）で、右寄せグループの中に居る。
    const add = screen.getByRole('button', { name: '新規登録' });
    expect(add).toHaveClass('sp-action-btn');
    expect(group!.contains(add)).toBe(true);
  });

  it('編集権限が無くても行は残り、予定一覧の開始位置が動かない', () => {
    const { container } = renderPanel(false);
    expect(screen.queryByRole('button', { name: '新規登録' })).not.toBeInTheDocument();
    const row = container.querySelector('.sp-list-action-row');
    expect(row).not.toBeNull();
    // 行と一覧は別要素のまま（行が消えて一覧が上へ詰まらない）。
    expect(container.querySelector('.calendar-list-scroll')).not.toBeNull();
    expect(row!.querySelectorAll('button')).toHaveLength(0);
  });

  it('行の高さは CSS の min-height が持ち、画面側で高さを直書きしない', () => {
    const { container } = renderPanel(false);
    const row = container.querySelector('.sp-list-action-row') as HTMLElement;
    // 権限でボタンが 0 個でも、行は style で高さを持たない（CSS 側の 2rem が効く）。
    expect(row.getAttribute('style')).toBeNull();
  });

  it('カレンダーの CSS は行の高さ・間隔を作り直していない（共通クラスへ委譲）', () => {
    const css = readFileSync(join(__dirname, 'calendar.css'), 'utf8');
    const block = css.slice(
      css.indexOf('.calendar-list-actions {'),
      css.indexOf('.calendar-list-heading {'),
    );
    // min-height / margin-bottom をカレンダー側で再定義しない（共通クラスが正本）。
    expect(block).not.toContain('min-height');
    expect(block).not.toContain('margin-bottom');
    // 見出しを左に残すため space-between だけを持つ。
    expect(block).toContain('justify-content: space-between');
  });

  it('段間トークンは 1 箇所でだけ定義する（カレンダー側に写しを作らない）', () => {
    const srcRoot = join(__dirname, '../..');
    const cssFiles = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.css'))
      .map((f) => join(srcRoot, f));
    const definitions: string[] = [];
    for (const file of cssFiles) {
      for (const m of readFileSync(file, 'utf8').matchAll(/--sp-section-gap:\s*([^;]+);/g)) {
        definitions.push(`${relative(srcRoot, file).replaceAll('\\', '/')}:${m[1].trim()}`);
      }
    }
    expect(definitions).toEqual(['app/globals.css:0.75rem']);
  });
});
