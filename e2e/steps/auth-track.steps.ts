/**
 * rete E2E — 認証トラック（docs/scenarios/tracks/01-auth.md）の追加ステップ（2026-10-25）
 *
 * 既存のステップで書けなかった次の 4 つを足す。いずれも「接続（cookie）を分けて同じことを確かめる」
 * ための道具で、ブラウザを開かずに画面の手順を API でなぞる。
 *
 *   - 実行が通った時にだけユースケースを確認済みにする（状態は実行の結果でだけ動かす・README §5）
 *   - 別の接続で、同じ人のログイン・セッションを確かめる（S-AUTH-03 / 13）
 *   - ログイン試行のロックを解除する（S-AUTH-09 の後始末。fixtures 側でも必ず解除する）
 *   - 一覧の派生状態（{ email, status }）を 1 件引いて確かめる（招待の失効の案内）
 *
 * 重複定義は playwright-bdd が禁止するため、パターンは既存（common / extended / mfa / org-change）と
 * 衝突しない語順にしてある。引数は入口で 1 度 resolvePlaceholders してから使う（cmn-0397 の規律）。
 */

import { expect, request, type APIResponse } from '@playwright/test';
import { generate as otplibGenerate } from 'otplib';
import { Given, When, Then } from '../support/fixtures';
import { BASE_URL, CREDENTIALS, credByEmail } from '../support/auth';
import { resolvePlaceholders } from '../support/placeholders';
import { markVerifiedCase } from '../support/verified-cases';

/** playwright-bdd がステップ定義の第 2 引数に渡すもののうち、使う部分だけを書く。 */
type ScenarioSteps = { getStatus(): 'failed' | 'passed' | 'skipped' };

// ----------------------------------------------------------------
// helpers
// ----------------------------------------------------------------

/**
 * 管理操作（解除）用の接続。ログイン込みで作り、終わったら必ず捨てる。
 * 応答本文は接続を捨てる前に読んで返す（捨てた後の応答は読めない・「Response has been disposed」）。
 */
async function withAdmin<T>(
  fn: (
    ctx: Awaited<ReturnType<typeof request.newContext>>,
  ) => Promise<{ value: T; status: number; body: string }>,
): Promise<{ value: T; status: number; body: string }> {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.post('/api/v1/auth/login', {
      data: { email: CREDENTIALS.admin.email, password: CREDENTIALS.admin.password },
    });
    if (!res.ok()) throw new Error(`admin ログインに失敗: ${res.status()} ${await res.text()}`);
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/**
 * 使い終わった接続の応答の代わりに、本文と状態だけを持つ応答を作る。
 * 以降の Then（ステータスコード・レスポンスの …）は lastResponse をそのまま読むため、本文・状態だけ
 * 写したものを渡せば同じように判定できる。本文を読み終えたものなので dispose の影響を受けない。
 */
function settledResponse(status: number, bodyText: string): APIResponse {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      return null;
    }
  })();
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    json: async () => parsed,
    text: async () => bodyText,
    body: async () => Buffer.from(bodyText, 'utf-8'),
    headers: () => ({}),
    headersArray: () => [],
    url: () => '',
    dispose: async () => undefined,
  } as unknown as APIResponse;
}

