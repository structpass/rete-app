import { createHash } from 'node:crypto';
import type { KoaContextWithOIDC } from 'oidc-provider';

/**
 * RP 起点ログアウト（end_session）の画面（d1269）。
 *
 * なぜ既定の画面を置き換えるか: oidc-provider の既定 `logoutSource` は
 * 「サインアウトしますか？」の確認ページを出し、利用者がボタンを押して初めてセッションを消す。
 * アプリ側のログアウト操作から end_session へ来た時に確認ページを挟むと、
 * ・利用者はアプリでログアウトしたつもりなのに SSO セッションは残る（もう一度押すまで）
 * ・Reference / 報告管理を開くと自動入場してしまい、d1269 の目的（ログアウト後にログイン画面から入る）が
 *   達成されない
 * そこで「id_token_hint の本人が今の SSO セッションの本人と一致する時だけ」確認を省いて自動送信する。
 *
 * 無条件に自動送信しない理由（CSRF）: end_session は GET で来る。他人が用意したリンクを踏ませるだけで
 * 利用者の SSO セッションを切れると、ログアウト攻撃（denial of service）が成立する。id_token_hint は
 * provider が署名・audience を検証済みで `ctx.oidc.entities.IdTokenHint` に入る。その sub が今の
 * セッションの accountId と一致する場合に限れば、hint を用意できるのは「そのセッションの本人へ
 * 有効な id_token を渡せる相手」＝本人が使っている RP だけになる。
 * 一致しない時は既定と同じ確認ページを出し、利用者の操作を待つ。
 */
export interface RpInitiatedLogoutConfig {
  logoutSource: (ctx: KoaContextWithOIDC, form: string) => void;
}

/** 自動送信ページのインライン script（CSP の sha256 を同じ文字列から計算するため定数にする）。 */
const AUTO_SUBMIT_SCRIPT =
  "document.addEventListener('DOMContentLoaded',function(){" +
  "var f=document.getElementById('op.logoutForm');" +
  "var i=document.createElement('input');i.type='hidden';i.name='logout';i.value='yes';" +
  'f.appendChild(i);f.submit();});';

const htmlSafe = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

function readCspDirectives(ctx: KoaContextWithOIDC): Map<string, string[]> | undefined {
  const csp = ctx.response.get('content-security-policy');
  if (!csp) return undefined;
  const directives = new Map<string, string[]>();
  for (const directive of String(csp).split(';')) {
    const [name, ...values] = directive.trim().split(/\s+/);
    if (name) directives.set(name, values);
  }
  return directives;
}

function writeCspDirectives(ctx: KoaContextWithOIDC, directives: Map<string, string[]>): void {
  ctx.set(
    'content-security-policy',
    [...directives.entries()].map(([name, values]) => [name, ...values].join(' ')).join(';'),
  );
}

/**
 * インライン script の sha256 を CSP の script-src へ足す（oidc-provider の form_post と同じ作法）。
 *
 * helmet 既定の CSP（script-src 'self'）配下では、そのままではインライン script が実行されない。
 * CSP ヘッダが無い場合は何もしない（開発でヘッダを外している時に壊さない）。
 */
function pushInlineScriptSha(ctx: KoaContextWithOIDC, script: string): void {
  const directives = readCspDirectives(ctx);
  if (!directives) return;
  const scriptSrc = directives.get('script-src');
  if (!scriptSrc) return;
  const digest = createHash('sha256').update(script).digest('base64');
  directives.set('script-src', [...scriptSrc, `'sha256-${digest}'`]);
  writeCspDirectives(ctx, directives);
}

/**
 * CSP の form-action に、ログアウト後の戻り先オリジンを足す。
 *
 * なぜ要るか（d1269・実測）: helmet の既定は `form-action 'self'`。oidc-provider の確認フォームは
 * backend 自身（同一オリジン）へ POST するが、その応答が 303 で RP の画面（別オリジン）へ戻る。
 * Chrome は form-action を**リダイレクト先にも適用**するため、戻り先オリジンが許可に無いと
 * 「form data の送信が CSP に違反」として送信そのものがブロックされ、ログアウトが完了しない。
 * 戻り先は provider が client 登録値との完全一致で検証済み（= RP が申告した画面）なので、
 * そのオリジンだけを足す。CSP ヘッダが無い時は何もしない。
 */
