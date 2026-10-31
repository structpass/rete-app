'use client';

import { useMemo, useState } from 'react';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';
import { ChevronDown, ListTree } from 'lucide-react';
import { TaskStatus } from '@rete/shared';
import { cn, formatDate } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { taskStatusLabel } from '@/features/tasks/lib/status';
import type { Category } from '@/features/tasks/lib/api';
import type { DeskTaskTree, DeskTaskNode } from '../lib/api';
import { applyQuietFocus } from '../utils/quiet-focus';
import type { DropIndicator, ProvisionalRow } from '../hooks/use-chat-promotion';
import { type TaskMoveData, type TaskGapData } from '../lib/drop-projection';
import { buildDeskTreeRows } from '../lib/desk-tree-rows';
import { MentionIcon, TenmatsuIcon } from './desk-status-icons';
import { shouldHideGroupHead } from '../hooks/use-desk-search';
import { highlightMatches } from '@/lib/highlight';

/** TaskStatus → mock の .desk-task-status.status-* バリアントクラス。ラベルは taskStatusLabel を流用。 */
const STATUS_VARIANT_CLASS: Record<TaskStatus, string> = {
  [TaskStatus.TODO]: 'status-todo',
  [TaskStatus.IN_PROGRESS]: 'status-doing',
  [TaskStatus.IN_REVIEW]: 'status-review',
  [TaskStatus.DONE]: 'status-done',
};

/** 既知ステータスは status-* バリアントへ、未知値は todo にフォールバック（防御的）。 */
function statusVariantClass(status: string): string {
  return STATUS_VARIANT_CLASS[status as TaskStatus] ?? 'status-todo';
}

/**
 * 緑枠ドロップインジケータの左位置（rete-desk-0079）。タスク行はタイトル列のみを段付けする
 * （checkbox / # 列は全 depth で固定）ため、インジケータも「タイトル列起点 + depth × タイトル
 * インデント幅」に合わせ、落ちる先の明細タイトル位置に重なるようにする。
 * - DROP_BOX_BASE_REM: 行 padding(0.5) + checkbox(1.25) + gap(0.25) + #(3) + gap(0.25) = 5.25rem
 *   （.desk-task-row の grid-template-columns / column-gap と一致）
 * - DROP_BOX_INDENT_REM: .desk-task-row.is-indent-N .desk-task-title の padding-left/level = 0.625rem
 * 注: 量子化用の INDENT_WIDTH(=24px) は projection の depth 判定しきい値であり、描画位置とは別概念。
 */
const DROP_BOX_BASE_REM = 5.25;
const DROP_BOX_INDENT_REM = 0.625;
function dropBoxMarginLeft(depth: number): string {
  // CSS の is-indent-N は depth 3 以上を is-indent-4(=3×0.625rem) にクランプするため、
  // インジケータのインデント量も同じく depth 3 で頭打ちにして一致させる。
  const clamped = Math.min(Math.max(depth, 0), 3);
  return `${DROP_BOX_BASE_REM + clamped * DROP_BOX_INDENT_REM}rem`;
}

/** depth(0..) → mock の .is-indent-N クラス。depth 0 は無印（トップレベル）。 */
function indentClass(depth: number): string | undefined {
  if (depth <= 0) return undefined;
  // depth 1 → is-indent-2, 2 → is-indent-3, 3+ → is-indent-4（CSS は 2..4 のみ定義）
  return `is-indent-${Math.min(depth + 1, 4)}`;
}

