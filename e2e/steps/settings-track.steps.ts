/**
 * rete E2E — 設定トラック（d775）のステップ定義
 *
 * `docs/scenarios/tracks/05-settings.md` の未確認 7 件（S-SET-02 / 04 / 06 / 10 / 11 / 14 / 15）を、
 * 通信の応答で確かめるための語彙。既存の語彙（common / extended / auth-track）は再定義せず、
 * ここにしか無い手順だけを置く（playwright-bdd は同一パターンの重複定義を禁止する）。
 *
 * 設計上の注意:
 * - 引数はすべて入口で 1 度 resolvePlaceholders し、以後は解決済みの値だけを通信へ渡す
 *   （`scripts/check-e2e-step-arg-resolution.mjs` の規律）。
 * - 作った行は `world.createdIds` に積み、破った後始末に任せる（行を残さない）。
 * - 「実測して挙動が決まったので <ID> を確認済みにする」は auth-track の同じ行を再利用する。
 * - 受諾（S-SET-08）は、表に当たらない値を渡して断られるところまでを確かめる（受諾の成立は、
 *   作ったアカウントを消す手段が無いため確かめない。後始末は発行した招待まで）。
 * - ロック解除（S-SET-11）は auth-track の語彙（誤入力 N 回・管理者の解除・新しい接続でのログイン）
 *   をそのまま並べるため、ここでは定義しない。
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { generate as otplibGenerate } from 'otplib';
import { request, expect } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { BASE_URL } from '../support/auth';
import { resolvePlaceholders } from '../support/placeholders';
import { listOf } from '../support/list-counts';

// ----------------------------------------------------------------
// IP 許可リストの保存（S-SET-05・d827）
// ----------------------------------------------------------------

/**
 * 直前の応答が返した「この接続の IP」を控える。
 *
 * d827 以降、IP 許可リストは**自分の IP を含む時だけ保存できる**（含まないリストは、保存した瞬間に
 * 管理セッションごと遮断されて戻す手が無くなるため、保存の入口で断る）。試験の接続元はその場の
 * 開発機なので、固定の CIDR を書くと保存そのものが 400 になる。自分の IP を読んでから自分の範囲で保存する。
 */
Then('直前のレスポンスの data.currentIp を {string} に保存する', async ({ world }, key: string) => {
  if (!world.lastResponse) throw new Error('直前の応答が無い — 先に GET する');
  const body = (await world.lastResponse.json()) as { data?: { currentIp?: unknown } };
  const ip = body.data?.currentIp;
  if (typeof ip !== 'string' || ip.length === 0) {
    throw new Error('応答に data.currentIp が無い（IP を検出できない接続）');
  }
  world.uniqueNames[resolvePlaceholders(key, world.uniqueNames)] = `${ip}/32`;
});

/** 直前の応答を本文ごと読む（成功前提の判定なので success=true を確かめてから使う）。 */
async function readSuccessBody(world: {
  lastResponse: { json: () => Promise<unknown> } | null;
}): Promise<{ success: boolean; data: unknown }> {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  return (await world.lastResponse.json()) as { success: boolean; data: unknown };
}

