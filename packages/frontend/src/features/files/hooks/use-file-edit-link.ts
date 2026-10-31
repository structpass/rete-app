'use client';

import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { fetchFileMeta } from '../lib/api';
import type { FileEditTarget } from '../lib/types';

/**
 * お気に入りファイル★の deep link（/files?fileId=<id>）を編集オーバーレイ導線へ解決する（FF・rete-files-0026）。
 *
 * fileId が来たらメタ（名前 / 所属フォルダ / 最新版）を取得し、所属フォルダへ移動したうえで編集
 * オーバーレイ（DL→ローカル編集→再アップで新版）を開く。同一 fileId での二重発火は ref で抑止する。
 * 取得失敗は toast で通知する。fileId が null に戻ったら（URL から消えたら）印を外すので、
 * 同じ★を続けて押しても開き直せる（d560）。
 *
 * v2-505 実測で分かった2つの落とし穴（どちらも「Home の★を押しても編集画面が出ない」の原因）:
 *   1. Home の★は router.push で /files?fileId= へ来る。File 画面が既にマウント済みだと
 *      server component が再実行されず、server から渡る prop は古いまま。→ 呼出元が
 *      クライアント側の URL も読み、その値をここへ渡す（useFileIdFromLocation）。
 *   2. 遷移直後は目的の器（space）がまだ復元されておらず、その間に開いても直後に画面が
 *      作り直されて消える。実測では meta 200 → folder 200 まで進むのに overlay が 0 件だった。
 *      → ready が true になる（＝器が確定して一覧を読み始められる）まで解決を待つ。
 *
 * @param fileId       対象ファイル id（無ければ null）
 * @param selectFolder 所属フォルダへ遷移させる（browser.selectFolder・useCallback 安定前提）
 * @param openEdit     編集オーバーレイを開く（overlays.openEdit・useCallback 安定前提）
 * @param ready        この画面が器を読み込める状態か（false の間は解決を保留する）
 */
export function useFileEditLink(
  fileId: string | null,
  selectFolder: (fid: string) => void,
  openEdit: (target: FileEditTarget) => void,
  ready = true,
): void {
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    // URL から fileId が消えたら解決済みの印を外す（d560）。これが無いと、別の画面へ移って
    // 戻ってきた時に同じ fileId を「解決済み」のまま扱い、★を押しても編集画面が出ない。
    if (!fileId) {
      handledRef.current = null;
      return;
    }
    // 器が未確定の間は解決しない（開いても直後に作り直されて消えるため）。
    if (!ready) return;
    if (handledRef.current === fileId) return;
    handledRef.current = fileId;
    let cancelled = false;
    void (async () => {
      try {
        const meta = await fetchFileMeta(fileId);
        if (cancelled) return;
        selectFolder(meta.folderId);
        openEdit({ id: meta.id, name: meta.name, versionNo: meta.versionNo });
      } catch {
        if (cancelled) return;
        // 取得失敗時は次回同 fileId で再試行できるよう解決済みフラグを戻す。
        handledRef.current = null;
        toast.error('お気に入りファイルを開けませんでした');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, selectFolder, openEdit, ready]);
}