interface TaskTreeProps {
  tree: DeskTaskTree | null;
  loading: boolean;
  error: string | null;
  selectedId: number | null;
  /** アクティブ枠（.sp-row-ring）用の「最後に開いた」タスク id（dsk-0401）。selectedId（開閉状態
   *  そのもの）と違い、詳細を閉じても null に戻らないため枠が残り続ける。未指定時は selectedId を使う
   *  （呼び出し元が持たない旧経路・テストとの後方互換）。 */
  activeId?: number | null;
  onSelect: (id: number) => void;
  categories?: Category[];
  isDragActive?: boolean;
  /** タスク行を draggable 化（移動 D&D を有効化）。 */
  draggableTasks?: boolean;
  /** 昇格 / 移動 共通の緑枠インジケータ（行間 gap + 採用 depth）。 */
  dropIndicator?: DropIndicator | null;
  /** 昇格の楽観仮挿入行（gap 位置 + depth に描く）。 */
  provisionalRow?: ProvisionalRow | null;
  /**
   * 統合検索の可視 task id 集合（C-検索）。null = ツリー未取得。集合外の行は is-hidden で隠す。
   * 既定ビューでも完了（DONE）除外のため集合は常に非 null（rete-desk-0056）。full tree を保持したまま
   * 隠すことで D&D の gap index（full tree の flatten 前提）を壊さない。
   */
  visibleTaskIds?: Set<number> | null;
  /**
   * タスク明細が「明示フィルタ中」か（既定の完了除外は数えない / rete-desk-0056・0057）。
   * true のときだけ可視0グループの見出し・空カテゴリ落とし先を畳む。既定ビューでは全カテゴリを
   * 落とし先として残す（D&D 昇格先を失わせない）。
   */
  taskFiltered?: boolean;
  /** 統合検索のタスクキーワード（検索ハイライト用 / cmn-0092）。空/未指定はハイライトなし。 */
  taskKeyword?: string;
}

/** ツリー全行を表示順に平坦化した描画モデル（gap index と node を保持）。 */
interface RenderRow {
  node: DeskTaskNode;
  depth: number;
  // 所属分類 ID。null = 未分類バケット（rete-desk-0158）。
  categoryId: number | null;
  /** 表示順（buildDeskTreeRows）と一致するグローバル行 index（= この行の直前 gap index）。 */
  index: number;
}

/** 行と行の間の gap droppable。緑枠インジケータ / 仮挿入行をこの位置に重ねる。 */
function GapDropZone({
  gapIndex,
  indicator,
  provisional,
  boundaryPrependCategoryId,
}: {
  gapIndex: number;
  indicator?: DropIndicator | null;
  provisional?: ProvisionalRow | null;
  /**
   * dsk-0256: 非先頭グループの先頭行 gap は、直前グループの appendGapIndex と同一 index で衝突する
   * 「分類境界 gap」。この gap は「次カテゴリの先頭へ prepend」を表す物理的に別のドロップゾーン
   * （分類ラベルと 1 行目の間）であり、prepend 先カテゴリ ID を渡すと TaskGapData に載せて
   * projectDrop へ透過する。indicator 側も「実際にこの境界ゾーンがホバーされたか」を
   * boundaryPrependCategoryId で運ぶため、CategoryAppendZone（同一 gapIndex の競合ゾーン）との
   * 二重シャドウは起きない（indicator の有無で排他判定）。未指定＝通常の行間 gap。
   */
  boundaryPrependCategoryId?: number | null;
}) {
  const id = `gap-${gapIndex}`;
  const isBoundary = boundaryPrependCategoryId !== undefined;
  const { setNodeRef } = useDroppable({
    id,
    data: { kind: 'task-gap', gapIndex, boundaryPrependCategoryId } satisfies TaskGapData,
  });
  // showBox は「今まさにホバー中」の indicator、ghost は「ドロップ確定後」の provisional で
  // それぞれ別の boundary フラグを見る（onDragEnd で indicator は null に落ちるため使い回せない）。
  const showBox =
    indicator?.gapIndex === gapIndex &&
    (indicator?.boundaryPrependCategoryId !== undefined) === isBoundary;
  const ghost =
    provisional?.gapIndex === gapIndex &&
    (provisional?.boundaryPrependCategoryId !== undefined) === isBoundary
      ? provisional
      : null;
  return (
    <div ref={setNodeRef} data-drop-id={id} className="desk-task-gap">
      {showBox && (
        <span
          data-drop-indicator="true"
          data-indicator-depth={indicator!.depth}
          className="desk-dnd-drop-box"
          style={{ marginLeft: dropBoxMarginLeft(indicator!.depth) }}
        />
      )}
      {ghost && <ProvisionalTaskRow title={ghost.title} depth={ghost.depth} />}
    </div>
  );
}

