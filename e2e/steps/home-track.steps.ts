/**
 * rete E2E — ホームトラック（docs/scenarios/tracks/02-home.md）の追加ステップ（2026-10-25）
 *
 * 掲示板と FAQ の一覧を、通信の応答だけで見分けられる形で確かめるための道具。既存の
 * common.steps.ts は「一覧の中身（どの行が入っているか）」「並び順」「未読の増減」「一覧の全体性」
 * 「添付したファイルの中身」を持たず、次の行を書けなかった:
 *
 *   - 一覧に、指定した行が（配列のどの位置にあっても）入っている（S-HOME-05 の前提・S-HOME-14）
 *   - 一覧の 2 行が指定どおりの順で並んでいる（S-HOME-05 の「新しい順」・S-HOME-06・15）
 *   - 一覧が先へ進む先の無い形（件数＝返ってきた行数）で返っている（S-HOME-06 の全体性）
 *   - 未読の件数が、基準から増える・減る・変わらない（S-HOME-03 の冪等）
 *   - 添付ファイルの中身が、掲示に添付した時点のものと一致する（S-HOME-05）
 *
 * 重複定義は playwright-bdd が禁止するため、パターンは既存（common / extended / auth-track）と
 * 衝突しない語順にしてある。引数は入口で 1 度 resolvePlaceholders してから使う（cmn-0397 の規律）。
 *
 * 段の順番について（実測 2026-10-25）: playwright-bdd は書式の段を「上から順に」試し、外れた時は
 * 段を減らして後ろの段を伸ばす。そのため `… から {string}` のような形は、後ろに文字が続く行だと
 * 2 段目が伸びて一致しないことがある（`… から 増える` が未一致になった）。この file では、
 * 束縛の少ない行を先に、`{string}` で終わる形を後に置いて衝突を避けている。
 */

import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { When, Then, Given } from '../support/fixtures';
import { resolvePlaceholders } from '../support/placeholders';
import { describeListShape, indexOfValue, isAhead, listOf } from '../support/list-counts';

/** JSON path（例: "data.count"）をたどる。 */
function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** 直前の応答を本文ごと読む（成功前提の判定なので success=true を確かめてから使う）。 */
async function readSuccessBody(world: {
  lastResponse: { json: () => Promise<unknown> } | null;
}): Promise<{ success: boolean; data: unknown; meta?: unknown }> {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  return (await world.lastResponse.json()) as { success: boolean; data: unknown; meta?: unknown };
}

/** 保存値（uniqueNames）を引く。未設定のまま判定へ進むと原因の分からない赤になるため投げる。 */
function savedValue(world: { uniqueNames: Record<string, string> }, key: string): string {
  const value = world.uniqueNames[key];
  if (value === undefined) throw new Error(`保存値 ${key} が未設定`);
  return value;
}

// ----------------------------------------------------------------
// 一覧の応答を丸ごと控える（S-HOME-06 の「元の並びへ戻す」）
// ----------------------------------------------------------------

When('直前の一覧の応答を {string} として控える', async ({ world }, key: string) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  world.uniqueNames[key] = JSON.stringify(body.data);
});

// ----------------------------------------------------------------
// 一覧の全体性（先へ進む先があるか）
// ----------------------------------------------------------------

Then('一覧は全件がまとめて返っている', async ({ world }) => {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const rows = listOf(body.data);
  const meta = (body.meta ?? {}) as { total?: unknown; totalPages?: unknown; page?: unknown };
  // 「全件が 1 ページに収まっている」を、返ってきた行数と meta の総件数・総ページ数の両方で見る
  // （片方だけだと、meta を付け忘れた応答で行数の比較が空振りしても気づけない）。
  expect(meta.total, '一覧に総件数（meta.total）が付いていること').toBeDefined();
  expect(
    Number(meta.total),
    `総件数（${String(meta.total)}）が返ってきた行数（${rows.length}）と一致すること`,
  ).toBe(rows.length);
  if (meta.totalPages !== undefined) {
    expect(Number(meta.totalPages), '総ページ数が 1 であること').toBe(1);
  }
  if (meta.page !== undefined) {
    expect(Number(meta.page), '1 ページ目であること').toBe(1);
  }
});

// ----------------------------------------------------------------
// 掲示の並び替え（S-HOME-06）
// ----------------------------------------------------------------

/**
 * 掲示の並びを、指定した 1 件が先頭に来るよう入れ替えて保存する（S-HOME-06）。
 *
 * 並び替えの API は「現存全件の id」を渡す形で、部分集合は 400 になる（部分集合で並びが壊れるのを
 * 防ぐため）。ここで全件を取り直し、対象だけ先頭へ動かして渡す。呼ぶ前に今の並びを控えておけば、
 * 後で元へ戻せる。
 */
