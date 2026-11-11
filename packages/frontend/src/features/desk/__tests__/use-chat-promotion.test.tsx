import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { TaskStatus } from '@rete/shared';
import type { DeskTaskTree, DeskTaskNode } from '../lib/api';
import { buildDeskTreeRows } from '../lib/desk-tree-rows';

// dsk-0332: hook は表示行の索引を受け取る。テストは本番と同じ導出を tree から掛ける。
const rowsOf = (tree: DeskTaskTree | null) => buildDeskTreeRows(tree, []);
import {
  useChatPromotion,
  buildPromotePayload,
  targetInsertLabel,
  type DragTheme,
  type DropTarget,
} from '../hooks/use-chat-promotion';

// cmn-0146: vi.hoisted 化（factory クロージャ参照を構造的に hoist）
const { promote, fetchDetail } = vi.hoisted(() => ({
  promote: vi.fn(),
  fetchDetail: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  promoteChatToTask: (...args: unknown[]) => promote(...args),
  fetchChatThemeDetail: (...args: unknown[]) => fetchDetail(...args),
}));

const theme: DragTheme = {
  id: 'theme-1',
  title: '在庫差異の検知',
  description: '差異を自動検知したい',
};
const summaryTheme: DragTheme = { id: 'theme-2', title: 'タイトルのみ', description: null };