/** 仮挿入行（楽観 UI）。mock の .desk-task-row.is-pending + 「未保存」バッジ（.desk-pending-badge）。 */
function ProvisionalTaskRow({ title, depth }: { title: string; depth: number }) {
  return (
    <div
      data-provisional="true"
      data-depth={depth}
      className={cn('desk-task-row is-pending', indentClass(depth))}
    >
      <span className="desk-task-check" aria-hidden="true">
        <span className="desk-task-check-ghost" />
      </span>
      <span className="desk-task-id" />
      <span className="desk-task-title">
        {title}
        {/* 正本 comp-badge: 状態を表す小型ラベルは Badge の variant を選ぶ（四角・独自色を作らない）。
            「未保存」は注意喚起の一時状態なので既存の warning トーンを変えず、形だけ Badge へ寄せる。 */}
        <Badge variant="warning" className="desk-pending-badge">
          未保存
        </Badge>
      </span>
      <span className="desk-task-status status-todo" />
      <span className="desk-task-due" />
      <span className="desk-task-assignee" />
      <span aria-hidden="true" />
    </div>
  );
}

/** ツリー 1 行。draggableTasks 時は行を掴んで移動できる（サブツリーのルートをドラッグ対象に）。 */
function TaskRow({
  row,
  subtreeDepth,
  selectedId,
  activeId,
  onSelect,
  draggableTasks,
  hidden,
  stripe,
  taskKeyword,
}: {
  row: RenderRow;
  subtreeDepth: number;
  selectedId: number | null;
  activeId: number | null;
  onSelect: (id: number) => void;
  draggableTasks?: boolean;
  /** 統合検索で絞り込まれ非表示か（is-hidden = display:none）。 */
  hidden?: boolean;
  /** 明細の縞模様（mdl-0022）。可視行の偶数番目に true（親が可視行を数えて決める）。 */
  stripe?: boolean;
  /** 検索ハイライト対象キーワード（cmn-0092）。 */
  taskKeyword?: string;
}) {
  const { node, depth } = row;
  const isSelected = node.id === selectedId;
  const isActive = node.id === activeId;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `task-${node.id}`,
    data: { kind: 'task-move', taskId: node.id, subtreeDepth } satisfies TaskMoveData,
    disabled: !draggableTasks,
  });

  return (
    <button
      ref={draggableTasks ? setNodeRef : undefined}
      type="button"
      data-depth={depth}
      data-task-id={node.id}
      data-task-drag={draggableTasks ? node.id : undefined}
      onClick={(e) => {
        // dsk-0391: 選択中の行の再作動＝トグル閉じ。Space/Enter のキーボード作動時の
        // teal 枠残留を Esc 経路（desk-shell）と同じ目印で抑止する。
        if (isSelected) applyQuietFocus(e.currentTarget);
        onSelect(node.id);
      }}
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'desk-task-row',
        // mdl-0050: hover 帯スライドの対象行（内容の z-index 持ち上げも担う）。
        'sp-row-pillable',
        indentClass(depth),
        stripe && 'is-stripe',
        // mdl-0055: 選択行は teal 内枠線 1px（.sp-row-ring）。mdl-0050 の板ピル（拡大表現）は廃止。
        // dsk-0401: 枠は isSelected でなく isActive（最後に開いた行）で描く＝詳細を閉じても消えない。
        isActive && 'sp-row-ring',
        isDragging && 'is-dragging',
        draggableTasks && 'is-draggable',
        hidden && 'is-hidden',
      )}
      {...(draggableTasks ? attributes : {})}
      {...(draggableTasks ? listeners : {})}
    >
      {/* チェックボックスは見た目のみ（完了トグル = Phase C）。行が button のため本物の input は
          ネストできず、未チェック見た目の四角で再現する。 */}
      <span className="desk-task-check" aria-hidden="true">
        <span className="desk-task-check-ghost" />
      </span>
      <span className="desk-task-id">{node.id}</span>
      {/* sp-row-title: 選択行の拡大は mdl-0055 で廃止済み。共通クラスの目印としてのみ残す。 */}
      <span className="desk-task-title sp-row-title">
        {highlightMatches(node.title, taskKeyword)}
      </span>
      <span className={cn('desk-task-status', statusVariantClass(node.status))}>
        {taskStatusLabel(node.status)}
      </span>
      <span className="desk-task-due">{formatDate(node.dueDate)}</span>
      <span className="desk-task-assignee">{node.assigneeName ?? ''}</span>
      {/* 7 列目: 状況アイコン群（モック JS 準拠で 顛末 → メンション の順）。
          顛末は実データ（node.tenmatsu 非空）、メンションはサンプル値（sampleTaskMeta）の見た目シェル。 */}
      <TaskRowMeta taskId={node.id} tenmatsu={node.tenmatsu} />
    </button>
  );
}

