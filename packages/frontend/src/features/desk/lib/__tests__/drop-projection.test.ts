import { describe, it, expect } from 'vitest';
import { TaskStatus } from '@rete/shared';
import type { DeskTaskTree, DeskTaskNode } from '../api';
import {
  flattenTree,
  findTaskNode,
  projectDrop,
  subtreeDepthOf,
  MAX_TREE_DEPTH,
  type FlatRow,
} from '../drop-projection';

// ---- ツリー組み立てヘルパ ----
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

/**
 * カテゴリ 1 のツリー:
 *   #1 親A (depth0)
 *     #2 子A1 (depth1)
 *       #3 孫A1a (depth2)
 *     #4 子A2 (depth1)
 *   #5 親B (depth0)
 * カテゴリ 2:
 *   #6 親C (depth0)
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
  ],
};

const INDENT = 24; // 1 インデント幅(px)。テストではこの値で量子化を駆動する。

describe('flattenTree', () => {
  it('深さ優先で全行を depth 付きで平坦化すること', () => {
    const rows = flattenTree(tree);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0, 0]);
    expect(rows.map((r) => r.categoryId)).toEqual([1, 1, 1, 1, 1, 2]);
  });

  it('各行に parentTaskId を保持すること', () => {
    const rows = flattenTree(tree);
    const byId = (id: number) => rows.find((r) => r.id === id)!;
    expect(byId(1).parentTaskId).toBeNull();
    expect(byId(3).parentTaskId).toBe(2);
    expect(byId(4).parentTaskId).toBe(1);
  });
});

describe('findTaskNode（dsk-0219 詳細オープンの種）', () => {
  it('トップ階層・子・孫いずれの id でも完全な Task ノードを返すこと', () => {
    expect(findTaskNode(tree, 5)?.title).toBe('親B');
    expect(findTaskNode(tree, 4)?.title).toBe('子A2');
    expect(findTaskNode(tree, 3)?.title).toBe('孫A1a');
    expect(findTaskNode(tree, 6)?.categoryId).toBe(2);
  });
  it('存在しない id / null tree は null を返すこと', () => {
    expect(findTaskNode(tree, 999)).toBeNull();
    expect(findTaskNode(null, 1)).toBeNull();
  });
});

describe('subtreeDepthOf', () => {
  it('葉ノードは 0 を返すこと', () => {
    expect(subtreeDepthOf(flattenTree(tree), 3)).toBe(0);
    expect(subtreeDepthOf(flattenTree(tree), 5)).toBe(0);
  });
  it('子孫を持つノードは自身からの最大深さを返すこと', () => {
    // #1 親A 配下は #1->#2->#3 で深さ 2。
    expect(subtreeDepthOf(flattenTree(tree), 1)).toBe(2);
    // #2 子A1 配下は #2->#3 で深さ 1。
    expect(subtreeDepthOf(flattenTree(tree), 2)).toBe(1);
  });
});

describe('projectDrop — depth クランプ（昇格: subtreeDepth=0）', () => {
  const rows = flattenTree(tree);
  // 行 index 0(#1) と 1(#2) の間の gap = gapIndex 1。prev=#1(depth0) next=#2(depth1)。
  // maxDepth = prev.depth+1 = 1, minDepth = next.depth = 1 → 1 に固定。
  it('prev=#1 / next=#2 の gap は depth1 に固定される', () => {
    const p = projectDrop({ rows, gapIndex: 1, offsetX: 0, indentWidth: INDENT, subtreeDepth: 0 });
    expect(p?.depth).toBe(1);
  });

  // gapIndex 3 = #3 と #4 の間。prev=#3(depth2) next=#4(depth1)。
  // maxDepth = 3, minDepth = 1。offsetX で 1..3 を選べる。
  it('横位置が深いほど depth が増え maxDepth=prev.depth+1 でクランプされる', () => {
    // base = prev.depth = 2。offsetX を 1 インデント幅で量子化して 2 ± n。
    const arg = { rows, gapIndex: 3, indentWidth: INDENT, subtreeDepth: 0 };
    expect(projectDrop({ ...arg, offsetX: -100 })?.depth).toBe(1); // minDepth クランプ
    expect(projectDrop({ ...arg, offsetX: 0 })?.depth).toBe(2); // base
    expect(projectDrop({ ...arg, offsetX: INDENT * 5 })?.depth).toBe(3); // maxDepth クランプ
  });

  it('末尾 gap（next=なし）は minDepth=0 まで戻れる', () => {
    // 末尾 = 全行の後ろ。prev=#6(depth0)。maxDepth=1 minDepth=0。
    const lastGap = rows.length;
    expect(
      projectDrop({ rows, gapIndex: lastGap, offsetX: -100, indentWidth: INDENT, subtreeDepth: 0 })
        ?.depth,
    ).toBe(0);
    expect(
      projectDrop({
        rows,
        gapIndex: lastGap,
        offsetX: INDENT * 2,
        indentWidth: INDENT,
        subtreeDepth: 0,
      })?.depth,
    ).toBe(1);
  });

  it('先頭 gap（prev=なし）は depth0 固定（トップレベル先頭）', () => {
    const p = projectDrop({
      rows,
      gapIndex: 0,
      offsetX: INDENT * 3,
      indentWidth: INDENT,
      subtreeDepth: 0,
    });
    expect(p?.depth).toBe(0);
  });
});

describe('projectDrop — DropTarget 解決', () => {
  const rows = flattenTree(tree);

  it('depth=prev.depth+1 は prev の子（parentTaskId=prev, afterTaskId=null）', () => {
    // gapIndex 1: prev=#1。depth1 = #1 の子先頭。
    const p = projectDrop({ rows, gapIndex: 1, offsetX: 0, indentWidth: INDENT, subtreeDepth: 0 });
    expect(p?.target).toMatchObject({ parentTaskId: 1, afterTaskId: null, categoryId: 1 });
  });

  it('depth=prev.depth は prev の兄弟（afterTaskId=prev）', () => {
    // gapIndex 5: #5 と #6 の間。prev=#5(depth0) next=#6(depth0, cat2)。
    // depth0 = #5 の兄弟、afterTaskId=#5。
    const p = projectDrop({ rows, gapIndex: 5, offsetX: 0, indentWidth: INDENT, subtreeDepth: 0 });
    expect(p?.target).toMatchObject({ parentTaskId: null, afterTaskId: 5, categoryId: 1 });
  });

  it('depth が prev より浅い時は対応する祖先の兄弟になる', () => {
    // gapIndex 3: #3(depth2) と #4(depth1) の間。depth1 を選ぶと #3 の祖先 #2 の兄弟、afterTaskId は #2 の子サブツリー末尾の #3。
    // → parentTaskId=#1(=#2 の親), afterTaskId=#2 の末尾子孫 #3。
    const p = projectDrop({
      rows,
      gapIndex: 3,
      offsetX: INDENT * 0.0,
      indentWidth: INDENT,
      subtreeDepth: 0,
    });
    // depth1 を明示選択
    const p1 = projectDrop({
      rows,
      gapIndex: 3,
      offsetX: -100,
      indentWidth: INDENT,
      subtreeDepth: 0,
    });
    expect(p1?.depth).toBe(1);
    expect(p1?.target.parentTaskId).toBe(1);
    expect(p1?.target.categoryId).toBe(1);
    expect(p).toBeTruthy();
  });

  it('別カテゴリの gap は categoryId が移動先カテゴリになる', () => {
    // gapIndex 6 = 末尾(=#6 の後ろ)。prev=#6(cat2)。depth0 sibling → categoryId=2。
    const p = projectDrop({ rows, gapIndex: 6, offsetX: 0, indentWidth: INDENT, subtreeDepth: 0 });
    expect(p?.target.categoryId).toBe(2);
    expect(p?.target.afterTaskId).toBe(6);
  });

  it('未分類バケット（categoryId=null）の gap は categoryId=null を返す（rete-desk-0158）', () => {
    // 未分類バケットの行のみで構成した flat rows。末尾 gap に落とすと未分類のまま（null）になる。
    const unassignedRows: FlatRow[] = [
      { id: 9, depth: 0, categoryId: null, parentTaskId: null, childCount: 0 },
    ];
    const p = projectDrop({
      rows: unassignedRows,
      gapIndex: 1,
      offsetX: 0,
      indentWidth: INDENT,
      subtreeDepth: 0,
    });
    expect(p?.target.categoryId).toBeNull();
    expect(p?.target.afterTaskId).toBe(9);
  });
});

describe('projectDrop — 4 階層クランプ（移動: subtreeDepth>0）', () => {
  const rows = flattenTree(tree);

  it('subtreeDepth を加味して採用 depth + subtreeDepth <= MAX_TREE_DEPTH に制限', () => {
    // gapIndex 3: maxDepth(単独)=3。subtreeDepth=1 のサブツリーなら 3+1=4 > MAX(3) なので採用 depth は 2 まで。
    const p = projectDrop({
      rows,
      gapIndex: 3,
      offsetX: INDENT * 5,
      indentWidth: INDENT,
      subtreeDepth: 1,
    });
    expect(p?.depth).toBe(2);
  });

  it('クランプしても depth が minDepth を下回るならドロップ不可(null)', () => {
    // minDepth=1 の gap で subtreeDepth=3 → 許容 depth=0 だが minDepth=1 を満たせない → null。
    const p = projectDrop({ rows, gapIndex: 1, offsetX: 0, indentWidth: INDENT, subtreeDepth: 3 });
    expect(p).toBeNull();
  });
});

describe('projectDrop — 自己子孫拒否', () => {
  const rows = flattenTree(tree);

  it('ドラッグ中サブツリー内部の gap は null（落とせない）', () => {
    // #1 をドラッグ中（excludeIds = #1 とその子孫 #2 #3 #4）。
    // gapIndex 2 = #2 と #3 の間 = サブツリー内部 → null。
    const exclude = new Set([1, 2, 3, 4]);
    const p = projectDrop({
      rows,
      gapIndex: 2,
      offsetX: 0,
      indentWidth: INDENT,
      subtreeDepth: 2,
      excludeIds: exclude,
    });
    expect(p).toBeNull();
  });

  it('ドラッグ中サブツリー直後の gap は許容（自分の末尾の後ろ）', () => {
    // #1 ドラッグ中、gapIndex 4 = #4(サブツリー末尾) と #5 の間。
    // prev は除外対象だが gap 自体はサブツリー外との境界 → 許容。
    const exclude = new Set([1, 2, 3, 4]);
    const p = projectDrop({
      rows,
      gapIndex: 4,
      offsetX: -100,
      indentWidth: INDENT,
      subtreeDepth: 2,
      excludeIds: exclude,
    });
    expect(p).toBeTruthy();
  });

  it('excludeIds の行を prev/next 計算からスキップすること', () => {
    // #1 ドラッグ中、gapIndex 0(先頭)に落とすと next は除外をスキップして #5 になる。
    const exclude = new Set([1, 2, 3, 4]);
    const p = projectDrop({
      rows,
      gapIndex: 0,
      offsetX: 0,
      indentWidth: INDENT,
      subtreeDepth: 2,
      excludeIds: exclude,
    });
    expect(p?.target).toMatchObject({ parentTaskId: null, afterTaskId: null, categoryId: 1 });
  });

  it('全行が除外（ドラッグ中サブツリー＝ツリー全体）の先頭 gap は落とせない（null / 指摘[8]）', () => {
    // 単一カテゴリ・単一ルート #1 とその全子孫のみのツリー。#1 をドラッグ＝全行 exclude。
    // 先頭 gap には実在 prev/next が無く firstReal=null。誤カテゴリ（ハードコード 1）を送らず null を返す。
    const soloTree: DeskTaskTree = {
      categories: [
        {
          id: 7,
          name: 'C7',
          sortOrder: 0,
          tasks: [
            node({
              id: 1,
              title: '親A',
              categoryId: 7,
              children: [node({ id: 2, title: '子A1', parentTaskId: 1, categoryId: 7 })],
            }),
          ],
        },
      ],
    };
    const soloRows = flattenTree(soloTree);
    const exclude = new Set([1, 2]);
    const p = projectDrop({
      rows: soloRows,
      gapIndex: 0,
      offsetX: 0,
      indentWidth: INDENT,
      subtreeDepth: 1,
      excludeIds: exclude,
    });
    expect(p).toBeNull();
  });
});

describe('projectDrop — 分類境界 gap の prepend ヒント（dsk-0256）', () => {
  const rows = flattenTree(tree);
  // gapIndex 5 = #5(親B, cat1 末尾) と #6(親C, cat2 先頭) の間。boundaryPrependCategoryId 無指定時は
  // 従来どおり「cat1 の末尾（#5 の兄弟）」に解決される（CategoryAppendZone 側・上の既存テストで確認済）。

  it('boundaryPrependCategoryId 指定 かつ depth=minDepth なら次カテゴリの先頭へ明示的に解決する', () => {
    const p = projectDrop({
      rows,
      gapIndex: 5,
      offsetX: 0,
      indentWidth: INDENT,
      subtreeDepth: 0,
      boundaryPrependCategoryId: 2,
    });
    expect(p?.depth).toBe(0);
    expect(p?.target).toMatchObject({ parentTaskId: null, afterTaskId: null, categoryId: 2 });
  });

  it('boundaryPrependCategoryId=null（未分類バケット prepend）も categoryId=null で解決する', () => {
    const p = projectDrop({
      rows,
      gapIndex: 5,
      offsetX: 0,
      indentWidth: INDENT,
      subtreeDepth: 0,
      boundaryPrependCategoryId: null,
    });
    expect(p?.target).toMatchObject({ parentTaskId: null, afterTaskId: null, categoryId: null });
  });

  it('boundaryPrependCategoryId 指定でも depth を右へずらせば従来どおり prev の子として解決する', () => {
    // offsetX を大きく振って depth=prev.depth+1(=1) を選ばせると、prepend ヒントより
    // resolveTarget（#5 の子）が優先される（右へずらす=明示的に「前カテゴリの子にする」意図）。
    const p = projectDrop({
      rows,
      gapIndex: 5,
      offsetX: INDENT * 5,
      indentWidth: INDENT,
      subtreeDepth: 0,
      boundaryPrependCategoryId: 2,
    });
    expect(p?.depth).toBe(1);
    expect(p?.target).toMatchObject({ parentTaskId: 5, afterTaskId: null, categoryId: 1 });
  });
});

describe('MAX_TREE_DEPTH', () => {
  it('0-indexed の最大深さは 3（=4 階層）', () => {
    expect(MAX_TREE_DEPTH).toBe(3);
  });
});

// FlatRow 型が公開されていること（型のみの assertion）。
describe('FlatRow 型', () => {
  it('id/depth/categoryId/parentTaskId を持つ', () => {
    const r: FlatRow = { id: 1, depth: 0, categoryId: 1, parentTaskId: null, childCount: 0 };
    expect(r.id).toBe(1);
  });
});
