/**
 * rete E2E — MFA login ステップ (cmn-0139)
 *
 * otpauth URI の secret 抽出、TOTP 生成（epoch オプションで replay 防御＝future step 採用）、
 * MFA setup/confirm と login/mfa チャレンジを集約。
 *
 * シナリオ自己完結のため、setup 系 Given はログイン→setup→confirm→logout を一気通貫で行い、
 * テスト本体は challenge 完了に集中する。teardown は admin mfa-reset で MFA 状態を確実に掃き出す。
 */

import { generate as otplibGenerate } from 'otplib';
import { expect, request } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { CREDENTIALS, BASE_URL, createAuthenticatedContext, credByEmail } from '../support/auth';

// cmn-0139 で固定した MFA 専用 UUID。seed.ts の MFA_DEMO_SUB と同値（手動同期・e2e 独立性確保のため再宣言）。
const MFA_DEMO_SUB = '00000000-0000-4000-a000-000000000008';

// ----------------------------------------------------------------
// helpers
// ----------------------------------------------------------------

/** otpauth://totp/<label>?secret=XXX[&...] の XXX を返す */
function parseSecretFromOtpauth(uri: string): string {
  const m = uri.match(/[?&]secret=([A-Z2-7]+)/i);
  if (!m) throw new Error(`otpauth URI から secret を抽出できません: ${uri}`);
  return m[1];
}

