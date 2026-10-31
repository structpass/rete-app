/**
 * rete E2E 認証ヘルパー
 *
 * globalSetup で事前生成したセッションクッキーを使い、
 * ログイン API を叩かずに認証済み APIRequestContext を返す。
 * セッション有効性チェックの余分なリクエストは行わない
 * （失効していれば当該テストが 401 で失敗するため検出可能）。
 */

import { request } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import path from 'path';
import fs from 'fs/promises';

/**
 * 対象 backend。既定は開発統括ローカルの dev サーバー（:3011）。
 * 隔離チェックアウトの backend など別インスタンスへ向けたい時は E2E_BASE_URL で上書きする
 * （スイート全体が同じ backend を叩く前提なので、ここ1箇所だけを見る）。
 */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3011';

/**
 * 画面（frontend）の置き場。UI の破損を捕まえる試験（画面の点検）が最初に開く URL。
 *
 * 画面と backend は置き場所が別で、画面は Cookie のドメインでしか入場できない。
 * ここを E2E_API 系の URL から導くと画面では未ログインになり、壊れていない画面を赤にする。
 */
export const FRONTEND_URL = process.env.E2E_FRONTEND_URL ?? 'http://localhost:3010';

/**
 * 画面用の Cookie（同じセッションを画面の置き場へ向け直したもの）。
 *
 * 保存したセッションの Cookie は backend の置き場（127.0.0.1）に結び付いているため、
 * そのまま画面へ渡しても持ち込まれず未ログインのまま開く。中身（値）は変えず、ドメインだけを
 * 画面の置き場に合わせる。
 */
export function frontendCookies(
  cookies: { name: string; value: string; path: string }[],
  base: string = FRONTEND_URL,
): { name: string; value: string; path: string; domain: string }[] {
  const host = new URL(base).hostname;
  return cookies.map((c) => ({ name: c.name, value: c.value, path: c.path, domain: host }));
}

/** もう一方のローカル名（既定が localhost なら 127.0.0.1、その逆）。同じ置き場を別名で確かめる時に使う。 */
export function alternateFrontendUrl(base: string = FRONTEND_URL): string | null {
  try {
    const u = new URL(base);
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) return null;
    u.hostname = u.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    return u.origin;
  } catch {
    return null;
  }
}

/** seed に存在する認証情報 */
export const CREDENTIALS = {
  admin: { email: 'admin@rete.local', password: 'ReteAdmin1234!', key: 'admin' },
  /** システム MEMBER（org-change / space-scope の可視・越境シナリオで使用） */
  member: { email: 'of-admin@struct-pass.example', password: 'ReteDemo1234!', key: 'member' },
  /** システム MEMBER（非メンバー PJ のチャネルが見えないこと＝S-SPC-05） */
  whUser: { email: 'wh-user@struct-pass.example', password: 'ReteDemo1234!', key: 'whUser' },
  /** システム MEMBER（異動・脱退で可視が切れること＝org-change） */
  newcomer: { email: 'newcomer@struct-pass.example', password: 'ReteDemo1234!', key: 'newcomer' },
  /** cmn-0139: mfa-login.feature 専用。seed 固定・MFA 無効で焼き込み、シナリオ内 setup→confirm→teardown disable。*/
  mfaUser: { email: 'mfa-user@rete.local', password: 'ReteDemo1234!', key: 'mfaUser' },
  /** cmn-0140: org-change.feature 退職ロック対象。システム ADMIN（bootstrap admin との2名体制でロックしても管理者ゼロにならない）。 */
  tanaka: { email: 'tanaka@struct-pass.example', password: 'ReteDemo1234!', key: 'tanaka' },
} as const;

/** メールアドレスで CREDENTIALS エントリを引く（seed 未存在は throw）。散在していた Object.values(CREDENTIALS).find の単一ソース（cmn-0161）。 */
export function credByEmail(email: string) {
  const c = Object.values(CREDENTIALS).find((x) => x.email === email);
  if (!c) throw new Error(`seed に存在しないメール: ${email}`);
  return c;
}

const SESSION_DIR = path.join(__dirname, '..', '.cache', 'sessions');

/** 応答本文から { data: { mfaRequired } } を読む（MFA ありの人がパスワード段だけで止まったか）。 */
async function mfaPending(res: { json: () => Promise<unknown> }): Promise<boolean> {
  try {
    const body = (await res.json()) as { data?: { mfaRequired?: boolean } | null };
    return body.data?.mfaRequired === true;
  } catch {
    return false;
  }
}

