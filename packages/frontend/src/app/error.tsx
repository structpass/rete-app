'use client';

import { ScreenBroken } from './_components/screen-broken';

/**
 * 画面を組み立てる途中の例外の受け皿（d785）。
 *
 * 実測 2026-10-25: 主要な画面が本文ほぼ空の 500 になり、利用者には「まだ読み込み中」と見分けが付かない
 * 状態で残った。ここで受け止めて「壊れている」と示し、もう一度表示する手段を出す。中身は
 * app/_components/screen-broken.tsx 1 か所に集める（根の表示の受け皿 global-error.tsx と同じ見た目・文言）。
 * 読み込み中と区別できるよう、本文には状態そのもの（壊れている）を最初の見出しで示す。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ScreenBroken error={error} reset={reset} />;
}
