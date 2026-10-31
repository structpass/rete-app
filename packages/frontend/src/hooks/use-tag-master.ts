'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { extractErrorMessage } from '@/lib/error-utils';

/**
 * タグマスタの最小形（FileTag / AnnouncementTag 共通形）。
 * File の TagDto（@rete/shared）と AnnouncementTag の両方と structurally 互換。
 */
export interface TagLike {
  id: string;
  name: string;
  icon: string;
  color: string;
  /** アーカイブ済か（hom-0083 お知らせタグ・fil-0094 で File タグも対応。両マスタとも boolean を返す）。 */
  archived?: boolean;
}

export interface UseTagMasterOptions {
  /** タグ一覧取得（GET）。name 昇順で返す前提。 */
  fetch: () => Promise<TagLike[]>;
  /** タグ作成（POST）→ 作成された TagLike。 */
  create: (name: string, icon: string, color: string) => Promise<TagLike>;
  /** タグ更新（PATCH・部分更新）→ 更新後の TagLike。archived は hom-0083（お知らせ）・fil-0094（File）両対応。 */
  update: (
    id: string,
    patch: { name?: string; icon?: string; color?: string; archived?: boolean },
  ) => Promise<TagLike>;
  /** タグ削除（DELETE）。付与は backend 側で連鎖削除。 */
  remove: (id: string) => Promise<void>;
}

export interface UseTagMasterResult {
  tags: TagLike[];
  loading: boolean;
  error: boolean;
  /** 作成/更新/削除の進行中フラグ（ボタン二度押し防止）。 */
  mutating: boolean;
  /** 直近の create/update 失敗時にサーバが返した具体メッセージ（無ければ null・hom-0103）。呼び出し側が toast 表示に使う。 */
  lastError: string | null;
  reload: () => Promise<void>;
  /** 作成して true / 失敗で false（呼び出し側が toast 制御）。成功時は一覧を再取得する。 */
  create: (name: string, icon: string, color: string) => Promise<boolean>;
  update: (
    id: string,
    patch: { name?: string; icon?: string; color?: string; archived?: boolean },
  ) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

/**
 * タグマスタ（一覧 + CRUD）の汎用状態管理 hook（rete-home-0043 / rete-files-0006 共通化）。
 * API 関数を引数で受け取るため、File タグと AnnouncementTag の両方で使える。
 * I/O は引数の API 関数に委譲し、本 hook は view state とエラーハンドリングだけを持つ。
 */
export function useTagMaster({
  fetch: fetchApi,
  create: createApi,
  update: updateApi,
  remove: removeApi,
}: UseTagMasterOptions): UseTagMasterResult {
  const [tags, setTags] = useState<TagLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  // hom-0088: 世代カウンタ。アーカイブ表示トグル等の連打で reload が重複発火した時、古い応答が
  // 後から返ってきて新しい応答の結果を上書きしないよう、応答受信時に「自分が最新の呼び出しか」を確認する。
  const generationRef = useRef(0);

  // cmn-0044: reload の identity は fetchApi に依存する。fetchApi は呼び出し側で安定参照（module-level 関数 or
  // useCallback）にすること。インラインで毎レンダー新しい関数を渡すと reload→下の mount useEffect が再発火し
  // 再フェッチが繰り返される。create/update/remove も reload を deps に持つため同様に再生成される。
  const reload = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(false);
    try {
      const result = await fetchApi();
      if (generation !== generationRef.current) return;
      setTags(result);
    } catch {
      if (generation !== generationRef.current) return;
      setError(true);
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [fetchApi]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (name: string, icon: string, color: string): Promise<boolean> => {
      setMutating(true);
      try {
        await createApi(name, icon, color);
        setLastError(null);
        await reload();
        return true;
      } catch (err) {
        setLastError(extractErrorMessage(err, '').slice(0, 200) || null);
        return false;
      } finally {
        setMutating(false);
      }
    },
    [createApi, reload],
  );

  const update = useCallback(
    async (
      id: string,
      patch: { name?: string; icon?: string; color?: string; archived?: boolean },
    ): Promise<boolean> => {
      setMutating(true);
      try {
        await updateApi(id, patch);
        setLastError(null);
        await reload();
        return true;
      } catch (err) {
        setLastError(extractErrorMessage(err, '').slice(0, 200) || null);
        return false;
      } finally {
        setMutating(false);
      }
    },
    [updateApi, reload],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setMutating(true);
      try {
        await removeApi(id);
        await reload();
        return true;
      } catch {
        return false;
      } finally {
        setMutating(false);
      }
    },
    [removeApi, reload],
  );

  return { tags, loading, error, mutating, lastError, reload, create, update, remove };
}