/** JSON path（例: "data.backupCodes"）をたどる。欄が無ければ undefined を返す。 */
function pickField(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// 断る行に使う宛先の頭。一意名（時刻＋乱数）を後ろに付けるので、実行を重ねても重ならない。
const CSV_BAD_EMAIL_HEAD = 'e2e-csv-bad-';

// 契約システムの seed の並び（prisma/seed.ts の TENANT_SYSTEM_DEFS と同じ 4 件・同じ順）。
// seed の定義が変わったらここも合わせる（並びを戻す手順が参照する唯一の場所）。
const SEED_SYSTEM_ORDER = ['SYS-001', 'SYS-002', 'RETE-DESK', 'RETE-FILE'] as const;

// ----------------------------------------------------------------
// 招待 CSV（S-SET-10）
// ----------------------------------------------------------------

/**
 * 招待 CSV を multipart で取り込む（`POST /invites/csv/import`）。
 *
 * 送る中身はテンプレートの見出しに「良い宛先・空行・形の崩れた宛先・良い宛先」を足した形。
 * 空行を**崩れた行より前に**置くのは、行番号を「実際の CSV の行」で数えているか
 * （空行を飛ばして詰めていないか）を、期待値 4 行目で判別できるようにするため。
 */
When(
  '招待 CSV のテンプレートを取り込み宛先の形を確かめてから、良い宛先と形の崩れた宛先を混ぜた CSV を取り込む',
  async ({ world }) => {
    if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');

    // ① テンプレートを取得する（取れなければ以降の期待が成り立たないので、そこで止める）。
    const template = await world.apiCtx.get('/api/v1/invites/csv/template');
    if (!template.ok()) {
      throw new Error(`テンプレートの取得に失敗: ${template.status()} ${await template.text()}`);
    }
    const templateText = await template.text();

    // ② テンプレートの 1 行目（見出し）をそのまま使い、行を足す。
    const header = templateText.split(/\r\n|\r|\n/)[0];
    if (!header || header.trim() === '') {
      throw new Error(
        `テンプレートの見出し行が読めない: ${JSON.stringify(templateText.slice(0, 80))}`,
      );
    }
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const badEmail = `${CSV_BAD_EMAIL_HEAD}${suffix}`;
    world.uniqueNames['csvOkEmail1'] = `e2e-csv-ok-${suffix}@example.com`;
    world.uniqueNames['csvOkEmail2'] = `e2e-csv-ok2-${suffix}@example.com`;
    const csv = [
      header,
      world.uniqueNames['csvOkEmail1'],
      // 空行（2 行目の後ろ）。数えずに詰めると、崩れた行の番号が 3 になって期待と食い違う。
      '',
      badEmail,
      world.uniqueNames['csvOkEmail2'],
    ].join('\n');

    // ③ 取り込む。文脈は Content-Type を JSON に固定しているため、同じ cookie を写した別 context で送る。
    const state = await world.apiCtx.storageState();
    const ctx = await request.newContext({
      baseURL: BASE_URL,
      storageState: state,
      extraHTTPHeaders: {},
    });
    world.auxiliaryContexts.push(ctx);
    world.uniqueNames['csvBadEmail'] = badEmail;
    world.lastResponse = await ctx.post('/api/v1/invites/csv/import', {
      multipart: {
        file: { name: 'invites.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8') },
        spaceId: `${world.uniqueNames['groupId'] ?? ''}`,
      },
    });

    // ④ 発行された 2 件は、後始末で消す（作りっぱなしにすると、招待一覧へ溜まる）。
    //   取り込みの応答は発行した行の id を返さないため、一覧から自分の宛先の行を引いて消す。
    if (!world.lastResponse.ok()) return;
    const list = await ctx.get('/api/v1/invites');
    if (!list.ok()) return;
    const rows = listOf(((await list.json()) as { data?: unknown }).data);
    const mine = new Set([world.uniqueNames['csvOkEmail1'], world.uniqueNames['csvOkEmail2']]);
    for (const row of rows) {
      if (!mine.has(String(row.email))) continue;
      world.createdIds.push({ method: 'DELETE', path: `/api/v1/invites/${String(row.id)}` });
    }
  },
);

Then('取り込みの結果に発行数と断った件数が分かれて返る', async ({ world }) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const data = (body.data ?? {}) as {
    issued?: unknown;
    skipped?: unknown;
    skippedDetails?: unknown;
  };
  expect(typeof data.issued, '発行数（issued）が数値で返ること').toBe('number');
  expect(typeof data.skipped, '断った件数（skipped）が数値で返ること').toBe('number');
  // 送った CSV は「良い宛先 2 件・形の崩れた宛先 1 件」。発行数と断った件数に分かれることを見る。
  expect(Number(data.issued), '良い宛先 2 件が発行されたこと').toBe(2);
  expect(Number(data.skipped), '形の崩れた宛先 1 件が断られたこと').toBe(1);
  expect(Array.isArray(data.skippedDetails), '断った行の内訳が配列で返ること').toBe(true);

  // 断った行の内訳に、宛先・理由・CSV の行番号が入っていること（ここが「理由と行番号付きで残る」の判定本体）。
  const details = data.skippedDetails as Array<Record<string, unknown>>;
  expect(details.length, '断った行の内訳が 1 件であること').toBe(1);
  const row = details[0];
  const bad = world.uniqueNames['csvBadEmail'];
  expect(String(row.email), `断った宛先（${String(bad)}）が内訳に残ること`).toBe(String(bad));
  expect(String(row.reason ?? ''), '断った理由が入っていること').not.toBe('');
  // CSV は 見出し=1・良い宛先=2・空行=3・形の崩れた宛先=4。空行を詰めて数えると 3 になる。
  expect(Number(row.row), 'CSV の行番号が、空行を飛ばした実際の 4 行目であること').toBe(4);
});

