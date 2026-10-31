/**
 * SSO 横断ジャーニー UI-E2E（cmn-0141・ui-sso project）
 *
 * reference（RP）× rete（IdP）の OIDC SSO 往復をブラウザで検証する。
 * reference は SSO 一本化済み（passwordHash 撤去・/login 到達で即 OIDC 遷移）のため、
 * SSO 退行 = reference 全体の入場不能（製品全損）。本 spec が唯一の自動退行ガード。
 *
 * フロー（3オリジン跨ぎ・ホストは localhost 固定必須）:
 *   http://localhost:3000/login（reference FE・OIDC 開始へ自動遷移）
 *     → http://localhost:3001/api/v1/auth/oidc/login（reference BE・302）
 *     → http://localhost:3011/api/v1/oidc/auth（rete provider・interaction 生成）
 *     → http://localhost:3010/login?uid=<uid>（rete FE ログインフォーム）
 *     → resume → callback → http://localhost:3000/home（着地・/dashboard ではない）
 *
 * ホスト注意: rete CORS / OIDC issuer・redirect / cookie ドメインはすべて localhost のみ許可。
 * 127.0.0.1 を混ぜると cookie ドメイン不一致と CORS ブロックで seamless 経路が壊れる。
 *
 * 起動前提: reference / rete の2系統稼働。
 * 不達なら test.skip で明示スキップ（red にしない）。旧Board v1はこの検証対象ではない。
 *
 * 状態への反映（d827）: この spec は 01-auth.md の実施ケースの `実行` 欄（`自動 @S-AUTH-04`）が指す
 * 自動試験だが、playwright-bdd の外（ui/ 配下の通常 spec）にあり、フィクスチャの「確認済みにする」行を
 * 使えなかった。そのため緑でも表が ⬜ のままだった。緑になった時に自分が担う行を控え、
 * 後始末で読み出して確かめる（控えの置き場は support/verified-cases.ts の 1 つに保つ）。
 */

import { test, expect, request, type Page } from '@playwright/test';
import { CREDENTIALS } from '../support/auth';
import {
  beginScenario,
  endScenario,
  markVerifiedCase,
  resetVerifiedCases,
  verifiedCasesFor,
} from '../support/verified-cases';

const REFERENCE_FE = 'http://localhost:3000';
const RETE_FE = 'http://localhost:3010';

/** rete bootstrap admin — reference 側 SYS_ADMIN（admin@struct-pass.example）へ oidcSub リンク済み（JIT pending にならず /home 着地）。認証情報は support/auth.ts の CREDENTIALS を単一ソースに（cmn-0161）。 */
const ADMIN = CREDENTIALS.admin;

let referenceUp = false;

async function isReachable(url: string): Promise<boolean> {
  const ctx = await request.newContext();
  try {
    const res = await ctx.fetch(url, { timeout: 5_000 });
    return res.status() < 500;
  } catch {
    return false;
  } finally {
    await ctx.dispose();
  }
}

/**
 * /home 着地の確定待ち（rete-top-0006）。
 *
 * 旧実装は `waitForTimeout(1_500)` + `page.url()` 文字列検査だったが、固定 sleep は
 * CI マシンで flake り、URL 検査は SPA ルータの実装詳細に依存していた。
 * 代わりに reference の認証済みシェル（AppShell）が描画する要素の出現を待つ。
 * AppShell は `loading || !user` の間は何も描画せず、SSO 退行で /login?error=sso へ
 * 戻された場合はログアウトボタンごと消えるため、「認証済みで /home に留まっている」ことの
 * 直接シグナルになる。
 *
 * 注: /home 固有の `.home-summary` ではなくシェル側の要素を待つのは、前者が
 * `/dashboard/counts` のデータ取得成功に依存し、SSO とは無関係な API 障害を
 * 新しい flake 源として持ち込むため（本 spec の関心は入場可否のみ）。
 */
async function expectHomeLanded(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible({ timeout: 30_000 });
  expect(page.url()).toContain('/home');
  expect(page.url()).not.toContain('error=sso');
}

