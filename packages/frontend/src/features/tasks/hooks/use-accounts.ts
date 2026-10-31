'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { extractErrorMessage } from '@/lib/error-utils';
import { fetchAccounts, fetchAccountsBySpace, type Account } from '../lib/api';

/**
 * GET /accounts を取得して保持する hook（担当者 select / DM 相手選択 等で共有）。
 * useCategories と同じ軽量全件取得パターン（use-crud-api は使わない）。レスポンスは
 * id + 表示名のみ（backend が email / role / passwordHash を遮断する）。
 *
 * spaceId 指定時は GET /accounts/by-space で当該 Space（チャネル）のメンバーに絞る（dsk-0211 criteria 1）。
 * 未指定（undefined）時は従来どおり全有効アカウント。useCategories(selectedSpaceId) と同じ Space スコープ方針。
 *
 * errorMessage は取得失敗時の toast 文言（呼び出しドメインに合わせて差し替え可能）。既定は担当者割当文脈。
 */
export function useAccounts(errorMessage = '担当者候補の取得に失敗しました', spaceId?: string) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data =
        spaceId !== undefined ? await fetchAccountsBySpace(spaceId) : await fetchAccounts();
      setAccounts(data);
    } catch (err) {
      // 失敗した理由（権限・通信など）を捨てずに出す（d754）。
      toast.error(extractErrorMessage(err, errorMessage));
    } finally {
      setLoading(false);
    }
  }, [errorMessage, spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { accounts, loading, reload: load };
}
