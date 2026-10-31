/**
 * rete E2E — 共通ステップ定義
 *
 * playwright-bdd の fixture パターンを使い、シナリオ内の Given/When/Then が
 * `world` 経由で状態を共有する。テスト終了後は world.apiCtx.dispose() が
 * 自動実行される（fixtures.ts の teardown）。
 *
 * 認証方式: rete バックエンドは express-session（cookie）。
 * POST /api/v1/auth/login でセッションを確立し、以降は同一 APIRequestContext で叩く。
 */

import { request, expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { createAuthenticatedContext, BASE_URL, credByEmail } from '../support/auth';
import { resolvePlaceholders, resolveRequest } from '../support/placeholders';
import { buildCreatedResourceTeardown } from '../support/teardown';

// cmn-0336: 解決の実体は support/placeholders.ts へ移した（単体テストのため依存ゼロの単独
// モジュールにする必要があった）。ここからの再 export は steps/org-change.steps.ts の既存
// import（resolvePlaceholders as resolveVars）を無改修で通すため。
export { resolvePlaceholders };

// ----------------------------------------------------------------
// Given — 事前条件
// ----------------------------------------------------------------

Given('バックエンド {string} が稼働している', async ({}, _url: string) => {
  // /api/v1/auth/me が 500 未満なら稼働中とみなす（未ログインは 200 + data:null）
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.get('/api/v1/auth/me');
  await ctx.dispose();
  expect(res.status(), 'バックエンドが稼働中であること').toBeLessThan(500);
});

Given('システムADMIN {string} でログインする', async ({ world }, email: string) => {
  const cred = credByEmail(email);

  world.apiCtx = await createAuthenticatedContext(cred.email, cred.password);
  // ファイル設定は ADMIN だけが変えられる。このシナリオは全ユーザー共通の設定を触りうるため、
  // 後始末で既定へ戻す対象として印を付ける（support/fixtures.ts）。
  world.touchesFileSettings = true;

  // 自分の id を取得（P5-04 自己降格防止テスト用）
  const meRes = await world.apiCtx.get('/api/v1/auth/me');
  const meBody = (await meRes.json()) as {
    success: boolean;
    data: { id: string } | null;
  };
  world.currentUserId = meBody.data?.id ?? null;
});

Given('システムMEMBER {string} でログインする', async ({ world }, email: string) => {
  const cred = credByEmail(email);
  world.apiCtx = await createAuthenticatedContext(cred.email, cred.password);
});

// ----------------------------------------------------------------
// When — 操作
// ----------------------------------------------------------------

When('GET {string} を叩く', async ({ world }, path: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化 — Given でログインしてください');
  const resolved = resolvePlaceholders(path, world.uniqueNames);
  world.lastResponse = await world.apiCtx.get(resolved);
});

When('PATCH {string} を body {string} で叩く', async ({ world }, path: string, bodyStr: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const req = resolveRequest(path, bodyStr, world.uniqueNames);
  world.lastResponse = await world.apiCtx.patch(req.path, { data: req.body });
});

When('PATCH {string} を空ボディで叩く', async ({ world }, path: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const resolved = resolvePlaceholders(path, world.uniqueNames);
  world.lastResponse = await world.apiCtx.patch(resolved, { data: {} });
});

When('POST {string} を body {string} で叩く', async ({ world }, path: string, bodyStr: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  // path も body と同様にプレースホルダ解決する（cmn-0138: /chat/themes/{{themeId}}/messages
  // 等、保存済み id をパスに埋める幸せ道シナリオ用。{{}} 無し URL は無変換）。
  const req = resolveRequest(path, bodyStr, world.uniqueNames);
  world.lastResponse = await world.apiCtx.post(req.path, { data: req.body });
});

When(
  '自分自身の system-role を {string} に変更しようとする',
  async ({ world }, roleArg: string) => {
    if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
    if (!world.currentUserId) {
      throw new Error('currentUserId が未設定 — システムADMIN でログインしてください');
    }
    // cmn-0397: 入口で 1 度解決し、以後は解決済みの値だけを使う（素の引数を通信へ渡さない）
    const role = resolvePlaceholders(roleArg, world.uniqueNames);
    world.lastResponse = await world.apiCtx.patch(
      `/api/v1/members/${world.currentUserId}/system-role`,
      { data: { role } },
    );
  },
);

// ----------------------------------------------------------------
// Then — アサーション
// ----------------------------------------------------------------

Then('ステータスコード {int} が返る', async ({ world }, expectedStatus: number) => {
  if (!world.lastResponse) {
    throw new Error('レスポンスが未取得 — When ステップが実行されていません');
  }
  const actual = world.lastResponse.status();

  // 失敗時に body を表示してデバッグを容易にする
  let bodyText = '';
  try {
    const b = (await world.lastResponse.json()) as unknown;
    bodyText = JSON.stringify(b);
  } catch {
    bodyText = await world.lastResponse.text();
  }

  expect(
    actual,
    `ステータスコード ${expectedStatus} を期待 (実際: ${actual}) — body: ${bodyText}`,
  ).toBe(expectedStatus);
});

Then('レスポンスに {string} チャネルが含まれる', async ({ world }, channelName: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as {
    success: boolean;
    data: Array<{ name: string }>;
  };
  expect(body.success, 'success フラグが true であること').toBe(true);
  const names = body.data.map((s) => s.name);
  expect(names, `チャネル "${channelName}" が一覧に含まれること`).toContain(channelName);
});

// ----------------------------------------------------------------
// 作成系 step 基盤 (cmn-0054) — daily 側 cmn-0138 でも再利用
// ----------------------------------------------------------------

// teardown method 判定は support/teardown.ts へ切り出し（単体テスト対象・cmn-0408）

/** JSON path (例: "data.name") をたどって値を取得する */
function resolveJsonPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

When(
  '一意名 {string} を生成して {string} に保存する',
  async ({ world }, prefix: string, key: string) => {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    world.uniqueNames[key] = `${prefix}-${ts}-${rand}`;
  },
);

When(
  'POST {string} を body {string} で叩き id を記録する',
  async ({ world }, urlPath: string, bodyStr: string) => {
    if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
    const req = resolveRequest(urlPath, bodyStr, world.uniqueNames);
    world.lastResponse = await world.apiCtx.post(req.path, { data: req.body });

    // 失敗時・id 抽出不可時は記録しない（テスト本体で status code 検証が先に落ちる）
    if (!world.lastResponse.ok()) return;
    try {
      const resBody = (await world.lastResponse.json()) as {
        success: boolean;
        data: { id: unknown; revision?: unknown } | null;
      };
      // teardown も解決後の path を基準にする（DELETE step が resolved path で
      // createdIds を引くため、ここを生のままにすると照合が外れる）。
      // revision を要求する消し口（予定）は support/teardown.ts が revision を添える（d793）。
      const entry = resBody.success ? buildCreatedResourceTeardown(req.path, resBody.data) : null;
      if (entry) world.createdIds.push(entry);
    } catch {
      // id 抽出失敗時は記録しない（テスト失敗を優先）
    }
  },
);

When('直前のレスポンスの id を {string} に保存する', async ({ world }, key: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as {
    success: boolean;
    data: { id: string } | null;
  };
  expect(body.success, 'success フラグが true であること').toBe(true);
  if (!body.data?.id) throw new Error('data.id が無い — 直前のレスポンスが想定外');
  world.uniqueNames[key] = body.data.id;
});

Then(
  'レスポンスの {string} が {string} と一致する',
  async ({ world }, jsonPath: string, expected: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    const actual = resolveJsonPath(body, jsonPath);
    const expectedResolved = resolvePlaceholders(expected, world.uniqueNames);
    // actual が number の場合は文字列化して比較（型非依存アサート）
    expect(String(actual), `${jsonPath} が ${expectedResolved} と一致すること`).toBe(
      expectedResolved,
    );
  },
);

When('PUT {string} を body {string} で叩く', async ({ world }, path: string, bodyStr: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const req = resolveRequest(path, bodyStr, world.uniqueNames);
  world.lastResponse = await world.apiCtx.put(req.path, { data: req.body });
});

// ----------------------------------------------------------------
// partner-scope (cmn-0055) — DELETE 系 step
// 成功時のみ teardown に登録（403 など失敗時は登録しない＝resource は未削除）
// ----------------------------------------------------------------

When('DELETE {string} を叩く', async ({ world }, urlPath: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const resolved = resolvePlaceholders(urlPath, world.uniqueNames);
  world.lastResponse = await world.apiCtx.delete(resolved);

  // 明示削除成功時は teardown 登録から除外する（同じ resource の二重 DELETE を防ぐ）。
  // 予定は登録側の path に `?revision=` が付いているため、クエリを落とした path でも照合する（d793）。
  if (world.lastResponse.status() < 400) {
    const bare = resolved.split('?')[0];
    world.createdIds = world.createdIds.filter(
      (r) => r.path !== resolved && r.path.split('?')[0] !== bare,
    );
  }
});

// ----------------------------------------------------------------
// partner-scope (cmn-0055) — 一覧遮断アサート
// 直前レスポンス.data[] に指定した id/name/title が**含まれない**ことを確認
// （cmn-0364: コメントを実物の照合フィールドへ是正。判定ロジックは不変）
// ----------------------------------------------------------------

/**
 * 一覧レスポンスの data をフラットな配列へ正規化する（cmn-0138）。
 * 素の配列はそのまま、okPaginated の {items, meta}（announcements / tasks / chat
 * themes 等）は items、files tree の {roots} は roots（ルート階層のみ＝ルート直下
 * 作成フォルダの包含検証に使う）を返す。どちらの一覧 shape でも同一のアサート
 * step を再利用するため、包含/非包含の両アサートが共有する。
 *
 * 契約: items と roots が**同時に現れる**レスポンス形状は現状の API には存在
 * しない（各呼び出し元は items-only か roots-only のどちらかに閉じる）。
 * 両方を一度に正規化する必要が出た場合は items を優先する（既存実装の挙動を
 * そのまま契約として明文化し、過剰な正規化を避ける・cmn-0153）。
 */
export function resolveListItems(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    const obj = data as { items?: unknown; roots?: unknown };
    if (Array.isArray(obj.items)) return obj.items as Array<Record<string, unknown>>;
    if (Array.isArray(obj.roots)) return obj.roots as Array<Record<string, unknown>>;
  }
  throw new Error(
    `data が配列でも {items}/{roots} でもない — 期待: 一覧, 実際: ${JSON.stringify(data).slice(0, 80)}`,
  );
}

