'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, ArchiveRestore, Check, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { TAG_NAME_MAX_LEN } from '@rete/shared';
import { cn } from '@/lib/utils';
import type { UseTagMasterResult } from '@/hooks/use-tag-master';
import { useDeleteConfirm } from '@/hooks/use-delete-confirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { OverlayCloseButton, OverlayDialog } from '@/components/ui/overlay-dialog';
import { OverlayHeader } from '@/components/ui/overlay-header';
import { ToggleFilter } from '@/components/filters/toggle-filter';
import { FilterSearchInput } from '@/components/shared/filter-bar';
import { Spinner } from '@/components/ui/spinner';
import { TagIcon, TAG_ICON_NAMES, TAG_COLOR_NAMES, resolveTagColorHex } from './tag-icon';

/**
 * タグマスタ管理オーバーレイ（rete-files-0006 / rete-home-0043 共有化 / hom-0084 骨格刷新 / hom-0080 再設計 / fil-0081 OverlayDialog 移行）。
 * タグの一覧 + 追加 / 改名 / アイコン変更 / 削除を行う。settings-overlay と同じ file-overlay シェルに
 * 揃え、二重オーバーレイ禁止（排他は use-file-overlays）。状態は親が持つ useTagMaster インスタンスを
 * 共有し、変更が即フィルタ列にも反映される。File タグと AnnouncementTag の両方で使う共有コンポーネント
 * （UseTagMasterResult は generic hook を参照）。
 * headTabs は見出しの下に独立行として差し込む任意スロット（hom-0074 掲示板/FAQ タブ切替用）。一覧ビュー
 * でのみ表示し、登録/編集ビューでは非表示にする（hom-0080＝見出しラベル自体が画面名を表すため）。
 * 本コンポーネントに kind/タブの概念は持ち込まず、あくまで呼び出し側が渡した ReactNode を表示するだけ。
 * シェル（focus trap / inert 隔離 / Esc / 破棄確認）は共通 primitive OverlayDialog に委譲する。fil-0080 で
 * TagPickerOverlay が先行移行し、本件で残っていた手組み（.file-overlay/.file-overlay-backdrop + Esc 閉じ/
 * useDiscardConfirm 直結）を OverlayDialog へ移し二重管理を解消する（cmn-0355: useFocusTrap は本番参照
 * ゼロのため削除済み・focus trap は OverlayDialog が担う）。カード面（file-overlay-panel）
 * は children として維持し、位置決めと a11y は primitive 側に集約。ヘッダのアイコンは hom-0080 で廃止
 * （画面名ラベルのため不要）。フッターの「閉じる」ボタンは廃止（×とEscで閉じる）。
 *
 * archiveFilter は能力フラグ（hom-0084・hom-0080 でセマンティクス変更）。渡された時のみ、アーカイブ
 * 概念（フィルタ行の Archive chip・行毎のアーカイブ切替ボタン）を有効化する。fil-0093 以降は、archiveFilter
 * 未提供の呼び出し元も共通テーブル意匠（外枠線＋行区切り線）・Search/Clear フィルタ行・右寄せ新規登録
 * ボタン（tag-master-list-actions--end）を共有する（HOME と見た目を揃える）。fil-0094 で File タグも
 * archived 列を持ち、File タグ管理（files-shell）も archiveFilter を配線済（HOME/Files 両経路とも有効）。
 * archiveFilter.value は「アーカイブ済のみ表示」
 * （ON=アーカイブ済のみ／OFF=通常のみ、Desk のアーカイブフィルタと同じ意味）。
 */
