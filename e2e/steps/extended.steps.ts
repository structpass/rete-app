/**
 * rete E2E — トラック別シナリオ用の追加ステップ（2026-10-25）
 *
 * 既存の common.steps.ts は「JSON body を叩く」「一覧の包含/非包含」までで、次が無く
 * トラック別シナリオ（docs/scenarios/tracks）を書き切れなかった:
 *   - multipart でのファイルアップロード（文脈が Content-Type: application/json を固定している）
 *   - 数値・null・真偽値の jsonPath アサート（既存は文字列一致のみ）
 *   - 未ログインの接続（セッションを持たない状態の再現）
 *
 * 重複定義は playwright-bdd が禁止するため、パターンは既存と衝突しない語順にしてある。
 * 引数はすべて入口で 1 度 resolvePlaceholders し、以後は解決済みの値だけを送る
 * （scripts/check-e2e-step-arg-resolution.mjs の規律）。
 */

import { request, expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { BASE_URL, createAuthenticatedContext, credByEmail } from '../support/auth';
import { resolvePlaceholders, resolveRequest } from '../support/placeholders';
import { buildCreatedResourceTeardown } from '../support/teardown';
import { splitActorSuffix } from '../support/deferred-teardown';
import { tappedIdsOf } from '../support/response-fingerprint';

/** JSON path (例: "data.versionNo") をたどる。数値・null をそのまま返す。 */
function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** 一覧レスポンスの要素配列（素の配列 / {items} / {roots} のいずれでも受ける）。 */
function listOf(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    const o = data as { items?: unknown; roots?: unknown };
    if (Array.isArray(o.items)) return o.items as Array<Record<string, unknown>>;
    if (Array.isArray(o.roots)) return o.roots as Array<Record<string, unknown>>;
  }
  return [];
}

// ----------------------------------------------------------------
// 未ログイン（セッションを持たない接続）
// ----------------------------------------------------------------

Given('未ログインの接続を {string} に用意する', async ({ world }, key: string) => {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  world.sessions[key] = ctx;
  world.auxiliaryContexts.push(ctx);
});

/**
 * キャッシュを使わずに新しくログインした接続を用意する。
 * ログアウトを試すシナリオ専用（共有のセッションキャッシュを落とすと、後続のシナリオが
 * 401 で落ちる）。資格情報は seed 固定値なので、呼び出し側がメールとパスワードを渡す。
 */
Given(
  'メール {string}・パスワード {string} で新しくログインした接続を {string} に用意する',
  async ({ world }, emailArg: string, passwordArg: string, key: string) => {
    const email = resolvePlaceholders(emailArg, world.uniqueNames);
    const password = resolvePlaceholders(passwordArg, world.uniqueNames);
    const ctx = await request.newContext({ baseURL: BASE_URL });
    const res = await ctx.post('/api/v1/auth/login', { data: { email, password } });
    if (!res.ok()) {
      throw new Error(`新規ログインに失敗: ${res.status()} ${await res.text()}`);
    }
    world.sessions[key] = ctx;
    world.auxiliaryContexts.push(ctx);
  },
);

When('保存セッション {string} でログアウトする', async ({ world }, key: string) => {
  const ctx = world.sessions[key];
  if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
  world.lastResponse = await ctx.post('/api/v1/auth/logout');
});

// ----------------------------------------------------------------
// multipart アップロード
// ----------------------------------------------------------------

When(
  'POST {string} に名前 {string}・中身 {string} のファイルを multipart で送り id を記録する',
  async ({ world }, urlPath: string, fileName: string, content: string) => {
    if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
    const path = resolvePlaceholders(urlPath, world.uniqueNames);
    const name = resolvePlaceholders(fileName, world.uniqueNames);
    const body = resolvePlaceholders(content, world.uniqueNames);

    // 文脈の extraHTTPHeaders が Content-Type を JSON に固定しているため、
    // multipart は同じセッション（cookie）を写した別 context で送る。
    // ヘッダは明示的に空にする（空にしないと設定の Content-Type: application/json が乗り、
    // 本文が JSON として解釈されて 400 になる）。
    const state = await world.apiCtx.storageState();
    const ctx = await request.newContext({
      baseURL: BASE_URL,
      storageState: state,
      extraHTTPHeaders: {},
    });
    world.auxiliaryContexts.push(ctx);
    world.lastResponse = await ctx.post(path, {
      multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.from(body, 'utf-8') } },
    });

    if (!world.lastResponse.ok()) return;
    try {
      const json = (await world.lastResponse.json()) as { data?: { id?: string } };
      // 実体の消し口は /files/files/<id>（アップロード元 path からは組み立てられない）。
      // 同名で上げ直すと版追加になり **同じ id** が返るため、二重登録すると後始末が 404 で落ちる。
      const deletePath = json.data?.id ? `/api/v1/files/files/${json.data.id}` : null;
      if (deletePath && !world.createdIds.some((r) => r.path === deletePath)) {
        world.createdIds.push({ method: 'DELETE', path: deletePath });
      }
    } catch {
      // 形が想定外なら記録しない（本体のステータス検証が先に落ちる）
    }
  },
);