/** 一覧エントリから照合対象の値（id / name / title）を扁平に集める */
function collectListValues(items: Array<Record<string, unknown>>): string[] {
  return items.flatMap((e) => [e.id, e.name, e.title].map((v) => (v == null ? '' : String(v))));
}

Then('レスポンス配列に {string} が含まれない', async ({ world }, key: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as {
    success: boolean;
    data: unknown;
  };
  expect(body.success, 'success フラグが true であること').toBe(true);
  const resolved = resolvePlaceholders(key, world.uniqueNames);
  expect(
    collectListValues(resolveListItems(body.data)),
    `一覧に "${resolved}" が含まれないこと`,
  ).not.toContain(resolved);
});

// ----------------------------------------------------------------
// daily (cmn-0138) — 一覧包含アサート + 数値の保存/差分比較
// 幸せ道シナリオ（お知らせ未読カウント・chat/task/file 一覧反映）で再利用する
// 汎用 step。リソース固有 step を増やさず、jsonPath 指定で共通化する。
// ----------------------------------------------------------------

Then('レスポンス配列に {string} が含まれる', async ({ world }, key: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as {
    success: boolean;
    data: unknown;
  };
  expect(body.success, 'success フラグが true であること').toBe(true);
  const resolved = resolvePlaceholders(key, world.uniqueNames);
  expect(
    collectListValues(resolveListItems(body.data)),
    `一覧に "${resolved}" が含まれること`,
  ).toContain(resolved);
});

