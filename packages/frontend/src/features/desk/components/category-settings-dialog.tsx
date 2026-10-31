'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveRestore, GripVertical, Pencil, Trash2, X } from 'lucide-react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Spinner } from '@/components/ui/spinner';
import {
  fetchCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  type Category,
} from '@/features/tasks/lib/api';
import { apiErrorMessage } from '../lib/api-error';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { OverlayDialog } from '@/components/ui/overlay-dialog';
import { useDeleteConfirm } from '@/hooks/use-delete-confirm';
import { useOptimisticReorder } from '@/hooks/use-optimistic-reorder';
import { useRowHoverBand } from '@/hooks/use-row-hover-band';

interface CategorySettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** 編集対象チャネル（Space）の id。null = 未選択（一覧を出さずガード / rete-desk-0158）。 */
  spaceId: string | null;
  /** 分類マスタを変更した後に呼ぶ（呼び出し側が分類一覧 + タスクツリーを取り直す）。 */
  onChanged: () => void;
}

/** 有効 / アーカイブの 2 タブ（rete-desk-0200）。 */
type CategoryTab = 'active' | 'archived';

/**
 * 分類設定画面（rete-desk-0140 / 本格化 = rete-desk-0197・0199・0200・0201・0202）。
 * タスク明細ツールバーの「分類設定」から開くモーダル。追加 / 名称変更 / 並び替え（D&D）/
 * アーカイブ・解除 / 削除を行う。削除は紐づくタスクがあると backend が 409 で拒否し、
 * その場合はアーカイブを案内する（アーカイブ済分類と所属タスクはツリー・一覧から非表示になる）。
 *
 * 一覧は [有効][アーカイブ] の 2 タブ（rete-desk-0200）× 表形式（rete-desk-0201・Desk チャット明細スタイル
 * = ヘッダ行あり / フッタなし / 外枠 + 行間横罫線 / 縦罫線なし）。有効タブは @dnd-kit/sortable で
 * D&D 並び替え可能（rete-desk-0197）。並び順列は行の表示位置（index+1）を 1 始まりで描画（rete-desk-0199）。
 *
 * A1 状態機械（use-desk-view-state）のビューではなく独立モーダル（タスク詳細等と重なっても
 * 画面遷移状態を汚さない）。チケットの「チャネル管理者ロール」制限はロール導入が別チケットのため
 * 縮退（全ログインユーザー編集可）。分類は選択中チャネル（Space）単位スコープ（rete-desk-0158）。
 */