/**
 * ログイン（MFA を有効にした人がパスワード段で止まった時は、2 段目も済ませる）。
 *
 * MFA を有効にした人はパスワード段では認証が確定しない（/auth/me が null のまま）。E2E の大半は
 * その人を使わないが、後片付けの済んでいない控えを持つ人は止まるため、入口で 2 段目まで通せるようにしておく。
 * 控えが手元に無ければ 1 段目の応答をそのまま返す（「入れなかった」を呼び出し側が判定できる）。
 */
async function postLogin(
  ctx: APIRequestContext,
  email: string,
  password: string,
): Promise<APIResponse> {
  const res = await ctx.post('/api/v1/auth/login', { data: { email, password } });
  if (!res.ok() || !(await mfaPending(res))) return res;
  return res;
}

/**
 * ログインし直す前に、古い接続が持ち越していた状態（MFA チャレンジ待ち）を捨てる。
 * 開発機専用の口（/auth/self-heal）。本番では同じ経路が 403 を返して何も変えない
 * （route 自体は登録され、処理の先頭で NODE_ENV=production を弾く・d849）。
 */
export async function discardStuckSession(ctx: APIRequestContext): Promise<void> {
  await ctx.post('/api/v1/auth/self-heal').catch(() => undefined);
}

/**
 * 事前生成したセッションを使い認証済み APIRequestContext を返す。
 * セッションファイルが無い場合はフォールバックとしてログインして生成する。
 */
export async function createAuthenticatedContext(email: string, password: string) {
  const cred = Object.values(CREDENTIALS).find((c) => c.email === email);
  const key = cred?.key ?? 'unknown';
  const sFile = path.join(SESSION_DIR, `${key}.json`);

  // 保存済みセッションを使う（有効性チェックは省略して余分なリクエストを出さない）
  try {
    const raw = await fs.readFile(sFile, 'utf-8');
    const state = JSON.parse(raw) as {
      cookies: {
        name: string;
        value: string;
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        // Playwright の storageState が書き出す値そのもの。string へ広げると
        // request.newContext({ storageState }) の cookies 型と合わず型検査で落ちる。
        sameSite: 'Strict' | 'Lax' | 'None';
      }[];
    };
    if (state.cookies && state.cookies.length > 0) {
      const ctx = await request.newContext({
        baseURL: BASE_URL,
        storageState: { cookies: state.cookies, origins: [] },
      });
      // 保存済みのセッションが生きているかだけを見る（/auth/me は未ログインでも 200 を返す契約なので、
      // 「本人が返るか」で判定できる）。前日の試験中に全員へ MFA 強制を掛けたまま止まっていた・サーバー側で
      // 期限が切れた、といった時に、死んだ cookie を配り続けると後続の全シナリオが巻き添えで赤になる。
      const me = await ctx.get('/api/v1/auth/me').catch(() => null);
      const alive = (() => {
        try {
          return Boolean(me?.ok());
        } catch {
          return false;
        }
      })();
      const body = alive ? ((await me!.json()) as { data?: { id?: string } | null }) : null;
      if (body?.data?.id) return ctx;
      await ctx.dispose();
    }
  } catch {
    // セッションファイルが無い/壊れている → フォールバック
  }

  // フォールバック: 直接ログイン
  const ctx = await request.newContext({ baseURL: BASE_URL });
  // 前回の試験が残した状態（MFA チャレンジ待ち・全員への MFA 強制）を捨ててから入る。捨てても入り直しに
  // 失敗するならその旨を出したいので、まず捨て、それでも入れない時は応答をそのまま報告する。
  await discardStuckSession(ctx);
  const res = await postLogin(ctx, email, password);
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Login failed for ${email}: ${res.status()} ${body}`);
  }
  // 本物のパスワードで入れたので、ロック（失敗回数）が残っていても解除しておく。
  // 全員への MFA 強制やロックが日をまたいで残ると、別の試験の「正しいパスワードで入れる」まで巻き添えになる。
  if (cred) {
    const id = ((await res.json()) as { data?: { id?: string } }).data?.id;
    if (id) await ctx.patch(`/api/v1/members/${id}/unlock`).catch(() => undefined);
  }

  // 生成したセッションを保存（次回以降に使う）
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const saved = await ctx.storageState();
    await fs.writeFile(sFile, JSON.stringify(saved, null, 2), 'utf-8');
  } catch {
    // 保存失敗は無視（テスト自体は続行）
  }

  return ctx;
}
