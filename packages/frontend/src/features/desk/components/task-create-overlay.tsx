'use client';

import { useEffect, useMemo } from 'react';
import { Controller } from 'react-hook-form';
import { X } from 'lucide-react';
import { useTaskForm } from '@/features/tasks/hooks/use-task-form';
import type { Account, Category, ParentTaskOption } from '@/features/tasks/lib/api';
import type { TaskFormData } from '@/features/tasks/lib/validations';
import { DeskTaskFields } from './desk-task-fields';
import { validateParentMatch } from './desk-parent-field';
import { RichTextEditor } from './rich-text-editor';
import {
  PendingAttachmentField,
  PendingChipsRow,
  PendingAddButton,
} from './pending-attachment-field';
import { usePendingAttachments } from '../hooks/use-pending-attachments';
import { extractMentionAccountIds } from '../lib/mentions';

type TaskCreateVariant = 'create' | 'promote';

interface TaskCreateOverlayProps {
  /**
   * - `create`: タスク明細の「新規登録」ボタンから開く素の新規作成（data-left-view="detail" + is-creating /
   *   mock setDetailCreatingMode 準拠。分類・ステータスに ※必須 を表示）。
   * - `promote`: チャットを D&D した昇格（data-left-view="promote"）。タスク詳細 編集モードと同じ二段組へ
   *   寄せる（開発統括指示 2026-06-03）。テーマ題名/説明をプリフィルし、挿入位置・元チャットを読み取り表示。
   */
  variant: TaskCreateVariant;
  categories: Category[];
  /**
   * 親タスク picker（rete-desk-0068/0071/0072）の候補。create variant でのみ渡す。
   * promote は挿入位置を parentLabel で読み取り表示するため picker は出さない。
   */
  parentTasks?: ParentTaskOption[];
  /** 担当者候補（rete-desk-0062）。指定時は担当者を Account select として描画する。 */
  accounts?: Account[];
  saving: boolean;
  error?: string | null;
  defaultValues?: Partial<TaskFormData>;
  /** promote: 解決済み挿入位置ラベル（親タスク欄に読み取り表示）。未指定は「—」。 */
  parentLabel?: string;
  /** promote: 元チャットの題名（右列「元チャット」行に読み取り表示）。create では出さない。 */
  sourceThemeTitle?: string;
  onClose: () => void;
  /**
   * 確定。raw TaskFormData を渡し、create→POST /tasks / promote→昇格 payload の変換は呼び出し側に委ねる。
   * descriptionMentionAccountIds は説明 RTE の @ メンションから抽出した宛先（dsk-0203・説明面）。
   * 戻り値は作成されたタスク id（失敗時 null）。保留中の添付（FL-3b deferred-flush）をこの id へ紐づける。
   */
  onSubmit: (
    data: TaskFormData,
    mention: { descriptionMentionAccountIds: string[] },
  ) => Promise<number | null>;
  /** 編集中フラグの報告（C-編集・DBT-7 / 閉じ経路の破棄ガード用）。dirty 変化・アンマウントで通知。 */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * タスク新規作成オーバーレイ（二段組 / タスク詳細 編集モードと同型シェル）。
 * 「新規登録」(create) と「チャット昇格」(promote) は左=編集可能 new-form / 右=属性フォームで構造が同一の
 * ため単一コンポーネントに統一する（architecture-invariants §3）。属性フィールドはタスク詳細 編集と共有の
 * DeskTaskFields を用いる。題名・説明は左列の new-form（mock .desk-thread-new-form 相当）で編集する。
 *
 * RTE（リッチテキスト）は別途デファー（DBT-1）のため説明欄は plain textarea。
 */
export function TaskCreateOverlay({
  variant,
  categories,
  parentTasks,
  accounts,
  saving,
  error,
  defaultValues,
  parentLabel,
  sourceThemeTitle,
  onClose,
  onSubmit,
  onDirtyChange,
}: TaskCreateOverlayProps) {
  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    setError,
    clearErrors,
    formState: { errors, isDirty },
  } = useTaskForm(defaultValues);

  // deferred-flush 添付（FL-3b）: 作成前はファイルをローカル保留し、作成成功後に確定 id へ一括添付する。
  const pendingAttachments = usePendingAttachments();
  const dirty = isDirty || pendingAttachments.pending.length > 0;