When('PUT {string} を空ボディで叩く', async ({ world }, urlPath: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const resolved = resolvePlaceholders(urlPath, world.uniqueNames);
  world.lastResponse = await world.apiCtx.put(resolved, { data: {} });
});

/**
 * 数値の id を body に埋めるための入口。
 *
 * 既存の `POST ... を body ... で叩く` は「JSON.parse → 文字列値だけ置換」の順で解決する
 * （差し込む値に引用符が入っても構造が壊れないようにするため・cmn-0394）。そのため
 * `{"categoryId":{{catId}}}` のように **数値位置** へ id を埋める書き方ができない
 * （parse の時点で {{catId}} が不正な JSON になる）。
 * こちらは「文字列置換 → JSON.parse」の順にして、数値位置のプレースホルダを許す
 * （body 全体が自分で書いた固定 JSON のため、値の混入で構造が壊れる心配はない）。
 */
function resolveRawBody(bodyStr: string, vars: Record<string, string>): Record<string, unknown> {
  const replaced = resolvePlaceholders(bodyStr, vars);
  const parsed: unknown = JSON.parse(replaced);
  if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
    throw new Error(`body は JSON オブジェクトである必要があります: ${replaced}`);
  }
  return parsed as Record<string, unknown>;
}

When(
  'POST {string} を body {string} で置換してから叩き id を記録する',
  async ({ world }, urlPath: string, bodyStr: string) => {
    if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
    const path = resolvePlaceholders(urlPath, world.uniqueNames);
    world.lastResponse = await world.apiCtx.post(path, {
      data: resolveRawBody(bodyStr, world.uniqueNames),
    });
    if (!world.lastResponse.ok()) return;
    try {
      const json = (await world.lastResponse.json()) as {
        data?: { id?: string | number; revision?: unknown };
      };
      // revision を要求する消し口（予定）は support/teardown.ts が revision を添える（d793）。
      const entry = buildCreatedResourceTeardown(path, json.data);
      if (entry) world.createdIds.push(entry);
    } catch {
      // 形が想定外なら記録しない（本体のステータス検証が先に落ちる）
    }
  },
);

When(
  'PATCH {string} を body {string} で置換してから叩く',
  async ({ world }, urlPath: string, bodyStr: string) => {
    if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
    const path = resolvePlaceholders(urlPath, world.uniqueNames);
    world.lastResponse = await world.apiCtx.patch(path, {
      data: resolveRawBody(bodyStr, world.uniqueNames),
    });
  },
);

When(
  'PUT {string} を body {string} で置換してから叩く',
  async ({ world }, urlPath: string, bodyStr: string) => {
    if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
    const path = resolvePlaceholders(urlPath, world.uniqueNames);
    world.lastResponse = await world.apiCtx.put(path, {
      data: resolveRawBody(bodyStr, world.uniqueNames),
    });
  },
);

// ----------------------------------------------------------------
// 値のアサート（数値・null・真偽値・保存値）
// ----------------------------------------------------------------

Then(
  'レスポンスの {string} が数値 {int} と一致する',
  async ({ world }, jsonPath: string, expected: number) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    expect(Number(pick(body, jsonPath)), `${jsonPath} が ${expected} と一致すること`).toBe(
      expected,
    );
  },
);

Then('レスポンスの {string} が null である', async ({ world }, jsonPath: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
  expect(body.success, 'success フラグが true であること').toBe(true);
  expect(pick(body, jsonPath), `${jsonPath} が null であること`).toBeNull();
});

Then('レスポンスの {string} が空でない', async ({ world }, jsonPath: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
  expect(body.success, 'success フラグが true であること').toBe(true);
  expect(pick(body, jsonPath), `${jsonPath} が空でないこと`).toBeTruthy();
});