// ----------------------------------------------------------------
// 祝日（S-SET-15）
// ----------------------------------------------------------------

When(
  'カレンダーの祝日に保存値 {string} の日付を名前とともに登録して同じ日付でもう一度登録する',
  async ({ world }, dateArg: string) => {
    if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
    const date = world.uniqueNames[dateArg];
    // 生の path で先に消していいのは、日付が形式（YYYY-MM-DD）を満たすと自分で確かめた時だけ。
    // 前の実行が落ちて同じ日付が残っていると、そのままだと 409 で「断られた」と読めてしまう。
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`日付の形式が違う（YYYY-MM-DD でない）: ${String(date)}`);
    }
    await world.apiCtx.delete(`/api/v1/calendar-holidays/${date}`);
    const first = await world.apiCtx.post('/api/v1/calendar-holidays', {
      data: { date, name: '祝日 初回' },
    });
    if (!first.ok()) {
      throw new Error(
        `祝日の 1 回目の登録に失敗（日付 ${date}）: ${first.status()} ${await first.text()}`,
      );
    }
    // 1 回目が 201 で入ったことを控える（最後の応答は 2 回目に上書きされるため）。
    world.uniqueNames['set15FirstStatus'] = String(first.status());
    // 1 本目は通ったので、その行は後始末で消す（2 本目は断られた場合も同じ日付を消せば元に戻る）。
    world.createdIds.push({ method: 'DELETE', path: `/api/v1/calendar-holidays/${date}` });
    world.lastResponse = await world.apiCtx.post('/api/v1/calendar-holidays', {
      data: { date, name: '祝日 二回目' },
    });
  },
);

Then('同じ日付の再登録は 409 で断られ、行が増えない', async ({ world }) => {
  // 1 回目は入った（201）・2 回目は断られた（409）を、両方ひとつの判定で確かめる。
  expect(world.uniqueNames['set15FirstStatus'], '1 回目の登録は 201 で入ること').toBe('201');
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const status = world.lastResponse.status();
  const body = await world.lastResponse.text();
  expect(
    status,
    `同じ日付の再登録は 409 で断ること（実際: ${status} / ${body.slice(0, 120)}）`,
  ).toBe(409);
});

Then('一覧に保存値 {string} の日付の行が 1 件だけある', async ({ world }, key: string) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const value = world.uniqueNames[key];
  if (value === undefined) throw new Error(`保存値 ${key} が未設定`);
  const hits = listOf(body.data).filter((row) => String(row.date) === value);
  expect(hits.length, `日付 ${value} の行が 1 件だけであること（実際: ${hits.length} 件）`).toBe(1);
});

// ----------------------------------------------------------------
// メンバー一覧の書き出し（S-SET-14）
// ----------------------------------------------------------------

Then('書き出した名簿の本文が読める文字列で、件数が一覧と一致する', async ({ world }) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const text = await world.lastResponse.text();
  // 素の UTF-8 で読めて先頭行に見出しが入っていること（文字化けしていればここで崩れる）。
  const [header, ...rows] = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
  expect(
    header,
    `見出し行が空でないこと（実際: ${JSON.stringify(header?.slice(0, 60))}）`,
  ).toBeTruthy();
  expect(header.includes('\uFFFD'), '置換文字（文字化けの印）が含まれないこと').toBe(false);
  expect(rows.length, '見出しの下に 1 行以上の名簿があること').toBeGreaterThan(0);

  // 同じ件数が一覧の側でも返ること（書き出しだけが空、一覧だけが空になっていないこと）。
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const listed = await world.apiCtx.get('/api/v1/members');
  if (!listed.ok()) throw new Error(`メンバー一覧の取得に失敗: ${listed.status()}`);
  const body = (await listed.json()) as { data?: unknown };
  expect(rows.length, '書き出した行数が一覧の件数と一致すること').toBe(listOf(body.data).length);
});