  // 編集状態を上位（desk-shell）へ報告。アンマウント時は false に戻し、次回オープンへ持ち越さない。
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const isCreate = variant === 'create';
  // promote（昇格）の確定ボタンも「保存」に統一（rete-desk-0176・開発統括指示。旧「タスク化」）。
  // mdl-0035: create 側も「登録」の言い換えをやめ基底語「保存」へ統一。
  const submitLabel = '保存';

  // @ メンション候補（dsk-0203）。task-detail-overlay と同じ accounts 一覧を {id, label} へ写像する。
  // RichTextEditor は mentionItems を ref 経由で読むため、accounts の遅延ロードにも追従する。
  const mentionItems = useMemo(
    () => (accounts ?? []).map((a) => ({ id: a.id, label: a.name })),
    [accounts],
  );

  // 確定 → 作成（onSubmit が id を返す）→ 保留中ファイルをその id へ flush。成功側の close は呼び出し側で行う。
  const handleValid = async (data: TaskFormData) => {
    // dsk-0239: 親コード該当なし（存在しない親 No）での新規登録を submit 前に弾く（編集側と同一の共有ガード）。
    // create variant のみ picker を出す（parentTasks 供給）。promote は picker 非表示なので素通り（undefined）。
    if (
      !validateParentMatch(
        data.parentTaskId,
        isCreate ? parentTasks : undefined,
        setError,
        clearErrors,
      )
    ) {
      return;
    }
    // 説明文中の @ メンションを宛先（説明面）として抽出し、本体作成と同時に永続化する
    // （dsk-0203・チャットの ThemeComposer と同型。抽出は submit 時の確定 HTML から行う）。
    const createdId = await onSubmit(data, {
      descriptionMentionAccountIds: extractMentionAccountIds(data.description ?? ''),
    });
    if (createdId != null) {
      await pendingAttachments.flush('task', createdId);
    }
  };

  return (
    <section
      data-left-view={isCreate ? 'detail' : 'promote'}
      aria-label={isCreate ? 'タスク新規登録' : 'タスク昇格'}
      className={`desk-view is-active${isCreate ? ' is-creating' : ''}`}
    >
      <form
        onSubmit={handleSubmit(handleValid)}
        className="desk-detail-split"
        aria-label={isCreate ? 'タスク新規登録フォーム' : 'タスク昇格フォーム'}
      >
        {/* ===== 左列: スレッドタブ + 新規入力（題名 + 説明） ===== */}
        <div className="desk-detail-thread">
          <div className="desk-ticket-tabs" role="tablist" aria-label="タスク新規登録タブ">
            <button type="button" role="tab" aria-selected className="desk-ticket-tab is-active">
              スレッド
            </button>
          </div>
          <div className="desk-pane-body" data-detail-tabpanel="thread">
            <div className="desk-thread-view">
              <div className="desk-thread-new-form">
                {/* 題名行とエラーを 1 つの flex 子にまとめ、エラーが題名直下（mt-1）に付くようにする
                    （rete-desk-0076・他フィールドのエラー間隔に揃える）。 */}
                <div className="desk-thread-new-form-field">
                  <div className="desk-global-input-title-row">
                    <input
                      className="desk-global-input-title"
                      aria-label="題名"
                      aria-required={isCreate ? 'true' : undefined}
                      placeholder="タイトル"
                      {...register('title')}
                    />
                    {/* 正本 comp-form-field: サーバが空を拒否する題名は「* 必須」を出す。新規登録だけが出す
                        （昇格は元チャットの題名で埋まり、編集は既存値がある＝FormField の required なし扱い）。
                        ラベル要素を持たない題名欄なので、マークは題名行の右側に添える。 */}
                    {isCreate && (
                      <span className="desk-ticket-required" aria-hidden="true">
                        * 必須
                      </span>
                    )}
                  </div>
                  {errors.title && (
                    <p className="mt-1 text-xs text-[var(--sp-accent-red)]">
                      {errors.title.message}
                    </p>
                  )}
                </div>
                <div className="desk-global-input-composer">
                  {/* 説明は共有リッチエディタ（Tiptap / ADR 0019）。HTML を field 値として保持し、
                      submit で description（HTML）として送る。dirty は Controller が追従。 */}
                  <Controller
                    control={control}
                    name="description"
                    render={({ field }) => (
                      <RichTextEditor
                        value={field.value ?? ''}
                        onChange={field.onChange}
                        ariaLabel="説明"
                        placeholder="説明"
                        minRows={10}
                        enableMention
                        mentionItems={mentionItems}
                      />
                    )}
                  />
                  {/* dsk-0349: 説明欄フッタにファイル添付（メッセージ系とパリティ）。
                      右列 PendingAttachmentField と同一 pendingAttachments を共有＝双方向同期。 */}
                  <PendingChipsRow
                    pending={pendingAttachments.pending}
                    onRemove={pendingAttachments.remove}
                    disabled={saving}
                  />
                  <div className="desk-global-input-footer">
                    <PendingAddButton onAdd={pendingAttachments.add} disabled={saving} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ===== 右列: 確定ボタン帯 + 属性情報 ===== */}
        <div className="desk-detail-info">
          <div className="desk-detail-info-head">
            <button
              type="submit"
              className="desk-ticket-btn desk-ticket-btn-save"
              disabled={saving}
              aria-busy={saving}
            >
              {submitLabel}
            </button>
            {/* 確定ボタンと隣接させ右端に寄せる（編集モードと同じ位置関係 / rete-desk-0180）。 */}
            <button
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              className="desk-pane-close ml-1"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="desk-pane-body">
            {error && (
              <p role="alert" className="px-3 pt-2 text-xs text-[var(--sp-accent-red)]">
                {error}
              </p>
            )}