Then('レスポンスの {string} が空である', async ({ world }, jsonPath: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
  expect(body.success, 'success フラグが true であること').toBe(true);
  const actual = pick(body, jsonPath);
  const len = Array.isArray(actual) ? actual.length : actual == null ? 0 : 1;
  expect(len, `${jsonPath} が空であること（実際: ${JSON.stringify(actual)?.slice(0, 120)}）`).toBe(
    0,
  );
});

Then(
  'レスポンスの {string} が真偽値 {string} である',
  async ({ world }, jsonPath: string, expected: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    expect(pick(body, jsonPath), `${jsonPath} が ${expected} であること`).toBe(expected === 'true');
  },
);

Then(
  'レスポンスの {string} が保存値 {string} と一致する',
  async ({ world }, jsonPath: string, key: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    // key は「保存した時のキー名」なので、値は uniqueNames から引く（{{}} 置換ではない）。
    // タスク id は数値で保存されるため、比較は文字列に揃える。
    const base = world.uniqueNames[key];
    if (base === undefined) throw new Error(`保存値 ${key} が未設定`);
    expect(
      String(pick(body, jsonPath)),
      `${jsonPath} が保存値 ${key}(${base}) と一致すること`,
    ).toBe(String(base));
  },
);

Then(
  'レスポンス配列の {string} 一覧に {string} と一致する要素が 1 件ある',
  async ({ world }, field: string, expected: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    const exp = resolvePlaceholders(expected, world.uniqueNames);
    const hits = listOf(body.data).filter((e) => String(e[field]) === exp);
    expect(hits.length, `${field}=${exp} の要素が 1 件であること`).toBe(1);
  },
);

Then(
  'レスポンス配列の {string} 一覧に {string} と一致する要素は 0 件',
  async ({ world }, field: string, expected: string) => {
    if (!world.lastResponse) throw new Error('レスポンスが未取得');
    const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
    expect(body.success, 'success フラグが true であること').toBe(true);
    const exp = resolvePlaceholders(expected, world.uniqueNames);
    const hits = listOf(body.data).filter((e) => String(e[field]) === exp);
    expect(hits.length, `${field}=${exp} の要素が 0 件であること`).toBe(0);
  },
);

// ----------------------------------------------------------------
// 一覧の行に値が入っているか（S-FILE-02）
//   既存の `… と一致する要素が 1 件ある` は値を feature に直書きする形で、
//   「大きさが 0 より大きい」「更新時刻が空でない」のように**規則**で見る書き方ができない。
// ----------------------------------------------------------------

Then('レスポンス配列の {string} 一覧に 0 より大きい値がある', async ({ world }, field: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
  expect(body.success, 'success フラグが true であること').toBe(true);
  const values = listOf(body.data).map((e) => Number(e[field]));
  expect(
    values.some((v) => Number.isFinite(v) && v > 0),
    `${field} が 0 より大きい行があること（実際: ${values.join(', ') || 'なし'}）`,
  ).toBe(true);
});

Then('レスポンス配列の {string} 一覧に空でない値がある', async ({ world }, field: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
  expect(body.success, 'success フラグが true であること').toBe(true);
  const values = listOf(body.data).map((e) => e[field]);
  expect(
    values.some((v) => v != null && String(v).length > 0),
    `${field} が空でない行があること（実際: ${values.map(String).join(', ') || 'なし'}）`,
  ).toBe(true);
});

// ----------------------------------------------------------------
// 保存セッション（並存させる別ユーザー）
// ----------------------------------------------------------------

When(
  '保存セッション {string} で PATCH {string} を body {string} で叩く',
  async ({ world }, key: string, urlPath: string, bodyStr: string) => {
    const ctx = world.sessions[key];
    if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
    const req = resolveRequest(urlPath, bodyStr, world.uniqueNames);
    world.lastResponse = await ctx.patch(req.path, { data: req.body });
    // 叩いた先の id を控える（応答に写っていないことの照合・d859。前の GET の控えを持ち越さない）。
    world.tappedIds = tappedIdsOf(req.path);
  },
);

When(
  '保存セッション {string} で DELETE {string} を叩く',
  async ({ world }, key: string, urlPath: string) => {
    const ctx = world.sessions[key];
    if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
    const resolved = resolvePlaceholders(urlPath, world.uniqueNames);
    world.lastResponse = await ctx.delete(resolved);
    world.tappedIds = tappedIdsOf(resolved);
  },
);