/**
 * タスク明細行のメンションフラグ。
 *
 * ⚠ Phase C 配線までの「見た目シェル」用サンプル値。メンション・未読フィールドがまだ無いため
 * task id ハッシュから決定的に導くプレースホルダ（ADR 0013 の「データ無し→非表示」境界をレビュー用に
 * 緩める判断 / 開発統括承認 2026-06-02）。顛末は実データ（task.tenmatsu）で判定する。
 */
function sampleTaskMeta(id: number): { mention: boolean } {
  const h = (id * 2654435761) >>> 0;
  return { mention: h % 5 === 0 };
}

/** 7 列目セル（顛末 → メンション）。空のときも grid 列を保つため wrapper は常時描画する。
 *  顛末は task.tenmatsu の非空判定（空白のみは未記録扱い）、メンションはサンプル値。 */
function TaskRowMeta({ taskId, tenmatsu }: { taskId: number; tenmatsu: string | null }) {
  const meta = sampleTaskMeta(taskId);
  const hasTenmatsu = tenmatsu != null && tenmatsu.trim() !== '';
  return (
    <span className="desk-task-meta">
      {hasTenmatsu && (
        <span className="desk-thread-tenmatsu" title="顛末あり" aria-label="顛末あり">
          <TenmatsuIcon />
        </span>
      )}
      {meta.mention && (
        <span className="desk-thread-count is-mention" aria-label="自分宛メンションあり">
          <MentionIcon />
        </span>
      )}
    </span>
  );
}

/**
 * タスク明細（右ペイン常時 / data-right-view="tree"）。
 * カテゴリ別グループ + parentTaskId による親子インデントのツリー。行クリックでタスク詳細を開く。
 * D&D は「全行間 gap droppable + 緑枠インジケータ」に一本化（昇格・移動 共通）。行被りの子化ゾーンは廃止。
 */
