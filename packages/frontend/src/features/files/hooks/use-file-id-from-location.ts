'use client';

import { useEffect, useState } from 'react';

function readFileIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('fileId');
}

/** 解決済みの印（use-file-edit-link の「この fileId は開いた」記録）を外す合図。 */
interface UnlockDetail {
  /** 押されたお気に入りが指すファイル。URL ではなく押下時点の対象を載せる（下の経路の説明を参照）。 */
  fileId: string;
}

/**
 * 同一 fileId の再取得を許す合図。`unlockFileLink(fileId)` で発火する。
 * 同じファイルの★を続けて押した時など、URL が変わらないまま「もう一度開く」ことを伝える（d560）。
 */
export const FILE_LINK_UNLOCK_EVENT = 'rete:file-link-unlock';

/**
 * お気に入り★の押下時、対象ファイルをこの画面上で解決し直させる（d560）。
 *
 * 同じ URL への `router.push` は Next が遷移を取り消すため、URL も履歴も変わらない。
 * その経路では「同じ★の押し直し」を URL から観測できないので、押した側が対象を直接伝える。
 * fileId は URL と同じ表現（decode 済み）で渡すこと（呼出元で encodeURIComponent しない）。
 */
export function unlockFileLink(fileId: string): void {
  if (typeof window === 'undefined' || !fileId) return;
  window.dispatchEvent(
    new CustomEvent<UnlockDetail>(FILE_LINK_UNLOCK_EVENT, { detail: { fileId } }),
  );
}

/**
 * 現在の URL の `?fileId=` をクライアント側で読む（v2-505 / d560）。
 *
 * なぜ server の searchParams だけでは足りないか:
 * `/files?fileId=` は Home のお気に入り★から `router.push` で開かれる。File 画面が既に
 * マウント済みのまま同じルートへ query 付きで push される経路では、server component の
 * 再実行に依存すると fileId を取りこぼす。クライアント側の URL も見て補う。
 *
 * なぜ useSearchParams を使わないか:
 * この画面は AppShell を内包するため、useSearchParams は Suspense 境界を要求し、fallback 無しの
 * 境界が他タブ→files 遷移でシェルごと白化する（fil-0077 / dsk-0372 と同型の anti-pattern）。
 * そこで location を直接読む。
 *
 * 拾う経路（d560 実測）:
 * - 初期表示（この画面を `/files?fileId=` で直接開いた時）
 * - 戻る/進む（popstate）
 * - Next の画面遷移（router.push）… Next App Router は push/replace の後に `history.pushState` /
 *   `replaceState` を呼ぶ。popstate は飛ばないため、これを見ないと URL の変化を取りこぼす。
 *   API を差し替えて「入った後に」読む。
 *   （prefetch 済みのリンクは取得完了後に履歴を更新する。URL の更新と描画の厳密な同時性までは
 *   この方式では保証しない＝★の押下はその後の値で解決するので現状の用途では問題にしない。）
 *   `/files` に既にいる状態で★を押すと Next は同じ URL への遷移を取り消す（URL は変わらない）。
 *   その時に押し直しを伝えるのが `unlockFileLink`（同じ fileId の再解決）。
 *
 * 画面遷移で fileId が消えたら null を返す（呼出元の useFileEditLink が解決済みの印を外す）。
 */
export function useFileIdFromLocation(): string | null {
  const [fileId, setFileId] = useState<string | null>(null);

  useEffect(() => {
    // 押し直しの合図で予約した「後で値を戻す」処理。画面を離れたら戻さない（外した画面を触らない）。
    const pendingFrames = new Set<number>();

    const read = () => {
      // URL が読み込み後に変わったら（別のお気に入りへ移った等）、届いていた押し直しの合図は
      // 古い対象になるので捨てる。捨てないと、遷移の後に合図が届いた時に古いファイルへ
      // 戻して URL と表示が食い違ったまま固定される（d560 の独立確認で実測）。
      pendingFrames.forEach((frame) => cancelAnimationFrame(frame));
      pendingFrames.clear();
      setFileId(readFileIdFromLocation());
    };
    read();
    window.addEventListener('popstate', read);

    // pushState / replaceState は popstate を出さないため、呼び出しを包んで遷移後にも読む。
    // 他画面の遷移も観測するが、`?fileId=` が無ければ null に落ちるだけで副作用は無い。
    const original = {
      pushState: window.history.pushState,
      replaceState: window.history.replaceState,
    };
    const wrap =
      (fn: typeof window.history.pushState) =>
      (...args: Parameters<typeof window.history.pushState>) => {
        fn.apply(window.history, args);
        read();
      };
    window.history.pushState = wrap(original.pushState);
    window.history.replaceState = wrap(original.replaceState);

    const unlock = (e: Event) => {
      const detail = (e as CustomEvent<UnlockDetail>).detail;
      const fileId = detail?.fileId;
      if (!fileId) return;
      // 遷移前の押し直しは、URL がまだ前のお気に入りのままで、押された対象と食い違う。
      // 画面がまだ URL を見ていなければ、その合図は画面の無い時間に押されたものとして捨て、
      // 遷移先の URL に任せる（画面がマウント済み＝URL を反映済みなら、押し直しとして扱う）。
      if (fileId !== readFileIdFromLocation()) return;
      // 押された対象を一度 null にしてから戻す（同じ値のままだと再描画されず呼出元が再解決しない）。
      setFileId(null);
      const frame = requestAnimationFrame(() => setFileId(fileId));
      pendingFrames.add(frame);
    };
    window.addEventListener(FILE_LINK_UNLOCK_EVENT, unlock);

    return () => {
      pendingFrames.forEach((frame) => cancelAnimationFrame(frame));
      pendingFrames.clear();
      window.removeEventListener('popstate', read);
      window.history.pushState = original.pushState;
      window.history.replaceState = original.replaceState;
      window.removeEventListener(FILE_LINK_UNLOCK_EVENT, unlock);
    };
  }, []);

  return fileId;
}
