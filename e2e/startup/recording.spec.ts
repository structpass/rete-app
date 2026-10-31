import { test, expect } from '@playwright/test';
import { CREDENTIALS } from '../support/auth';
import { checkStartupLogin } from '../support/startup-login';

test('503の画面文言・URL・時刻を保存し、秘密値を記録しない', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/v1/auth/login', async (route) => {
    attempts += 1;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: { message: '起動確認用の一時障害' } }),
    });
  });
  const result = await checkStartupLogin(page, CREDENTIALS.admin);
  expect(result.status).toBe('fail');
  expect(result.pageUrl).toBe('http://localhost:3010/login');
  expect(result.loginResponse?.status).toBe(503);
  expect(result.loginResponse?.message).toBe('起動確認用の一時障害');
  expect(result.uiMessages.join(' ')).toContain('起動確認用の一時障害');
  expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  expect(attempts).toBe(1);
  expect(JSON.stringify(result)).not.toContain(CREDENTIALS.admin.password);
});

test('通信切断で消えた通知も発生時刻とともに残す', async ({ page }) => {
  await page.route('**/api/v1/auth/login', (route) => route.abort('connectionrefused'));
  const result = await checkStartupLogin(page, CREDENTIALS.admin);
  expect(result.status).toBe('fail');
  expect(result.networkFailures.some((event) => event.url.endsWith('/api/v1/auth/login'))).toBe(
    true,
  );
  expect(result.uiEvents.some((event) => event.message.includes('ログインに失敗しました'))).toBe(
    true,
  );
  expect(result.uiMessages.join(' ')).toContain('ログインに失敗しました');
  expect(JSON.stringify(result)).not.toContain(CREDENTIALS.admin.password);
});