When(
  '保存セッション {string} で POST {string} を body {string} で叩く',
  async ({ world }, key: string, urlPath: string, bodyStr: string) => {
    const ctx = world.sessions[key];
    if (!ctx) throw new Error(`保存セッション ${key} が見つからない`);
    const req = resolveRequest(urlPath, bodyStr, world.uniqueNames);
    world.lastResponse = await ctx.post(req.path, { data: req.body });
    world.tappedIds = tappedIdsOf(req.path);

    // 作った資源を後始末の登録へ入れる（d971）。他の人の個人メモの中の話は、管理者の接続では
    // 消せない（404）ため、作った接続（この保存セッション）を控えて後始末でもそれを使う。
    if (!world.lastResponse.ok()) return;
    try {
      const json = (await world.lastResponse.json()) as {
        success: boolean;
        data?: { id?: string | number; revision?: unknown };
      };
      const entry = buildCreatedResourceTeardown(req.path, json);
      if (entry) {
        // 話なら body の spaceId が「どの器の中に作ったか」（個人メモの中の話を器ごと消すため・d971）。
        const spaceId =
          req.path === '/api/v1/chat/themes' && typeof req.body === 'object' && req.body !== null
            ? (req.body as { spaceId?: unknown }).spaceId
            : undefined;
        // 管理経路（/admin）で作った器は、既存の更新口（:id）がスコープの ADMIN を求めて通らない。
        // 先頭の 1 か所だけを書き換える（置換は最初の一致だけ。入れ子の id には触らない）。
        // 管理経路は作成者の立場に依らないので、作った人の接続でも同じ管理経路で消す（d971）。
        const adminPath = entry.path.replace(
          /^\/api\/v1\/(spaces|projects|organizations)\//,
          '/api/v1/$1/admin/',
        );
        world.createdIds.push({
          ...entry,
          own: {
            ctx,
            session: key,
            method: entry.method,
            path: adminPath.endsWith('admin') ? entry.path : adminPath,
          },
          // d1024: 登録の時点の接続そのものを控える（`world.apiCtx` はシナリオ中に差し替わる）。
          ownCtx: ctx,
          session: key,
          ownerSpaceId: typeof spaceId === 'string' ? spaceId : undefined,
        });
      }
    } catch {
      // 形が想定外なら記録しない（本体のステータス検証が先に落ちる）
    }
  },
);

// ----------------------------------------------------------------
// 途中でも済ませる後始末（全ユーザー共通の設定を作り変えるシナリオ用）
//   記法と判定の実体は support/deferred-teardown.ts。ここは手順の配線だけを持つ。
// ----------------------------------------------------------------

/**
 * 末尾の `=> システムADMIN "<メール>"` を付けた行は「後始末でも流し直す」手順として登録する。
 * 手順そのものは印を除いた部分で、叩く人は末尾で名乗った人（メインの apiCtx の人は変えない）。
 *
 * 戻し済みの印は次の行で付く。後始末は「まだ印の無い行」だけを流すため、手順どおり最後まで
 * 進めば戻し行も印つきで終わり、後始末は何も流さない（二重実行しない）。
 */
When(
  'PATCH {string} を body {string} で叩く => システムADMIN {string}',
  async ({ world }, urlPath: string, bodyStr: string, email: string) => {
    const pathPart = splitActorSuffix(urlPath);
    const bodyPart = splitActorSuffix(bodyStr);
    // 登録は変数を解決する前の形で持つ（シナリオが途中で落ちても同じ値で流し直せるように）。
    world.deferredSteps.push({
      path: pathPart.text,
      body: bodyPart.text,
      email,
      settled: false,
    });

    const cred = credByEmail(email);
    const actorCtx = await createAuthenticatedContext(cred.email, cred.password);
    world.auxiliaryContexts.push(actorCtx);

    const req = resolveRequest(pathPart.text, bodyPart.text, world.uniqueNames);
    world.lastResponse = await actorCtx.patch(req.path, { data: req.body });

    // 通った時点でこの行は「手順として流れ終えた」。この後にシナリオが落ちても流し直さない。
    if (world.lastResponse.ok()) world.deferredSteps[world.deferredSteps.length - 1].settled = true;
  },
);

/**
 * 戻し済みの印を付ける（feature の戻し行の末尾へ `設定を戻した` と書く）。
 * PATCH の手順は「2xx が返った」時点で印を付くため通常は不要だが、戻し行を 2xx 以外で
 * 通す特殊な設定でも後始末から外せるよう、明示の口も残す。
 */
Then('設定を戻した', async ({ world }) => {
  const last = world.deferredSteps[world.deferredSteps.length - 1];
  if (!last) throw new Error('後始末に登録された手順が無い — 先に戻し行を置いてください');
  last.settled = true;
});
