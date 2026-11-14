import { describe, it, expect } from 'vitest';
import { TaskStatus } from '@rete/shared';
import type { DeskTaskTree, DeskTaskNode } from '../api';
import { applyMove } from '../drop-projection';

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

const makeTree = (): DeskTaskTree => ({
  categories: [
    {
      id: 1,
      name: 'C1',
      sortOrder: 0,
      tasks: [
        node({
          id: 1,
          title: '親A',
          children: [node({ id: 2, title: '子A1', parentTaskId: 1 })],
        }),
        node({ id: 5, title: '親B' }),
      ],
    },
    {
      id: 2,
      name: '開発エージェント',
      sortOrder: 1,
      tasks: [node({ id: 6, title: '親C', categoryId: 2 })],
    },
  ],
});

// 平坦化して id 順・parent・category を読みやすく検証するヘルパ。
const flatOf = (tree: DeskTaskTree) => {
  const out: { id: number; parentTaskId: number | null; categoryId: number | null }[] = [];
  const walk = (n: DeskTaskNode) => {
    out.push({ id: n.id, parentTaskId: n.parentTaskId, categoryId: n.categoryId });
    n.children.forEach(walk);
  };
  tree.categories.forEach((c) => c.tasks.forEach(walk));
  return out;
};

describe('applyMove', () => {
  it('サブツリーを別カテゴリのトップレベル末尾へ移動し categoryId を波及すること', () => {
    const tree = makeTree();
    // #1（+子#2）を カテゴリ2 トップレベル、#6 の後ろへ。
    const next = applyMove(tree, {
      taskId: 1,
      target: { parentTaskId: null, afterTaskId: 6, categoryId: 2 },
    });
    const flat = flatOf(next);
    const t1 = flat.find((t) => t.id === 1)!;
    const t2 = flat.find((t) => t.id === 2)!;
    expect(t1).toMatchObject({ parentTaskId: null, categoryId: 2 });
    // 子も categoryId が波及する。
    expect(t2).toMatchObject({ parentTaskId: 1, categoryId: 2 });
    // カテゴリ1 には #5 だけ残る。
    const c1 = next.categories.find((c) => c.id === 1)!;
    expect(c1.tasks.map((t) => t.id)).toEqual([5]);
  });

  it('サブツリーを別タスクの子へ移動すること（parentTaskId 更新）', () => {
    const tree = makeTree();
    // #5 を #1 の子（#2 の後ろ）へ。
    const next = applyMove(tree, {
      taskId: 5,
      target: { parentTaskId: 1, afterTaskId: 2, categoryId: 1 },
    });
    const parentA = next.categories.find((c) => c.id === 1)!.tasks.find((t) => t.id === 1)!;
    expect(parentA.children.map((c) => c.id)).toEqual([2, 5]);
    const moved = parentA.children.find((c) => c.id === 5)!;
    expect(moved.parentTaskId).toBe(1);
  });

  it('afterTaskId=null は兄弟グループの先頭へ差し込むこと', () => {
    const tree = makeTree();
    // #5 を #1 の子の先頭へ。
    const next = applyMove(tree, {
      taskId: 5,
      target: { parentTaskId: 1, afterTaskId: null, categoryId: 1 },
    });
    const parentA = next.categories.find((c) => c.id === 1)!.tasks.find((t) => t.id === 1)!;
    expect(parentA.children.map((c) => c.id)).toEqual([5, 2]);
  });

  it('元ツリーを破壊しないこと（純関数）', () => {
    const tree = makeTree();
    const snapshot = JSON.stringify(tree);
    applyMove(tree, { taskId: 1, target: { parentTaskId: null, afterTaskId: 6, categoryId: 2 } });
    expect(JSON.stringify(tree)).toBe(snapshot);
  });

  it('対象 id が存在しなければ元ツリーを返すこと', () => {
    const tree = makeTree();
    const next = applyMove(tree, {
      taskId: 999,
      target: { parentTaskId: null, afterTaskId: null, categoryId: 1 },
    });
    expect(flatOf(next)).toEqual(flatOf(tree));
  });
});