// テスト用ツリー: カテゴリ1 に #1（子 #2）/ #5、カテゴリ2 に #6。
const baseNode = {
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
const n = (over: Partial<DeskTaskNode>): DeskTaskNode =>
  ({
    ...baseNode,
    id: 0,
    title: 't',
    categoryId: 1,
    parentTaskId: null,
    children: [],
    ...over,
  }) as DeskTaskNode;
const tree: DeskTaskTree = {
  categories: [
    {
      id: 1,
      name: 'C1',
      sortOrder: 0,
      tasks: [
        n({ id: 1, title: '親A', children: [n({ id: 2, title: '子A1', parentTaskId: 1 })] }),
        n({ id: 5, title: '親B' }),
      ],
    },
    { id: 2, name: '開発エージェント', sortOrder: 1, tasks: [n({ id: 6, title: '親C', categoryId: 2 })] },
  ],
};

// 合成 dnd イベント（gap droppable + ポインタ delta）。boundaryPrependCategoryId は分類境界 gap に
// だけ載る prepend 先カテゴリ ID（null=未分類バケット / 省略=通常 gap。dsk-0256 / dsk-0263）。
const dragStart = () => ({ active: { id: theme.id, data: { current: { theme } } } }) as never;
const gapEvent = (
  t: DragTheme,
  gapIndex: number | null,
  deltaX = 0,
  boundaryPrependCategoryId?: number | null,
) =>
  ({
    active: { id: t.id, data: { current: { theme: t } } },
    over:
      gapIndex == null
        ? null
        : {
            id: `gap-${gapIndex}`,
            data: {
              current: {
                kind: 'task-gap',
                gapIndex,
                ...(boundaryPrependCategoryId !== undefined ? { boundaryPrependCategoryId } : {}),
              },
            },
          },
    delta: { x: deltaX, y: 0 },
  }) as never;

beforeEach(() => {
  promote.mockReset();
  promote.mockResolvedValue({ id: 1 });
  fetchDetail.mockReset();
  fetchDetail.mockResolvedValue({ description: '取得した説明文' });
});

describe('buildPromotePayload', () => {
  const values = { title: 'T', description: 'D', status: TaskStatus.TODO };

  it('append（トップレベル末尾）: parent / after を含めないこと', () => {
    const target: DropTarget = { parentTaskId: null, afterTaskId: null, categoryId: 1 };
    const p = buildPromotePayload(theme, target, values);
    expect(p).toMatchObject({ title: 'T', categoryId: 1, sourceThemeId: 'theme-1' });
    expect(p.parentTaskId).toBeUndefined();
    expect(p.afterTaskId).toBeUndefined();
  });

  it('sibling（トップレベル）: parentTaskId を落とし afterTaskId を載せること', () => {
    const target: DropTarget = { parentTaskId: null, afterTaskId: 7, categoryId: 2 };
    const p = buildPromotePayload(theme, target, values);
    expect(p.categoryId).toBe(2);
    expect(p.parentTaskId).toBeUndefined();
    expect(p.afterTaskId).toBe(7);
  });

  it('sibling（子グループ内）: parentTaskId と afterTaskId を両方載せること', () => {
    const target: DropTarget = { parentTaskId: 5, afterTaskId: 7, categoryId: 2 };
    const p = buildPromotePayload(theme, target, values);
    expect(p.parentTaskId).toBe(5);
    expect(p.afterTaskId).toBe(7);
  });

  it('child（先頭子）: parentTaskId を載せ afterTaskId は含めないこと', () => {
    const target: DropTarget = { parentTaskId: 9, afterTaskId: null, categoryId: 1 };
    const p = buildPromotePayload(theme, target, values);
    expect(p.parentTaskId).toBe(9);
    expect(p.afterTaskId).toBeUndefined();
  });
});

describe('targetInsertLabel', () => {
  it('トップレベル末尾（parent/after なし）= カテゴリ末尾に追加', () => {
    expect(targetInsertLabel({ parentTaskId: null, afterTaskId: null, categoryId: 1 })).toBe(
      'カテゴリ末尾に追加',
    );
  });
  it('トップレベル兄弟の間（after のみ）= 兄弟タスクとして挿入', () => {
    expect(targetInsertLabel({ parentTaskId: null, afterTaskId: 7, categoryId: 1 })).toBe(
      '兄弟タスクとして挿入',
    );
  });
  it('子グループ先頭（parent のみ）= 子タスクの先頭に追加', () => {
    expect(targetInsertLabel({ parentTaskId: 5, afterTaskId: null, categoryId: 1 })).toBe(
      '子タスクの先頭に追加',
    );
  });
  it('子グループ内の間（parent + after）= 子タスクとして挿入', () => {
    expect(targetInsertLabel({ parentTaskId: 5, afterTaskId: 7, categoryId: 1 })).toBe(
      '子タスクとして挿入',
    );
  });
});

describe('useChatPromotion', () => {
  it('drag 開始で activeTheme をセットすること', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragStart(dragStart()));
    expect(result.current.activeTheme?.id).toBe('theme-1');
  });

  it('gap 上で indicator（gapIndex + depth）をセットすること', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragStart(dragStart()));
    // gapIndex 1 = #1 と #2 の間。prev=#1 next=#2 → depth1 固定。
    act(() => result.current.onDragMove(gapEvent(theme, 1)));
    expect(result.current.indicator).toMatchObject({ gapIndex: 1, depth: 1 });
  });

  it('ツリー外（over=null）では indicator が null', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragStart(dragStart()));
    act(() => result.current.onDragMove(gapEvent(theme, null)));
    expect(result.current.indicator).toBeNull();
  });

  it('gap ドロップで provisionalRow と promoteDraft をセットすること', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    // gapIndex 3 = #5 の後ろ（#6 の手前）。トップレベル兄弟 after=#5。
    act(() => result.current.onDragEnd(gapEvent(theme, 3)));
    expect(result.current.provisionalRow).toMatchObject({ title: '在庫差異の検知', gapIndex: 3 });
    expect(result.current.promoteDraft?.theme.id).toBe('theme-1');
    expect(result.current.promoteDraft?.target).toMatchObject({ afterTaskId: 5, categoryId: 1 });
    expect(result.current.activeTheme).toBeNull();
  });

  it('ツリー外ドロップ（over=null）は昇格を起こさないこと', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragEnd(gapEvent(theme, null)));
    expect(result.current.promoteDraft).toBeNull();
  });

  it('savePromotion 成功で promoteChatToTask を呼び refetchTree 後に draft / 仮挿入行を消すこと', async () => {
    const refetchTree = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useChatPromotion({ rows: rowsOf(tree), refetchTree }));
    act(() => result.current.onDragEnd(gapEvent(theme, 3)));

    await act(async () => {
      await result.current.savePromotion({ title: '在庫差異の検知', status: TaskStatus.TODO });
    });

    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote.mock.calls[0][0].sourceThemeId).toBe('theme-1');
    expect(refetchTree).toHaveBeenCalledTimes(1);
    expect(result.current.promoteDraft).toBeNull();
    expect(result.current.provisionalRow).toBeNull();
  });

  it('savePromotion 成功で refetchThemes も呼び、昇格済みテーマを一覧から落とすこと', async () => {
    const refetchTree = vi.fn().mockResolvedValue(undefined);
    const refetchThemes = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree, refetchThemes }),
    );
    act(() => result.current.onDragEnd(gapEvent(theme, 3)));

    await act(async () => {
      await result.current.savePromotion({ title: '在庫差異の検知', status: TaskStatus.TODO });
    });

    expect(refetchThemes).toHaveBeenCalledTimes(1);
    expect(result.current.promoteDraft).toBeNull();
  });

  it('refetchThemes 未指定でも savePromotion が成功して draft を消すこと（後方互換）', async () => {
    const refetchTree = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useChatPromotion({ rows: rowsOf(tree), refetchTree }));
    act(() => result.current.onDragEnd(gapEvent(theme, 3)));

    await act(async () => {
      await result.current.savePromotion({ title: 'X', status: TaskStatus.TODO });
    });

    expect(promote).toHaveBeenCalledTimes(1);
    expect(result.current.promoteDraft).toBeNull();
  });

  it('savePromotion 失敗で仮挿入行 / draft を残しエラーを立てること', async () => {
    promote.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragEnd(gapEvent(theme, 3)));

    await act(async () => {
      await result.current.savePromotion({ title: 'X', status: TaskStatus.TODO });
    });

    await waitFor(() => expect(result.current.saveError).not.toBeNull());
    expect(result.current.promoteDraft).not.toBeNull();
    expect(result.current.provisionalRow).not.toBeNull();
  });

  it('description を持たない summary テーマは詳細を後追い取得して draft へ補完すること', async () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragEnd(gapEvent(summaryTheme, 3)));
    expect(result.current.promoteDraft?.theme.description).toBeNull();
    expect(fetchDetail).toHaveBeenCalledWith('theme-2');
    await waitFor(() =>
      expect(result.current.promoteDraft?.theme.description).toBe('取得した説明文'),
    );
  });

  it('description を持つテーマは詳細を再取得しないこと', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragEnd(gapEvent(theme, 3)));
    expect(fetchDetail).not.toHaveBeenCalled();
  });

  it('cancelPromotion で draft / 仮挿入行 / エラーを消すこと', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragEnd(gapEvent(theme, 3)));
    act(() => result.current.cancelPromotion());
    expect(result.current.promoteDraft).toBeNull();
    expect(result.current.provisionalRow).toBeNull();
    expect(result.current.saveError).toBeNull();
  });
});