export function TaskTree({
  tree,
  categories,
  isDragActive,
  loading,
  error,
  selectedId,
  activeId = selectedId,
  onSelect,
  draggableTasks,
  dropIndicator,
  provisionalRow,
  visibleTaskIds,
  taskFiltered,
  taskKeyword,
}: TaskTreeProps) {
  // グループ折り畳み（rete-desk-0081 アコーディオン）。見出しクリックで当該カテゴリの行を畳む。
  // 永続化要件は無いためコンポーネントローカル state（refetch では再マウントされず維持される）。
  // 折り畳みキーは分類 id（number）または未分類バケット（null / rete-desk-0158）。
  const [collapsed, setCollapsed] = useState<Set<number | null>>(new Set());
  // mdl-0050: 明細行 hover は単一の薄グレー帯（.sp-row-hoverband）のスライド追従。グループ見出しも
  // 帯対象行に含める（sp-row-pillable）。early return より前に呼ぶ（hooks 規則）。
  const { listRef, onMouseOver, onMouseLeave, bandStyle } =
    useRowHoverBand<HTMLDivElement>('.sp-row-pillable');
  const toggleCollapse = (id: number | null) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 表示行（グループ・行 index・サブツリー最大深さ）は tree / categories の更新時に1回だけ導出する
  // （dsk-0332: 全行ぶんの subtreeDepthOf と先頭探索をやめ、D&D projection と同じ派生値を共有する）。
  // early return より前に置き、hook の呼出し順を分岐で変えない。
  const treeRows = useMemo(() => buildDeskTreeRows(tree, categories), [tree, categories]);
  const groups = treeRows.groups;

  if (loading) {
    return (
      <div data-right-view="tree" className="flex flex-1 items-center justify-center">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-right-view="tree"
        className="flex flex-1 items-center justify-center p-4 text-sm text-[var(--sp-accent-red)]"
      >
        {error}
      </div>
    );
  }

  // rete-desk-0171: 分類は「所属タスクがある時だけ」描く（追加直後の空分類は出さない）。空チャネルの
  // 落とし先は空カテゴリ見出しではなく、groups 空時の単一ドロップゾーン（EmptyTreeDropZone）が担う。
  // 未分類バケット（id===null / rete-desk-0158）は権威リストに無いため tree 側から拾って末尾に足す。
  // この正規化は buildDeskTreeRows（表示行の正本）が担う（dsk-0332）。

  // rete-desk-0162: 明示フィルタ中（taskFiltered）で可視タスクが 0 件なら、空白ではなく不一致ラベルを出す。
  // 検索は full tree を is-hidden で隠す方式（D&D gap index 維持）のため groups.length は 0 にならず、
  // この経路（可視 0）でしか「検索ヒットなし」を捉えられない（チャット明細 ChatListBody の isFiltered と同方針）。
  // ツリーは unmount せず（is-hidden 行を保持＝D&D gap index 維持）、本文にメッセージを重ねるだけにする。
  const filteredEmpty = !!taskFiltered && visibleTaskIds != null && visibleTaskIds.size === 0;

  if (groups.length === 0) {
    // rete-desk-0171/0172: 空分類を描かない代わりに、空チャネル（新規チャネル）でも昇格 D&D を
    // 受けられる単一ドロップゾーンを敷く。落とし先は未分類トップレベル（hook 側で解決）。
    return (
      <div data-right-view="tree" className="flex min-h-0 flex-1 flex-col">
        <EmptyTreeDropZone
          isDragActive={isDragActive}
          indicator={dropIndicator}
          provisional={provisionalRow}
        />
      </div>
    );
  }

  // 各 group の描画行（RenderRow）を組み立てる。行 index は treeRows（表示順の索引）から引き、
  // gap index の整合性のため D&D projection と SSOT を共有する。
  // append gap index は非空カテゴリは「最終行 index + 1」（= 末尾 gap）。空カテゴリは行が無く
  // 同一値（旧実装は一律 flatRows.length）になり droppable が競合するため、実 gap 域（0..rows.length）
  // と重ならない rows.length 超の固有スロットを空カテゴリごとに連番で割り当てる（指摘[9]）。
  // gapIndex >= rows.length は projectDrop 上どれも「末尾 append」と解釈されるため、固有化しても
  // ドロップ先解決の挙動は変わらず、競合だけが解消される。
  let emptySlot = 0;
  const groupRows = groups.map((group) => {
    const rows: RenderRow[] = [];
    const pushNode = (node: DeskTaskNode, depth: number) => {
      rows.push({
        node,
        depth,
        categoryId: group.id,
        index: treeRows.indexOfId.get(node.id) ?? 0,
      });
      node.children.forEach((c) => pushNode(c, depth + 1));
    };
    group.tasks.forEach((t) => pushNode(t, 0));
    const appendGapIndex =
      rows.length > 0 ? rows[rows.length - 1].index + 1 : treeRows.rows.length + emptySlot;
    if (rows.length === 0) emptySlot += 1;
    return { group, rows, appendGapIndex };
  });

  // 明細の縞模様（mdl-0022）: グループ見出し・折りたたみ/絞り込みの is-hidden 行が混在し
  // :nth-child が使えないため、可視行をグループ跨ぎで連番カウントし偶数行（2,4,…行目）へ
  // is-stripe を付与する。判定は下の描画側 groupHidden / rowHidden と同一ロジック。
  const stripeIds = new Set<number>();
  let visibleRowCount = 0;
  for (const { group, rows } of groupRows) {
    if (!!taskFiltered && shouldHideGroupHead(group.tasks, visibleTaskIds ?? null)) continue;
    const groupCollapsed = collapsed.has(group.id);
    for (const row of rows) {
      if (groupCollapsed || (visibleTaskIds != null && !visibleTaskIds.has(row.node.id))) continue;
      visibleRowCount += 1;
      if (visibleRowCount % 2 === 0) stripeIds.add(row.node.id);
    }
  }

  return (
    <div data-right-view="tree" className="flex min-h-0 flex-1 flex-col">
      <div className="desk-task-tree-head" aria-hidden="true">
        <span />
        <span>#</span>
        <span>タイトル</span>
        <span>ステータス</span>
        <span>期日</span>
        <span>担当者</span>
        <span>状況</span>
      </div>
      <div
        ref={listRef}
        className="desk-pane-body relative"
        onMouseOver={onMouseOver}
        onMouseLeave={onMouseLeave}
      >
        {/* rete-desk-0162: 絞り込み結果 0 件のヒットなしラベル。ツリー（全行 is-hidden）は下に残したまま
            重ねるだけ＝D&D gap index を壊さない。可視行があるときは出さない。 */}
        {filteredEmpty && (
          // rete-desk-0206: チャット明細の空状態（縦横中央 / text-sm / 通常太さ / 末尾「。」）に合わせる。
          // ツリーは is-hidden で下に残置するため、絶対配置でペイン中央へ重ね、pointer-events-none で
          // D&D の落とし先（gap index）を塞がない。
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center text-[var(--sp-text-warm-mute)]">
            {/* rete-desk-0162: アイコンは不要（開発統括指示）。テキストのみで「該当なし」を示す。 */}
            <p className="text-sm">条件に一致するタスクがありません。</p>
          </div>
        )}
        <div className="desk-task-tree">
          {groupRows.map(({ group, rows, appendGapIndex }, groupIdx) => {
            const appendId = `cat-${group.id}-append`;
            // dsk-0237: 非空カテゴリの append gapIndex は次グループ先頭行の gapIndex と衝突する（flatten 連番）。
            // 分類末尾 append（CategoryAppendZone）と、次カテゴリ先頭への prepend（境界 GapDropZone）は
            // 物理的に別のドロップゾーン（前者は次分類の見出しより上・後者は見出しと1行目の間）なので、
            // dsk-0256 で gap データに boundaryPrependCategoryId を持たせて projectDrop の落とし先解決を
            // 明示的に分岐させ、indicator/provisional 側もこのフラグで排他表示する（二重シャドウ防止）。
            // 空カテゴリは groups 段階で除外済（rete-desk-0171）のため、ここに来る group は必ず非空。
            // rete-desk-0037・0056: 明示フィルタ中（taskFiltered）かつ可視0のグループは見出しを隠す。
            // 既定ビュー（完了除外のみ）では畳まず、空カテゴリ見出しも残す（空ツリーへの初回昇格先 /
            // D&D 落とし先を失わせないため）。visibleTaskIds は既定でも非 null なので gate は taskFiltered。
            const hideHead =
              !!taskFiltered && shouldHideGroupHead(group.tasks, visibleTaskIds ?? null);
            // rete-desk-0055: 絞り込みで可視行が 0 になったグループは見出しも append ゾーンも
            // 残さず、グループ全体を畳む（display:none）。append ゾーンの min-height や group margin が
            // 残余余白として積み上がり、可視行が下にずれる（上に詰められない）のを解消する。
            const groupHidden = hideHead;
            const isCollapsed = collapsed.has(group.id);
            return (
              <div key={group.id} className={cn('desk-task-group', groupHidden && 'is-hidden')}>
                {!hideHead && (
                  <button
                    type="button"
                    className={cn(
                      'desk-task-group-head',
                      'sp-row-pillable',
                      isCollapsed && 'is-collapsed',
                    )}
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleCollapse(group.id)}
                  >
                    <ChevronDown aria-hidden="true" className="desk-task-group-chevron h-3 w-3" />
                    {/* mdl-0050: 生テキストは .sp-row-pillable > * の z-index 持ち上げが効かないため span で包む。 */}
                    <span>{group.name}</span>
                  </button>
                )}
                {rows.map((row, rowIdx) => {
                  // 行ボタンのみ is-hidden（display:none）で隠し、GapDropZone（D&D droppable）は
                  // DOM に残す。折り畳み / 絞り込み中もドロップ先を失わせない（既存の絞り込みと同方式）。
                  // 隠れた行の gap は高さ 0 のため残余余白は出ない（残余は groupHidden 側で解消）。
                  const rowHidden =
                    isCollapsed || (visibleTaskIds != null && !visibleTaskIds.has(row.node.id));
                  // dsk-0237/dsk-0256: 非先頭グループの先頭行 gap は直前グループの appendGapIndex と
                  // 衝突する境界 gap。「次カテゴリの先頭へ prepend」の物理ゾーンとして group.id を
                  // boundaryPrependCategoryId に渡す（下記 GapDropZone）。
                  const isBoundaryGap = groupIdx > 0 && rowIdx === 0;
                  return (
                    // mdl-0050: この wrapper に position:relative を付けない（付けると行の offsetParent が
                    // wrapper になり、hover 帯の測位（desk-pane-body 基準）が壊れる）。gap 内の緑枠 /
                    // 仮挿入行は .desk-task-gap 自身の position:relative が受ける。
                    <div key={row.node.id}>
                      {/* 行の直前 gap（緑枠 / 仮挿入行をここに重ねる）。 */}
                      <GapDropZone
                        gapIndex={row.index}
                        indicator={dropIndicator}
                        provisional={provisionalRow}
                        boundaryPrependCategoryId={isBoundaryGap ? group.id : undefined}
                      />
                      <TaskRow
                        row={row}
                        subtreeDepth={treeRows.subtreeDepthOfId.get(row.node.id) ?? 0}
                        selectedId={selectedId}
                        activeId={activeId}
                        onSelect={onSelect}
                        draggableTasks={draggableTasks}
                        hidden={rowHidden}
                        stripe={stripeIds.has(row.node.id)}
                        taskKeyword={taskKeyword}
                      />
                    </div>
                  );
                })}
                {/* カテゴリ末尾 gap = append ドロップゾーン（トップレベル末尾 / 空カテゴリの落とし先）。
                    折り畳み中も droppable は残す（D&D の落とし先を失わせない）。
                    dsk-0237: 分類末尾の箱描画権は常にここが持つ（次グループ先頭行の境界 gap とは
                    dsk-0256 の boundaryPrependCategoryId 排他判定で衝突を回避）。 */}
                <CategoryAppendZone
                  appendId={appendId}
                  gapIndex={appendGapIndex}
                  indicator={dropIndicator}
                  provisional={provisionalRow}
                />
              </div>
            );
          })}
        </div>
        {/* hover 帯（装飾専用）。行の下・コンテナ末尾に置き、bandStyle 非 null の時だけ描く
            （dsk-0395: mdl-0050 の下準備だけ入りこの1行が落ちていた。chat-list と逐語同一）。 */}
        {bandStyle ? <div aria-hidden className="sp-row-hoverband" style={bandStyle} /> : null}
      </div>
    </div>
  );
}