export function CategorySettingsDialog({
  open,
  onClose,
  spaceId,
  onChanged,
}: CategorySettingsDialogProps) {
  const [items, setItems] = useState<Category[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<CategoryTab>('active');
  const {
    listRef: catsetTabsRef,
    onMouseOver: onCatsetTabMouseOver,
    onMouseLeave: onCatsetTabMouseLeave,
    bandStyle: catsetTabHoverBandStyle,
  } = useRowHoverBand<HTMLDivElement>('.desk-catset-tab', 'horizontal');
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  /** 名称変更を始めた時点の名前。入力が変わったか（＝破棄確認が要るか）はこれとの比較で決める。 */
  const [editingBase, setEditingBase] = useState('');
  /** 実行中の変更操作（多重送信ガード）。true の間は全操作ボタンを無効化する。
   *  ガード判定は busyRef（同期・run の deps 非依存）、ボタン disabled の描画は busy（state）で行う。 */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // cmn-0353: 削除確認を共通フックへ移行（close-first + run() がエラー文言・reload・onChanged を担う）。
  const { deleteTarget, setDeleteTarget, handleDelete } = useDeleteConfirm<Category>({
    remove: async (id) => {
      // run() が busy ガード・エラー文言（画面内 actionError）・成功時 reload + onChanged を担う。
      return run(
        () => deleteCategory(Number(id)),
        '分類の削除に失敗しました。時間をおいて再試行してください。',
      );
    },
  });

  // ── D&D 並び替え（cmn-0357: センサー設定・共通判定・順序計算・施錠は共通フックへ集約）──
  // items には並べ替え対象の有効行のみを渡す（アーカイブ行は並べ替え不可）。送信内容の組み立て
  // （アーカイブ済を含む当該 Space の完全列・rete-desk-0197）は onReorder 側で行う。
  // isReordering / resetReordering は共通フックが所有する施錠の読み取り・リセット API として公開される
  // （run() の変更系ガードと閉じ時のリセットが参照する。生 ref 直書きの二重管理はフック側へ寄せた・cmn-0409）。
  const active = (items ?? []).filter((c) => !c.archived);
  const { sensors, handleDragEnd, isReordering, resetReordering } = useOptimisticReorder<Category>({
    items: active,
    // 変更系（busyRef）/ チャネル未確定（spaceId なし）のいずれかはドラッグ確定を無視する。
    isBlocked: () => !spaceId || busyRef.current,
    onReorder: async (reorderedActive) => {
      if (!spaceId || !items) return;
      // 楽観更新: 有効分を新順序、アーカイブ分を後ろに繋ぐ（一覧の見た目を即座に反映）。
      const optimistic = [...reorderedActive, ...items.filter((c) => c.archived)];
      setItems(optimistic);
      setActionError(null);
      // backend へ送るのは当該 Space の全 id（有効 + アーカイブ）の完全列。
      try {
        await reorderCategories(
          spaceId,
          optimistic.map((c) => c.id),
        );
        onChanged();
      } catch (e) {
        setActionError(apiErrorMessage(e, '並び替えの保存に失敗しました。'));
        void load(); // 失敗時はサーバー順へ復元。
      }
    },
  });

  const load = useCallback(async () => {
    // spaceId 未確定では取得しない（チャネルが定まらないと分類スコープが決まらない / rete-desk-0158）。
    if (!spaceId) return;
    setLoadError(false);
    try {
      // アーカイブ済も表示する（解除操作のため）。select 用の既定取得（除外）とは別経路。
      setItems(await fetchCategories(spaceId, true));
    } catch {
      setLoadError(true);
    }
  }, [spaceId]);

  // 開くたびに最新を取得し、入力・エラー・タブ状態をリセットする。
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setActionError(null);
    setNewName('');
    setEditingId(null);
    setDeleteTarget(null);
    setTab('active');
    void load();
  }, [open, load, setDeleteTarget]);

  // Esc の持ち主は共通 OverlayDialog 1つだけ（パネルの onKeyDown で stopPropagation する）。
  // ここで document capture の useEscapeConsume を併設すると、先に閉じて OverlayDialog の
  // stopPropagation が走らず、同じキーが desk-shell の closeAll にも届いて後ろのペインまで閉じる。
  // 削除確認（ConfirmDialog）表示中の Esc は AlertDialog 側が stopPropagation して消費する（従来どおり）。

  // 開閉のたびに busyRef をリセット（途中で閉じた場合の取り残しガード）。施錠の取り残しリセットも
  // フックの resetReordering() へ委ねる（往復実行中は無視し finally に解錠を委ねる・cmn-0409 MEDIUM 5）。
  useEffect(() => {
    if (!open) {
      busyRef.current = false;
      setBusy(false);
      resetReordering();
    }
  }, [open, resetReordering]);

  /** 変更系操作の共通ラッパ（busy ガード + 失敗メッセージ + 成功時の再取得・親通知）。
   *  ガードは busyRef（同期）で行い deps から busy を外す → run / 各 handler が busy 変化で再生成されない。 */
  const run = useCallback(
    async (op: () => Promise<unknown>, fallbackError: string) => {
      // reorder 往復中は変更系（追加/改名/アーカイブ/削除）も止める（楽観更新と load() の交錯防止）。
      if (busyRef.current || isReordering()) return false;
      busyRef.current = true;
      setBusy(true);
      setActionError(null);
      try {
        await op();
        await load();
        onChanged();
        return true;
      } catch (e) {
        setActionError(apiErrorMessage(e, fallbackError));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [load, onChanged, isReordering],
  );

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    if (!spaceId) return;
    const ok = await run(() => createCategory(spaceId, name), '分類の追加に失敗しました。');
    if (ok) setNewName('');
  };

  const handleRename = async (id: number) => {
    const name = editingName.trim();
    if (!name) return;
    const ok = await run(() => updateCategory(id, { name }), '分類名の変更に失敗しました。');
    if (ok) setEditingId(null);
  };

  const handleArchiveToggle = async (c: Category) => {
    await run(
      () => updateCategory(c.id, { archived: !c.archived }),
      c.archived ? 'アーカイブ解除に失敗しました。' : 'アーカイブに失敗しました。',
    );
  };

  if (!open) return null;

  const archived = (items ?? []).filter((c) => c.archived);
  const rows = tab === 'active' ? active : archived;

  // 有効タブ行（D&D グリップ + 並び順 + 名称 + 操作）。position は行の表示位置（index+1 / rete-desk-0199）。
  const renderActiveRow = (c: Category, position: number) => (
    <SortableCategoryRow key={c.id} id={c.id}>
      {({ setNodeRef, setActivatorNodeRef, style, attributes, listeners, isDragging }) => (
        <tr
          ref={setNodeRef}
          style={style}
          className={`desk-catset-trow${isDragging ? ' is-dragging' : ''}`}
        >
          {editingId === c.id ? (
            <td className="desk-catset-td" colSpan={3}>
              <div className="desk-catset-edit">
                <input
                  className="desk-catset-input"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRename(c.id);
                  }}
                  aria-label="分類名"
                  autoFocus
                />
                <div className="desk-catset-row-actions">
                  <button
                    type="button"
                    className="desk-catset-btn is-primary"
                    disabled={busy || editingName.trim() === ''}
                    onClick={() => void handleRename(c.id)}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className="desk-catset-btn"
                    disabled={busy}
                    onClick={() => setEditingId(null)}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            </td>
          ) : (
            <>
              <td className="desk-catset-td">
                <div className="desk-catset-row-order">
                  <button
                    type="button"
                    ref={setActivatorNodeRef}
                    {...attributes}
                    {...listeners}
                    className="desk-catset-grip"
                    aria-label={`${c.name} を並び替え`}
                    style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
                  >
                    <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <span className="desk-catset-order-no">{position}</span>
                </div>
              </td>
              <td className="desk-catset-td desk-catset-td-name">
                <span className="desk-catset-name">{c.name}</span>
              </td>
              <td className="desk-catset-td desk-catset-td-actions">
                <div className="desk-catset-row-actions">
                  <button
                    type="button"
                    className="desk-catset-icon-btn"
                    title="名称変更"
                    aria-label={`${c.name} の名称変更`}
                    disabled={busy}
                    onClick={() => {
                      setEditingId(c.id);
                      setEditingName(c.name);
                      setEditingBase(c.name);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="desk-catset-icon-btn"
                    title="アーカイブ"
                    aria-label={`${c.name} をアーカイブ`}
                    disabled={busy}
                    onClick={() => void handleArchiveToggle(c)}
                  >
                    <ArchiveRestore
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                      style={{ transform: 'scaleX(-1)' }}
                    />
                  </button>
                  <button
                    type="button"
                    className="desk-catset-icon-btn is-destructive"
                    title="削除"
                    aria-label={`${c.name} を削除`}
                    disabled={busy}
                    onClick={() => setDeleteTarget(c)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </td>
            </>
          )}
        </tr>
      )}
    </SortableCategoryRow>
  );

  // アーカイブタブ行（名称 + 操作[解除・削除]・並び替え不可 / rete-desk-0200）。
  const renderArchivedRow = (c: Category) => (
    <tr key={c.id} className="desk-catset-trow is-archived">
      <td className="desk-catset-td desk-catset-td-name">
        <span className="desk-catset-name">{c.name}</span>
      </td>
      <td className="desk-catset-td desk-catset-td-actions">
        <div className="desk-catset-row-actions">
          <button
            type="button"
            className="desk-catset-icon-btn"
            title="アーカイブ解除"
            aria-label={`${c.name} をアーカイブ解除`}
            disabled={busy}
            onClick={() => void handleArchiveToggle(c)}
          >
            <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="desk-catset-icon-btn is-destructive"
            title="削除"
            aria-label={`${c.name} を削除`}
            disabled={busy}
            onClick={() => setDeleteTarget(c)}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </td>
    </tr>
  );

  // 正本 comp-overlay-dialog: 重ね表示は共通 OverlayDialog 1枚（fixed div の手組み禁止）。
  // backdrop の曇りガラス・z 10050・Esc・focus trap・inert 隔離・フォーカス復帰は primitive が担う。
  return (
    <>
      <OverlayDialog
        open
        onClose={onClose}
        ariaLabel="分類設定"
        width="min(480px, 92vw)"
        className="desk-catset-overlay"
        // 入力途中の取消に破棄確認を挟む既存規約（mdl-0034 規約②）を primitive 側の共通ガードへ揃える。
        // 「入力途中」＝追加の名前を打ち始めた、または名称変更の入力が元の名前から変わった時だけ
        // （名称変更モードに入っただけ・未編集の名前だけでは dirty にしない）。
        dirty={newName.trim() !== '' || (editingId != null && editingName !== editingBase)}
      >
        <div className="desk-catset-card" data-testid="catset-card">
          <div className="desk-catset-head">
            <h2 className="desk-catset-title">分類設定</h2>
            <button
              type="button"
              className="desk-catset-icon-btn"
              aria-label="閉じる"
              onClick={onClose}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {/* 説明文（.desk-catset-note）は不要のため削除（rete-desk-0195・開発統括指示）。 */}
          {!spaceId ? (
            // チャネル未選択時は分類スコープが定まらないため一覧・追加を出さずに案内する（rete-desk-0158）。
            <p className="desk-catset-empty" role="status">
              チャネルを選択すると、そのチャネルの分類を管理できます。
            </p>
          ) : (
            <>
              <div className="desk-catset-add">
                <input
                  className="desk-catset-input"
                  value={newName}
                  placeholder="新しい分類名"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleAdd();
                  }}
                  aria-label="新しい分類名"
                />
                <button
                  type="button"
                  className="desk-catset-btn is-primary"
                  disabled={busy || newName.trim() === ''}
                  onClick={() => void handleAdd()}
                >
                  追加
                </button>
              </div>

              {/* 有効 / アーカイブ タブ（rete-desk-0200） */}
              <div
                className="desk-catset-tabs"
                role="tablist"
                aria-label="分類の表示切替"
                ref={catsetTabsRef}
                onMouseOver={onCatsetTabMouseOver}
                onMouseLeave={onCatsetTabMouseLeave}
              >
                {catsetTabHoverBandStyle ? (
                  <div
                    aria-hidden="true"
                    className="desk-catset-tab-hoverband"
                    style={catsetTabHoverBandStyle}
                  />
                ) : null}
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'active'}
                  className={`desk-catset-tab${tab === 'active' ? ' is-active' : ''}`}
                  onClick={() => {
                    setTab('active');
                    setEditingId(null);
                  }}
                >
                  有効
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'archived'}
                  className={`desk-catset-tab${tab === 'archived' ? ' is-active' : ''}`}
                  onClick={() => {
                    setTab('archived');
                    setEditingId(null);
                  }}
                >
                  アーカイブ
                </button>
              </div>

              {actionError && (
                <p className="desk-catset-error" role="alert">
                  {actionError}
                </p>
              )}

              {items == null && !loadError && (
                <div className="desk-catset-loading">
                  <Spinner className="h-4 w-4" />
                </div>
              )}
              {loadError && (
                <p className="desk-catset-error" role="alert">
                  分類の取得に失敗しました。閉じて再度お試しください。
                </p>
              )}

              {items != null && (
                <div className="desk-catset-table-wrap">
                  {rows.length === 0 ? (
                    <p className="desk-catset-empty" role="status">
                      {tab === 'active'
                        ? '有効な分類はありません'
                        : 'アーカイブ済みの分類はありません'}
                    </p>
                  ) : tab === 'active' ? (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={active.map((c) => c.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <table className="desk-catset-table" aria-label="有効な分類">
                          <thead>
                            <tr>
                              <th className="desk-catset-th desk-catset-th-order">並び順</th>
                              <th className="desk-catset-th">分類名</th>
                              <th className="desk-catset-th desk-catset-th-actions">操作</th>
                            </tr>
                          </thead>
                          <tbody>{active.map((c, i) => renderActiveRow(c, i + 1))}</tbody>
                        </table>
                      </SortableContext>
                    </DndContext>
                  ) : (
                    <table className="desk-catset-table" aria-label="アーカイブ済みの分類">
                      <thead>
                        <tr>
                          <th className="desk-catset-th">分類名</th>
                          <th className="desk-catset-th desk-catset-th-actions">操作</th>
                        </tr>
                      </thead>
                      <tbody>{archived.map(renderArchivedRow)}</tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </OverlayDialog>

      {/* OverlayDialog の外に置く: Radix portal でも React ツリー上は親の閉じ要求へバブルするため、
          中に置くと確認ダイアログの OK/キャンセル クリックでモーダル全体が閉じてしまう。 */}
      <ConfirmDialog
        open={deleteTarget != null}
        message={`分類「${deleteTarget?.name ?? ''}」を削除しますか？元に戻せません。`}
        destructive
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

/** useSortable の render-prop ラッパ（行コンポーネント分割を避けつつ tr に DnD を付与する）。 */
function SortableCategoryRow({
  id,
  children,
}: {
  id: number;
  children: (args: {
    setNodeRef: (node: HTMLElement | null) => void;
    setActivatorNodeRef: (node: HTMLElement | null) => void;
    style: React.CSSProperties;
    attributes: ReturnType<typeof useSortable>['attributes'];
    listeners: ReturnType<typeof useSortable>['listeners'];
    isDragging: boolean;
  }) => React.ReactElement;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: isDragging ? 'relative' : undefined,
    zIndex: isDragging ? 1 : undefined,
    background: isDragging ? 'var(--sp-card)' : undefined,
    boxShadow: isDragging ? '0 8px 20px -6px rgba(0,0,0,0.25)' : undefined,
  };
  return children({ setNodeRef, setActivatorNodeRef, style, attributes, listeners, isDragging });
}
