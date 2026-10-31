// dsk-0332: 表示行の導出（buildDeskTreeRows）と D&D projection の入力が一致することの全件照合。
//
// 方針: 表示順の正本を frontend（分類マスタを sortOrder → id で整列した表示順）と定め、取得ツリーの
// 並び（flattenTree）と一致するのは「同一 Space 内で category.sortOrder が重複しない時」に限る
// （backend の orderBy は category.sortOrder のみで id タイブレークを持たず、DB/API も一意を強制しない）。
// そのため本テストは (1) 代表フィクスチャで全行が flattenTree と一致すること、(2) 食い違う場合は
// 表示順（マスタ順）を採ること、(3) 索引の有無で projectDrop の結果が変わらないこと の3点を全件で確かめる。
import { describe, it, expect } from 'vitest';
import { TaskStatus } from '@rete/shared';
import type { Category } from '@/features/tasks/lib/api';
import type { DeskTaskTree, DeskTaskNode } from '../api';
import {
  flattenTree,
  projectDrop,
  subtreeDepthOf,
  subtreeIds,
  MAX_TREE_DEPTH,
  type FlatRow,
  type FlatRowIndex,
  type DropProjection,
} from '../drop-projection';
import { buildDeskTreeRows } from '../desk-tree-rows';

const base = {
  description: null,
  status: TaskStatus.TODO,
  assigneeName: null,
  startDate: null,
  dueDate: null,
  sourceThemeId: null,
  sourceTheme: null,
  createdAt: '',
  updatedAt: '',
  sortOrder: 0,
};

const node = (over: Partial<DeskTaskNode>): DeskTaskNode =>
  ({
    ...base,
    id: 0,
    title: 't',
    categoryId: 1,
    parentTaskId: null,
    children: [],
    ...over,
  }) as DeskTaskNode;

const cat = (id: number, name: string, sortOrder: number): Category =>
  ({
    id,
    name,
    spaceId: 'space-1',
    sortOrder,
    archived: false,
    createdAt: '',
    updatedAt: '',
  }) as Category;

const INDENT = 24;

/**
 * カテゴリ1: #1 親A(depth0) → #2 子A1(depth1) → #3 孫A1a(depth2)、 #4 子A2(depth1)、 #5 親B(depth0)
 * カテゴリ2: #6 親C(depth0)
 * 未分類(id=null): #7 未分類A(depth0)
 */
const tree: DeskTaskTree = {
  categories: [
    {
      id: 1,
      name: 'C1',
      sortOrder: 0,
      tasks: [
        node({
          id: 1,
          title: '親A',
          children: [
            node({
              id: 2,
              title: '子A1',
              parentTaskId: 1,
              children: [node({ id: 3, title: '孫A1a', parentTaskId: 2 })],
            }),
            node({ id: 4, title: '子A2', parentTaskId: 1 }),
          ],
        }),
        node({ id: 5, title: '親B' }),
      ],
    },
    { id: 2, name: '開発エージェント', sortOrder: 1, tasks: [node({ id: 6, title: '親C', categoryId: 2 })] },
    {
      id: null,
      name: '未分類',
      sortOrder: 0,
      tasks: [node({ id: 7, title: '未分類A', categoryId: null })],
    },
  ],
};

/** 空チャネル（タスク 0 件のカテゴリのみ）＋空の分類マスタ。 */
const emptyTree: DeskTaskTree = {
  categories: [{ id: 9, name: 'C9', sortOrder: 0, tasks: [] }],
};

/** 最大深さ（MAX_TREE_DEPTH）を使い切る 4 階層。 */
const deepTree: DeskTaskTree = {
  categories: [
    {
      id: 1,
      name: 'C1',
      sortOrder: 0,
      tasks: [
        node({
          id: 10,
          title: 'd0',
          children: [
            node({
              id: 11,
              title: 'd1',
              parentTaskId: 10,
              children: [
                node({
                  id: 12,
                  title: 'd2',
                  parentTaskId: 11,
                  children: [node({ id: 13, title: 'd3', parentTaskId: 12 })],
                }),
              ],
            }),
          ],
        }),
      ],
    },
  ],
};

/** 旧実装（findIndex + 後続走査）を独立に書き下した照合オラクル。 */
function legacySubtreeDepth(rows: FlatRow[], rootId: number): number {
  const idx = rows.findIndex((r) => r.id === rootId);
  if (idx < 0) return 0;
  const rootDepth = rows[idx].depth;
  let max = 0;
  for (let i = idx + 1; i < rows.length; i += 1) {
    if (rows[i].depth <= rootDepth) break;
    max = Math.max(max, rows[i].depth - rootDepth);
  }
  return max;
}

