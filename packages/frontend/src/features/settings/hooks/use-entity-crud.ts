'use client';

import { apiErrorMessage } from '@/features/settings/lib/api-error';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 器（組織/プロジェクト）の一覧 + CRUD を共通化したカスタム hook（architecture-invariants §6）。
 *
 * 組織画面と PJ 画面は「一覧取得 + 名前で作成 + 部分更新（改名/archive）」が逐語的に一致する。
 * このフックを介して共通化し、コピペ（§3）を避ける。
 *
 * **fetchFn 参照が変わると再取得を自動トリガーする**:
 * 呼び出し側で `useCallback(() => fetchXxxAdmin(someParam), [someParam])` と memoize すれば、
 * someParam 変化 → fetchFn 変化 → useEffect 再実行 → リスト更新、という流れになる。
 */

export interface UseEntityCrudResult<T> {
  items: T[];
  isLoading: boolean;
  creating: boolean;
  updating: boolean;
  /**
   * 直近の一覧取得の失敗（v2-410）。成功した取得・より新しい取得の開始で消える。
   * 呼び出し側は領域内の role="alert" へ接続する（正本 ui.ts:109「取得失敗は領域内に残す・
   * toast だけにしない」＝消えたあと 0 件表示と区別できないため）。
   */
  error: string | null;
  /** 一覧を再取得する（保存成功後の明示 reload が必要な場合に使う）。 */
  reload: () => void;
  /** 新規アイテムを作成してリストへ追加する。失敗時は throw するので caller が catch する。 */
  create: (name: string) => Promise<T>;
  /** アイテムを部分更新する（改名 / archive / restore）。失敗時は throw するので caller が catch する。 */
  update: (id: string, patch: { name?: string; archived?: boolean }) => Promise<T>;
}

/**
 * @param fetchFn  一覧取得 fn。参照変更で useEffect が再実行される（useCallback で memoize 推奨）。
 * @param createFn 名前を受け取り新規作成して返す fn。
 * @param updateFn id + 部分パッチを受け取り更新後 DTO を返す fn。
 * @param loadErrorMessage 取得失敗時に `error` へ入れる画面固有の文言（未指定は汎用文言）。
 */
export function useEntityCrud<T extends { id: string }>({
  fetchFn,
  createFn,
  updateFn,
  loadErrorMessage = '一覧の取得に失敗しました',
}: {
  fetchFn: () => Promise<T[]>;
  createFn: (name: string) => Promise<T>;
  updateFn: (id: string, patch: { name?: string; archived?: boolean }) => Promise<T>;
  loadErrorMessage?: string;
}): UseEntityCrudResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 取得の世代番号（set-0150）。load のたびに ++ し、解決時に自分が最新でなければ結果を捨てる。
   *
   * アーカイブ絞り込みチップ（active ⇄ all）を素早く往復させると fetchFn 参照が続けて変わり、
   * 先行の取得が後から解決して新しい一覧を上書きしうる（後着上書き）。AbortController でも塞げるが、
   * 取り消しに対応しない fetchFn にも効く世代カウンタを採る。isLoading も同様に最新世代だけが下ろす
   * （古い取得の解決で、まだ走っている新しい取得のスピナーを消さない）。
   *
   * **守備範囲は取得どうしの競合だけ**（load 対 load）。create / update は世代の外で setItems を
   * 触るので、「取得の最中に作成が成功し、その作成物を含まない取得が後から解決する」順序では
   * 追加行が消える。これは絞り込み操作では起こらない（フォーム送信中に取得は走らない）ため
   * 本チケットの範囲外に置いた。塞ぐなら create / update の成功時にも世代を進める。
   */
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setIsLoading(true);
    try {
      const list = await fetchFn();
      // 古い取得の解決は現在の状態を変えない（items も error も触らない・set-0150）。
      if (gen !== loadGenRef.current) return;
      setItems(list);
      // 最新の成功でだけ失敗表示を消す（再試行中は前回の失敗を残したままにする）。
      setError(null);
    } catch (err) {
      // 最新世代の失敗だけを残す（古い取得の失敗で、現在の成功や表示を上書きしない・v2-410）。
      if (gen !== loadGenRef.current) return;
      setError(apiErrorMessage(err, loadErrorMessage));
    } finally {
      if (gen === loadGenRef.current) setIsLoading(false);
    }
  }, [fetchFn, loadErrorMessage]);

  useEffect(() => {
    // fetchFn が変わるたびに再取得（引数変化への反応）。
    // 失敗は `error` へ残す（呼び出し側が領域内 role="alert" へ接続する・v2-410）。
    void load();
  }, [load]);

  const create = useCallback(
    async (name: string): Promise<T> => {
      setCreating(true);
      try {
        const created = await createFn(name);
        setItems((cur) => [...cur, created]);
        return created;
      } finally {
        setCreating(false);
      }
    },
    [createFn],
  );

  const update = useCallback(
    async (id: string, patch: { name?: string; archived?: boolean }): Promise<T> => {
      setUpdating(true);
      try {
        const updated = await updateFn(id, patch);
        setItems((cur) => cur.map((i) => (i.id === updated.id ? updated : i)));
        return updated;
      } finally {
        setUpdating(false);
      }
    },
    [updateFn],
  );

  return {
    items,
    isLoading,
    creating,
    updating,
    error,
    reload: () => {
      void load();
    },
    create,
    update,
  };
}