// ----------------------------------------------------------------
// 一覧に残っていないこと（S-SET-10）
// ----------------------------------------------------------------

Then('一覧に保存値 {string} の行は入っていない', async ({ world }, key: string) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const value = world.uniqueNames[key];
  if (value === undefined) throw new Error(`保存値 ${key} が未設定`);
  const hits = listOf(body.data).filter((row) => String(row.email) === value);
  expect(hits.length, `断った宛先 ${value} の招待が作られていないこと`).toBe(0);
});

// ----------------------------------------------------------------
// 招待の再送（S-SET-09）
// ----------------------------------------------------------------

/** 一覧の行から、宛先（保存値）が一致する行を 1 件取り出す。 */
async function findInviteByEmail(
  world: {
    uniqueNames: Record<string, string>;
    lastResponse: { json: () => Promise<unknown> } | null;
  },
  key: string,
): Promise<Record<string, unknown>> {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const email = `${world.uniqueNames[key]}@example.com`;
  const hits = listOf(body.data).filter((row) => String(row.email) === email);
  if (hits.length !== 1) {
    throw new Error(`宛先 ${email} の招待が 1 件になること（実際: ${hits.length} 件）`);
  }
  return hits[0];
}

Then(
  '一覧から保存値 {string} の行の {string} を {string} に控える',
  async ({ world }, emailKey: string, field: string, saveKey: string) => {
    const row = await findInviteByEmail(world, emailKey);
    const value = row[field];
    if (value == null) throw new Error(`招待の行に ${field} が無い`);
    world.uniqueNames[saveKey] = String(value);
  },
);

Then(
  '一覧の保存値 {string} の行の期限は保存値 {string} より後である',
  async ({ world }, emailKey: string, beforeKey: string) => {
    const row = await findInviteByEmail(world, emailKey);
    const before = Date.parse(world.uniqueNames[beforeKey] ?? '');
    const after = Date.parse(String(row.expiresAt ?? ''));
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      throw new Error(
        `期限を読めない（控え: ${String(beforeKey)} / 行: ${String(row.expiresAt)}）`,
      );
    }
    expect(after, '再送で期限が延びること').toBeGreaterThan(before);
  },
);

// ----------------------------------------------------------------
// 表示設定（S-SET-16）
// ----------------------------------------------------------------

Then('直前の応答を {string} として控える', async ({ world }, key: string) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  world.uniqueNames[key] = JSON.stringify(body.data ?? null);
});

When('直前の応答を控えた保存値 {string} の表示設定へ戻す', async ({ world }, key: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const raw = world.uniqueNames[key];
  if (raw === undefined) throw new Error(`保存値 ${key} が未設定`);
  const before = JSON.parse(raw) as { stripeEnabled?: boolean; stripeColor?: string } | null;
  // 未保存（null）だった時は、変更前の見え方（縞あり・既定色）へ戻す。
  world.lastResponse = await world.apiCtx.put('/api/v1/accounts/me/display-preference', {
    data: {
      stripeEnabled: before?.stripeEnabled ?? true,
      stripeColor: before?.stripeColor ?? '#FAFCFF',
    },
  });
});

// ----------------------------------------------------------------
// 二段階認証の有効化（S-SET-04）
//   有効化の前提（ログイン・状態の取得）は既存の語彙で済ませ、ここでは「設定で得た secret から
//   いまの時刻の 6 桁を作り、確定する」ところだけを持つ。
// ----------------------------------------------------------------

When('直前の応答の二段階認証の設定 URI から secret を取り出して確定する', async ({ world }) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  // 確定は「設定を始めた本人の接続」で行う（世界の apiCtx は直前に管理者で入り直していることがある）。
  const ctx = world.sessions['set04'];
  if (!ctx)
    throw new Error('保存セッション set04 が見つからない（先に本人でログインしてください）');
  const body = (await world.lastResponse.json()) as {
    success: boolean;
    data?: { otpauthUri?: string };
  };
  expect(body.success, 'success フラグが true であること').toBe(true);
  const uri = body.data?.otpauthUri ?? '';
  const secret = /[?&]secret=([A-Z2-7]+)/i.exec(uri)?.[1];
  if (!secret) throw new Error(`otpauth URI から secret を取り出せない: ${uri.slice(0, 80)}`);
  const code = await otplibGenerate({ secret, epoch: Math.floor(Date.now() / 1000) });
  world.lastResponse = await ctx.post('/api/v1/settings/mfa/confirm', { data: { code } });
});