/** 旧実装（findIndex + 後続走査）の id 集合オラクル。 */
function legacySubtreeIds(rows: FlatRow[], rootId: number): number[] {
  const ids: number[] = [];
  const idx = rows.findIndex((r) => r.id === rootId);
  if (idx < 0) return ids;
  const rootDepth = rows[idx].depth;
  ids.push(rootId);
  for (let i = idx + 1; i < rows.length; i += 1) {
    if (rows[i].depth <= rootDepth) break;
    ids.push(rows[i].id);
  }
  return ids;
}

/** 索引の自己整合（id → index / id → サブツリー最大深さ）を全行で照合する。 */
function expectIndexConsistent(rows: FlatRow[], index: FlatRowIndex): void {
  expect(index.rows).toBe(rows);
  rows.forEach((row, i) => {
    expect(index.indexOfId.get(row.id)).toBe(i);
    expect(index.subtreeDepthOfId.get(row.id)).toBe(legacySubtreeDepth(rows, row.id));
  });
}

const rowKey = (r: FlatRow) =>
  `${r.id}:${r.depth}:${r.categoryId}:${r.parentTaskId}:${r.childCount}`;

describe('buildDeskTreeRows — 表示行の全件照合', () => {
  it('分類マスタの並びがツリーと一致する時、全行が flattenTree と一致すること', () => {
    // マスタはわざと逆順で渡し、sortOrder → id の整列が効くことを同時に確かめる。
    const master = [cat(2, '開発エージェント', 1), cat(1, 'C1', 0)];
    const { groups, rows } = buildDeskTreeRows(tree, master);
    expect(groups.map((g) => g.id)).toEqual([1, 2, null]);
    expect(rows.map(rowKey)).toEqual(flattenTree(tree).map(rowKey));
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0, 0, 0]);
  });

  it('空分類を描かず、未分類バケットを末尾に置くこと', () => {
    const master = [cat(1, 'C1', 0), cat(3, 'C3', 2), cat(2, '開発エージェント', 1)];
    const { groups } = buildDeskTreeRows(tree, master);
    // C3 は取得ツリーに無い＝空分類なので落ちる。未分類は末尾。
    expect(groups.map((g) => `${g.id}:${g.name}`)).toEqual(['1:C1', '2:開発エージェント', 'null:未分類']);
  });

  it('分類マスタ未指定／空（既定の全件ビュー）はツリーの並びをそのまま使うこと', () => {
    for (const master of [undefined, [] as Category[]]) {
      const { groups, rows } = buildDeskTreeRows(tree, master);
      expect(groups.map((g) => g.id)).toEqual([1, 2, null]);
      expect(rows.map(rowKey)).toEqual(flattenTree(tree).map(rowKey));
    }
  });

  it('分類マスタの sortOrder がツリーの並びと食い違う時は表示順（マスタ順）を採ること', () => {
    // 同一 Space 内で sortOrder が重複しない前提でのみ両者は一致する。食い違った場合は表示行の順が正
    // （gapIndex は表示行の連番。projection も同じ行を使うため判定と描画は常に一致する）。
    const master = [cat(1, 'C1', 5), cat(2, '開発エージェント', 0)];
    const { rows } = buildDeskTreeRows(tree, master);
    expect(rows.map((r) => r.id)).toEqual([6, 1, 2, 3, 4, 5, 7]);
    expect(rows.map(rowKey)).not.toEqual(flattenTree(tree).map(rowKey));
  });

  it('空チャネルは groups / rows とも空になること', () => {
    const empty = buildDeskTreeRows(emptyTree, [cat(9, 'C9', 0)]);
    expect(empty.groups).toEqual([]);
    expect(empty.rows).toEqual([]);
    const noTree = buildDeskTreeRows(null, [cat(9, 'C9', 0)]);
    expect(noTree.groups).toEqual([]);
    expect(noTree.rows).toEqual([]);
  });

  it('最大深さ（4 階層）のツリーでも全行の深さとサブツリー最大深さが一致すること', () => {
    const index = buildDeskTreeRows(deepTree, [cat(1, 'C1', 0)]);
    expect(index.rows.map((r) => r.depth)).toEqual([0, 1, 2, 3]);
    expectIndexConsistent(index.rows, index);
    expect(subtreeDepthOf(index.rows, 10, index)).toBe(3);
    expect(subtreeDepthOf(index.rows, 12, index)).toBe(1);
    expect(MAX_TREE_DEPTH).toBe(3);
  });
});