When('掲示の並びを保存値 {string} が先頭に来るよう入れ替える', async ({ world }, key: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const target = savedValue(world, key);
  const listed = await world.apiCtx.get('/api/v1/announcements');
  if (!listed.ok()) throw new Error(`掲示の一覧の取得に失敗: ${listed.status()}`);
  const body = (await listed.json()) as { data?: unknown };
  const ids = listOf(body.data).map((row) => String(row.id));
  if (!ids.includes(target)) throw new Error(`並び替えの対象 ${target} が一覧に無い`);
  const ordered = [target, ...ids.filter((id) => id !== target)];
  world.lastResponse = await world.apiCtx.patch('/api/v1/announcements/reorder', {
    data: { orderedIds: ordered, kind: 'board' },
  });
});

/**
 * 掲示の並びを、控えた一覧の順へ戻す（S-HOME-06 の後始末）。
 * 控えは「この試験の前に在った並び」なので、その後に作った掲示は末尾へ回す。
 */
When('掲示の並びを保存値 {string} の順へ戻す', async ({ world }, key: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const before = listOf(JSON.parse(savedValue(world, key)) as unknown).map((row) => String(row.id));
  const listed = await world.apiCtx.get('/api/v1/announcements');
  if (!listed.ok()) throw new Error(`掲示の一覧の取得に失敗: ${listed.status()}`);
  const body = (await listed.json()) as { data?: unknown };
  const current = listOf(body.data).map((row) => String(row.id));
  // 控えた並びのうち、まだ在るものだけを残し、増えた分を末尾に足す（全件を落とさない）。
  const kept = before.filter((id) => current.includes(id));
  const added = current.filter((id) => !kept.includes(id));
  world.lastResponse = await world.apiCtx.patch('/api/v1/announcements/reorder', {
    data: { orderedIds: [...kept, ...added], kind: 'board' },
  });
});

// ----------------------------------------------------------------
// 添付したファイルの中身（S-HOME-05）
// ----------------------------------------------------------------

/**
 * 掲示に添付したファイルを取得する（名称の一致で対象を選ぶ）。**添付が指す版**を取得する。
 *
 * 最新版を落とす口（/files/:id/download）ではなく版を指定する口を使うのは、掲示の添付が
 * 「掲示した時点の版を固定」しているためで、後から同じファイルへ版が上がっても中身は当時のまま
 * でなければならない。名称は掲示した時のものを使うので、後で似た名前が増えても取り違えない。
 */
When('保存値 {string} と同じ名称の添付を取得する', async ({ world }, nameKey: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  // 直前の応答（掲示の詳細）から添付一覧を引き、名称の一致で対象を選ぶ。
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const name = savedValue(world, nameKey);
  const attachments = (pick(body, 'data.attachments') ?? []) as Array<{
    fileId?: string;
    fileName?: string;
    versionNo?: number;
  }>;
  const hit = attachments.find((a) => a.fileName === name);
  if (!hit?.fileId || hit.versionNo === undefined) {
    throw new Error(
      `掲示に ${name} の添付が無い（添付: ${attachments.map((a) => a.fileName).join(', ') || 'なし'}）`,
    );
  }
  world.lastResponse = await world.apiCtx.get(
    `/api/v1/files/files/${hit.fileId}/versions/${hit.versionNo}/download`,
  );
});

// ----------------------------------------------------------------
// 一覧の中身（値が入っているか・どの順か）
// ----------------------------------------------------------------

Then(
  '一覧に {string} が保存値 {string} の行で入っている',
  async ({ world }, field: string, key: string) => {
    // この行は後ろが `の行で入っている` で固定なので、上の段のどれとも重ならない。
    await assertListHas(world, field, savedValue(world, key));
  },
);

Then(
  '一覧に {string} の値が {string} の行で入っている',
  async ({ world }, field: string, literalArg: string) => {
    // 保存値ではなく、feature に直書きした値で探す（祝日の日付など、作った値と別に書くもの）。
    await assertListHas(world, field, resolvePlaceholders(literalArg, world.uniqueNames));
  },
);

/** 一覧に `field` が `value` の行が 1 件以上あること（2 つの書き方から共有する実体）。 */
async function assertListHas(
  world: { lastResponse: { json: () => Promise<unknown> } | null },
  field: string,
  value: string,
): Promise<void> {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  expect(
    indexOfValue(listOf(body.data), field, value) >= 0,
    `一覧（${describeListShape(body.data)}）に ${field}=${value} の行があること`,
  ).toBe(true);
}