Then('レスポンスに {string} の欄が無い', async ({ world }, jsonPath: string) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  expect(
    pickField(body, jsonPath),
    `${jsonPath} が応答に含まれないこと（再表示されない証拠）`,
  ).toBeUndefined();
});

// ----------------------------------------------------------------
// 並びの入れ替え（S-SET-06）
// ----------------------------------------------------------------

/**
 * 契約システムの並びを seed の順（seed の TENANT_SYSTEM_DEFS の並び）へ戻す。
 * 前の実行が並びを変えたまま落ちても、この行から始めれば同じ条件で並べ替えを試せる。
 */
When('契約システムの並びを seed の順へ戻す', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  world.lastResponse = await world.apiCtx.patch('/api/v1/settings/tenant/systems', {
    data: { orderedIds: [...SEED_SYSTEM_ORDER] },
  });
});

/**
 * 契約システムの並びを、保存値の id が先頭へ来るよう入れ替える。
 * 並び替えは「現存全件の id」を渡す形（部分集合は 400）なので、その都度一覧を取り直す。
 * 並びを変える前に今の並びを控えておけば、後で元へ戻せる（並びは表示順として画面に出るため）。
 */
When(
  '契約システムの並びを保存値 {string} が先頭に来るよう入れ替える',
  async ({ world }, key: string) => {
    if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
    const target = world.uniqueNames[key];
    if (target === undefined) throw new Error(`保存値 ${key} が未設定`);
    const listed = await world.apiCtx.get('/api/v1/settings/tenant/systems');
    if (!listed.ok()) throw new Error(`契約システムの一覧の取得に失敗: ${listed.status()}`);
    const body = (await listed.json()) as { data?: unknown };
    const ids = listOf(body.data).map((row) => String(row.id));
    if (!ids.includes(target)) throw new Error(`並び替えの対象 ${target} が一覧に無い`);
    // 控え（後始末で元の並びへ戻す）。
    world.uniqueNames['systemsOrderBefore'] = JSON.stringify(ids);
    world.lastResponse = await world.apiCtx.patch('/api/v1/settings/tenant/systems', {
      data: { orderedIds: [target, ...ids.filter((id) => id !== target)] },
    });
  },
);

When('契約システムの並びを保存値 {string} の順へ戻す', async ({ world }, key: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const before = JSON.parse(world.uniqueNames[key] ?? '[]') as string[];
  const listed = await world.apiCtx.get('/api/v1/settings/tenant/systems');
  if (!listed.ok()) throw new Error(`契約システムの一覧の取得に失敗: ${listed.status()}`);
  const body = (await listed.json()) as { data?: unknown };
  const current = listOf(body.data).map((row) => String(row.id));
  const kept = before.filter((id) => current.includes(id));
  const added = current.filter((id) => !kept.includes(id));
  world.lastResponse = await world.apiCtx.patch('/api/v1/settings/tenant/systems', {
    data: { orderedIds: [...kept, ...added] },
  });
});

Then('一覧の先頭の行が保存値 {string} である', async ({ world }, key: string) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const rows = listOf(body.data);
  const value = world.uniqueNames[key];
  if (value === undefined) throw new Error(`保存値 ${key} が未設定`);
  expect(rows.length, '一覧に 1 行以上あること').toBeGreaterThan(0);
  expect(String(rows[0].id), `先頭が ${value} であること（実際: ${String(rows[0].id)}）`).toBe(
    value,
  );
});

Then('契約システムの並びは保存値 {string} の順に戻っている', async ({ world }, key: string) => {
  const body = await readSuccessBody(world);
  const rows = listOf(body.data).map((row) => String(row.id));
  const before = JSON.parse(world.uniqueNames[key] ?? '[]') as string[];
  expect(JSON.stringify(rows), '並びが元の順へ戻っていること').toBe(JSON.stringify(before));
});