/** admin の新規 ctx を取得（テスト本体の world.apiCtx とは別系統にすることで上書きを防ぐ） */
async function withAdminCtx<T>(
  fn: (ctx: Awaited<ReturnType<typeof createAuthenticatedContext>>) => Promise<T>,
): Promise<T> {
  const ctx = await createAuthenticatedContext(CREDENTIALS.admin.email, CREDENTIALS.admin.password);
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/** メールアドレスで CREDENTIALS エントリを引く helper は support/auth.ts の credByEmail を import（cmn-0161 で重複解消） */

/**
 * mfa-user 専用：キャッシュを一切使わず毎回 fresh login。
 * 理由 = シナリオ間でログアウトしても local の session ファイルが残り cookie 再利用が
 * server 側 invalid session で 401 化する問題を断つ。
 * cmn-0395: 旧コメントの「throttle は別 counter で吸収」は誤り（実体は同じ /auth/login の
 * 5req/60s 窓を消費する）。開発機は E2E_THROTTLE_BYPASS=true で素通しする
 * （e2e/README.md §前提）。素通しを入れていない機械では本関数の呼び出しは throttle 窓を
 * 消費し続けるため、シナリオ集約（mfa-login.feature の結合）がそれを抑える。
 */
async function freshMfaUserLogin(email: string, password: string) {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.post('/api/v1/auth/login', { data: { email, password } });
  if (!res.ok()) {
    // res.text() は dispose 前に読む（Playwright API は dispose 後に response 触れない）
    const body = await res.text().catch(() => '(unreadable)');
    await ctx.dispose();
    throw new Error(`fresh login failed: ${res.status()} ${body}`);
  }
  return ctx;
}

// ----------------------------------------------------------------
// admin mfa-reset (self-healing + teardown 兼用)
// ----------------------------------------------------------------

/** admin で mfa-user の MFA を強制リセット。連続 run で MFA 有効残留しても詰まない。*/
Given('admin で MFA ユーザーを MFA リセットする', async () => {
  await withAdminCtx(async (adminCtx) => {
    const res = await adminCtx.patch(`/api/v1/members/${MFA_DEMO_SUB}/mfa-reset`);
    // 404 = MFA 未設定（reset 対象が無い）= 期待状態。エラーにしない。
    if (res.status() >= 400 && res.status() !== 404) {
      throw new Error(`mfa-reset failed: ${res.status()} ${await res.text()}`);
    }
  });
});

// ----------------------------------------------------------------
// MFA setup + confirm（シナリオ内セットアップ）
// ----------------------------------------------------------------

/**
 * {email} でログインし、setup→confirm を一気通貫で実行。secret と backupCodes を world に格納。
 * confirm 直後に logout する（次ステップで password login から MFA チャレンジを再現するため）。
 */
Given('MFA ユーザー {string} で MFA を有効化する', async ({ world }, email: string) => {
  const u = credByEmail(email);

  // 1) password login（まだ MFA 有効化前なので full session が確立する）
  world.apiCtx = await freshMfaUserLogin(u.email, u.password);

  // 2) setup → otpauthUri → secret parse
  const setupRes = await world.apiCtx.post('/api/v1/settings/mfa/setup');
  if (setupRes.status() !== 200) {
    throw new Error(`mfa setup failed: ${setupRes.status()} ${await setupRes.text()}`);
  }
  const setupBody = (await setupRes.json()) as { success: boolean; data: { otpauthUri: string } };
  if (!setupBody.success || !setupBody.data?.otpauthUri) {
    throw new Error(`mfa setup response shape: ${JSON.stringify(setupBody)}`);
  }
  const secret = parseSecretFromOtpauth(setupBody.data.otpauthUri);
  world.uniqueNames['mfaSecret'] = secret;

  // 3) confirm：spec §「confirm=現在 epoch」に従い現在 step で生成。
  //    backend の verifyCode が ±30s tolerance で検証するため boundary を含む。
  const code = await otplibGenerate({ secret, epoch: Math.floor(Date.now() / 1000) });
  const confirmRes = await world.apiCtx.post('/api/v1/settings/mfa/confirm', { data: { code } });
  if (confirmRes.status() !== 200) {
    throw new Error(`mfa confirm failed: ${confirmRes.status()} ${await confirmRes.text()}`);
  }
  const confirmBody = (await confirmRes.json()) as {
    success: boolean;
    data: { backupCodes: string[] };
  };
  if (!confirmBody.success || !Array.isArray(confirmBody.data.backupCodes)) {
    throw new Error(`mfa confirm response shape: ${JSON.stringify(confirmBody)}`);
  }
  if (confirmBody.data.backupCodes.length !== 10) {
    throw new Error(`backupCodes 件数想定外: ${confirmBody.data.backupCodes.length}`);
  }
  world.uniqueNames['backupCodes'] = JSON.stringify(confirmBody.data.backupCodes);

  // 4) logout（次ステップで password login から MFA チャレンジを再現する）
  await world.apiCtx.post('/api/v1/auth/logout');
  await world.apiCtx.dispose();
  world.apiCtx = null;
});

// ----------------------------------------------------------------
// logout（自由用）
// ----------------------------------------------------------------

When('ログアウトする', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化 — 事前にログインしてください');
  // 直後の Then が status/body を読むため、ここでは dispose しない（dispose 後は読めない）。
  // 破棄は fixture の teardown に任せる（auxiliaryContexts へ移して二重 dispose を避ける）。
  const ctx = world.apiCtx;
  world.lastResponse = await ctx.post('/api/v1/auth/logout');
  world.auxiliaryContexts.push(ctx);
  world.apiCtx = null;
});

// ----------------------------------------------------------------
// password login + MFA チャレンジ
// ----------------------------------------------------------------

/**
 * {email} で password login → mfaRequired:true を受けて partial session 確立。
 * world.apiCtx は保持（次の login/mfa ステップで同一 cookie を使う）。
 */
When('パスワードでログインし MFA チャレンジを受ける {string}', async ({ world }, email: string) => {
  const u = credByEmail(email);
  // 前回の ctx があれば破棄
  if (world.apiCtx) {
    await world.apiCtx.dispose();
    world.apiCtx = null;
  }
  world.apiCtx = await freshMfaUserLogin(u.email, u.password);
  // login の戻り値を lastResponse に格納（Then ステップで mfaRequired:true を検証する）
  world.lastResponse = await world.apiCtx.post('/api/v1/auth/login', {
    data: { email: u.email, password: u.password },
  });
});

Then('レスポンスに MFA チャレンジが含まれる', async ({ world }) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as {
    success: boolean;
    data: { mfaRequired?: boolean } | null;
  };
  expect(body.success, 'login response success').toBe(true);
  expect(body.data?.mfaRequired, 'mfaRequired が true').toBe(true);
});

