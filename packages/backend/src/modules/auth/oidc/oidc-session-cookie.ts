import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';

/**
 * oidc-provider の `_session` cookie（SSO セッション）の読み取りと破棄。
 *
 * provider は Koa の `cookies`（keygrip 署名）で `_session=<jti>` と `_session.sig=<署名>` の
 * 2 枚を発行する。ログアウト時に「cookie に書かれた値をそのままセッション id として消す」と、
 * 他人の session id を投げれば他人の SSO セッションを消せる経路になるため、**必ず署名を検証**し、
 * 検証が通った値だけを id として返す（d1269）。
 *
 * keygrip の署名形式（HMAC-SHA1 → base64 → base64url 変形）に合わせる。鍵は provider が実際に
 * 使っている `provider.keys`（= `OIDC_COOKIE_KEYS`）を渡し、ここで env を読み直さない
 * （鍵の正本を 2 箇所に持たない）。
 */

/** 署名アルゴリズムは keygrip の既定（oidc-provider の cookie 署名）。 */
const SIGNATURE_ALGORITHM = 'sha1';

/** oidc-provider が SSO セッションに使う cookie 名（provider の types に定数が無いため 1 か所に固定する）。 */
export const OIDC_SESSION_COOKIE = '_session';

/** cookie ヘッダから `name` の最初の値を取り出す（同名が並ぶ場合は先勝ち）。 */
export function readCookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return undefined;
}

/** keygrip と同じ手順で署名する（base64 の `+` `/` `=` を base64url へ寄せる）。 */
export function signCookieValue(key: string, data: string): string {
  return createHmac(SIGNATURE_ALGORITHM, key)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 署名付き cookie の値を返す。署名が無い・一致しない・鍵が無い場合は undefined（= 未検証として扱う）。
 * 複数鍵（rotation 中の旧鍵）はどれか 1 つに一致すれば通す。
 */
export function readSignedCookieValue(
  cookieHeader: string | undefined,
  name: string,
  keys: readonly string[],
): string | undefined {
  if (!Array.isArray(keys) || keys.length === 0) return undefined;
  const value = readCookieValue(cookieHeader, name);
  if (!value) return undefined;
  const signature = readCookieValue(cookieHeader, `${name}.sig`);
  if (!signature) return undefined;

  const data = `${name}=${value}`;
  const provided = Buffer.from(signature);
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) continue;
    const expected = Buffer.from(signCookieValue(key, data));
    // 長さが違うと timingSafeEqual が throw するため先に比較する（長さの差は署名の差として扱う）。
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return value;
  }
  return undefined;
}

/**
 * `_session` と `_session.sig` を Max-Age=0 で消す。
 *
 * provider は path='/' / sameSite=lax / httpOnly で発行しているため、属性を揃えないと
 * ブラウザによっては消えない（属性が違うと別 cookie 扱いになる）。
 * secure は「今のリクエストが https か」に合わせる（http で secure 付きの削除ヘッダを送ると弾かれる）。
 */
export function clearOidcSessionCookies(res: Response, secure: boolean): void {
  const options = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure, maxAge: 0 };
  res.clearCookie(OIDC_SESSION_COOKIE, options);
  res.clearCookie(`${OIDC_SESSION_COOKIE}.sig`, options);
}
