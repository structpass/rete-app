'use client';

import type {
  Control,
  FieldErrors,
  FieldPath,
  UseFormRegister,
  UseFormSetValue,
  UseFormWatch,
} from 'react-hook-form';
import { Controller } from 'react-hook-form';
import { TASK_STATUS_OPTIONS } from '@/features/tasks/lib/status';
import type { Account, Category, ParentTaskOption } from '@/features/tasks/lib/api';
import type { TaskFormData } from '@/features/tasks/lib/validations';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DeskDateRangeFields } from './desk-date-range';
import { DeskParentField } from './desk-parent-field';

interface DeskTaskFieldsProps {
  /**
   * RHF control。共通 Select へ移したフィールド（分類・ステータス・担当者）の Controller 結線に使う
   * （mdl-0030: native <select> → 共通 Select 移行・comp-select 禁止規約への対応）。useTaskForm は
   * FormProvider を被せないため、useFormContext は使わず呼び出し元から control を直接渡す。
   */
  control: Control<TaskFormData>;
  register: UseFormRegister<TaskFormData>;
  errors: FieldErrors<TaskFormData>;
  categories: Category[];
  /**
   * 親タスク picker（rete-desk-0068/0071/0072）を末尾に描画する。指定時のみ表示。
   * 候補は呼び出し側で自身＋子孫を除外済みのものを渡す。watch / setValue は分類連動に使う。
   */
  parentTasks?: ParentTaskOption[];
  watch?: UseFormWatch<TaskFormData>;
  setValue?: UseFormSetValue<TaskFormData>;
  /**
   * 担当者候補（rete-desk-0062）。指定時は担当者を Account select（assigneeId 連結）として描画する。
   * 未指定時は移行期フォールバックとして旧フリーテキスト（assigneeName）を描画する。
   */
  accounts?: Account[];
}

interface DeskSelectFieldProps<T extends string> {
  control: Control<TaskFormData>;
  name: FieldPath<TaskFormData>;
  id: string;
  ariaLabel: string;
  /** placeholder（空選択時のラベル・例「（未分類）」） */
  placeholder: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  /** 空 value のラベルが必要か（分類の「（未分類）」用・担当者未割当の空白用）。既定 false。 */
  includeBlank?: boolean;
  /** 空 value ラベル（includeBlank=true 時のみ使用） */
  blankLabel?: string;
}

function DeskSelectField<T extends string>({
  control,
  name,
  id,
  ariaLabel,
  placeholder,
  options,
  includeBlank = false,
  blankLabel = '',
}: DeskSelectFieldProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <Select value={(field.value ?? '') as string} onValueChange={field.onChange}>
          <SelectTrigger id={id} aria-label={ariaLabel} className="desk-ticket-select">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {includeBlank && <SelectItem value="">{blankLabel || placeholder}</SelectItem>}
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    />
  );
}

/**
 * Desk タスクフォームの属性フィールド群（分類 / ステータス / 担当者 / 開始日 / 期日）の stacked 描画。
 * DeskTaskForm（編集・タスク詳細）と TaskCreateOverlay（新規登録モード）の双方が同一の属性 markup を
 * 共有するための単一ソース（architecture-invariants §3 コピペ回避）。
 *
 * markup・並び順はモック（desk/index.html data-left-view="detail"）の .desk-detail-info-form に準拠:
 * 各フィールドは縦積み（.desk-detail-info-field = ラベル上・入力 full-width）、順序は 分類 → ステータス
 * → 担当者 → 開始日 → 期日。全ラベルは同一フォントで揃える（rete-desk-0181）。分類は任意・ステータスは
 * ドロップダウン初期値付きで未入力が起きないため「※必須」注記は出さない（rete-desk-0184・0185）。
 * 本コンポーネントは 4 項目とも任意のため必須マークを持たない（必須は題名だけで、題名は
 * 呼び出し側の新規登録フォームが出す＝正本 comp-form-field の意図的例外）。
 *
 * 開始日・期日は 1 コンポーネント（DeskDateRangeFields）で入力する（どちらの行から開いても同じ
 * 期日範囲 popover が出る＝v2-170）。
 *
 * 題名・説明は surface ごとに別 markup（編集 = 右情報列の hidden input / 新規登録 = 左列の new-form）
 * のため本コンポーネントには含めない。register / errors は呼び出し側の useTaskForm から受け取る。
 */
