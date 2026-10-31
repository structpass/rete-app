// d904: pretest の「生成を省いてよいか」の判定（scripts/prisma-generate-unless-current.mjs の
// checkGenerated）を固定する。
//
// 背景: d893 で pretest を「生成物が古い時だけ generate」に変えた。その判定は更新時刻の比較だけで、
// 「いまの定義から作ったこと」を確かめていなかった。実測（2026-10-28）では生成物の schema.prisma は
// いまの定義と同じ内容だったが、クエリエンジン本体は前日のもので、index.js だけが新しい状態を
// 『最新です』と通していた。時刻の新旧は、schema を戻した・取り込みで時計が揃った・生成が途中で
// 落ちた、のどれでも成り立つので、定義の内容と本体の実在で決めるように直した。
//
// **この検査は、判定を import して中身を当てる**（生成スクリプトは起動しない）。前の版は import
// しただけで本体が走って process.exit していたため、ここに書いた assertion が 1 件も実行されず、
// 判定を古い形へ戻しても緑のままだった（d904 の独立の目）。
// さらに、import の途中で止まっても `node --test` は「このファイルは 1 件 ok」と exit 0 で返すので、
// **走った件数を最後に数えて比べる**（数が合わなければ赤にする。d904 の再検査の指摘）。
//
// 検査は実物の node_modules に触らない（読むだけ）。置き場を一時ディレクトリに作り、判定を当ててから消す。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

// 検査で作った一時の置き場（終わりにまとめて消す）
const TEMP_DIRS = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

/** 定義（いまの schema.prisma の代わり）を 1 枚作る。 */
function makeSchema(text) {
  const path = join(tempDir('rete-d904-schema-'), 'schema.prisma');
  writeFileSync(path, text);
  return path;
}

