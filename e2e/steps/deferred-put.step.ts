/**
 * 途中でも済ませる後始末（PUT 版）— 2026-10-25
 *
 * `steps/extended.steps.ts` の `PATCH … => システムADMIN "…"` と同じ記法を、**全置換の PUT** にも使えるように
 * する。パスワードポリシー（`PUT /settings/login/password-policy`）のように、シナリオの途中で
 * 全ユーザー共通の設定を作り変える手順は、途中で落ちると設定が戻らず、後続のシナリオや手元の操作を
 * 壊す（MFA 強制が残ると全員が業務画面へ入れなくなる）。
 *
 * 挙動は PATCH 版と同じ: 末尾に `=> システムADMIN "<メール>"` を付けた行は「後始末でも流し直す手順」
 * として登録し、手順どおり 2xx で通り終えた行は印を付けて後始末では流さない（二重に戻さない）。
 * 記法と判定の実体は `support/deferred-teardown.ts`、手順の配線はこのファイル。
 */

import { Given, When } from '../support/fixtures';
import { createAuthenticatedContext, credByEmail } from '../support/auth';
import { resolveRequest } from '../support/placeholders';
import { splitActorSuffix } from '../support/deferred-teardown';

/** 戻し先（全置換の PUT）。戻す対象の呼び名から API のパスを引く。 */
const RESTORE_ROUTES: Record<string, string> = {
  '強制 MFA を': '/api/v1/settings/login/password-policy',
  パスワードポリシーを: '/api/v1/settings/login/password-policy',
};

/**
 * 「後始末でも流し直す」戻し行。`<何を> body "<値>" で戻す => システムADMIN "<メール>"` と書き、
 * 叩き先は何を書いたかで決まる（feature 側に API のパスを書かせない）。
 *
 * 戻し値を本体の行と別に書くのは、**本体と独立に戻せる**ようにするため。本体の設定値は後から
 * 書き換わる一方、戻す値は既定のまま据え置きたい（同じ行にまとめると本体の変更で戻し値がずれる）。
 */
Given(
  '{word} MFA を body {string} で戻す => システムADMIN {string}',
  async ({ world }, what: string, bodyStr: string, email: string) => {
    await restore(world, `${what} MFA を`, bodyStr, email);
  },
);

Given(
  'パスワードポリシーを body {string} で戻す => システムADMIN {string}',
  async ({ world }, bodyStr: string, email: string) => {
    await restore(world, 'パスワードポリシーを', bodyStr, email);
  },
);

/** 戻し行の実体（2 つの書き方のどちらから来ても同じ手順を流す）。 */
async function restore(
  world: {
    deferredSteps: import('../support/deferred-teardown').DeferredStep[];
    auxiliaryContexts: import('@playwright/test').APIRequestContext[];
    uniqueNames: Record<string, string>;
    lastResponse: import('@playwright/test').APIResponse | null;
  },
  what: string,
  bodyStr: string,
  email: string,
): Promise<void> {
  const path = RESTORE_ROUTES[what];
  if (!path) {
    throw new Error(`戻し先が決まっていない: ${what}（RESTORE_ROUTES に足してください）`);
  }
  const bodyPart = splitActorSuffix(bodyStr);
  world.deferredSteps.push({ path, body: bodyPart.text, email, settled: false });

  const cred = credByEmail(email);
  const actorCtx = await createAuthenticatedContext(cred.email, cred.password);
  world.auxiliaryContexts.push(actorCtx);
  const req = resolveRequest(path, bodyPart.text, world.uniqueNames);
  world.lastResponse = await actorCtx.put(req.path, { data: req.body });

  // 通った時点で戻しは済んでいる。この後にシナリオが落ちても流し直さない（二重に戻さない）。
  if (world.lastResponse.ok()) world.deferredSteps[world.deferredSteps.length - 1].settled = true;
}

When(
  'PUT {string} を body {string} で叩く => システムADMIN {string}',
  async ({ world }, urlPath: string, bodyStr: string, email: string) => {
    const pathPart = splitActorSuffix(urlPath);
    const bodyPart = splitActorSuffix(bodyStr);
    // 登録は変数を解決する前の形で持つ（シナリオが途中で落ちても同じ値で流し直せるように）。
    world.deferredSteps.push({
      path: pathPart.text,
      body: bodyPart.text,
      email,
      settled: false,
    });

    const cred = credByEmail(email);
    const actorCtx = await createAuthenticatedContext(cred.email, cred.password);
    world.auxiliaryContexts.push(actorCtx);

    const req = resolveRequest(pathPart.text, bodyPart.text, world.uniqueNames);
    world.lastResponse = await actorCtx.put(req.path, { data: req.body });

    // 通った時点でこの行は「手順として流れ終えた」。この後にシナリオが落ちても流し直さない。
    if (world.lastResponse.ok()) world.deferredSteps[world.deferredSteps.length - 1].settled = true;
  },
);
