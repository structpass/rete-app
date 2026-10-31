'use client';

import { useCallback, useEffect, useState } from 'react';
import { extractErrorMessage } from '@/lib/error-utils';
import { createChatThreadFromFiles, createTaskFromFiles, fetchCategories } from '../lib/api';
import type { ShareCategory } from '../lib/api';
import type { ShareTarget } from '../lib/types';

export interface ShareSubmitInput {
  title: string;
  description: string;
  /** タスク共有時の categoryId（chat では未使用）。 */
  categoryId?: number;
}

/** 共有の実生成の結果。失敗時はサーバーが返した理由を載せる（d754・v2-198 と同じ扱い）。 */
export type ShareSubmitResult = { ok: true } | { ok: false; reason: string };

export interface UseFileShareResult {
  categories: ShareCategory[];
  categoriesLoading: boolean;
  /** カテゴリ取得に失敗したか（タスク共有は categoryId 必須なので取得失敗 = 共有不能を明示する）。 */
  categoriesError: boolean;
  /** カテゴリ取得に失敗した理由（取れなければ「カテゴリの取得に失敗しました」・d754）。 */
  categoriesErrorReason: string;
  submitting: boolean;
  /** 実生成して { ok: true } / 失敗で { ok: false, reason } を返す（呼び出し側が toast / close を制御）。 */
  submit: (input: ShareSubmitInput) => Promise<ShareSubmitResult>;
}

/**
 * ファイル→Desk 共有（FL）の生成ロジック。chat は新規テーマ、task は新規タスクを実生成する。
 * task のみ categoryId が必須のため、target==='task' のときだけカテゴリ一覧を取得する。
 *
 * d754: 以前は catch { return false } で運ぶ側の理由を捨て、画面が「作成に失敗しました」の一律の文言に
 * 置き換えていた（同じ画面の別の経路は extractErrorMessage でサーバーの理由を出していた）。
 * 共有できなかった理由（権限・上限・宛先の不正など）をそのまま画面へ渡す。
 */
export function useFileShare(target: ShareTarget): UseFileShareResult {
  const [categories, setCategories] = useState<ShareCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(target === 'task');
  const [categoriesError, setCategoriesError] = useState(false);
  const [categoriesErrorReason, setCategoriesErrorReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (target !== 'task') return;
    let active = true;
    setCategoriesLoading(true);
    setCategoriesError(false);
    setCategoriesErrorReason('');
    fetchCategories()
      .then((cats) => {
        if (active) setCategories(cats);
      })
      .catch((err) => {
        if (!active) return;
        setCategories([]);
        // 失敗の理由を捨てない（d754）。取れない失敗は固定文言へ縮退する。
        setCategoriesErrorReason(extractErrorMessage(err, 'カテゴリの取得に失敗しました'));
        setCategoriesError(true);
      })
      .finally(() => {
        if (active) setCategoriesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [target]);

  const submit = useCallback(
    async (input: ShareSubmitInput): Promise<ShareSubmitResult> => {
      setSubmitting(true);
      try {
        if (target === 'task') {
          // カテゴリ未選択は画面の手前で止める（ここへ来た時も理由を返して黙って失敗させない）。
          if (input.categoryId === undefined) {
            return { ok: false, reason: 'カテゴリを選択してください' };
          }
          await createTaskFromFiles({
            title: input.title,
            categoryId: input.categoryId,
            description: input.description,
          });
        } else {
          await createChatThreadFromFiles(input.title, input.description);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: extractErrorMessage(err, '作成に失敗しました') };
      } finally {
        setSubmitting(false);
      }
    },
    [target],
  );

  return {
    categories,
    categoriesLoading,
    categoriesError,
    categoriesErrorReason,
    submitting,
    submit,
  };
}