/**
 * 直前レスポンスの任意 jsonPath 値を world.uniqueNames へ保存する。
 * 未読カウント（data.count）等、id 以外の値を後続 step の比較に使うため
 * 「直前のレスポンスの id を保存する」の汎用版として追加。
 */
When(
  'レスポンスの {string} を {string} に保存する',
  async ({ world }, jsonPath: string, key: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    const v = resolveJsonPath(body, jsonPath);
    if (v == null) throw new Error(`jsonPath ${jsonPath} が null/undefined — 保存できません`);
    world.uniqueNames[key] = String(v);
  },
);

/**
 * 直前レスポンスの jsonPath 数値が「保存値 + delta」と一致することを検証する。
 * お知らせ未読カウントの +1 / 既読化で元に戻る（+0）を、既存お知らせ数に依存せず
 * 差分で固定する（絶対値アサートは他シナリオの残データで flaky になるため）。
 */
Then(
  'レスポンスの {string} が保存値 {string} + {int} と一致する',
  async ({ world }, jsonPath: string, key: string, delta: number) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    const actual = Number(resolveJsonPath(body, jsonPath));
    const base = Number(world.uniqueNames[key]);
    if (Number.isNaN(actual)) throw new Error(`jsonPath ${jsonPath} が数値ではありません`);
    if (Number.isNaN(base))
      throw new Error(`保存値 ${key} が数値ではありません（先に保存 step を）`);
    expect(
      actual,
      `${jsonPath} が ${key}(${base}) + ${delta} = ${base + delta} と一致すること`,
    ).toBe(base + delta);
  },
);