Then(
  '一覧の {string} は保存値 {string} が保存値 {string} より先である',
  async ({ world }, field: string, aheadKey: string, behindKey: string) => {
    const body = await readSuccessBody(world);
    expect(body.success, 'success フラグが true であること').toBe(true);
    const ahead = savedValue(world, aheadKey);
    const behind = savedValue(world, behindKey);
    const verdict = isAhead(listOf(body.data), field, ahead, behind);
    // 見つからない（null）と、見つかったが順が逆（false）を別の文言で出す（切り分けを残すため）。
    expect(
      verdict,
      `${ahead} も ${behind} も一覧にあること（${describeListShape(body.data)}）`,
    ).not.toBe(null);
    expect(verdict, `${ahead} が ${behind} より先に並ぶこと`).toBe(true);
  },
);

// ----------------------------------------------------------------
// 未読の数（基準との比較。増える／変わらないの 2 通り）
// ----------------------------------------------------------------

/**
 * 一覧が出している未読の行を、すべて開いて既読にする（S-HOME-03 の土台）。
 *
 * 未読の件数は「既読 0 の人が見た時の数」なので、手前の試験が既読にした行のぶん少ない。
 * 差で見ようとすると、画面の一覧を開いた時の自動選択（先頭 1 件が既読になる）が混ざって
 * 基準がずれる。そこで「一覧が出している未読の行だけを開く」ことを土台にして、
 * そのうえで「新しく積まれた 1 件を開いたら 1 減り、もう一度開いても減らない」を見る。
 */
When('一覧の未読の行をすべて開いて既読にする', async ({ world }) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const listed = await world.apiCtx.get('/api/v1/announcements?limit=100');
  if (!listed.ok()) throw new Error(`掲示の一覧の取得に失敗: ${listed.status()}`);
  const body = (await listed.json()) as { data?: unknown };
  const unread = listOf(body.data).filter((row) => row.unread === true);
  for (const row of unread) {
    const opened = await world.apiCtx.get(`/api/v1/announcements/${String(row.id)}`);
    if (!opened.ok()) {
      throw new Error(`未読の行を開けなかった: ${String(row.id)} → ${opened.status()}`);
    }
  }
});

/** 未読の件数が基準から delta だけ変わっていること（判定の実体・2 つの書き方から共有する）。 */
async function assertUnreadDelta(
  world: {
    lastResponse: { json: () => Promise<unknown> } | null;
    uniqueNames: Record<string, string>;
  },
  jsonPath: string,
  key: string,
  delta: number,
): Promise<void> {
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const base = Number(savedValue(world, key));
  if (Number.isNaN(base)) throw new Error(`保存値 ${key} が数値ではありません（先に保存 step を）`);
  expect(
    Number(pick(body, jsonPath)),
    `${jsonPath} が ${key}(${base}) から ${delta} だけ変わった ${base + delta} であること`,
  ).toBe(base + delta);
}

Then(
  '未読の件数を比べる {string} が保存値 {string} から一覧の差分で増える',
  async ({ world }, jsonPath: string, key: string) => {
    await assertUnreadDelta(world, jsonPath, key, 1);
  },
);

Then(
  '未読の件数を比べる {string} が保存値 {string} から一覧の差分なし',
  async ({ world }, jsonPath: string, key: string) => {
    await assertUnreadDelta(world, jsonPath, key, 0);
  },
);

/** 取得した中身が、控えた中身と同じであること。 */
Then('取得した中身が保存値 {string} と一致する', async ({ world }, contentKey: string) => {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const expected = savedValue(world, contentKey);
  const actual = await world.lastResponse.text();
  expect(actual, '添付した時の中身で返ること').toBe(expected);
});

// ----------------------------------------------------------------
// 予定が読む側にも見えること（S-HOME-10・d820）
// ----------------------------------------------------------------

When(
  'レスポンスの中の {string} を丸ごと {string} に保存する',
  async ({ world }, jsonPath: string, key: string) => {
    // 一覧そのもの（配列）を控える。控えた中身は、後の行で件数の基準として使う。
    // common.steps の「…を保存する」は 1 つの値を文字にするだけなので、配列は別の語順で持つ。
    const body = await readSuccessBody(world);
    const value = pick(body, jsonPath);
    if (value === undefined) throw new Error(`レスポンスに ${jsonPath} が無い`);
    world.uniqueNames[key] = JSON.stringify(value);
  },
);