/**
 * 空チャネル（タスク 0 件）の単一ドロップゾーン（rete-desk-0172）。新規チャネルでもチャット→タスクの
 * 昇格 D&D を受けられるよう、空状態自体を droppable（gapIndex 0）にする。落とし先＝未分類トップレベルは
 * use-chat-promotion 側が「行が無い時は categoryId=null」で解決する。緑枠は 1 個だけ描く（0173）。
 */
function EmptyTreeDropZone({
  isDragActive,
  indicator,
  provisional,
}: {
  isDragActive?: boolean;
  indicator?: DropIndicator | null;
  provisional?: ProvisionalRow | null;
}) {
  const { setNodeRef } = useDroppable({
    id: 'empty-tree-drop',
    data: { kind: 'task-gap', gapIndex: 0 } satisfies TaskGapData,
  });
  const showBox = indicator?.gapIndex === 0;
  const ghost = provisional?.gapIndex === 0 ? provisional : null;
  return (
    <div
      ref={setNodeRef}
      data-drop-id="empty-tree-drop"
      data-gap-index={0}
      className={cn(
        'desk-empty-tree-drop flex flex-1 flex-col items-center justify-center p-6 text-center text-[var(--sp-text-warm-mute)] transition-colors',
        isDragActive && 'is-drag-active',
      )}
    >
      <ListTree className="mb-3 h-8 w-8 text-[var(--sp-text-warm-mute)]" />
      <p className="text-sm font-medium">タスクがありません</p>
      {isDragActive && <p className="mt-1 text-xs opacity-80">ここにドロップしてタスク化</p>}
      {showBox && (
        <span
          data-drop-indicator="true"
          data-indicator-depth={indicator!.depth}
          className="desk-dnd-drop-box mt-3"
        />
      )}
      {ghost && <ProvisionalTaskRow title={ghost.title} depth={ghost.depth} />}
    </div>
  );
}