/** 生成物の置き場を 1 つ作って中身を書く（名前 → 中身）。 */
function makeClient(files) {
  const dir = tempDir('rete-d904-client-');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/** 実物の生成物の置き場（無ければ null）。 */
function findRealClient() {
  const roots = [
    join(HERE, '..', 'node_modules', '.pnpm'),
    join(HERE, '..', 'packages', 'backend', 'node_modules', '.pnpm'),
  ];
  for (const pnpmDir of roots) {
    let names = [];
    try {
      names = readdirSync(pnpmDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('@prisma+client')) continue;
      const probe = join(pnpmDir, name, 'node_modules', '.prisma', 'client');
      try {
        if (readFileSync(join(probe, 'index.js'), 'utf8').length > 0) return probe;
      } catch {
        /* 無い */
      }
    }
  }
  return null;
}

// ── 件数の番人（import より先に置く）─────────────────────────────
// 走った検査を数える。import の途中で本体が走って止まると「走ったのは 1 件だけ」で残り、
// 最後の数え合わせで赤になる（後ろに置くと、止まった時に読む所まで届かない）。
const STARTED = [];
test.beforeEach((t) => STARTED.push(t.name));

const SCHEMA_TEXT =
  'datasource db {\n  provider = "postgresql"\n}\n\nmodel A {\n  id String @id\n}\n';
const CHANGED_SCHEMA = SCHEMA_TEXT.replace('model A {', 'model B {');
const realClient = findRealClient();
const realIndex = realClient ? readFileSync(join(realClient, 'index.js'), 'utf8') : '';
const realSchema = (() => {
  try {
    return readFileSync(join(HERE, '..', 'packages', 'backend', 'prisma', 'schema.prisma'), 'utf8');
  } catch {
    return null;
  }
})();

/** Prisma の生成物と同じ形の index.js（埋め込みの定義と、その指紋）。 */
const generatedIndexFor = (mod, schemaText) =>
  `module.exports = {\n  "inlineSchema": ${JSON.stringify(schemaText)},\n  "inlineSchemaHash": "${mod.inlineSchemaHashOf(schemaText)}",\n};\n`;

// 判定の関数を当てる。**import で本体が走る版では、この import でプロセスが終わる**
// （その時は番人が「1 件しか走っていない」と赤にする）。
const MOD = await import(pathToFileURL(join(HERE, 'prisma-generate-unless-current.mjs')).href);

// **import の直後（同期の行）に、import が返ってきたことを焼き付ける。** test.after は import が
// 途中で止まると呼ばれず、node --test は「このファイルは 1 件 ok」と exit 0 で終える（d904 の再検査の
// 実測）。ここは import が返ってきた直後の同期の行なので、本体が走って止まる版では届かない。
const IMPORT_REACHED = true;

const idx = (schemaText) => generatedIndexFor(MOD, schemaText);

test('d904: import しただけでは生成スクリプトを起動しない（process.exit しない）', () => {
  assert.equal(typeof MOD.checkGenerated, 'function');
  assert.equal(typeof MOD.main, 'function');
  const self = join(HERE, 'prisma-generate-unless-current.mjs');
  assert.equal(
    MOD.isMainModule(self, pathToFileURL(self).href),
    true,
    '直に起動した時に本体を走らせない',
  );
  assert.equal(MOD.isMainModule(undefined), false, '引数が無い時に本体を走らせる判定になっている');
});

test('d904: 定義の内容・入口・クエリエンジン本体がそろっていれば生成しない', () => {
  const clientDir = makeClient({
    'schema.prisma': SCHEMA_TEXT,
    'index.js': idx(SCHEMA_TEXT),
    'query_engine-windows.dll.node': 'BINARY',
  });
  const r = MOD.checkGenerated({ clientDir, schemaPath: makeSchema(SCHEMA_TEXT) });
  assert.equal(r.current, true, r.reason);
});

test('d904: 指紋の作り方が Prisma の生成物と合う（実物で照合）', () => {
  if (!realClient || !realSchema) return; // 生成物が無い環境では照合しない
  const got = realIndex.match(/["']?\binlineSchemaHash["']?\s*:\s*["']([0-9a-f]+)["']/i);
  assert.ok(got, '実物の生成物に指紋がありません');
  assert.equal(MOD.inlineSchemaHashOf(realSchema), got[1], '指紋の作り方が Prisma と違う');
});

test('d904: 改行の違い（CRLF/LF）だけなら同じ内容と見る（毎回生成しない）', () => {
  const crlf = SCHEMA_TEXT.replace(/\n/g, '\r\n');
  const clientDir = makeClient({
    'schema.prisma': crlf,
    'index.js': idx(crlf),
    'query_engine-windows.dll.node': 'BINARY',
  });
  const r = MOD.checkGenerated({ clientDir, schemaPath: makeSchema(SCHEMA_TEXT) });
  assert.equal(r.current, true, r.reason);
});

test('d904: クエリエンジン本体が置き場に無ければ生成し直す（生成の途中で落ちた跡を通さない）', () => {
  const clientDir = makeClient({ 'schema.prisma': SCHEMA_TEXT, 'index.js': idx(SCHEMA_TEXT) });
  const r = MOD.checkGenerated({ clientDir, schemaPath: makeSchema(SCHEMA_TEXT) });
  assert.equal(r.current, false, '本体の無い置き場を通した');
  assert.match(r.reason, /クエリエンジン本体/);
});

test('d904: wasm の読み込み役（query_engine_bg.*）だけでは本体と見なさない', () => {
  const clientDir = makeClient({
    'schema.prisma': SCHEMA_TEXT,
    'index.js': idx(SCHEMA_TEXT),
    'query_engine_bg.js': 'x',
    'query_engine_bg.wasm': 'wasm',
  });
  const r = MOD.checkGenerated({ clientDir, schemaPath: makeSchema(SCHEMA_TEXT) });
  assert.equal(r.current, false, '読み込み役だけで「本体がある」と通した');
});

test('d904: 定義の内容が生成物と違えば生成し直す（時刻の新旧では決めない）', () => {
  const clientDir = makeClient({
    'schema.prisma': SCHEMA_TEXT,
    'index.js': idx(SCHEMA_TEXT),
    'query_engine-windows.dll.node': 'BINARY',
  });
  const r = MOD.checkGenerated({ clientDir, schemaPath: makeSchema(CHANGED_SCHEMA) });
  assert.equal(r.current, false, '内容の違う生成物を通した');
  assert.match(r.reason, /内容/);
});

test('d904: 生成物の schema.prisma だけ差し替えても、index.js の指紋が古ければ生成し直す', () => {
  const clientDir = makeClient({
    'schema.prisma': CHANGED_SCHEMA,
    // index.js の指紋は古い定義のまま（schema だけ取り替えた形）
    'index.js': idx(SCHEMA_TEXT),
    'query_engine-windows.dll.node': 'BINARY',
  });
  const r = MOD.checkGenerated({ clientDir, schemaPath: makeSchema(CHANGED_SCHEMA) });
  assert.equal(r.current, false, '指紋の食い違いを通した');
  assert.match(r.reason, /定義/);
});

test('d904: 生成物の schema.prisma・index.js が欠けていれば生成し直す', () => {
  const clientDir = makeClient({
    'schema.prisma': SCHEMA_TEXT,
    'query_engine-windows.dll.node': 'BINARY',
  });
  const r = MOD.checkGenerated({ clientDir, schemaPath: makeSchema(SCHEMA_TEXT) });
  assert.equal(r.current, false);
  assert.match(r.reason, /index\.js/);
});

test('d904: 生成物が無ければ生成する', () => {
  const r = MOD.checkGenerated({ clientDir: null });
  assert.equal(r.current, false);
  assert.match(r.reason, /生成物がありません/);
});

test('d904: 判定は更新時刻を使わない（中身と実在で決める。時刻の比較へ戻す変異で赤になる）', () => {
  const src = readFileSync(join(HERE, 'prisma-generate-unless-current.mjs'), 'utf8');
  assert.doesNotMatch(src, /mtime/, '更新時刻で最新と決める判定が戻っています');
});

// **同期の区切りで数える。** test.after は import が途中で止まると呼ばれない（node --test が
// ファイルを 1 件 ok として終える）ため、import の直後の同期の所で「走った件数」を先に焼き付ける。
test.after(() => {
  // import が返ってきたこと、かつ 11 件が実際に走ったことを数えて比べる
  // （import の途中で止まった時に、緑のまま穴が開かない）
  assert.equal(
    IMPORT_REACHED,
    true,
    'import が返ってこなくなりました。import の途中で本体が走っていませんか',
  );
  assert.equal(STARTED.length, 11, `走った検査が ${STARTED.length} 件です（11 件あるはず）`);
  for (const p of TEMP_DIRS) rmSync(p, { recursive: true, force: true });
});
