/**
 * rete E2E — Desk トラック（docs/scenarios/tracks/03-desk.md）の追加ステップ（2026-10-25）
 *
 * 既存の steps（common / extended / home-track）は、次を持つ:
 *   - 一覧の行に、指定した値の行が入っている（ホームトラック）
 *   - タスクのツリーを平らにせずに読む
 *
 * 足りないのは次の 3 つ。Desk トラックの未確認行はこれらが無いと書けなかった。
 *   - タスクのツリー（分類 → タスク → 子）に、題名で引いた行がある／無い（S-DESK-10・16）
 *   - その行が、指定した状態（TODO / IN_PROGRESS / DONE）で載っている（S-DESK-15）
 *   - 一覧の行に、指定した項目が指定した値の行が**入っていない**（S-DESK-10・12 の解除）
 *
 * ツリーは `{ categories: [{ tasks: [ { title, status, children: [...] } ] }] }` の入れ子なので、
 * 配列の平坦化を 1 箇所（flattenTaskTree）に置いて、上の 2 つを同じ実体から実現する。
 * 入れ子の取りこぼし（子の下にだけ在る行を見逃す）を防ぐため、比較は必ず平坦化した全行に対して行う。
 *
 * ツリーは `{ categories: [{ tasks: [ { title, status, children: [...] } ] }] }` の入れ子なので、
 * 配列の平坦化を 1 箇所（flattenTaskTree）に置いて、上の 2 つを同じ実体から実現する。
 * 入れ子の取りこぼし（子の下にだけ在る行を見逃す）を防ぐため、比較は必ず平坦化した全行に対して行う。
 *
 * 重複定義は playwright-bdd が禁止するため、パターンは既存と衝突しない語順にしてある。
 * 引数は入口で 1 度 resolvePlaceholders してから使う（scripts/check-e2e-step-arg-resolution.mjs の規律）。
 */

import { expect } from '@playwright/test';
import { Then, When } from '../support/fixtures';
import { resolvePlaceholders } from '../support/placeholders';

/** 直前の応答を本文ごと読む（成功前提の判定なので success=true を確かめてから使う）。 */
async function readSuccessBody(world: {
  lastResponse: { json: () => Promise<unknown> } | null;
}): Promise<{
  success: boolean;
  data: unknown;
}> {
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const body = (await world.lastResponse.json()) as { success: boolean; data: unknown };
  expect(body.success, 'success フラグが true であること').toBe(true);
  return body;
}

/** ツリーの 1 行（分類の見出しは行ではない）。 */
type TaskTreeRow = { title?: unknown; status?: unknown; children?: unknown };

/** ツリーを、分類・親子の入れ子を問わず全行の平坦な配列にする（深さ優先・兄弟順を保つ）。 */
function flattenTaskTree(data: unknown): TaskTreeRow[] {
  const rows: TaskTreeRow[] = [];
  const categories = (data as { categories?: unknown } | null)?.categories;
  if (!Array.isArray(categories)) return rows;
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as TaskTreeRow[]) {
      rows.push(node);
      walk(node.children);
    }
  };
  for (const category of categories as Array<{ tasks?: unknown }>) {
    walk(category.tasks);
  }
  return rows;
}

/** 題名で引いた行（見つからなければ undefined）。 */
function rowByTitle(rows: TaskTreeRow[], title: string): TaskTreeRow | undefined {
  return rows.find((row) => String(row.title) === title);
}

/** 保存値を引く（未設定のまま判定へ進むと原因の分からない赤になるため投げる）。 */
function savedValue(world: { uniqueNames: Record<string, string> }, key: string): string {
  const value = world.uniqueNames[key];
  if (value === undefined) throw new Error(`保存値 ${key} が未設定`);
  return value;
}

// ----------------------------------------------------------------
// 発話（チャットの返信）の添付を取得する（S-DESK-12）
//
// ホームトラックの `同じ名称の添付を取得する` は揭示（announcement）の詳細から添付を引く形なので、
// チャットの発話では使えない。同じ「添付が指す版」を落とす口（版を指定する取得）を使い、
// 発話の詳細（`data.messages[].attachments`）から名称の一致で対象を選ぶ。
// ----------------------------------------------------------------