export function TagMasterOverlay({
  master,
  onClose,
  headTabs,
  archiveFilter,
}: {
  master: UseTagMasterResult;
  onClose: () => void;
  headTabs?: ReactNode;
  archiveFilter?: { value: boolean; onChange: (value: boolean) => void };
}) {
  // 一覧ビュー / フォームビュー（登録・編集共用）の切替（hom-0085）。二重オーバーレイを作らず、
  // 同一パネル内で丸ごと差し替える（新しいオーバーレイを重ねない）。
  const [view, setView] = useState<'list' | 'form'>('list');
  // 編集対象（null=新規作成モード）。name / icon / color はフォーム入力。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>(TAG_ICON_NAMES[0]);
  const [color, setColor] = useState<string>(TAG_COLOR_NAMES[0]);
  const [saveFailure, setSaveFailure] = useState<'create' | 'update' | null>(null);

  // await 前の master は古い lastError を保持するため、失敗後のレンダーで今回の理由を表示する。
  useEffect(() => {
    if (saveFailure === null) return;
    toast.error(
      master.lastError ??
        (saveFailure === 'update'
          ? 'タグの更新に失敗しました（同名重複など）'
          : 'タグの追加に失敗しました（同名重複など）'),
    );
    setSaveFailure(null);
  }, [saveFailure, master.lastError]);
  // cmn-0356: 削除確認を共通フックへ移行。tag-master のみ従来 close-after（失敗時ダイアログが開いたまま）
  // だったが、移行でリポ既定の close-first（失敗時も閉じてエラートースト）へ揃える＝意図した差分
  // （cmn-0352 で closeOnConfirm オプション両立案は棄却済み）。success トースト・editingId の
  // resetForm は onSuccess 第 1 引数（id）で判定する。
  const {
    deleteTarget: pendingDeleteTarget,
    setDeleteTarget: setPendingDelete,
    handleDelete: handleDeleteConfirm,
  } = useDeleteConfirm<{ id: string; name: string }>({
    remove: async (id) => {
      const ok = await master.remove(String(id));
      if (!ok) toast.error('タグの削除に失敗しました');
      return ok;
    },
    onSuccess: (id) => {
      toast.success('タグを削除しました');
      // hom-0089: 削除ボタンは一覧ビュー（view === 'list'）でしか描画されず、一覧ビューでは
      // editingId は常に null（hom-0085 でフォームビューに入る時にしか editingId をセットしない）。
      // そのため現行の不変条件下では editingId === id に到達しない。将来 view 分離の前提が崩れた
      // 時の防御として分岐は削除せず残す。
      if (editingId === id) resetForm();
    },
  });
  // キーワード検索（hom-0084・fil-0093 で File 経路でも有効化。archiveFilter 未提供でも Search 入力で
  // table が絞り込まれる＝HOME と揃える）。
  const [keyword, setKeyword] = useState('');
  const newRegisterButtonRef = useRef<HTMLButtonElement>(null);
  const hasMountedRef = useRef(false);

  const isEditing = editingId !== null;
  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= TAG_NAME_MAX_LEN && !master.mutating;

  // フォームを離れ一覧ビューへ戻る（送信成功・キャンセル・Esc のいずれからも呼ぶ・hom-0085）。
  const resetForm = () => {
    setEditingId(null);
    setName('');
    setIcon(TAG_ICON_NAMES[0]);
    setColor(TAG_COLOR_NAMES[0]);
    setView('list');
  };

  const beginCreate = () => {
    resetForm();
    setView('form');
  };

  // フォーム入力に変更があるか（mdl-0034 規約②の発火判定）。新規＝既定値（空名 / 先頭アイコン / 先頭色）
  // からの変更、編集＝編集対象タグの現在値からの変更。
  const editingTag = editingId !== null ? master.tags.find((t) => t.id === editingId) : undefined;
  const formDirty =
    view === 'form' &&
    (editingTag
      ? name !== editingTag.name || icon !== editingTag.icon || color !== editingTag.color
      : name.trim() !== '' || icon !== TAG_ICON_NAMES[0] || color !== TAG_COLOR_NAMES[0]);

  // OverlayDialog が Esc / 背景クリック / OverlayCloseButton 経由（×/キャンセル）の全 close 経路を
  // dirty ガード付きで一本化する。フォーム入力中は onClose=resetForm ＝ 一覧ビューへ戻る（dirty=true
  // なら破棄確認を挟み、false なら即座に戻る・mdl-0034 規約②）。一覧ビューでは onClose=親から渡された
  // ハンドラ＝オーバーレイ close。fil-0081 ＝ 案A 採用（2026-07-14 開発統括確認：Esc/背景/×/キャンセル全て
  // を「フォーム編集中は一覧ビューへ戻る」側で統一）。

  // フォームビュー→一覧ビューへ戻ると、直前までフォーカスのあった入力/ボタンが丸ごとアンマウントされ
  // フォーカスが document.body へ抜けてしまう（hom-0085・focus trap は OverlayDialog が担うが、同 root の
  // 子ツリーが消える挙動は復帰フォーカスで補う必要がある）。復帰時は「＋新規登録」ボタンへ明示的にフォーカスを
  // 戻す。マウント直後（初期フォーカスは OverlayDialog の data-autofocus / FOCUSABLE_SELECTOR 機構が担当）
  // は対象外にする。
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    if (view === 'list') {
      newRegisterButtonRef.current?.focus();
    }
  }, [view]);

  const beginEdit = (
    id: string,
    currentName: string,
    currentIcon: string,
    currentColor: string,
  ) => {
    setEditingId(id);
    setName(currentName);
    setIcon(currentIcon);
    setColor(currentColor);
    setPendingDelete(null);
    setView('form');
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const ok = isEditing
      ? await master.update(editingId, { name: trimmed, icon, color })
      : await master.create(trimmed, icon, color);
    if (ok) {
      toast.success(isEditing ? 'タグを更新しました' : 'タグを追加しました');
      resetForm();
    } else {
      setSaveFailure(isEditing ? 'update' : 'create');
    }
  };

  // hom-0083 の archived API へ接続するアーカイブ切替（archiveFilter 提供時のみ呼ばれる）。
  const handleArchiveToggle = async (id: string, currentlyArchived: boolean) => {
    const ok = await master.update(id, { archived: !currentlyArchived });
    if (ok) {
      toast.success(currentlyArchived ? 'アーカイブを解除しました' : 'タグをアーカイブしました');
    } else {
      toast.error(currentlyArchived ? 'アーカイブ解除に失敗しました' : 'アーカイブに失敗しました');
    }
  };

  const pendingTag = pendingDeleteTarget ?? null;
  // fil-0093: キーワード絞り込みは File 経路でも有効化（archiveFilter 未提供でも Search 入力で table が
  // 絞り込まれる）。archiveFilter 未提供の呼び出し元は archive フィルタを素通し（全件が対象）する。
  // hom-0080: archiveFilter.value は「アーカイブ済のみ表示」（ON=アーカイブ済のみ／OFF=通常のみ）に意味変更。
  const filteredTags = master.tags
    .filter((t) => (archiveFilter ? (archiveFilter.value ? !!t.archived : !t.archived) : true))
    .filter((t) => t.name.toLowerCase().includes(keyword.trim().toLowerCase()));

  // hom-0080: 見出しラベルは一覧/登録/編集で切り替える（画面名として一意に表す。フォームビュー内の
  // 重複タイトルは廃止しこの見出しのみで表す）。
  const panelTitle = view === 'form' ? (isEditing ? 'タグ編集' : 'タグ登録') : 'タグ管理';

  return (
    <>
      <OverlayDialog
        open
        onClose={view === 'form' ? resetForm : onClose}
        dirty={formDirty}
        ariaLabel="タグ管理"
        width="min(540px, 92vw)"
      >
        <div
          className={cn(
            'file-overlay-panel',
            // hom-0112: ⑦⑧固定高さ＋内側スクロールの修飾子は archiveFilter 提供時（掲示板/FAQ タブがある使い方）のみ付与。
            // File タグ管理など archiveFilter 未提供の呼び出し元には波及させない（criteria: 回帰無し）。
            archiveFilter && 'file-overlay-panel--tag-master-with-tabs',
          )}
        >
          <OverlayHeader title={panelTitle} />
          {/* hom-0084: 掲示板/FAQ タブは見出し下の独立行へ（headTabs 未提供時＝File 側は何も出ない）。
              hom-0080: タグ登録/編集ビューではタブを非表示にする（見出し自体が画面名を表すため）。 */}
          {view === 'list' && headTabs && <div className="tag-master-tabs-row">{headTabs}</div>}
          {/* hom-0080: フィルタ行・新規登録行は file-overlay-body（overflow-y:auto・テーブルのみスクロール
              させる想定）の外に置く。ToggleFilter のポップオーバー自体は createPortal で document.body 直下へ
              描画するため、この配置に関わらずクリップされない（toggle-filter.tsx 参照）。 */}
          {view === 'list' && (
            <div className="tag-master-filter-row">
              {/* mdl-0033: 生 input（type=text・Esc 無し）から共通 FilterSearchInput（type=search +
                  Esc クリア。値ありの Esc は stopPropagation され、オーバーレイの Esc 閉じと両立）へ統一。 */}
              <FilterSearchInput
                placeholder="タグ名で検索"
                value={keyword}
                onChange={setKeyword}
                ariaLabel="タグ名で検索"
              />
              {/* fil-0093: Archive chip は archiveFilter 提供時のみ描画（fil-0094 で File 経路も提供済）。
                  hom-0136: dsk-0403 の flash prop を渡して 1 クリック自動トグル化（Desk と同型）。
                  dsk-0436: 一過性 flash popup は撤去（ON/OFF トグルはリストを出さず is-active で識別）。 */}
              {archiveFilter && (
                <ToggleFilter
                  Icon={Archive}
                  label="アーカイブ"
                  switchLabel="アーカイブ済のみ表示"
                  active={archiveFilter.value}
                  onToggle={() => archiveFilter.onChange(!archiveFilter.value)}
                  flash
                />
              )}
              <button
                type="button"
                className="desk-filter-clear home-filter-clear"
                title="フィルタをクリア"
                aria-label="検索をクリア"
                onClick={() => {
                  setKeyword('');
                  // fil-0093: archiveFilter 未提供の File 経路では Archive chip が無いので keyword のみクリア。
                  if (archiveFilter) archiveFilter.onChange(false);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="desk-filter-icon-label">クリア</span>
              </button>
            </div>
          )}
          {/* hom-0135是正: 新規登録はフィルタ行に同居させず、テーブル直上の独立行に段を分ける。
              fil-0093: File タグ管理（archiveFilter 無し）も Hub と同じく右寄せに揃え、画面デザイン一致させる。
              旧来の左寄せ挙動（hom-0135 で File 側を維持）は fil-0093 で方針転換＝File 側も右寄せ。 */}
          {view === 'list' && (
            <div className="tag-master-list-actions tag-master-list-actions--end">
              <button
                ref={newRegisterButtonRef}
                type="button"
                className="fo-btn-primary"
                onClick={beginCreate}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                新規登録
              </button>
            </div>
          )}
          <div className="file-overlay-body">
            {view === 'form' ? (
              <div className="tag-master-form">
                <input
                  type="text"
                  className="settings-input"
                  placeholder="タグ名"
                  maxLength={TAG_NAME_MAX_LEN}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
                <div className="tag-form-pick-label">アイコン</div>
                <div className="tag-icon-grid" role="radiogroup" aria-label="アイコンを選択">
                  {TAG_ICON_NAMES.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={icon === n}
                      aria-label={n}
                      className={cn('tag-icon-cell', icon === n && 'is-selected')}
                      onClick={() => setIcon(n)}
                    >
                      {/* アイコンは選択中の色でプレビュー描画（rete-files-0022）。 */}
                      <TagIcon name={n} size={16} color={color} />
                      {icon === n && (
                        <Check className="tag-icon-cell-check h-3 w-3" aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
                <div className="tag-form-pick-label">色</div>
                <div className="tag-color-grid" role="radiogroup" aria-label="色を選択">
                  {TAG_COLOR_NAMES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={color === c}
                      aria-label={c}
                      className={cn('tag-color-swatch', color === c && 'is-selected')}
                      style={{ backgroundColor: resolveTagColorHex(c) }}
                      onClick={() => setColor(c)}
                    >
                      {color === c && (
                        <Check className="tag-color-swatch-check h-3 w-3" aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
                {/* 保存/キャンセルは新規作成・編集どちらのフォームでも同じ配置（モデルタブ「フォーム画面」型・hom-0085）。 */}
                <div className="tag-master-form-actions">
                  <OverlayCloseButton
                    type="button"
                    className="fo-btn-ghost"
                    disabled={master.mutating}
                  >
                    キャンセル
                  </OverlayCloseButton>
                  <button
                    type="button"
                    className="fo-btn-primary"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                  >
                    {master.mutating ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* 既存タグ一覧。fil-0093: 共通テーブル意匠（分類設定と同系）を File 経路でも使う。
                archiveFilter 未提供（File）の場合はアーカイブ概念無しのテーブル、archiveFilter 提供時
                （お知らせ）は行毎のアーカイブ切替ボタンを追加表示。 */}
                {master.error ? (
                  <div className="file-empty">タグの読み込みに失敗しました</div>
                ) : master.loading ? (
                  <div className="flex justify-center py-6">
                    <Spinner className="h-4 w-4" />
                  </div>
                ) : master.tags.length === 0 ? (
                  <div className="file-empty">
                    タグはまだありません。「新規登録」ボタンから追加してください。
                  </div>
                ) : filteredTags.length === 0 ? (
                  <div className="file-empty">検索条件に一致するタグがありません</div>
                ) : (
                  // hom-0135九度目是正: .tag-master-table 自身が外枠の角丸クリップ用に overflow:hidden
                  // を持つため、thead th の position:sticky の基準（nearest scrolling ancestor）が table
                  // 自身になってしまい効かない（実機検証で特定）。角丸枠をラッパー側へ移し table 側の
                  // overflow をキャンセルする（globals.css .tag-master-table-wrap 側のコメント参照）。
                  <div className="tag-master-table-wrap">
                    <table className="tag-master-table" aria-label="タグ一覧">
                      <thead>
                        <tr>
                          <th scope="col" className="tag-master-th">
                            タグ名
                          </th>
                          <th scope="col" className="tag-master-th tag-master-th-actions">
                            操作
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTags.map((t) => (
                          <tr
                            key={t.id}
                            className={cn(
                              'tag-master-trow',
                              t.archived && 'is-archived',
                              editingId === t.id && 'is-editing',
                            )}
                          >
                            <td className="tag-master-td">
                              <span className="tag-master-item-main">
                                <TagIcon name={t.icon} size={14} color={t.color} />
                                <span className="tag-master-item-name">{t.name}</span>
                              </span>
                            </td>
                            <td className="tag-master-td tag-master-td-actions">
                              <span className="tag-master-actions">
                                <button
                                  type="button"
                                  className="tag-master-icon-btn"
                                  onClick={() => beginEdit(t.id, t.name, t.icon, t.color)}
                                  aria-label={`${t.name} を編集`}
                                  disabled={master.mutating}
                                >
                                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                                {/* fil-0093: 行毎のアーカイブ切替ボタンは archiveFilter 提供時のみ描画
                              （fil-0094 で File 経路も archived 対応・提供済）。 */}
                                {archiveFilter && (
                                  <button
                                    type="button"
                                    className="tag-master-icon-btn"
                                    onClick={() => void handleArchiveToggle(t.id, !!t.archived)}
                                    aria-label={`${t.name} を${t.archived ? 'アーカイブ解除' : 'アーカイブ'}`}
                                    title={t.archived ? 'アーカイブ解除' : 'アーカイブ'}
                                    disabled={master.mutating}
                                  >
                                    <ArchiveRestore
                                      className={cn(
                                        'h-3.5 w-3.5',
                                        !t.archived && 'tag-master-archive-icon-flip',
                                      )}
                                      aria-hidden="true"
                                    />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="tag-master-icon-btn is-danger"
                                  onClick={() => setPendingDelete({ id: t.id, name: t.name })}
                                  aria-label={`${t.name} を削除`}
                                  disabled={master.mutating}
                                >
                                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
          {/* hom-0080: フッターの「閉じる」ボタンは廃止（×とEscで閉じる・.file-overlay-foot の CSS
              定義自体は他6画面が共有するため削除しない）。 */}
        </div>
      </OverlayDialog>
      {/* 永久削除確認（cmn-0041）。AlertDialog は body へ portal されるためオーバーレイ外に置いても最前面で開く。
          cmn-0356: useDeleteConfirm へ移行。open は deleteTarget の有無・onConfirm はフックの handleDelete。 */}
      <ConfirmDialog
        open={pendingDeleteTarget !== null}
        message={`タグ「${pendingTag?.name ?? ''}」を削除しますか？元に戻せません。`}
        destructive
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