describe('索引（indexFlatRows）— 旧実装との全件照合', () => {
  const cases: [string, DeskTaskTree | null, Category[] | undefined][] = [
    ['カテゴリ2件＋未分類', tree, [cat(1, 'C1', 0), cat(2, '開発エージェント', 1)]],
    ['マスタ未指定', tree, undefined],
    ['マスタ空', tree, []],
    ['マスタ順が不一致', tree, [cat(2, '開発エージェント', 0), cat(1, 'C1', 1)]],
    ['空チャネル', emptyTree, [cat(9, 'C9', 0)]],
    ['最大深さ', deepTree, [cat(1, 'C1', 0)]],
  ];

  it.each(cases)('%s: 行 index とサブツリー最大深さが全行一致すること', (_name, t, master) => {
    const index = buildDeskTreeRows(t, master);
    expectIndexConsistent(index.rows, index);
  });

  it('subtreeDepthOf / subtreeIds は索引の有無で同じ結果を返すこと', () => {
    const index = buildDeskTreeRows(tree, [cat(1, 'C1', 0), cat(2, '開発エージェント', 1)]);
    const { rows } = index;
    for (const row of rows) {
      expect(subtreeDepthOf(rows, row.id, index)).toBe(legacySubtreeDepth(rows, row.id));
      expect(subtreeDepthOf(rows, row.id)).toBe(legacySubtreeDepth(rows, row.id));
      expect([...subtreeIds(rows, row.id, index)].sort((a, b) => a - b)).toEqual(
        legacySubtreeIds(rows, row.id),
      );
      expect([...subtreeIds(rows, row.id)].sort((a, b) => a - b)).toEqual(
        legacySubtreeIds(rows, row.id),
      );
    }
    // 不在 id は空集合 / 深さ 0。
    expect(subtreeDepthOf(rows, 999, index)).toBe(0);
    expect([...subtreeIds(rows, 999, index)]).toEqual([]);
  });
});

describe('projectDrop — 索引の有無で全 gap / 全オフセットの結果が変わらないこと', () => {
  const cases: [string, DeskTaskTree | null, Category[] | undefined][] = [
    ['カテゴリ2件＋未分類', tree, [cat(1, 'C1', 0), cat(2, '開発エージェント', 1)]],
    ['マスタ未指定（既定ビュー）', tree, undefined],
    ['マスタ順が不一致', tree, [cat(2, '開発エージェント', 0), cat(1, 'C1', 1)]],
    ['空チャネル', emptyTree, [cat(9, 'C9', 0)]],
    ['最大深さ', deepTree, [cat(1, 'C1', 0)]],
  ];

  it.each(cases)('%s: 全 gap × 全オフセット × 除外集合で一致すること', (_name, t, master) => {
    const index = buildDeskTreeRows(t, master);
    const { rows } = index;
    const excludeSets: (Set<number> | undefined)[] = [undefined];
    // 自己子孫禁止: 各サブツリーを除外集合にした場合も全 gap 走査する。
    for (const row of rows) excludeSets.push(subtreeIds(rows, row.id, index));

    for (const excludeIds of excludeSets) {
      for (let gapIndex = 0; gapIndex <= rows.length + 1; gapIndex += 1) {
        for (const offsetX of [-2 * INDENT, -INDENT, 0, INDENT, 2 * INDENT]) {
          for (const subtreeDepth of [0, 1, 3]) {
            for (const baseDepth of [undefined, 0, 2]) {
              const args = {
                rows,
                gapIndex,
                offsetX,
                indentWidth: INDENT,
                subtreeDepth,
                excludeIds,
                baseDepth,
              };
              const withIndex = projectDrop({ ...args, index });
              const withoutIndex = projectDrop(args);
              expect(withIndex, `gap=${gapIndex} offsetX=${offsetX}`).toEqual(withoutIndex);
            }
          }
        }
      }
    }
  });

  it('分類境界 gap は次カテゴリ先頭への prepend を解決すること', () => {
    const index = buildDeskTreeRows(tree, [cat(1, 'C1', 0), cat(2, '開発エージェント', 1)]);
    const { rows } = index;
    // #5（C1 末尾, index 4）と #6（開発エージェント先頭, index 5）の間の gap。
    const projection: DropProjection | null = projectDrop({
      rows,
      index,
      gapIndex: 5,
      offsetX: 0,
      indentWidth: INDENT,
      subtreeDepth: 0,
      boundaryPrependCategoryId: 2,
    });
    expect(projection?.target).toEqual({ parentTaskId: null, afterTaskId: null, categoryId: 2 });
  });

  it('カテゴリ末尾 append は最終行の兄弟として解決すること', () => {
    const index = buildDeskTreeRows(tree, [cat(1, 'C1', 0), cat(2, '開発エージェント', 1)]);
    const { rows } = index;
    const projection = projectDrop({
      rows,
      index,
      gapIndex: 5, // #6 の直前 = C1 の末尾
      offsetX: 0,
      indentWidth: INDENT,
      subtreeDepth: 0,
    });
    expect(projection?.target).toEqual({ parentTaskId: null, afterTaskId: 5, categoryId: 1 });
  });
});