/** メンバー一覧からメールで id を引く（seed の固定 id を書かずに済む）。 */
async function findAccountId(
  admin: Awaited<ReturnType<typeof request.newContext>>,
  email: string,
): Promise<string> {
  const res = await admin.get('/api/v1/members');
  if (res.status() !== 200) {
    throw new Error(`メンバー一覧の取得に失敗: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: Array<{ id: string; email: string }> };
  const hit = body.data?.find((m) => m.email === email);
  if (!hit) throw new Error(`seed に存在しないメール: ${email}`);
  return hit.id;
}

// ----------------------------------------------------------------
// 実行でだけ状態を進める（S-AUTH-08）
// ----------------------------------------------------------------

/**
 * 実施して挙動が決まったユースケースを確認済みにする。
 * 判定の本体はこの行より前の Then が持つ。この行は「ここまで通った」ことだけを控えるので、途中で
 * 落ちた場合は控えが残らず、印も動かない（状態を実行の結果でだけ動かす規約のまま）。
 */
Then('実測して挙動が決まったので {string} を確認済みにする', async ({}, trackIdArg: string) => {
  markVerifiedCase(resolvePlaceholders(trackIdArg, {}));
});

// ----------------------------------------------------------------
// 端末も控えも失った時の管理者復旧（S-OPS-04）
// ----------------------------------------------------------------

/**
 * 保存セッションの持ち主に、管理者が MFA をリセットする（`PATCH /members/{id}/mfa-reset`）。
 * S-OPS-04 の手順は「本人は入れない → 管理者がリセット → 本人が設定し直す」の 3 段。
 * 管理操作の接続はその場で作り、応答を読み切ってから捨てる（捨てた後の応答は読めない）。
 */
async function resetMfaOf(
  world: { sessionOwners: Record<string, string> },
  key: string,
): Promise<{ status: number; body: string }> {
  const email = world.sessionOwners[key];
  if (!email) throw new Error(`保存セッション ${key} の持ち主が分からない（先にログインする）`);
  const { status, body } = await withAdmin(async (admin) => {
    const accountId = await findAccountId(admin, email);
    const res = await admin.patch(`/api/v1/members/${accountId}/mfa-reset`);
    return { value: accountId, status: res.status(), body: await res.text() };
  });
  return { status, body };
}

When(
  '管理者が保存セッション {string} の持ち主の MFA をリセットする',
  async ({ world }, key: string) => {
    const result = await resetMfaOf(world, key);
    // 次の Then（ステータスコード…）が読めるよう、読み切った本文を lastResponse へ渡す。
    world.lastResponse = settledResponse(result.status, result.body);
  },
);

/**
 * 本人がログインし、その結果から「2 段目（コード要求）を出すか」「出さずに入れたか」を残す。
 * チャレンジを出した時は、**その場のバックアップコードではなく**手元に持っている控えで入り直すため、
 * 未使用の控えを 1 本使う（設定し直しの前の状態を作る）。
 */
When(
  '本人 {string} としてログインし直して MFA チャレンジの有無を確かめる',
  async ({ world }, key: string) => {
    const ctx = world.sessions[key];
    if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
    const email = world.sessionOwners[key];
    if (!email) throw new Error(`保存セッション ${key} の持ち主が分からない`);
    const u = credByEmail(email);
    // 前のセッションを捨てて、ログインからやり直す（リセット後の状態を新しい接続で見る）。
    await ctx.dispose();
    const fresh = await request.newContext({ baseURL: BASE_URL });
    world.auxiliaryContexts.push(fresh);
    world.sessions[key] = fresh;
    world.lastResponse = await fresh.post('/api/v1/auth/login', {
      data: { email: u.email, password: u.password },
    });
  },
);

/** 2 段目のコード要求（mfaRequired）が出ていないこと＝パスワードだけで入れたことを確かめる。 */
Then('MFA チャレンジを出さずにログインできた', async ({ world }) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as {
    success?: boolean;
    data?: { mfaRequired?: boolean } | null;
  };
  expect(world.lastResponse.status(), 'パスワード段で 200 が返る').toBe(200);
  expect(body.success, 'ログインが成功している').toBe(true);
  expect(body.data?.mfaRequired, 'MFA チャレンジを出さずに full session へ進む').toBeFalsy();
});

/** アカウントの MFA が未設定（enabled=false）であること。 */
Then('本人の二段階認証は未設定になっている', async ({ world }) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as { data?: { enabled?: boolean } | null };
  expect(body.data?.enabled, 'リセット後は enabled=false').toBe(false);
});

/**
 * 本人が二段階認証の設定をやり直す（setup → confirm）。S-OPS-04 の手順 3 と、その前段の用意の両方で使う。
 * 接続は「保存セッション」で指定する（ログイン済みであることが前提。未設定の人はパスワードだけで入れる）。
 * secret とバックアップコードは控え（uniqueNames）へ残し、後始末で管理者リセットに使う。
 */
When('本人 {string} が二段階認証を設定し直す', async ({ world }, key: string) => {
  const ctx = world.sessions[key];
  if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
  const setup = await ctx.post('/api/v1/settings/mfa/setup');
  if (setup.status() !== 200) {
    throw new Error(`MFA の設定やり直しの setup が失敗: ${setup.status()} ${await setup.text()}`);
  }
  const setupBody = (await setup.json()) as { data?: { otpauthUri?: string } };
  const secret = setupBody.data?.otpauthUri?.match(/[?&]secret=([A-Z2-7]+)/i)?.[1];
  if (!secret)
    throw new Error(`otpauth URI から secret を抽出できない: ${JSON.stringify(setupBody)}`);
  world.uniqueNames['mfaSecret'] = secret;
  // setup は旧 secret を上書きする（未確認の行）。やり直し後に新しいコードで通ることを確かめる。
  const code = await otplibGenerate({ secret, epoch: Math.floor(Date.now() / 1000) });
  world.lastResponse = await ctx.post('/api/v1/settings/mfa/confirm', { data: { code } });
  if (world.lastResponse.status() === 200) {
    const body = (await world.lastResponse.json()) as { data?: { backupCodes?: string[] } };
    if (body.data?.backupCodes) {
      world.uniqueNames['backupCodes'] = JSON.stringify(body.data.backupCodes);
    }
  }
});

/**
 * 保存セッションの接続で、もう一度ログインし直す（S-OPS-04 の手順 1・2 で共有）。
 * 接続は覚えておき、`本人 … としてログインし直して MFA チャレンジの有無を確かめる` と同じ入口を使う。
 */
When('同じ接続 {string} で本人が二段階認証を設定し直す', async ({ world }, key: string) => {
  const ctx = world.sessions[key];
  if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
  const setup = await ctx.post('/api/v1/settings/mfa/setup');
  if (setup.status() !== 200) {
    throw new Error(`MFA の有効化の setup が失敗: ${setup.status()} ${await setup.text()}`);
  }
  const setupBody = (await setup.json()) as { data?: { otpauthUri?: string } };
  const secret = setupBody.data?.otpauthUri?.match(/[?&]secret=([A-Z2-7]+)/i)?.[1];
  if (!secret)
    throw new Error(`otpauth URI から secret を抽出できない: ${JSON.stringify(setupBody)}`);
  const code = await otplibGenerate({ secret, epoch: Math.floor(Date.now() / 1000) });
  const confirm = await ctx.post('/api/v1/settings/mfa/confirm', { data: { code } });
  if (confirm.status() !== 200) {
    throw new Error(`MFA の有効化の confirm が失敗: ${confirm.status()} ${await confirm.text()}`);
  }
  // ここでは控えを使わない（次のログインでチャレンジを出すだけ）。ただし後始末で使えるよう残す。
  const body = (await confirm.json()) as { data?: { backupCodes?: string[] } };
  if (body.data?.backupCodes) {
    world.uniqueNames['backupCodes'] = JSON.stringify(body.data.backupCodes);
  }
});

/** 設定し直しで新しいバックアップコードが返ったことを確かめる。 */
Then('新しいバックアップコードが返る', async ({ world }) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  expect(world.lastResponse.status(), 'confirm が 200 で通る').toBe(200);
  const body = (await world.lastResponse.json()) as { data?: { backupCodes?: string[] } };
  expect(body.data?.backupCodes?.length, '設定し直しで新しい控えが返る').toBe(10);
});

// ----------------------------------------------------------------
// 接続を分けた確かめ（S-AUTH-03 / 13）
// ----------------------------------------------------------------

/**
 * 新しい接続でログインする。MFA ありの人は 2 段目まで済ませる（控えは保存済みのものを使う）。
 *
 * 段の構成は人によって違う: mfa-user はパスワード段で必ずチャレンジになる。**全員に MFA を強制した日**
 * は、MFA 未設定の人でもパスワード段で止まる（設定を促す印が付いた状態）。どちらも入口が同じなので、
 * 「応答が mfaRequired なら 2 段目へ」だけを見る。
 *
 * パスワードは seed の値をそのまま使わない。**パスワードを一時的に変えて確かめるシナリオ（S-AUTH-12）**
 * では変更後の値で入れたいため、seed の値に一致する人が「今は別のパスワード」の状態にある時は
 * その値を使う（S-AUTH-12 の手順が world.uniqueNames に残す）。seed の値のままの人には何も足さない。
 */
When(
  '新しい接続 {string} として {string} のパスワードでログインする',
  async ({ world }, key: string, emailArg: string) => {
    const email = resolvePlaceholders(emailArg, world.uniqueNames);
    const u = credByEmail(email);
    const password = world.uniqueNames[`password:${email}`] ?? u.password;
    const ctx = await request.newContext({ baseURL: BASE_URL });
    world.auxiliaryContexts.push(ctx);
    world.sessions[key] = ctx;
    // 管理操作の対象（S-OPS-04・05）を email で引くため、持ち主も控える。
    world.sessionOwners[key] = u.email;

    world.lastResponse = await ctx.post('/api/v1/auth/login', {
      data: { email: u.email, password },
    });
    if (!world.lastResponse.ok()) return; // 入れなかった（401/429 等）はその結果を残す
    const body = (await world.lastResponse.json()) as {
      data?: { mfaRequired?: boolean; mfaSetupRequired?: boolean };
    };
    if (!body.data?.mfaRequired) return; // 1 段で完結（未設定者のまま強制の日もここへ来る）

    // 2 段目: 控えを 1 本ずつ試す（使った控えは覚えて、次のシナリオで使い回さない）。
    const codes = world.uniqueNames['backupCodes']
      ? (JSON.parse(world.uniqueNames['backupCodes']) as string[])
      : [];
    for (const code of codes) {
      if (world.consumedBackupCodes.includes(code)) continue;
      const res = await ctx.post('/api/v1/auth/login/mfa', { data: { code } });
      world.lastResponse = res;
      if (res.ok()) {
        world.consumedBackupCodes.push(code);
        world.uniqueNames['consumedBackupCode'] = code;
        return;
      }
    }
    // 控えが無い／どれも通らない: ログインできない人なので、その場の応答（パスワード段）を残す。
  },
);

When(
  '保存セッション {string} で同じ控えをもう一度ログインに使う',
  async ({ world }, key: string) => {
    const ctx = world.sessions[key];
    if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
    const code = world.uniqueNames['consumedBackupCode'];
    if (!code) throw new Error('使った控えが無い（先に控えを 1 本使う手順を実行してください）');
    // ログイン成立で前のチャレンジは消えているため、パスワード段からやり直して 2 段目へ入る。
    await ctx.post('/api/v1/auth/login', {
      data: { email: CREDENTIALS.mfaUser.email, password: CREDENTIALS.mfaUser.password },
    });
    world.lastResponse = await ctx.post('/api/v1/auth/login/mfa', { data: { code } });
  },
);

/** 保険用の管理操作（PATCH）。本文が要らない解除・空更新に使う。 */
When(
  '保存セッション {string} で PATCH {string} を空ボディで叩く',
  async ({ world }, key: string, urlPath: string) => {
    const ctx = world.sessions[key];
    if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
    world.lastResponse = await ctx.patch(resolvePlaceholders(urlPath, world.uniqueNames), {
      data: {},
    });
  },
);

When('保存セッション {string} で自分の情報を確かめる', async ({ world }, key: string) => {
  const ctx = world.sessions[key];
  if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
  world.lastResponse = await ctx.get('/api/v1/auth/me');
});

When('保存セッション {string} で器の一覧を開く', async ({ world }, key: string) => {
  const ctx = world.sessions[key];
  if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
  world.lastResponse = await ctx.get('/api/v1/spaces');
});

/**
 * 新しい接続で **seed のパスワード（変更前の値）** でログインする（S-AUTH-12 の「旧パスワードでは入れない」）。
 *
 * 「… のパスワードでログインする」は今のパスワード（変えた後の値）を使うため、変更前の値で入れないことを
 * 確かめるにはこちらを使う。値は seed（`CREDENTIALS`）から引く。
 */
When(
  '新しい接続 {string} として {string} の旧いパスワードでログインする',
  async ({ world }, key: string, emailArg: string) => {
    const email = resolvePlaceholders(emailArg, world.uniqueNames);
    const u = credByEmail(email);
    const ctx = await request.newContext({ baseURL: BASE_URL });
    world.auxiliaryContexts.push(ctx);
    world.sessions[key] = ctx;
    world.lastResponse = await ctx.post('/api/v1/auth/login', {
      data: { email: u.email, password: u.password },
    });
  },
);

/**
 * 本人の MFA の設定状態を見る（S-AUTH-15 の後段）。管理者のリセットで未設定に戻ったことを、
 * 対象者本人の視点（次のログインで設定をやり直せる状態か）で確かめるために使う。
 */
When('保存セッション {string} で MFA の設定状態を確かめる', async ({ world }, key: string) => {
  const ctx = world.sessions[key];
  if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
  world.lastResponse = await ctx.get('/api/v1/settings/mfa');
});

// ----------------------------------------------------------------
// ログイン試行のロック（S-AUTH-09）
// ----------------------------------------------------------------

When(
  '{string} のパスワードログインを誤ったパスワードで {int} 回試す',
  async ({ world }, emailArg: string, times: number) => {
    const email = resolvePlaceholders(emailArg, world.uniqueNames);
    const u = credByEmail(email);
    // 1 回ごとに新しい接続で叩く（ロックはアカウント単位で残るため、接続を変えても効くことを見る）。
    for (let i = 0; i < times; i += 1) {
      const ctx = await request.newContext({ baseURL: BASE_URL });
      world.auxiliaryContexts.push(ctx);
      world.lastResponse = await ctx.post('/api/v1/auth/login', {
        data: { email: u.email, password: `wrong-${i}-${Date.now()}` },
      });
    }
  },
);

When('管理者が {string} のログイン試行ロックを解除する', async ({ world }, emailArg: string) => {
  const email = resolvePlaceholders(emailArg, world.uniqueNames);
  const result = await withAdmin(async (admin) => {
    const done = await unlock(admin, email);
    return { value: done.id, status: done.status, body: done.body };
  });
  const id = String(result.value);
  world.lastResponse = settledResponse(result.status, result.body);
  // 途中で落ちても解除されるよう、後始末の対象に残す（解除済みなら後始末は何もしない）。
  if (!world.unlockAccountIds.includes(id)) world.unlockAccountIds.push(id);

  // 解除が済んだので、この行はもう後始末で流し直さない（印を付けて二重解除を防ぐ）。
  const row = world.unlockRows[world.unlockRows.length - 1];
  if (row && row.email === email) row.settled = true;
});

/** 解除の実体（本文は接続を捨てる前に読み切る。捨てた後の応答は読めない）。 */
async function unlock(
  admin: Awaited<ReturnType<typeof request.newContext>>,
  email: string,
): Promise<{ id: string; status: number; body: string }> {
  const accountId = await findAccountId(admin, email);
  const res = await admin.patch(`/api/v1/members/${accountId}/unlock`);
  return { id: accountId, status: res.status(), body: await res.text() };
}

/**
 * 解除の試行は、後始末でも必ず 1 回流す（前の試験でロックが残っていると、この試験そのものが
 * 「ロック中の 429」から始まり、期待と食い違う）。行の登録は変数を解決する前の email で持つ。
 */
Given(
  'ロックが残っていても拾えるよう {string} の解除を後始末にも登録する',
  async ({ world }, emailArg: string) => {
    const email = resolvePlaceholders(emailArg, world.uniqueNames);
    world.unlockRows.push({ email, settled: false });
  },
);

/**
 * 失敗応答（{ success:false, error:{ code, message } }）の状態と文言をまとめて確かめる。
 * 成功前提の `レスポンスの … が … と一致する` は本文の success を見るため、断られた応答には使えない。
 */
Then(
  '招待の受諾はステータスコード {int} で断られ、次の文言を返す {string}',
  async ({ world }, status: number, messageArg: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const expected = resolvePlaceholders(messageArg, world.uniqueNames);
    const body = (await world.lastResponse.json()) as {
      success?: boolean;
      error?: { code?: string; message?: string };
    };
    expect(
      world.lastResponse.status(),
      `ステータスコード ${status}（本文: ${JSON.stringify(body)}）`,
    ).toBe(status);
    expect(body.success, '断られた応答は success が false であること').toBe(false);
    expect(body.error?.message, '断った理由の文言').toBe(expected);
  },
);

Then('人に見える文言に自動解除までの目安が含まれる', async ({ world }) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  // 失敗時の本文は { success:false, error:{ code, message } }（AllExceptionsFilter の形）。
  const body = (await world.lastResponse.json()) as {
    message?: string;
    error?: { code?: string; message?: string };
  };
  const message = body.error?.message ?? body.message ?? '';
  expect(message, 'ロック中の文言が返る').toContain('ロックされています');
  expect(message, '解除までの目安が人に見える文言に含まれる').toMatch(/約\s*\d+\s*分/);
});

// ----------------------------------------------------------------
// パスワードポリシーの違反（S-AUTH-11）
// ----------------------------------------------------------------

/**
 * 招待の受諾で、パスワードポリシーが実効していることを確かめる。
 * 招待トークンは使えないもの（64 桁の 0）を使う。受諾はトークン照合より前にパスワードを検証する設計
 * （列挙・総当たり対策）なので、断る理由からポリシーだけを見られる。
 */
When('招待の受諾をパスワード {string} で試す', async ({ world }, passwordArg: string) => {
  const password = resolvePlaceholders(passwordArg, world.uniqueNames);
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  world.lastResponse = await world.apiCtx.post('/api/v1/invites/accept', {
    data: { token: '0'.repeat(64), name: 'パスワード確認', password },
  });
});

Then('パスワードの不足を理由つきで断った', async ({ world }) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  // 論理的な拒否（ポリシー違反）は 422 で、本文の message に「パスワードは N 文字以上にしてください」が来る。
  expect(world.lastResponse.status(), '422 で断る（ポリシー違反は 422）').toBe(422);
  // 失敗時の本文は { success:false, error:{ code, message } }（AllExceptionsFilter の形）。
  const body = (await world.lastResponse.json()) as { error?: { message?: string } };
  expect(body.error?.message, '理由（何文字以上か）を添えて断る').toMatch(
    /パスワードは \d+ 文字以上/,
  );
});

Then('招待の受諾は理由つきで断られた', async ({ world }) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  // ポリシー違反（422）か、トークンが無効・期限切れ（400）。どちらも本文に理由の文言が入る。
  expect([400, 422]).toContain(world.lastResponse.status());
  const body = (await world.lastResponse.json()) as { message?: string };
  expect(body.message, '断った理由の文言').toMatch(
    /パスワードは \d+ 文字以上|招待が無効か期限切れ/,
  );
});

// ----------------------------------------------------------------
// 自己パスワード変更（S-AUTH-12）
// ----------------------------------------------------------------

/**
 * 変更前のパスワードを後始末へ登録する（S-AUTH-12）。
 *
 * 変えてから戻す確かめ方は、途中で落ちると seed の資格情報が変わったまま残る。後始末は fixtures が
 * 「元のパスワードへ自己変更し直す」形で流す（DB を直接書くとハッシュが変わり、古いセッションが
 * 失効したままになるため口を使う）。最初に登録された値だけを元の値として扱う。
 */
Given(
  'パスワード変更の控えを用意する {string} を {string} で',
  async ({ world }, emailArg: string, passwordArg: string) => {
    const email = resolvePlaceholders(emailArg, world.uniqueNames);
    const password = resolvePlaceholders(passwordArg, world.uniqueNames);
    if (!world.passwordResetRows.some((r) => r.email === email)) {
      world.passwordResetRows.push({ email, password, settled: false });
    }
  },
);

/**
 * 本人として入り直し、現在のパスワードを添えて新しいパスワードへ変える。
 * 変えた後のパスワードは控えへ残す（後始末はこの値で入り直して元へ戻す）。
 */
When(
  'アカウント {string} で自己変更する 現在 {string} 新 {string}',
  async ({ world }, emailArg: string, currentArg: string, newArg: string) => {
    const email = resolvePlaceholders(emailArg, world.uniqueNames);
    const current = resolvePlaceholders(currentArg, world.uniqueNames);
    const next = resolvePlaceholders(newArg, world.uniqueNames);
    const ctx = await request.newContext({ baseURL: BASE_URL });
    world.auxiliaryContexts.push(ctx);
    // 自己変更は「認証済みの接続」が前提。入り直してから叩く（現在のパスワードが違えば入れず 401）。
    const login = await ctx.post('/api/v1/auth/login', { data: { email, password: current } });
    if (!login.ok()) {
      world.lastResponse = login;
      return;
    }
    world.lastResponse = await ctx.post('/api/v1/auth/change-password', {
      data: { currentPassword: current, newPassword: next },
    });
    // 変えた時だけ控えを更新する（変えられなかった時は元のパスワードのまま）。
    const row = world.passwordResetRows.find((r) => r.email === email);
    if (world.lastResponse.ok()) {
      // 「この人の今のパスワード」を控える（同じシナリオの後のログインが seed の値ではなくこれを読む）。
      world.uniqueNames[`password:${email}`] = next;
      if (row) {
        // 元の値へ戻し終えたら、後始末でも流し直さない（戻しを二度流すと、後の 1 回が入れずに止まる）。
        if (current === row.password) row.settled = true;
        else row.changedPassword = next;
      }
    }
  },
);