function allowPostLogoutFormAction(ctx: KoaContextWithOIDC): void {
  const returnTo = ctx.oidc.session?.state?.postLogoutRedirectUri;
  if (typeof returnTo !== 'string' || !returnTo) return;
  let origin: string;
  try {
    origin = new URL(returnTo).origin;
  } catch {
    return;
  }
  const directives = readCspDirectives(ctx);
  if (!directives) return;
  const formAction = directives.get('form-action');
  if (!formAction) return;
  // 完全一致で見る（前方一致だと、戻り先オリジンが既存値の接頭辞の時に追加を飛ばしてしまい、
  // Chrome が送信をブロックする・レビュー指摘）。
  if (formAction.some((value) => value === origin)) return;
  directives.set('form-action', [...formAction, origin]);
  writeCspDirectives(ctx, directives);
}

/** id_token_hint の本人が、今の SSO セッションの本人と一致するか。 */
export function hintMatchesSession(ctx: KoaContextWithOIDC): boolean {
  const hint = ctx.oidc.entities.IdTokenHint as { payload?: { sub?: unknown } } | undefined;
  const hintSub = hint?.payload?.sub;
  const accountId = ctx.oidc.session?.accountId;
  return typeof hintSub === 'string' && typeof accountId === 'string' && hintSub === accountId;
}

/**
 * buildOidcConfiguration の features.rpInitiatedLogout に渡す設定を作る。
 *
 * 戻り先（post_logout_redirect_uri）は provider が「RP 登録済みの値と完全一致」で検証するため、
 * ここでは触らない（client 登録側の post_logout_redirect_uris が正本）。
 */
export function createRpInitiatedLogout(): RpInitiatedLogoutConfig {
  return {
    logoutSource: (ctx, form) => {
      ctx.type = 'html';
      ctx.status = 200;
      // 確認フォームの送信元は backend 自身（同一オリジン）。helmet の既定 Referrer-Policy
      // no-referrer のままだと Chrome は form POST の Origin を `null` にする（実測）。すると
      // CORS ミドルウェアが同一オリジンと判定できず 403 で止まる。この画面だけ same-origin に
      // して実際の Origin を送らせる（参照元は同じオリジン内に留まる＝no-referrer より緩めない）。
      ctx.set('referrer-policy', 'same-origin');
      // 戻り先オリジンを form-action に足す（足さないと Chrome が送信自体を止める・実測）。
      allowPostLogoutFormAction(ctx);
      // form は provider が組み立てたもの（end_session_confirm への POST + xsrf 入り）。
      // ここで別の form を組むと xsrf の出所が二重になるため、必ず provider の form を使う。
      if (hintMatchesSession(ctx)) {
        pushInlineScriptSha(ctx, AUTO_SUBMIT_SCRIPT);
        ctx.body = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ログアウトしています</title>
  <script>${AUTO_SUBMIT_SCRIPT}</script>
</head>
<body>
  <p>ログアウトしています。画面が切り替わらない時は下のボタンを押してください。</p>
  ${form}
  <button autofocus type="submit" form="op.logoutForm" name="logout" value="yes">ログアウトする</button>
</body>
</html>`;
        return;
      }

      // 本人が一致しない（id_token_hint 無し・他人の hint・期限切れ等）時は既定と同じ確認ページ。
      ctx.body = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ログアウトの確認</title>
</head>
<body>
  <h1>${htmlSafe(ctx.host)} からログアウトしますか？</h1>
  ${form}
  <button autofocus type="submit" form="op.logoutForm" name="logout" value="yes">ログアウトする</button>
  <button type="submit" form="op.logoutForm">ログアウトしない</button>
</body>
</html>`;
    },
  };
}
