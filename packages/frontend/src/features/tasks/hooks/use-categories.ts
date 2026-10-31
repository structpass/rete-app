'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { extractErrorMessage } from '@/lib/error-utils';
import { fetchCategories, type Category } from '../lib/api';

/**
 * GET /categories?spaceId= を取得して保持する hook（チャネル単位スコープ / rete-desk-0158）。
 * フォームの category select / 一覧のフィルタ・グルーピング名解決に共用する。
 *
 * ページング不要の全件取得なので、一覧 CRUD の use-crud-api（meta 前提）ではなく
 * lib/api.ts の軽量 fetchCategories を直接使う。
 *
 * spaceId 未確定（null/undefined）の間は fetch せず空配列のまま（分類はチャネルに属すため
 * スコープが定まらないと取得できない）。spaceId 確定 / 切替で取り直す。
 */
export function useCategories(spaceId: string | null | undefined) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // スコープ未確定では取得をスキップして空配列を維持する。
    if (!spaceId) {
      setCategories([]);
      setLoading(false);
      return;
    }
    // Space 切替時は旧 Space の分類を即クリアする（取得完了まで stale な分類を
    // select に出して別 Space の categoryId を選ばせないため / rete-desk-0158）。
    setCategories([]);
    setLoading(true);
    try {
      const data = await fetchCategories(spaceId);
      setCategories(data);
    } catch (err) {
      // 失敗した理由（権限・通信など）を捨てずに出す（d754）。
      toast.error(extractErrorMessage(err, '機能領域分類の取得に失敗しました'));
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { categories, loading, reload: load };
}
