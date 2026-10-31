'use client';

import { useEffect, useState } from 'react';
import type { FileRefResolutionDto } from '@rete/shared';
import { fetchFileRefs } from '@/features/files/lib/api';
import { extractFileRefs } from '../lib/file-refs';

/** 解決結果（id → 現在のパス表記）。 */
export type FileRefPaths = ReadonlyMap<string, FileRefResolutionDto>;

const EMPTY: FileRefPaths = new Map();

/**
 * 説明欄 HTML に含まれる参照ノードを、まとめて 1 回の解決 API 呼び出しで解決する（FL+2・設計 §2.2）。
 *
 * - 参照を含まない本文（大多数）は呼び出しもしない（空 Map を返す）。
 * - 解決できない参照は Map に載らない＝描画側で「（表示できません）」に倒れる（§5.1）。
 * - **本文が変わったとき（＝説明の描き直し）に解決を引き直し、キャッシュを跨がない**（§5.4）。
 *   参照先が非可視 Space へ移された（失効した）時、開いたままの画面が古い現在パスを出し続けない
 *   ようにするため、解決結果は本文の同一性だけに結び付け、以前の結果を保持しない。
 *
 * 引き直さない場合: 同じ本文 HTML の再描画（検索ハイライト・親の状態変化）。ここで毎回引き直すと
 * 親の状態更新のたびに問い合わせが増え、本文 1 本あたり 1 リクエスト上限（§2.2）を超える。
 */
export function useFileRefPaths(html: string | null | undefined): FileRefPaths {
  const [result, setResult] = useState<{ html: typeof html; paths: FileRefPaths }>({
    html,
    paths: EMPTY,
  });
  // 本文を離れた時点で結果を捨てる。同じ本文へ戻った場合も古いパスを再利用しない。
  if (result.html !== html) setResult({ html, paths: EMPTY });

  useEffect(() => {
    if (!html || typeof DOMParser === 'undefined') {
      return;
    }
    const ids = extractFileRefs(html).map((r) => r.id);
    if (ids.length === 0) {
      return;
    }
    let cancelled = false;
    void fetchFileRefs(ids)
      .then((items) => {
        if (cancelled) return;
        setResult({ html, paths: new Map(items.map((i) => [i.id, i])) });
      })
      .catch(() => {
        // 取得失敗は「表示できない」に倒す（本文変更・再マウントで引き直す）。
        if (cancelled) return;
        setResult({ html, paths: EMPTY });
      });
    return () => {
      cancelled = true;
    };
  }, [html]);

  // 新しい本文の取得中は、前の本文で解決したパスを表示しない。
  return result.html === html ? result.paths : EMPTY;
}
