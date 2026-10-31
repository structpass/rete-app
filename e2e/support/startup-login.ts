import type { Page } from '@playwright/test';

/** 開発用の通常ログインだけを測る。自動再試行・MFA設定変更・既存session再利用はしない。 */
export async function checkStartupLogin(
  page: Page,
  credentials: { email: string; password: string },
  frontend = 'http://localhost:3010',
) {
  const origin = new URL(frontend);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('起動確認の対象はローカル開発環境に限定します');
  }
  const redact = (text: string) =>
    text.split(credentials.password).join('[password]').split(credentials.email).join('[email]');
  const safeUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname; // query・fragment・userinfoは保存しない
    } catch {
      return 'about:blank';
    }
  };
  const stamp = () => new Date().toISOString();
  const result = {
    startedAt: stamp(),
    finishedAt: '',
    status: 'fail' as 'pass' | 'fail',
    stage: 'open-login',
    pageUrl: safeUrl(new URL('/login', origin).href),
    error: '',
    uiMessages: [] as string[],
    uiEvents: [] as { at: string; pageUrl: string; message: string }[],
    loginResponse: null as { at: string; status: number; message: string } | null,
    networkFailures: [] as { at: string; url: string; error: string }[],
    pageErrors: [] as { at: string; message: string }[],
  };
  const onFailed = (request: import('@playwright/test').Request) => {
    result.networkFailures.push({
      at: stamp(),
      url: safeUrl(request.url()),
      error: redact(request.failure()?.errorText ?? 'request failed'),
    });
  };
  const onError = (error: Error) => {
    result.pageErrors.push({ at: stamp(), message: redact(error.message) });
  };
  page.on('requestfailed', onFailed);
  page.on('pageerror', onError);
  try {
    // 通信失敗ではresponseが返らず待機が続く。toastが消える前にNode側へ保存する。
    await page.exposeBinding('__reteStartupLoginMessage', (source, text: string) => {
      result.uiEvents.push({
        at: stamp(),
        pageUrl: safeUrl(source.frame.url()),
        message: redact(text),
      });
    });
    await page.addInitScript(() => {
      const seen = new Set<string>();
      const collect = () => {
        for (const node of document.querySelectorAll('[role="status"], [role="alert"]')) {
          const text = node.textContent?.trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          const report = (window as unknown as Record<string, (message: string) => Promise<void>>)
            .__reteStartupLoginMessage;
          void report(text).catch(() => undefined);
        }
      };
      new MutationObserver(collect).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await page.goto(new URL('/login', origin).href);
    await page.locator('#email').fill(credentials.email);
    await page.locator('#password').fill(credentials.password);
    result.stage = 'submit-login';
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/auth/login' &&
        response.request().method() === 'POST',
      { timeout: 30_000 },
    );
    // click失敗時にもwaitForResponseのrejectを未処理にしない。
    const [response] = await Promise.all([
      responsePromise,
      page.getByRole('button', { name: 'ログイン', exact: true }).click(),
    ]);
    const body = await response.json().catch(() => null);
    result.loginResponse = {
      at: stamp(),
      status: response.status(),
      message: typeof body?.error?.message === 'string' ? redact(body.error.message) : '',
    };
    if (!response.ok()) {
      // toastが消える前に画面の文言も採る。レスポンス全体やheadersは保存しない。
      await page.locator('[role="status"], [role="alert"]').first().waitFor({ timeout: 5_000 });
      throw new Error(`ログイン応答 HTTP ${response.status()}`);
    }
    result.stage = 'authenticated-shell';
    await page.waitForURL(new URL('/hub', origin).href, { timeout: 30_000 });
    await page.getByRole('button', { name: 'ログアウト', exact: true }).waitFor();
    result.stage = 'reload-session';
    await page.reload();
    await page.getByRole('button', { name: 'ログアウト', exact: true }).waitFor();
    if (new URL(page.url()).pathname !== '/hub') throw new Error('再読込後にホームへ留まれません');
    result.status = 'pass';
    result.stage = 'complete';
  } catch (error) {
    result.error = redact(error instanceof Error ? error.message : String(error));
  } finally {
    if (page.url() !== 'about:blank') result.pageUrl = safeUrl(page.url());
    const finalMessages = (
      await page
        .locator('[role="status"], [role="alert"]')
        .allTextContents()
        .catch(() => [])
    ).map(redact);
    result.uiMessages = [
      ...new Set([...result.uiEvents.map((event) => event.message), ...finalMessages]),
    ];
    // Playwrightの失敗レポートが自動で採るDOMにも入力値を残さない。
    await page
      .locator('input')
      .evaluateAll((inputs) => {
        for (const input of inputs) {
          if (input instanceof HTMLInputElement) input.value = '';
          input.removeAttribute('value');
        }
      })
      .catch(() => undefined);
    result.finishedAt = stamp();
    page.off('requestfailed', onFailed);
    page.off('pageerror', onError);
  }
  return result;
}