// ----------------------------------------------------------------
// 招待の受諾（S-SET-08）
//   2 つの向きを確かめる。
//   ① 表に無い値を渡すと断る（列挙防止）: **32 バイト乱数の base64url**（受諾の値の形）を用意し、
//      **表のどの招待にも当たらないことを確かめてから渡す**。当たらないので受諾の口は断る。
//   ② 受諾の成立（アカウント作成）: 受諾に渡す値は保存前の生の値で、応答にも表にも出ない。表から
//      取り出した保存値（sha256）では成立しないことを実測済み（2026-10-27・d834）。そのため成立は
//      確かめず、「発行・一覧・削除の口が同じ宛先で 1 件に定まる」ところまでを確かめる。
// ----------------------------------------------------------------

/** 受諾に渡す値の形（招待トークンと同じ 32 バイト乱数の base64url）。 */
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** backend の置き場（Prisma の生成物がある）。表を直接引く確認をここで流す。 */
const BACKEND_DIR = path.join(__dirname, '..', '..', 'packages', 'backend');

/** backend の置き場で、Prisma を使う短いスクリプトを 1 回流し、標準出力を返す。 */
function runBackendScript(script: string, what: string): string {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development' },
    shell: false,
  });
  if (res.status !== 0) {
    const tail = `${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`
      .trim()
      .split('\n')
      .slice(-4);
    throw new Error(`${what}に失敗: ${tail.join(' / ')}`);
  }
  return String(res.stdout ?? '');
}

/**
 * 招待を発行し、その id を控える（受諾の対象になる 1 件）。
 *
 * 宛先は実行ごとの一意名。発行が通ったら招待の削除を後始末に登録する（受諾でアカウントができる前に、
 * 招待そのものが残らないようにする）。
 */
When('招待の宛先 {string} に招待を発行して id を控える', async ({ world }, emailArg: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const email = resolvePlaceholders(emailArg, world.uniqueNames);
  world.uniqueNames['acceptEmail'] = email;
  const spaceId = world.uniqueNames['groupId'];
  if (spaceId === undefined) {
    throw new Error('保存値 groupId が未設定（先に招待の宛先にするグループを控えてください）');
  }
  const res = await world.apiCtx.post('/api/v1/invites', {
    data: { email, spaceId },
  });
  world.lastResponse = res;
  if (!res.ok()) return; // 発行できなければ、後の行が同じ応答で理由を出す
  const body = (await res.json()) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error('招待の応答に id が無い');
  world.uniqueNames['acceptInviteId'] = id;
  world.createdIds.push({ method: 'DELETE', path: `/api/v1/invites/${id}` });
});

Then('招待は未使用の状態で並んでいる', async ({ world }) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const email = world.uniqueNames['acceptEmail'];
  if (!email) throw new Error('保存値 acceptEmail が未設定');
  const hits = listOf(body.data).filter((row) => String(row.email) === email);
  expect(hits.length, `宛先 ${email} の招待が 1 件だけ並ぶこと（実際: ${hits.length} 件）`).toBe(1);
  expect(String(hits[0].status), '状態が未使用（PENDING）であること').toBe('PENDING');
});

/**
 * 控えたトークンを、新しい接続（未ログイン）で受諾の口へ渡す。
 * 受諾は公開の口なので、押し戻されない（ログインなしで通る）ことがそのまま確かめになる。
 *
 * 受諾は宛先を自分で選ばない（トークンに結び付いた招待の宛先が使われる）ため、**先に「この値が
 * 表のどの招待にも当たらないこと」を DB で確かめる**。当たる値で入ると、利用者の行を黙って
 * 受諾してしまう（見当違いの赤、または作ってはいけないアカウント）。
 */
When('招待の口が発行したトークンの控えを新しい接続で受諾する', async ({ world }) => {
  const email = world.uniqueNames['acceptEmail'];
  if (!email) throw new Error('保存値 acceptEmail が未設定');
  // 受諾の値と同じ形（32 バイト乱数の base64url）を用意する。
  const token = randomBytes(32).toString('base64url');
  if (!INVITE_TOKEN_PATTERN.test(token)) throw new Error(`控えたトークンの形が違う: ${token}`);
  const matched = inviteEmailOfToken(token);
  if (matched !== null) {
    throw new Error(
      `控えた値が表の招待に当たってしまう（宛先: ${matched}）。受諾していないことを確かめられない`,
    );
  }
  const ctx = await request.newContext({ baseURL: BASE_URL });
  world.auxiliaryContexts.push(ctx);
  world.lastResponse = await ctx.post('/api/v1/invites/accept', {
    data: { token, name: `受諾 ${email}`, password: 'ReteDemo1234!' },
  });
});

