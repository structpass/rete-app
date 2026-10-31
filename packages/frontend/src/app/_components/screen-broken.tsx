'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * 画面が壊れた時の「壊れている」表示（d785）。
 *
 * 実測 2026-10-25: 描き上げの途中で失敗した画面が、本文ほぼ空のまま残った。その状態でも画面はただ白く、
 * 利用者には「まだ読み込み中」と見分けが付かない（E2E も緑のまま通った。検出する側は d784 で直した）。
 * この表示は、壊れていることをその場で示し、もう一度表示する手段を出す。
 *
 * 置き場は app 直下の error.tsx（画面の組み立て中の例外を受け止める）と global-error.tsx
 * （根の表示そのものが落ちた時の最後の受け皿）の 2 か所。見た目・文言・記録をここ 1 か所に集め、
 * 2 か所で文言が割れないようにする。
 *
 * 配色は正本のトークン（globals.css の --sp-paper / --sp-card / --sp-line-warm / --sp-accent-red /
 * --sp-accent-teal）を第一に読み、変数が届かない時だけ直接値へ落とす `var(--token, 直接値)` の形で持つ。
 * 根の表示が落ちた時は、トークンを定義しているスタイルが読み込まれていないことがあるため
 * （直接値を書かないと色が消える）、一方で正本の値を変えた時にこの表示だけ古い色で残らないよう、
 * 直接値は控え（フォールバック）に留める。値は globals.css と同値。
 *
 * 記録: 表示した時点で、直した後に原因を辿れるよう、画面の道筋と例外の内容をブラウザの
 * コンソールへ 1 組で残す（利用者に操作を求めない・サーバーへは送らない）。
 * 例外の内容は本文に出さない（内部の情報を画面に晒さないため）。Next.js が発行する識別子（digest）だけは、
 * 原因を照合できるように出す。読み上げにも「壊れている」と伝わるよう role="alert" を置く。
 */
export function ScreenBroken({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[画面が壊れました]', {
      path: typeof window === 'undefined' ? '' : window.location.pathname,
      message: error?.message ?? '',
      digest: error?.digest ?? '',
    });
  }, [error]);

  return (
    <div
      role="alert"
      data-screen-broken="true"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'var(--sp-paper, #f6f8fc)',
        color: 'var(--sp-nav-active-fg, #1a2b3c)',
      }}
    >
      <div
        style={{
          maxWidth: '560px',
          width: '100%',
          background: 'var(--sp-card, #ffffff)',
          border: '1px solid var(--sp-line-warm, #c5d0e0)',
          borderTop: '4px solid var(--sp-accent-red, #dc2626)',
          borderRadius: 'var(--radius, 0.625rem)',
          padding: '24px',
        }}
      >
        <h1
          style={{
            fontSize: '18px',
            fontWeight: 600,
            margin: 0,
            color: 'var(--sp-accent-red, #dc2626)',
          }}
        >
          この画面は壊れています
        </h1>
        <p style={{ marginTop: '12px', fontSize: '14px', lineHeight: 1.7, marginBottom: 0 }}>
          中身を表示できませんでした。データが消えたわけではなく、この画面を作る処理で失敗しています。
        </p>
        <p
          style={{
            marginTop: '8px',
            fontSize: '14px',
            lineHeight: 1.7,
            marginBottom: 0,
            color: 'var(--sp-text-warm-2, #4a5b64)',
          }}
        >
          もう一度試しても直らない時は、この画面が壊れていると分かる状態のまま、
          他の画面（掲示板・ファイル・設定）を使ってください。直すのは開発側で行います。
        </p>
        {error?.digest && (
          <p
            style={{
              marginTop: '8px',
              marginBottom: 0,
              fontSize: '12px',
              color: 'var(--sp-text-warm-2, #4a5b64)',
            }}
          >
            識別子: <code data-screen-broken-digest="">{error.digest}</code>
          </p>
        )}
        <div style={{ marginTop: '20px' }}>
          <Button
            type="button"
            variant="sp-primary"
            size="sp-compact"
            onClick={() => reset()}
            style={{
              background: 'var(--sp-accent-teal, #1fb6a2)',
              color: '#ffffff',
              border: 0,
              borderRadius: '0.1875rem',
              padding: '0 12px',
              height: '32px',
              fontWeight: 500,
            }}
          >
            もう一度表示する
          </Button>
        </div>
      </div>
    </div>
  );
}