Then('full session が確立している', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const me = await world.apiCtx.get('/api/v1/auth/me');
  const meBody = (await me.json()) as { success: boolean; data: { id: string } | null };
  expect(meBody.success, '/auth/me success').toBe(true);
  expect(meBody.data?.id, '/auth/me data.id が非 null（full session 確立済み）').toBeTruthy();
});

Then('full session が未確立', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const me = await world.apiCtx.get('/api/v1/auth/me');
  const meBody = (await me.json()) as { success: boolean; data: { id: string } | null };
  expect(meBody.success, '/auth/me success').toBe(true);
  expect(meBody.data?.id, '/auth/me data.id が null（full session 未確立）').toBeFalsy();
});

// ----------------------------------------------------------------
// login/mfa チャレンジ完了
// ----------------------------------------------------------------

When('誤コードで MFA ログインを叩く', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  world.lastResponse = await world.apiCtx.post('/api/v1/auth/login/mfa', {
    data: { code: '000000' },
  });
});

When('正 TOTP コードで MFA ログインを叩く', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const secret = world.uniqueNames['mfaSecret'];
  if (!secret)
    throw new Error('mfaSecret 未設定 — 「MFA ユーザーで MFA を有効化する」を先に実行してください');
  // future step で replay 防御を回避（login/mfa 自体も lastUsedCounter を進めるため）
  const code = await otplibGenerate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
  world.lastResponse = await world.apiCtx.post('/api/v1/auth/login/mfa', { data: { code } });
});

When('未使用バックアップコードで MFA ログインを叩く', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const raw = world.uniqueNames['backupCodes'];
  if (!raw)
    throw new Error(
      'backupCodes 未設定 — 「MFA ユーザーで MFA を有効化する」を先に実行してください',
    );
  const codes = JSON.parse(raw) as string[];
  if (codes.length === 0) throw new Error('backupCodes が空');
  // FIFO で消費（先頭を使用）
  world.lastResponse = await world.apiCtx.post('/api/v1/auth/login/mfa', {
    data: { code: codes[0] },
  });
});

When('同じバックアップコードで MFA ログインを叩く', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const raw = world.uniqueNames['backupCodes'];
  if (!raw) throw new Error('backupCodes 未設定');
  const codes = JSON.parse(raw) as string[];
  if (codes.length === 0) throw new Error('backupCodes が空');
  // 既使用コードを再投入（single-use 検証）
  world.lastResponse = await world.apiCtx.post('/api/v1/auth/login/mfa', {
    data: { code: codes[0] },
  });
});

/**
 * 本人確認して控えを作り直す（POST /settings/mfa/backup-codes/regenerate は code が必須）。
 * 使ってよい控えは「前半のシナリオが 1 つ目を使う」ため 3 つ目。5 つ目は作り直し後に試す用に残す。
 */
When('控えの 1 つで本人確認してバックアップコードを作り直す', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const raw = world.uniqueNames['backupCodes'];
  if (!raw) throw new Error('backupCodes 未設定');
  const codes = JSON.parse(raw) as string[];
  const forConfirm = codes[2];
  if (!forConfirm) throw new Error('本人確認に使える控えが無い（backupCodes が 3 つ未満）');
  world.lastResponse = await world.apiCtx.post('/api/v1/settings/mfa/backup-codes/regenerate', {
    data: { code: forConfirm },
  });
});

/**
 * 作り直しの前の控え（最初の confirm が返した 10 個）のうち、まだ使っていない 1 つで挑む。
 * 作り直しが効いていれば通らず 401 になる（S-OPS-03）。
 */
When('未使用の作り直し前のバックアップコードで MFA ログインを叩く', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const raw = world.uniqueNames['backupCodes'];
  if (!raw) throw new Error('backupCodes 未設定');
  const codes = JSON.parse(raw) as string[];
  // 1 つ目は前半のシナリオ、3 つ目は作り直しの本人確認で使う。5 つ目は未使用のまま作り直しを迎える。
  const unused = codes[4];
  if (!unused) throw new Error('未使用の控えが無い（backupCodes が 5 つ未満）');
  world.lastResponse = await world.apiCtx.post('/api/v1/auth/login/mfa', {
    data: { code: unused },
  });
});