            {/* チケットNo / 元チャット（promote のみ）— フォーム外の読み取りメタ。 */}
            <div className="desk-detail-info-form">
              <div className="desk-detail-info-field">
                <span className="desk-detail-info-label">チケットNo</span>
                <span className="desk-detail-info-id">—</span>
              </div>
              {sourceThemeTitle && (
                <div className="desk-detail-info-field">
                  <span className="desk-detail-info-label">元チャット</span>
                  <div className="desk-detail-parent-row">
                    <span className="desk-detail-parent-title" title={sourceThemeTitle}>
                      {sourceThemeTitle}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* 属性フォーム（タスク詳細 編集と共有の DeskTaskFields）。
                ラッパーは detail 編集側 / 前後の読み取りメタと同じ .desk-detail-info-form に統一
                （DeskTaskFields が mock 準拠の .desk-detail-info-field を出すため。旧 .desk-ticket-form は
                レガシー newform ビュー用のコンパクト grid で余白が不一致になる）。 */}
            <div className="desk-detail-info-form">
              <DeskTaskFields
                control={control}
                register={register}
                errors={errors}
                categories={categories}
                parentTasks={isCreate ? parentTasks : undefined}
                watch={isCreate ? watch : undefined}
                setValue={isCreate ? setValue : undefined}
                accounts={accounts}
              />
            </div>

            {/* 親タスク（promote のみ読み取り = 挿入位置）/ ファイル（サンプル見た目シェル / Phase C で配線）。
                create は picker を上の DeskTaskFields 内に出すため、ここでは読み取り行を出さない（二重回避）。 */}
            <div className="desk-detail-info-form">
              {!isCreate && (
                <div className="desk-detail-info-field">
                  <span className="desk-detail-info-label">親タスク</span>
                  <span className="desk-detail-parent-title">{parentLabel ?? '—'}</span>
                </div>
              )}
              {/* ファイル添付（FL-3b deferred-flush）。確定前はローカル保留し、作成成功後に新タスク id へ紐づける。
                  dsk-0379: 右列は「ファイル」ラベル直下のため flush（border-top 無し）。左コンポーザの
                  PendingChipsRow（本文との境）は flush しない＝メッセージ文脈の区切り線は残す。 */}
              <div className="desk-detail-info-field">
                <span className="desk-detail-info-label">ファイル</span>
                <PendingAttachmentField
                  pending={pendingAttachments.pending}
                  onAdd={pendingAttachments.add}
                  onRemove={pendingAttachments.remove}
                  disabled={saving}
                  flush
                />
              </div>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