Then(
  '一覧に {string} の値が {string} の行の開始時刻が {string} の日である',
  async ({ world }, field: string, valueArg: string, day: string) => {
    // 作った予定が「その日」に出ていること。取れているだけでは、別の日の枠に入った
    // （タイムゾーンや期間の解釈のずれ）を見逃すため、開始時刻の日付まで見る。
    const body = await readSuccessBody(world);
    expect(body.success, 'success フラグが true であること').toBe(true);
    const value = resolvePlaceholders(valueArg, world.uniqueNames);
    const rows = listOf(body.data);
    const index = indexOfValue(rows, field, value);
    expect(
      index,
      `${field}=${value} の行があること（${describeListShape(body.data)}）`,
    ).toBeGreaterThanOrEqual(0);
    const row = rows[index] as Record<string, unknown>;
    const startAt = row.startAt;
    expect(typeof startAt, `行 ${value} に開始時刻（startAt）があること`).toBe('string');
    // 開始時刻は UTC の ISO 文字列で返る。日本時間（UTC+9）に直した日付で比べる
    // （画面は日本の日付で並ぶため、UTC の日付のまま比べると朝 9 時前の予定が 1 日ずれる）。
    const jst = new Date(new Date(String(startAt)).getTime() + 9 * 60 * 60 * 1000);
    const jstDay = jst.toISOString().slice(0, 10);
    expect(jstDay, `予定 ${value} の開始日（日本時間）が ${day} であること`).toBe(day);
  },
);

Then('予定の件数は保存値 {string} より 1 件だけ多い', async ({ world }, key: string) => {
  // 作った 1 件だけが増えていること（期間の絞りが壊れて他の予定を巻き込むのを見逃さない）。
  const body = await readSuccessBody(world);
  expect(body.success, 'success フラグが true であること').toBe(true);
  const before = listOf(JSON.parse(savedValue(world, key)) as unknown).length;
  const after = listOf(body.data).length;
  expect(after, `予定が ${before} 件から 1 件だけ増えて ${before + 1} 件であること`).toBe(
    before + 1,
  );
});

// ----------------------------------------------------------------
// 部品（画面の都合で通信だけでは確かめられない所）の試験の結果（S-HOME-09・d820）
// ----------------------------------------------------------------

/** 結果の控えの場所（e2e/scripts/fast-test.mjs が回ごとに置く）。 */
const COMPONENT_RESULT_FILE = process.env.HOME_TRACK_COMPONENT_RESULT ?? '';

Given(
  '部品の試験 {string} の結果を {string} に読む',
  async ({ world }, testFile: string, key: string) => {
    // サイドバーはログイン後に描かれるため、ブラウザ無しの通信では判定できない。画面の部品の試験で
    // 確かめた結果を、同じ回の実行が置いた控えから読む。控えが無い・部品の試験を回していない・
    // その一部でも落ちている回は、このシナリオを赤で止める（確かめていないのに確認済みにしない）。
    if (!COMPONENT_RESULT_FILE) {
      throw new Error('部品の試験の結果が無い（e2e/scripts/fast-test.mjs から起動していない）');
    }
    let parsed: {
      file?: string | null;
      ran?: boolean;
      passed?: string[];
      failed?: string[];
      status?: number | null;
    };
    try {
      parsed = JSON.parse(readFileSync(COMPONENT_RESULT_FILE, 'utf-8')) as typeof parsed;
    } catch (error) {
      throw new Error(`部品の試験の結果を読めない: ${String(error)}`);
    }
    expect(parsed.ran, 'この回で部品の試験を回していること（--component-tests= で指定する）').toBe(
      true,
    );
    // リポジトリ直下からの場所で控える（呼ぶ側の書き方の揺れで取り違えない）。
    expect(parsed.file, `部品の試験の対象が ${testFile} であること`).toBe(testFile);
    expect(
      parsed.status,
      `部品の試験の回が緑であること（落ちた試験: ${(parsed.failed ?? []).join(' / ') || 'なし'}）`,
    ).toBe(0);
    world.uniqueNames[key] = JSON.stringify(parsed.passed ?? []);
  },
);

Then(
  '部品の試験 {string} で {string} が通っている',
  async ({ world }, key: string, name: string) => {
    // 試験の名前は完全一致で照合する（部分一致だと、たまたま名前が似た別の試験に救われて
    // 「その期待を確かめた」ことにならない）。
    const passed = JSON.parse(savedValue(world, key)) as string[];
    const exact = passed.filter((t) => t === name || t.endsWith(` > ${name}`));
    expect(exact.length, `通った部品の試験に ${name} がちょうど 1 件あること`).toBe(1);
  },
);
