import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { TaskStatus } from '@rete/shared';
import type { DeskTaskTree, DeskTaskNode } from '../lib/api';
import { useTaskMove } from '../hooks/use-task-move';
import { buildDeskTreeRows } from '../lib/desk-tree-rows';

// dsk-0332: hook は表示行の索引を受け取る。テストは本番と同じ導出を tree から掛ける。
const rowsOf = (tree: DeskTaskTree | null) => buildDeskTreeRows(tree, []);

// cmn-0146: vi.hoisted 化（factory クロージャ参照を構造的に hoist）
const { moveTask, toastError } = vi.hoisted(() => ({
  moveTask: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  moveTask: (...a: unknown[]) => moveTask(...a),
}));

vi.mock('react-hot-toast', () => ({ default: { error: (...a: unknown[]) => toastError(...a) } }));

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
        node({ id: 1, title: '親A', children: [node({ id: 2, title: '子A1', parentTaskId: 1 })] }),
        node({ id: 5, title: '親B' }),
      ],
    },
    { id: 2, name: '開発エージェント', sortOrder: 1, tasks: [node({ id: 6, title: '親C', categoryId: 2 })] },
  ],
});

// drag イベント合成（dnd-kit 形）。
const startEvent = (taskId: number) =>
  ({ active: { id: `task-${taskId}`, data: { current: { kind: 'task-move', taskId } } } }) as never;

// gap droppable 上の move/end イベント合成（dsk-0263）。boundaryPrependCategoryId は分類境界 gap
// にだけ載る prepend 先カテゴリ ID（null=未分類バケット / 省略=通常 gap。TaskGapData 参照）。
const gapMoveEvent = (
  taskId: number,
  gapIndex: number,
  opts: { deltaX?: number; boundaryPrependCategoryId?: number | null } = {},
) =>
  ({
    active: { id: `task-${taskId}`, data: { current: { kind: 'task-move', taskId } } },
    over: {
      id: `gap-${gapIndex}`,
      data: {
        current: {
          kind: 'task-gap',
          gapIndex,
          ...('boundaryPrependCategoryId' in opts
            ? { boundaryPrependCategoryId: opts.boundaryPrependCategoryId }
            : {}),
        },
      },
    },
    delta: { x: opts.deltaX ?? 0, y: 0 },
  }) as never;

beforeEach(() => {
  moveTask.mockReset();
  moveTask.mockResolvedValue({ id: 1 });
  toastError.mockReset();
});

describe('useTaskMove — ドラッグ状態', () => {
  it('task-move の drag 開始で activeTaskId をセットすること', () => {
    let tree: DeskTaskTree | null = makeTree();
    const setTree = vi.fn((u: DeskTaskTree | null) => (tree = u));
    const { result } = renderHook(() =>
      useTaskMove({
        rows: rowsOf(tree),
        setTree: setTree as never,
        refetchTree: vi.fn().mockResolvedValue(undefined),
      }),
    );
    act(() => result.current.onDragStart(startEvent(1)));
    expect(result.current.activeTaskId).toBe(1);
  });

  it('theme（昇格）ドラッグでは activeTaskId をセットしないこと', () => {
    const { result } = renderHook(() =>
      useTaskMove({
        rows: rowsOf(makeTree()),
        setTree: vi.fn(),
        refetchTree: vi.fn().mockResolvedValue(undefined),
      }),
    );
    act(() =>
      result.current.onDragStart({
        active: { id: 'theme-1', data: { current: { theme: { id: 'theme-1' } } } },
      } as never),
    );
    expect(result.current.activeTaskId).toBeNull();
  });
});

describe('useTaskMove — 分類境界 gap の prepend 解決（dsk-0256 / dsk-0263）', () => {
  // makeTree の flatten 順: #1(d0) #2(d1) #5(d0) #6(d0)。gapIndex 3 = #5 と #6 の間＝C1/開発エージェントの
  // 分類境界 gap（task-tree が boundaryPrependCategoryId=2 を載せる）。gapIndex 4 = 末尾。
  it('onDragMove: 境界 gap ホバーで indicator に boundaryPrependCategoryId が伝播すること', () => {
    const { result } = renderHook(() =>
      useTaskMove({
        rows: rowsOf(makeTree()),
        setTree: vi.fn(),
        refetchTree: vi.fn().mockResolvedValue(undefined),
      }),
    );
    act(() => result.current.onDragStart(startEvent(5)));
    act(() => result.current.onDragMove(gapMoveEvent(5, 3, { boundaryPrependCategoryId: 2 })));
    expect(result.current.indicator).toEqual({
      gapIndex: 3,
      depth: 0,
      boundaryPrependCategoryId: 2,
    });
  });

  it('onDragMove: 通常 gap（boundaryPrependCategoryId なし）では undefined のまま伝播すること', () => {
    const { result } = renderHook(() =>
      useTaskMove({
        rows: rowsOf(makeTree()),
        setTree: vi.fn(),
        refetchTree: vi.fn().mockResolvedValue(undefined),
      }),
    );
    act(() => result.current.onDragStart(startEvent(5)));
    // gapIndex 1 = #1 と #2 の間（通常 gap）。minDepth=1（next=#2）へクランプ。
    act(() => result.current.onDragMove(gapMoveEvent(5, 1)));
    expect(result.current.indicator).toMatchObject({ gapIndex: 1, depth: 1 });
    expect(result.current.indicator?.boundaryPrependCategoryId).toBeUndefined();
  });

  it('onDragEnd: 境界 gap ドロップで次カテゴリ先頭 prepend target（parent/after=null・categoryId=境界値）を確定すること', async () => {
    let tree: DeskTaskTree | null = makeTree();
    const setTree = vi.fn((updater: unknown) => {
      tree =
        typeof updater === 'function'
          ? (updater as (t: DeskTaskTree | null) => DeskTaskTree)(tree)
          : (updater as DeskTaskTree);
    });
    const refetchTree = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useTaskMove({ rows: rowsOf(tree), setTree: setTree as never, refetchTree }),
    );

    act(() => result.current.onDragStart(startEvent(5)));
    await act(async () => {
      result.current.onDragEnd(gapMoveEvent(5, 3, { boundaryPrependCategoryId: 2 }));
    });

    // commitMove → moveTask が「開発エージェント先頭へ prepend」の一意 target で呼ばれる（A 末尾 append ではない）。
    expect(moveTask).toHaveBeenCalledWith(5, {
      parentTaskId: null,
      afterTaskId: null,
      categoryId: 2,
    });
    expect(refetchTree).toHaveBeenCalledTimes(1);
    expect(result.current.indicator).toBeNull();
    expect(result.current.activeTaskId).toBeNull();
  });

  it('onDragEnd: 未分類バケット境界（boundaryPrependCategoryId=null）で categoryId:null の prepend を確定すること', async () => {
    const { result } = renderHook(() =>
      useTaskMove({
        rows: rowsOf(makeTree()),
        setTree: vi.fn(),
        refetchTree: vi.fn().mockResolvedValue(undefined),
      }),
    );

    act(() => result.current.onDragStart(startEvent(5)));
    await act(async () => {
      result.current.onDragEnd(gapMoveEvent(5, 4, { boundaryPrependCategoryId: null }));
    });

    expect(moveTask).toHaveBeenCalledWith(5, {
      parentTaskId: null,
      afterTaskId: null,
      categoryId: null,
    });
  });
});

