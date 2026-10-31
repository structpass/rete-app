import { writeFile } from 'fs/promises';
import { test, expect } from '@playwright/test';
import { CREDENTIALS } from '../support/auth';
import { checkStartupLogin } from '../support/startup-login';

test('起動後の画面ログインと再読込', async ({ page }, testInfo) => {
  const result = await checkStartupLogin(page, CREDENTIALS.admin);
  await writeFile(testInfo.outputPath('result.json'), JSON.stringify(result, null, 2));
  await page.screenshot({
    path: testInfo.outputPath('screen.png'),
    mask: [page.locator('input')],
  });
  expect(result.status, '起動後のログイン失敗: result.jsonの文言・URL・時刻を確認').toBe('pass');
});
