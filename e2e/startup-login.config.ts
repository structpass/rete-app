import path from 'path';
import { defineConfig } from '@playwright/test';

// 起動直後の最初のログインを測るため、通常E2EのglobalSetup・fixture resetを通さない。
export default defineConfig({
  testDir: path.join(__dirname, 'startup'),
  outputDir: path.join(__dirname, '../tmp/startup-login', `${Date.now()}-${process.pid}`),
  timeout: 240_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1440, height: 900 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    // 入力したパスワードやcookieを記録しない。画像とJSONは明示的に保存する。
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