When('保存値 {string} と同じ名称の発話の添付を取得する', async ({ world }, nameKey: string) => {
  if (!world.apiCtx) throw new Error('APIRequestContext が未初期化');
  const body = await readSuccessBody(world);
  const name = savedValue(world, nameKey);
  const messages = (body.data as { messages?: unknown } | null)?.messages;
  const attachments = (
    Array.isArray(messages) ? (messages as Array<Record<string, unknown>>) : []
  ).flatMap((m) =>
    Array.isArray(m.attachments) ? (m.attachments as Array<Record<string, unknown>>) : [],
  );
  const hit = attachments.find((a) => a.fileName === name);
  if (!hit || typeof hit.fileId !== 'string' || hit.versionNo === undefined) {
    throw new Error(
      `発話に ${name} の添付が無い（添付: ${attachments.map((a) => String(a.fileName)).join(', ') || 'なし'}）`,
    );
  }
  world.lastResponse = await world.apiCtx.get(
    `/api/v1/files/files/${hit.fileId}/versions/${String(hit.versionNo)}/download`,
  );
});

// ----------------------------------------------------------------
// 一覧に「入っていない」こと（S-DESK-12 の解除）
//   既存の `レスポンス配列に "<値>" が含まれない` は id / name / title の値そのものを照合する形で、
//   「項目 X が値 Y の行」を書けない。解除の判定は id の値で引くので、こちらの形を足す。
// ----------------------------------------------------------------

Then(
  '一覧に {string} が保存値 {string} の行が入っていない',
  async ({ world }, field: string, key: string) => {
    const body = await readSuccessBody(world);
    const value = savedValue(world, key);
    // 一覧の形は {items} / 素の配列のどちらでも受ける（解除は [] で返ることもある）。
    const data = body.data as unknown;
    const rows: Array<Record<string, unknown>> = Array.isArray(data)
      ? (data as Array<Record<string, unknown>>)
      : Array.isArray((data as { items?: unknown } | null)?.items)
        ? ((data as { items: Array<Record<string, unknown>> }).items ?? [])
        : [];
    expect(
      rows.some((row) => String(row[field]) === value),
      `一覧（${rows.length} 件）に ${field}=${value} の行が無いこと`,
    ).toBe(false);
  },
);

// ----------------------------------------------------------------
// タスクのツリーの中身（S-DESK-10 / 15 / 16）
// ----------------------------------------------------------------

Then('タスクのツリーに保存値 {string} が入っている', async ({ world }, titleKey: string) => {
  const body = await readSuccessBody(world);
  const title = savedValue(world, titleKey);
  const rows = flattenTaskTree(body.data);
  expect(rows.length, 'ツリーに 1 行以上あること（空のツリーで通さない）').toBeGreaterThan(0);
  expect(
    rowByTitle(rows, title),
    `ツリー（${rows.length} 行）に ${title} の行があること`,
  ).toBeDefined();
});

Then('タスクのツリーに保存値 {string} が無い', async ({ world }, titleKey: string) => {
  const body = await readSuccessBody(world);
  const title = savedValue(world, titleKey);
  const rows = flattenTaskTree(body.data);
  // 「何も無いから無い」で通らないよう、別の行は在ることを先に確かめる（器の切り替えの判定）。
  expect(
    rows.length,
    'ツリーに 1 行以上あること（空のツリーで「無い」を通さない）',
  ).toBeGreaterThan(0);
  expect(rowByTitle(rows, title), `ツリー（${rows.length} 行）に ${title} の行が無いこと`).toBe(
    undefined,
  );
});

Then(
  'タスクのツリーに保存値 {string} の行が {string} の状態で入っている',
  async ({ world }, titleKey: string, status: string) => {
    const body = await readSuccessBody(world);
    const title = savedValue(world, titleKey);
    const expected = resolvePlaceholders(status, world.uniqueNames);
    const rows = flattenTaskTree(body.data);
    const hit = rowByTitle(rows, title);
    expect(hit, `ツリー（${rows.length} 行）に ${title} の行があること`).toBeDefined();
    expect(String(hit?.status), `${title} の状態が ${expected} であること`).toBe(expected);
  },
);