/**
 * 受諾したアカウントが名簿に並んでいないこと（受諾が断られた時に、作られていないこと）。
 * 宛先は実行ごとの一意名なので、名簿に同じ宛先が居れば「断ったのに作られた」ことになる。
 */
Then('受諾したアカウントが名簿に並んでいない', async ({ world }) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const email = world.uniqueNames['acceptEmail'];
  if (!email) throw new Error('保存値 acceptEmail が未設定');
  const hits = listOf(body.data).filter((row) => String(row.email) === email);
  expect(hits.length, `断られた受諾で ${email} のアカウントができていないこと`).toBe(0);
});

/** 招待を一覧で特定して削除・再発行し、無効な値が断られることを確かめる。 */
When('招待を削除して発行し直し、無効な値の受諾を断る', async ({ world }) => {
  const id = world.uniqueNames['acceptInviteId'];
  const email = world.uniqueNames['acceptEmail'];
  if (!id || !email) {
    throw new Error('発行した招待の控えが無い（先に招待を発行する手順を実行してください）');
  }
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');

  // この宛先の招待が 1 件だけであることを確かめてから、消す（別の招待には触れない）。
  const listed = await world.apiCtx.get('/api/v1/invites');
  if (listed.status() !== 200) {
    world.lastResponse = listed;
    return;
  }
  const listBody = (await listed.json()) as { data?: Array<{ id: string; email: string }> };
  const hits = (listBody.data ?? []).filter((r) => r.email === email);
  if (hits.length !== 1 || hits[0].id !== id) {
    throw new Error(`対象の招待が 1 件に定まらない（宛先: ${email}・当たり: ${hits.length} 件）`);
  }
  // 手順 1 の招待を消し、消えたことを一覧で確かめる（消せた時だけ、発行し直す）。
  const removed = await world.apiCtx.delete(`/api/v1/invites/${id}`);
  if (removed.status() !== 200) {
    world.lastResponse = removed;
    return;
  }
  const after = await world.apiCtx.get('/api/v1/invites');
  const afterBody = (await after.json()) as { data?: Array<{ email: string }> };
  if ((afterBody.data ?? []).some((r) => r.email === email)) {
    throw new Error(`招待を消したのに一覧に残っている（宛先: ${email}）`);
  }
  world.createdIds = world.createdIds.filter((r) => !r.path.endsWith(`/invites/${id}`));

  // 同じ宛先で発行し直す（発行の口を通す）。返る id を受諾の対象にする。
  const issued = await world.apiCtx.post('/api/v1/invites', {
    data: { email, spaceId: world.uniqueNames['groupId'] },
  });
  world.lastResponse = issued;
  if (!issued.ok()) return;
  const issuedBody = (await issued.json()) as { data?: { id?: string } };
  const newId = issuedBody.data?.id;
  if (!newId) throw new Error('発行し直した招待の応答に id が無い');
  world.uniqueNames['acceptInviteId'] = newId;
  world.createdIds.push({ method: 'DELETE', path: `/api/v1/invites/${newId}` });

  // 新しい接続で無効な値を渡す。実際のメールによる受諾は隔離試験で確認する。
  const ctx = await request.newContext({ baseURL: BASE_URL });
  world.auxiliaryContexts.push(ctx);
  world.lastResponse = await ctx.post('/api/v1/invites/accept', {
    data: { token: 'unreachable-from-outside', name: `受諾 ${email}`, password: 'ReteDemo1234!' },
  });
});

/**
 * 受諾の口と同じ引き方（sha256 の 16 進で token_hash を引く）で、値に当たる招待の宛先を返す。
 * 当たらなければ null。
 */
function inviteEmailOfToken(value: string): string | null {
  const script = `
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  const hash = createHash('sha256').update(${JSON.stringify(value)}).digest('hex');
  const row = await prisma.invite.findFirst({ where: { tokenHash: hash }, select: { email: true } });
  console.log(row ? row.email : '');
} finally {
  await prisma.$disconnect();
}
`;
  const email = runBackendScript(script, '招待の引き直し').trim();
  return email === '' ? null : email;
}