/**
 * 1 シナリオを、確認済みの控えの仕組みに載せて走らせる（support/verified-cases.ts）。
 *
 * - 走る前に控えを空にする（前のシナリオを持ち越さない）
 * - 本文が緑の時だけ「この行を確認済み」と控える（落ちた時は控えに到達しない）
 * - 後始末で、そのシナリオの終わりとして結果を渡し、残った控えを読む
 *
 * 判定の本体は本文の assert が持つ。この行は「ここまで通った」ことだけを控える。
 */
async function scenarioWithClaim(trackId: string, fn: () => Promise<void>): Promise<string[]> {
  resetVerifiedCases();
  const scenarioId = beginScenario();
  let rows: string[] = [];
  try {
    await fn();
    markVerifiedCase(trackId);
    rows = verifiedCasesFor();
  } catch (error) {
    endScenario(scenarioId, 'failed');
    throw error;
  }
  endScenario(scenarioId, 'passed');
  return rows;
}

test.beforeAll(async () => {
  referenceUp = await isReachable(`${REFERENCE_FE}/login`);
});

test.describe('SSO 横断ジャーニー（reference RP × rete IdP）', () => {
  test('password 経路: reference /login → rete ログインフォーム入力 → /home 入場', async ({
    page,
  }) => {
    test.skip(!referenceUp, 'reference/rete 未起動 — skip（red にしない）');

    // 期待の 3 点（rete のログイン画面へ回ること・同意画面が出ないこと・reference のホームへ着地し
    // URL に uid が付くこと）が、この緑で決まる。
    const rows = await scenarioWithClaim('S-AUTH-05', async () => {
      await page.goto(`${REFERENCE_FE}/login`);

      // reference FE が OIDC を自動開始 → rete provider が interaction を生成し
      // rete /login?uid= へ遷移（reference は uid を一切扱わない・生成元は rete provider）
      await page.waitForURL(/localhost:3010\/login\?uid=/, { timeout: 60_000 });

      // 資格情報を入力して interaction を完了（POST /auth/interaction/:uid/login）
      await page.locator('#email').fill(ADMIN.email);
      await page.locator('#password').fill(ADMIN.password);
      await page.getByRole('button', { name: 'ログイン' }).click();

      // resume → OIDC callback → reference /home 着地（role あり＝/pending 非経由）
      await page.waitForURL(`${REFERENCE_FE}/home`, { timeout: 60_000 });
      await expectHomeLanded(page);
    });

    // 緑なのに控えが残らないのは、控えの付け方の不具合（実行の結果と表がずれる）。
    expect(rows, 'S-AUTH-05 の確認済みの控えが残らなかった').toContain('S-AUTH-05');
  });

  test('seamless 経路: rete ログイン済み → フォーム入力なしで reference へ透過入場', async ({
    page,
  }) => {
    test.skip(!referenceUp, 'reference/rete 未起動 — skip（red にしない）');

    // rete のセッションだけで通った（フォームが出ない）ことが、この緑で決まる。
    const rows = await scenarioWithClaim('S-AUTH-04', async () => {
      // 1) rete へ通常ログインし express-session（connect.sid @ localhost:3011）を確立。
      //    OIDC provider のロングセッションはこの context に無い（= interaction は必ず生成され、
      //    login-form の session-login 救済経路が確実に踏まれる）。
      await page.goto(`${RETE_FE}/login`);
      await page.locator('#email').fill(ADMIN.email);
      await page.locator('#password').fill(ADMIN.password);
      await page.getByRole('button', { name: 'ログイン' }).click();
      await page.waitForURL(`${RETE_FE}/hub`, { timeout: 60_000 });

      // 2) reference /login へ — rete セッションをゲートに session-login が自動発火し、
      //    email/password フォームは一切描画されず /home へ透過入場する。
      //    退行時（session-login 未発火/401）はフォーム描画で入力待ちになり
      //    waitForURL がタイムアウトする（= 退行シグナル）。
      await page.goto(`${REFERENCE_FE}/login`);
      await page.waitForURL(`${REFERENCE_FE}/home`, { timeout: 60_000 });
      await expectHomeLanded(page);
    });

    expect(rows, 'S-AUTH-04 の確認済みの控えが残らなかった').toContain('S-AUTH-04');
  });
});
