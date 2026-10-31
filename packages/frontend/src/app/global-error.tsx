'use client';

import '@/app/globals.css';
import { ScreenBroken } from './_components/screen-broken';

/**
 * 画面の表示そのものが落ちた時の最後の受け皿（d785）。
 *
 * ここは HTML の骨組み（<html>）ごと描き直す場所で、ルートの表示すら失敗した時にだけ呼ばれる。
 * そのため、他の場所で読まれているスタイルに頼らず、配色は正本の値（globals.css の --sp-accent-red /
 * --sp-accent-teal）を直接置く。壊れていることを示す中身は app/_components/screen-broken.tsx 1 か所に集める。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          fontFamily:
            'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji"',
        }}
      >
        <ScreenBroken error={error} reset={reset} />
      </body>
    </html>
  );
}