describe('useTaskMove — ドロップ確定', () => {
  it('ドロップで楽観更新（setTree）→ moveTask 呼び出し → 成功で refetch', async () => {
    let tree: DeskTaskTree | null = makeTree();
    const setTree = vi.fn((updater: unknown) => {
      tree =
        typeof updater === 'function'
          ? (updater as (t: DeskTaskTree | null) => DeskTaskTree)(tree)
          : (updater as DeskTaskTree);
    });
    const refetchTree = vi.fn().mockResolvedValue(undefined);

    const { result, rerender } = renderHook(
      ({ t }) => useTaskMove({ rows: rowsOf(t), setTree: setTree as never, refetchTree }),
      { initialProps: { t: tree } },
    );

    act(() => result.current.onDragStart(startEvent(5)));
    // projection 結果を直接渡してドロップ確定（DOM 計測を介さない単体テスト経路）。
    await act(async () => {
      await result.current.commitMove({
        taskId: 5,
        target: { parentTaskId: 1, afterTaskId: 2, categoryId: 1 },
      });
    });

    expect(setTree).toHaveBeenCalled();
    expect(moveTask).toHaveBeenCalledWith(5, { parentTaskId: 1, categoryId: 1, afterTaskId: 2 });
    expect(refetchTree).toHaveBeenCalledTimes(1);
    rerender({ t: tree });
    // #5 が #1 の子になっている。
    const parentA = tree!.categories[0].tasks.find((x) => x.id === 1)!;
    expect(parentA.children.map((c) => c.id)).toContain(5);
  });

  it('moveTask 失敗で移動前スナップショットへロールバックしトーストを出すこと', async () => {
    const original = makeTree();
    let tree: DeskTaskTree | null = original;
    const setTree = vi.fn((updater: unknown) => {
      tree =
        typeof updater === 'function'
          ? (updater as (t: DeskTaskTree | null) => DeskTaskTree)(tree)
          : (updater as DeskTaskTree);
    });
    const refetchTree = vi.fn().mockResolvedValue(undefined);
    moveTask.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() =>
      useTaskMove({ rows: rowsOf(tree), setTree: setTree as never, refetchTree }),
    );

    act(() => result.current.onDragStart(startEvent(5)));
    await act(async () => {
      await result.current.commitMove({
        taskId: 5,
        target: { parentTaskId: 1, afterTaskId: 2, categoryId: 1 },
      });
    });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // ロールバック: 最後の setTree 呼び出しで元スナップショットへ戻る。
    expect(JSON.stringify(tree)).toBe(JSON.stringify(original));
    expect(refetchTree).not.toHaveBeenCalled();
  });

  it('snapshot が null（未ロード）でも失敗ロールバックで null 上書きしないこと（指摘[7]）', async () => {
    // 楽観更新の時点でツリーが null。catch のロールバックで setTree(null) を呼ぶと、
    // それまでにロードされたツリーを潰す。snapshot=null のときは setTree を呼ばないこと。
    let tree: DeskTaskTree | null = null;
    const setTreeCalls: Array<DeskTaskTree | null> = [];
    const setTree = vi.fn((updater: unknown) => {
      const next =
        typeof updater === 'function'
          ? (updater as (t: DeskTaskTree | null) => DeskTaskTree | null)(tree)
          : (updater as DeskTaskTree | null);
      tree = next;
      setTreeCalls.push(next);
    });
    const refetchTree = vi.fn().mockResolvedValue(undefined);
    moveTask.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() =>
      useTaskMove({ rows: rowsOf(null), setTree: setTree as never, refetchTree }),
    );

    await act(async () => {
      await result.current.commitMove({
        taskId: 5,
        target: { parentTaskId: null, afterTaskId: null, categoryId: 1 },
      });
    });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // 楽観更新の 1 回（prev=null → null）のみ。catch でのロールバック setTree(null) は発火しない。
    expect(setTreeCalls).toHaveLength(1);
  });
});