export function DeskTaskFields({
  control,
  register,
  errors,
  categories,
  parentTasks,
  watch,
  setValue,
  accounts,
}: DeskTaskFieldsProps) {
  return (
    <>
      <div className="desk-detail-info-field">
        {/* ラベル文言「分類」を表示（rete-desk-0066/0069・開発統括指示で復活。過去 rete-desk-0045 で
            モック整合のため空にしていた判断を反転）。アクセシブル名は Select の aria-label でも温存。 */}
        <label className="desk-detail-info-label" htmlFor="dtf-category">
          分類
        </label>
        <DeskSelectField
          control={control}
          name="categoryId"
          id="dtf-category"
          ariaLabel="分類"
          // 分類は任意（rete-desk-0158）。先頭の「（未分類）」（空 value）を選ぶと categoryId=null で送る。
          // 実分類と区別するため丸括弧付き表記にする（rete-desk-0177）。
          placeholder="（未分類）"
          includeBlank
          options={categories.map((cat) => ({ value: String(cat.id), label: cat.name }))}
        />
        {errors.categoryId && (
          <p className="mt-1 text-xs text-[var(--sp-accent-red)]">{errors.categoryId.message}</p>
        )}
      </div>

      <div className="desk-detail-info-field">
        {/* ラベル文言「ステータス」を表示（rete-desk-0067/0070・開発統括指示で復活。過去 rete-desk-0046 で
            モック整合のため空にしていた判断を反転）。アクセシブル名は Select の aria-label でも温存。 */}
        <label className="desk-detail-info-label" htmlFor="dtf-status">
          ステータス
        </label>
        <DeskSelectField
          control={control}
          name="status"
          id="dtf-status"
          ariaLabel="ステータス"
          placeholder="ステータス"
          options={TASK_STATUS_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
        />
      </div>

      <div className="desk-detail-info-field">
        <label className="desk-detail-info-label" htmlFor="dtf-assignee">
          担当者
        </label>
        {accounts ? (
          // Account select（rete-desk-0062）。value は UUID（空 = 未割当）。assigneeId に連結。
          <DeskSelectField
            control={control}
            name="assigneeId"
            id="dtf-assignee"
            ariaLabel="担当者"
            placeholder=""
            includeBlank
            // 未割当の選択肢ラベルは空白（rete-desk-0178）。aria-label は Select 側で温存。
            blankLabel=""
            options={accounts.map((acc) => ({ value: acc.id, label: acc.name }))}
          />
        ) : (
          // 移行期フォールバック（accounts 未供給時）: 旧フリーテキスト担当者名。
          <input id="dtf-assignee" className="desk-ticket-input" {...register('assigneeName')} />
        )}
        {/* select モード（accounts 供給時）は assigneeId、フォールバック（freetext）は assigneeName のエラーを表示。 */}
        {accounts
          ? errors.assigneeId && (
              <p className="mt-1 text-xs text-[var(--sp-accent-red)]">
                {errors.assigneeId.message}
              </p>
            )
          : errors.assigneeName && (
              <p className="mt-1 text-xs text-[var(--sp-accent-red)]">
                {errors.assigneeName.message}
              </p>
            )}
      </div>

      {/* 開始日・期日（v2-170）: 個別のネイティブピッカー2つをやめ、フィルタの期日範囲と同じ
          コンポーネントで1画面入力にする（DeskDateRangeFields）。行の構成（開始日 → 期日 の縦積み）は
          モック準拠のまま残す。 */}
      <DeskDateRangeFields
        control={control}
        startError={errors.startDate?.message}
        dueError={errors.dueDate?.message}
      />

      {/* 親タスク picker（rete-desk-0068/0071/0072）。分類連動に必要な watch / setValue が渡された時のみ描画。
          parentTasks は空配列でも描画する（候補ゼロ＝「親なし（トップレベル）」のみ選べる状態）。 */}
      {parentTasks && watch && setValue && (
        <DeskParentField
          register={register}
          watch={watch}
          setValue={setValue}
          parentTasks={parentTasks}
          error={errors.parentTaskId?.message}
        />
      )}
    </>
  );
}