/**
 * カテゴリ末尾の append ドロップゾーン。gap droppable を兼ね、分類末尾（視覚的下端）のドロップ箱を
 * 常に描画する（dsk-0237 で導入・dsk-0256 で境界 gap と衝突する次グループ先頭行 GapDropZone との
 * 二重描画を boundaryPrependCategoryId の排他判定で防ぐ形へ更新）。空カテゴリは groups 段階で除外済
 * （rete-desk-0171）なのでここに来る group は常に非空。空ツリー自体への昇格は EmptyTreeDropZone が担う
 * （rete-desk-0172）。
 */
function CategoryAppendZone({
  appendId,
  gapIndex,
  indicator,
  provisional,
}: {
  appendId: string;
  gapIndex: number;
  indicator?: DropIndicator | null;
  provisional?: ProvisionalRow | null;
}) {
  // 末尾 gap も移動 / 昇格 projection が解決できるよう task-gap data を載せる（gapIndex は末尾位置）。
  const { setNodeRef } = useDroppable({
    id: appendId,
    data: { kind: 'task-gap', gapIndex } satisfies TaskGapData,
  });
  // dsk-0237/dsk-0256: 分類末尾の箱／仮挿入行はこのゾーンが描くが、gapIndex は次グループ先頭行の
  // 境界 GapDropZone と衝突する（flatten 連番）。境界ゾーンが実際にホバーされている（indicator/
  // provisional の boundaryPrependCategoryId が定義済み）時は「次カテゴリの先頭へ prepend」の意図
  // なので、こちら（末尾 append）は描かない（排他）。
  const showBox =
    indicator?.gapIndex === gapIndex && indicator?.boundaryPrependCategoryId === undefined;
  const ghost =
    provisional?.gapIndex === gapIndex && provisional?.boundaryPrependCategoryId === undefined
      ? provisional
      : null;
  return (
    <div
      ref={setNodeRef}
      data-drop-id={appendId}
      data-gap-index={gapIndex}
      className="desk-task-gap min-h-[0.75rem] transition-colors"
    >
      {showBox && (
        <span
          data-drop-indicator="true"
          data-indicator-depth={indicator!.depth}
          className="desk-dnd-drop-box"
          style={{ marginLeft: dropBoxMarginLeft(indicator!.depth) }}
        />
      )}
      {ghost && <ProvisionalTaskRow title={ghost.title} depth={ghost.depth} />}
    </div>
  );
}
