/**
 * rete E2E — org-change (cmn-0140 / P4 組織変更の運用イベント) ステップ定義
 *
 * common.steps.ts の語彙（POST id 記録 / DELETE / 一覧アサート等）と組み合わせ、
 * org-change.feature 固有のステップのみを定義する（playwright-bdd は同一パターンの
 * 重複定義を禁止するため、既存パターンは再定義せず再利用する）。
 *
 * 設計上の注意:
 * - ログイン throttle（/api/v1/auth/login = 5req/60s・IP 共有）を消費するのは
 *   「seed ユーザーのセッション確立（fallback 時のみ）」と「ロック後の再ログイン試行」
 *   の 2 経路だけ。feature 側でシナリオ集約＋セッションキャッシュ再利用と合わせ、
 *   workers:1 順次実行で上限内に収める（詳細は org-change.feature ヘッダ参照）。
 * - 補助セッションとログイン試行 context は afterEach で dispose し、P4-01 は途中失敗時も
 *   seed ユーザーの isActive を必ず復元する。
 */

import path from 'path';
import fs from 'fs/promises';
import { request, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { createAuthenticatedContext, BASE_URL, CREDENTIALS, credByEmail } from '../support/auth';
import { resolvePlaceholders as resolveVars, resolveListItems } from './common.steps';
import { tappedIdsOf } from '../support/response-fingerprint';

/**
 * シナリオ内で並存させる補助セッション（ victim 側 = ロック対象者のセッション等）。
 * world.apiCtx は単一スロットのため、actor 側（admin）と victim 側の並存はここで持つ。
 * workers:1（単一プロセス・順次実行）前提のモジュール状態。
 */

// body/path 内の {{key}} 置換と一覧正規化は common.steps.ts 経由で import する。
// 置換の実体は cmn-0336 で support/placeholders.ts へ移り、common.steps.ts がそれを再 export する。

/** GET /api/v1/auth/me からセッション本人の id を取る（未認証なら null） */
async function fetchMeId(ctx: APIRequestContext): Promise<string | null> {
  const res = await ctx.get('/api/v1/auth/me');
  if (res.status() !== 200) return null;
  const body = (await res.json()) as { data: { id: string } | null };
  return body.data?.id ?? null;
}

// ----------------------------------------------------------------
// Given — seed ユーザーの固定値・補助セッション確立
// ----------------------------------------------------------------

Given('固定値 {string} を {string} に保存する', async ({ world }, value: string, key: string) => {
  world.uniqueNames[key] = value;
});

Given(
  'seed ユーザー {string}（パスワード {string}）としてログインし、セッションと自分の id を {string} に保存する',
  async ({ world }, emailArg: string, passwordArg: string, key: string) => {
    // cmn-0397: 入口で 1 度解決し、以後は解決済みの値だけを使う。同じ引数をキャッシュログイン・
    // 資格引き当て・比較にも使うため、ここで揃えないと同一 step 内で解決済みと未解決が割れる。
    const email = resolveVars(emailArg, world.uniqueNames);
    const password = resolveVars(passwordArg, world.uniqueNames);
    // auth.ts のセッションキャッシュ（あれば再利用＝throttle 消費 0）→ 無効なら直接ログイン。
    let ctx = await createAuthenticatedContext(email, password);
    let id = await fetchMeId(ctx);

    if (!id) {
      // 保存セッションが失効（backend TTL 24h 超等）→ 直接ログインしキャッシュを上書きする。
      await ctx.dispose();
      ctx = await request.newContext({ baseURL: BASE_URL });
      const res = await ctx.post('/api/v1/auth/login', { data: { email, password } });
      expect(res.status(), `${email} のログインが成功すること`).toBe(200);
      const cred = credByEmail(email);
      const sKey = cred.key;
      const sFile = path.join(__dirname, '..', '.cache', 'sessions', `${sKey}.json`);
      await fs.writeFile(sFile, JSON.stringify(await ctx.storageState(), null, 2), 'utf-8');
      id = await fetchMeId(ctx);
      if (!id) {
        throw new Error(
          `${email} のログインは 200 だが /auth/me が未認証 — 強制 MFA 等の別要因を疑うこと`,
        );
      }
    }

    world.sessions[key] = ctx;
    world.sessionOwners[key] = email;
    world.auxiliaryContexts.push(ctx);
    if (email === CREDENTIALS.tanaka.email) {
      world.restoreAccountIds.push(id);
    }
    world.apiCtx = ctx;
    world.uniqueNames[key] = id;
  },
);

// ----------------------------------------------------------------
// When — 保存セッションでの操作 / ログイン試行 / 一覧からの値抽出
// ----------------------------------------------------------------

When(
  '保存セッション {string} で GET {string} を叩く',
  async ({ world }, key: string, urlPath: string) => {
    const ctx = world.sessions[key];
    if (!ctx) {
      throw new Error(`保存セッション ${key} が見つからない — 先に確立 step を実行してください`);
    }
    const resolved = resolveVars(urlPath, world.uniqueNames);
    world.lastResponse = await ctx.get(resolved);
    world.tappedIds = tappedIdsOf(resolved);
  },
);

When(
  'メール {string}・パスワード {string} でログインを試みる',
  async ({ world }, emailArg: string, passwordArg: string) => {
    // 失敗が期待されるログイン試行（ロック後 401 / throttle 窓内では 429）。
    // Then が body を読んだ後、afterEach で context を破棄する。
    // cmn-0397: 入口で 1 度解決し、以後は解決済みの値だけを使う。
    const email = resolveVars(emailArg, world.uniqueNames);
    const password = resolveVars(passwordArg, world.uniqueNames);
    const ctx = await request.newContext({ baseURL: BASE_URL });
    world.auxiliaryContexts.push(ctx);
    world.lastResponse = await ctx.post('/api/v1/auth/login', { data: { email, password } });
  },
);

When(
  'レスポンス配列から {string} が {string} と一致する要素の id を {string} に保存する',
  async ({ world }, field: string, expected: string, key: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    const exp = resolveVars(expected, world.uniqueNames);
    const hit = resolveListItems(body.data).find((e) => String(e[field]) === exp);
    if (hit?.id == null) {
      throw new Error(`${field}=${exp} の要素が見つからない（または id が無い）`);
    }
    world.uniqueNames[key] = String(hit.id);
  },
);

// ----------------------------------------------------------------
// Then — ステータス / 一覧フィールドアサート
// ----------------------------------------------------------------

Then('ステータスコード {int} または {int} が返る', async ({ world }, a: number, b: number) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const actual = world.lastResponse.status();
  let bodyText = '';
  try {
    bodyText = JSON.stringify(await world.lastResponse.json());
  } catch {
    bodyText = await world.lastResponse.text();
  }
  expect(
    [a, b],
    `ステータスコード ${a} または ${b} を期待 (実際: ${actual}) — body: ${bodyText}`,
  ).toContain(actual);
});

Then(
  'レスポンス配列の {string} 一覧に {string} が含まれる',
  async ({ world }, field: string, expected: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    const exp = resolveVars(expected, world.uniqueNames);
    const values = resolveListItems(body.data).map((e) => String(e[field]));
    expect(values, `一覧の ${field} に "${exp}" が含まれること`).toContain(exp);
  },
);

Then(
  'レスポンス配列の {string} 一覧に {string} が含まれない',
  async ({ world }, field: string, expected: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    const exp = resolveVars(expected, world.uniqueNames);
    const values = resolveListItems(body.data).map((e) => String(e[field]));
    expect(values, `一覧の ${field} に "${exp}" が含まれないこと`).not.toContain(exp);
  },
);

Then(
  'レスポンス配列で {string} が {string} と一致する要素は {int} 件',
  async ({ world }, field: string, expected: string, count: number) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    const exp = resolveVars(expected, world.uniqueNames);
    const actual = resolveListItems(body.data).filter((e) => String(e[field]) === exp).length;
    expect(actual, `${field}=${exp} の要素が ${count} 件であること（重複排除の検証）`).toBe(count);
  },
);
