'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { FavoriteDto } from '@rete/shared';
import {
  fetchFavorites,
  addFavorite,
  removeFavorite,
  reorderFavorites,
  type AddFavoriteInput,
} from '../lib/favorites-api';

export interface UseFavoritesResult {
  items: FavoriteDto[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  add: (input: AddFavoriteInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<void>;
}

/**
 * 並び替えの巻き戻し（d561）。current を「before の並び」へ戻し、before に無い項目は元の相対位置を
 * 保ったまま後ろへ残す。current はロールバック時点の一覧（待っている間に登録・削除が反映済み）なので、
 * before の順序だけを当て直し、後から増えた項目は消さない。
 */
function restoreOrder(current: FavoriteDto[], before: FavoriteDto[]): FavoriteDto[] {
  const byId = new Map(current.map((f) => [f.id, f]));
  const beforeIds = before.map((f) => f.id);
  const reordered = beforeIds.map((id) => byId.get(id)).filter((f): f is FavoriteDto => !!f);
  const rest = current.filter((f) => !beforeIds.includes(f.id));
  return [...reordered, ...rest];
}

/**
 * お気に入り一覧の取得（sortOrder 昇順・backend 採番）と世代ガード（d561）。連続した add/remove 等で
 * load が重複発火した時、古い応答が後から返ってきて新しい応答の結果を上書きしないよう、
 * 応答受信時に「自分が最新の呼び出しか」を確認する（タグマスタ・通知一覧と同型）。
 */
function useFavoriteList() {
  const [items, setItems] = useState<FavoriteDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await fetchFavorites();
      if (generation !== generationRef.current) return;
      setItems(list);
    } catch {
      if (generation !== generationRef.current) return;
      setError('お気に入りの取得に失敗しました');
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { items, loading, error, setItems, setError, load };
}

/**
 * HOME サイドバーの横断お気に入り（ユーザー別）の取得 + 追加/削除/並び替え。
 * 一覧は backend が sortOrder 昇順で返す。reorder は楽観更新（先にローカルを並べ替え、
 * 失敗時は確定済みデータへロールバック）でドラッグ体感を滑らかにする。add/remove は
 * 一覧を再取得して整合させる（sortOrder の採番は backend が握るため）。
 */
export function useFavorites(): UseFavoritesResult {
  const { items, loading, error, setItems, setError, load } = useFavoriteList();

  const add = useCallback(
    async (input: AddFavoriteInput) => {
      await addFavorite(input);
      await load();
    },
    [load],
  );

  const remove = useCallback(
    async (id: string) => {
      await removeFavorite(id);
      await load();
    },
    [load],
  );

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      // 楽観更新: orderedIds の順に並べ替えてから永続化。失敗時は呼び出し前の順序（items）へロールバック。
      // スナップショットを丸ごと戻さず「その時の一覧」へ順序だけ当てるので、待っている間に成功した
      // 登録・削除まで巻き戻らない（d561）。
      const byId = new Map(items.map((f) => [f.id, f]));
      const optimistic = orderedIds.map((id) => byId.get(id)).filter((f): f is FavoriteDto => !!f);
      setItems(optimistic);
      try {
        setItems(await reorderFavorites(orderedIds));
      } catch {
        setItems((current) => restoreOrder(current, items));
        setError('並び替えに失敗しました');
      }
    },
    [items, setItems, setError],
  );

  return { items, loading, error, refetch: load, add, remove, reorder };
}
