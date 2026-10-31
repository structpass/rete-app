'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  reorderAnnouncements,
  type AnnouncementSummary,
  type AnnouncementInput,
  type AnnouncementPatch,
  type AnnouncementTagKind,
} from '../lib/api';

const PAGE_LIMIT = 20;

export interface UseAnnouncementsResult {
  items: AnnouncementSummary[];
  total: number;
  /** 現在ページ（1 始まり）。 */
  page: number;
  /** 総ページ数（total と PAGE_LIMIT から導出）。 */
  totalPages: number;
  /** 1 ページ件数（表示範囲の計算用）。 */
  limit: number;
  setPage: (page: number) => void;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  /** 指定通知を一覧上で既読扱いにする楽観更新（詳細を開いた時 / HM-3・ADR 0029）。 */
  markReadLocal: (id: string) => void;
  create: (input: AnnouncementInput) => Promise<string>;
  update: (id: string, patch: AnnouncementPatch) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** D&D 並び替え（H0021・ADMIN 限定）。orderedIds は現在表示中の全件 id。楽観更新 → API → 失敗時ロールバック。 */
  reorder: (orderedIds: string[]) => Promise<void>;
}

/**
 * 掲示板/FAQ（通知）一覧の取得 + 作成/編集/削除（kind でスコープ・hom-0073）。一覧は publishedAt 降順
 * （backend 側でソート）。変更系は backend が ADMIN 限定のため、非 ADMIN が呼ぶと 403 が throw される
 * （呼び出しは UI 側で ADMIN のみ露出させる前提）。各変更後は refetch で一覧を最新化する。
 * kind 省略時は 'board'（既存呼び出し元との後方互換）。update/remove は id 単位の操作で kind を必要としない
 * （backend も未受理・useAnnouncementTagMaster と同方針）。
 */
export function useAnnouncements(kind: AnnouncementTagKind = 'board'): UseAnnouncementsResult {
  const [items, setItems] = useState<AnnouncementSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const load = useCallback(
    async (targetPage: number) => {
      const generation = ++requestGeneration.current;
      setLoading(true);
      setError(null);
      try {
        const res = await fetchAnnouncements({ page: targetPage, limit: PAGE_LIMIT, kind });
        if (generation !== requestGeneration.current) return;
        setItems(res.data);
        setTotal(res.meta.total);
        // 末尾ページの全件削除等でページが空になったら実在する最終ページへ戻す
        // （useEffect 経由で再取得。1 ずつ戻す再帰デクリメントは page=0 到達リスクがあるため取らない）。
        if (res.data.length === 0 && targetPage > 1) {
          setPage(Math.max(1, Math.ceil(res.meta.total / PAGE_LIMIT)));
        }
      } catch {
        if (generation === requestGeneration.current) setError('通知の取得に失敗しました');
      } finally {
        if (generation === requestGeneration.current) setLoading(false);
      }
    },
    [kind],
  );

  useEffect(() => {
    void load(page);
    // ページ・kind の切替と unmount でも、まだ返っていない旧応答を無効化する。
    return () => {
      requestGeneration.current += 1;
    };
  }, [load, page]);

  const refetch = useCallback(() => load(page), [load, page]);

  const create = useCallback(
    async (input: AnnouncementInput) => {
      const created = await createAnnouncement(input, kind);
      // 新着は publishedAt 降順の先頭に載るため 1 ページ目へ戻して再取得。
      setPage(1);
      await load(1);
      return created.id;
    },
    [load, kind],
  );

  const update = useCallback(
    async (id: string, patch: AnnouncementPatch) => {
      await updateAnnouncement(id, patch);
      await load(page);
    },
    [load, page],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteAnnouncement(id);
      await load(page);
    },
    [load, page],
  );

  // D&D 並び替え（H0021）。楽観的に items を新順序へ並べ替え → backend へ全件 id を渡して永続化 →
  // 反映後の summary で置き換え。失敗時は元順へロールバック（tenant-settings の reorder と同型）。
  // backend は orderedIds == 現存全件 を要求するため、呼び出し側で「全件が 1 ページに収まり未フィルタ」の
  // 時のみ発火させる（部分集合は set-mismatch で 400）。
  const reorder = useCallback(
    async (orderedIds: string[]) => {
      const prev = items;
      const byId = new Map(prev.map((a) => [a.id, a]));
      const optimistic = orderedIds
        .map((id) => byId.get(id))
        .filter((a): a is AnnouncementSummary => Boolean(a));
      setItems(optimistic);
      try {
        const updated = await reorderAnnouncements(orderedIds, kind);
        setItems(updated);
      } catch (e) {
        setItems(prev);
        throw e;
      }
    },
    [items, kind],
  );

  const markReadLocal = useCallback((id: string) => {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, unread: false } : a)));
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  return {
    items,
    total,
    page,
    totalPages,
    limit: PAGE_LIMIT,
    setPage,
    loading,
    error,
    refetch,
    create,
    update,
    remove,
    reorder,
    markReadLocal,
  };
}
