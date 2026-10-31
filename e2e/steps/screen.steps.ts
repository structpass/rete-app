/**
 * 画面の点検（画面が壊れていないこと）の手順 — d784。
 *
 * API の手順は「通信の応答」しか見ないため、画面が白くなる・赤い枠が出る・画面の実行時エラーで
 * 止まる、といった破損は緑のまま通り抜ける（実測 2026-10-25: 画面 6 枚が 500 で真っ白の間に、
 * E2E のシナリオは緑のまま）。ここは実ブラウザで画面を開き、画面そのものの破損を捕まえる。
 *
 * 画面の置き場・Cookie の向け直しは support/fixtures.ts（openSignedInPage）が行う。
 */

import { expect } from '@playwright/test';
import { Given, Then, When } from '../support/fixtures';
import { openReachableScreen, type VisitedScreen } from '../support/fixtures';
import { CREDENTIALS } from '../support/auth';

/** このシナリオで開いた画面（手順をまたいで読む）。 */
const visited: VisitedScreen[] = [];

function joined(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

Given('画面の点検に使う管理者でログインし直す', async ({ screen, screenFaults }) => {
  visited.length = 0;
  // 画面の置き場を開けること自体を先に確かめる（置き場が落ちている時に「全部赤」となる前に、
  // 何が起きたかをこの 1 行で切り分けられるようにする）。
  await openReachableScreen(screen, screenFaults, '/hub', CREDENTIALS.admin);
});

When('画面 {string} を開いて描き上がりを待つ', async ({ screen }, route: string) => {
  const page = screen.pages[0];
  if (!page) throw new Error('先に「画面の点検に使う管理者でログインし直す」を通す');
  const started = Date.now();
  // 画面の置き場が応答しない時は、ここで理由を添えて落とす（待ち切って「白い画面」に化けさせない。
  // 白い画面は画面の中身の破損を指す判定なので、開けないこととは分けて読ませる）。
  const res = await page
    .goto(`${screen.base}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .catch((e: unknown) => {
      throw new Error(
        `画面 ${route} を開けない（描き上がりが遅いか、画面の置き場が応答しない）: ${String(e).split('\n')[0]}`,
      );
    });
  expect(res?.status() ?? 0, `画面 ${route} が開けない（HTTP ${res?.status()}）`).toBeLessThan(500);
  // 画面は一覧などの取得が終わってから描き上がる。中身（本文の文字）が現れるまで待つ。
  // 現れなければ次の手順が「白くなっている」として弾く。
  await page
    .waitForFunction(() => (document.body?.innerText ?? '').trim().length > 0, undefined, {
      timeout: 30_000,
    })
    .catch(() => undefined);
  // 取得中の遅い通信を拾い切る（待ち切れずに途切れた後でも、画面の中身の判定は続ける）。
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
  const text = joined(
    await page
      .locator('body')
      .innerText()
      .catch(() => ''),
  );
  // 判定は「開いたこの瞬間」の画面で控える。1 つのページで 5 枚を順に開くため、判定の手順で
  // 読み直すと最後の 1 枚しか見えない（実測 2026-10-26: 2 枚目を壊しても緑のまま通った・d785）。
  // 壊れた画面の表示（d785）も、白い画面として弾くだけだと原因（中身を作る処理の失敗）が
  // 読み取れないため、表示そのものを名指しで控える（データが無いだけの空表示と区別する）。
  const broken = await page
    .locator('[data-screen-broken="true"]')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  const login = await page
    .evaluate(() => {
      const hasPassword = Array.from(document.querySelectorAll('input')).some(
        (el) => (el.getAttribute('type') ?? '').toLowerCase() === 'password',
      );
      return hasPassword || /Rete\s*Login/i.test(document.body?.innerText ?? '');
    })
    .catch(() => false);
  const crashed = /Application error|Unhandled Runtime Error|Something went wrong/i.test(text);
  visited.push({
    route,
    elapsedMs: Date.now() - started,
    textLength: text.length,
    broken,
    login,
    crashed,
  });
});

Then('どの画面も白くなっていない', async ({ screen, world }) => {
  expect(screen.pages.length).toBeGreaterThan(0);
  // 画面 1 枚ずつを、開いた時点の控え（visited）で判定する。白い画面（本文がほぼ無い）と、
  // ログイン画面へ押し戻された画面（画面の中身の取得が落ちるとこうなる。実測 2026-10-26: API を
  // 500 にすると /hub はログイン画面（本文 39 字）になる）。
  const blank: string[] = [];
  const bounced: string[] = [];
  const crashed: string[] = [];
  const broken: string[] = [];
  expect(visited.length, '開いた画面の控えが無い').toBeGreaterThan(0);
  for (const screen of visited) {
    if (screen.broken) broken.push(screen.route);
    if (screen.textLength <= 50) blank.push(`${screen.route}（本文 ${screen.textLength} 字）`);
    else if (screen.login && screen.route !== '/login')
      bounced.push(`${screen.route}（ログイン画面へ押し戻された）`);
    if (screen.crashed) crashed.push(screen.route);
  }
  world.screen = visited;
  expect(broken, '壊れた画面の表示が出た画面（中身を作る処理が失敗している）').toEqual([]);
  expect(blank, '白い画面').toEqual([]);
  expect(bounced, 'ログイン画面へ押し戻された画面').toEqual([]);
  expect(crashed, '例外の枠が出た画面').toEqual([]);
});

Then('どの画面も中の行き先が出ていて、本文が殻だけになっていない', async ({ screen }) => {
  const problems: string[] = [];
  for (const page of screen.pages) {
    const path = new URL(page.url()).pathname;
    // 置き場が別名（127.0.0.1）の時、行き先は絶対 URL で書かれる。行き先の判断は URL の道筋で見る。
    const paths = new Set(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map((a) => {
          const href = a.getAttribute('href') ?? '';
          try {
            return new URL(href, location.href).pathname;
          } catch {
            return href;
          }
        }),
      ),
    );
    const required =
      path === '/hub' ? ['/hub/calendar', '/hub/faq'] : path.startsWith('/hub') ? ['/hub'] : [];
    for (const target of required) {
      if (!paths.has(target)) problems.push(`導線切れ ${path} → ${target}`);
    }
    const text = joined(
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
    if (text.length <= 200) problems.push(`殻だけ ${path}（本文 ${text.length} 字）`);
  }
  expect(problems, '画面の導線と本文').toEqual([]);
});

Then('どの画面も画面の実行時エラーと止まった通信が無い', async ({ world }) => {
  expect(world.screenFaults, '画面の失敗を控えていない').toBeDefined();
  expect(world.screenFaults.pageErrors, '画面の実行時エラー').toEqual([]);
  expect(world.screenFaults.networkFailures, '止まった通信（画面の置き場）').toEqual([]);
});

Then('描き上がりに 15 秒を超えた画面が無い', async ({ world }) => {
  // 所要はシナリオをまたがない（前のシナリオの控えを読まない）。
  expect(world.screen.length, '開いた画面の控えが無い').toBeGreaterThan(0);
  const slow = world.screen
    .filter((v) => v.elapsedMs > 15_000)
    .map((v) => `${v.route}（${v.elapsedMs}ms）`);
  expect(slow, '描き上がりの遅い画面').toEqual([]);
});
