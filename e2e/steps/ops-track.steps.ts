/**
 * モデルタブの deep-link（S-OPS-10）の画面操作 — d824。
 *
 * 07-ops.md の S-OPS-10 は「`/model#<テーマ>` を直接開くとそのテーマが選ばれ、別テーマを選ぶと URL が追従し、
 * 戻るで前のテーマに戻る」を期待する。このうち「直接開くとそのテーマの本文が出る」は画面の中でしか見えない
 * （通信の応答に出ない）。実ブラウザで開いて見出しの題を確かめる。
 *
 * 選び直し・戻るの 2 手目以降は手動ケース（S-OPS-10-C1）に残す。画面の選択は履歴を積まない
 * （`window.history.replaceState`・model-view.tsx）ため、自動では「戻る先」を作れない。状態は動かさない
 * （07-ops.md の期待は ⚠ のまま。README §5 の「⚠ が付いたユースケースは ✅ にしない」）。
 */

import { expect } from '@playwright/test';
import { Given, Then, When } from '../support/fixtures';
import { openReachableScreen } from '../support/fixtures';
import { CREDENTIALS } from '../support/auth';

/** 本文の見出し（選択中のテーマの題）を読む。 */
async function shownTitle(page: import('@playwright/test').Page): Promise<string> {
  const h2 = page.locator('h2').first();
  await expect(h2).toBeVisible({ timeout: 30_000 });
  return (await h2.innerText()).trim();
}

Given(
  '画面の点検に使う管理者でログインし直し、モデルタブを開く準備をする',
  async ({ screen, screenFaults }) => {
    await openReachableScreen(screen, screenFaults, '/hub', CREDENTIALS.admin);
  },
);

When('モデルタブを {string} のテーマで直接開く', async ({ screen }, themeId: string) => {
  const page = screen.pages[0];
  if (!page) throw new Error('先に「モデルタブを開く準備をする」を通す');
  const res = await page.goto(`${screen.base}/model#${themeId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  expect(res?.status() ?? 0, `モデルタブが開けない（HTTP ${res?.status()}）`).toBeLessThan(500);
  // ハッシュの取り込みはマウント後に走る。本文が出るまで待つ（変わらなければ次の判定で落とす）。
  await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length > 0, undefined, {
    timeout: 30_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
});

Then('画面に {string} の題で本文が出ている', async ({ screen }, title: string) => {
  const page = screen.pages[0];
  if (!page) throw new Error('画面が開かれていない');
  expect(await shownTitle(page), '直接開いたテーマの本文が出ている').toBe(title);
  // URL のハッシュは開いたテーマのまま（この画面はハッシュを消さない）。
  const hash = new URL(page.url()).hash.replace(/^#/, '');
  expect(hash, 'URL のハッシュが開いたテーマのまま').not.toBe('');
});