describe('useChatPromotion — 分類境界 gap の prepend 解決（dsk-0256 / dsk-0263）', () => {
  // tree の flatten 順: #1(d0) #2(d1) #5(d0) #6(d0)。gapIndex 3 = #5 と #6 の間＝C1/開発エージェントの
  // 分類境界 gap（task-tree が boundaryPrependCategoryId=2 を載せる）。gapIndex 4 = 末尾。
  it('onDragMove: 境界 gap ホバーで indicator に boundaryPrependCategoryId が伝播すること', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragStart(dragStart()));
    act(() => result.current.onDragMove(gapEvent(theme, 3, 0, 2)));
    expect(result.current.indicator).toEqual({
      gapIndex: 3,
      depth: 0,
      boundaryPrependCategoryId: 2,
    });
  });

  it('onDragEnd: 境界 gap ドロップで provisionalRow に伝播し、target が次カテゴリ先頭 prepend になること', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragEnd(gapEvent(theme, 3, 0, 2)));
    expect(result.current.provisionalRow).toMatchObject({
      gapIndex: 3,
      depth: 0,
      boundaryPrependCategoryId: 2,
    });
    // A（C1）末尾 append（afterTaskId=5 / categoryId=1）ではなく 開発エージェント先頭 prepend が確定する。
    expect(result.current.promoteDraft?.target).toEqual({
      parentTaskId: null,
      afterTaskId: null,
      categoryId: 2,
    });
  });

  it('onDragEnd: 未分類バケット境界（boundaryPrependCategoryId=null）で categoryId:null の prepend を確定すること', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(tree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragEnd(gapEvent(theme, 4, 0, null)));
    expect(result.current.provisionalRow).toMatchObject({
      gapIndex: 4,
      boundaryPrependCategoryId: null,
    });
    expect(result.current.promoteDraft?.target).toEqual({
      parentTaskId: null,
      afterTaskId: null,
      categoryId: null,
    });
  });
});

describe('useChatPromotion — 空チャネル（新規チャネル）への昇格 (rete-desk-0172)', () => {
  const emptyTree: DeskTaskTree = { categories: [] };

  it('空チャネルの gap 上で indicator（gapIndex 0 / depth 0）をセットすること', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(emptyTree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragStart(dragStart()));
    act(() => result.current.onDragMove(gapEvent(theme, 0)));
    expect(result.current.indicator).toMatchObject({ gapIndex: 0, depth: 0 });
  });

  it('空チャネルへのドロップで未分類（categoryId null）トップレベルへ昇格できること', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(emptyTree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragEnd(gapEvent(theme, 0)));
    expect(result.current.promoteDraft?.target).toMatchObject({
      parentTaskId: null,
      afterTaskId: null,
      categoryId: null,
    });
    expect(result.current.provisionalRow).toMatchObject({ gapIndex: 0, depth: 0 });
  });

  it('空チャネルでも over=null（ツリー外）のドロップは昇格を起こさないこと', () => {
    const { result } = renderHook(() =>
      useChatPromotion({ rows: rowsOf(emptyTree), refetchTree: vi.fn() }),
    );
    act(() => result.current.onDragEnd(gapEvent(theme, null)));
    expect(result.current.promoteDraft).toBeNull();
  });
});
