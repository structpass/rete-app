// `pnpm test`（= backend の pretest）から呼ぶ Prisma Client の生成。
//
// 生成物が schema.prisma と同じ内容で、かつ生成物がそろっている時は生成を省く（skip）。
// 生成は node_modules 内のクエリエンジン（query_engine-*.node）を置き換える。稼働中の
// 開発サーバーがそのエンジンを握っていると、Windows では置き換えが EPERM で止まり、
// 常時起動の開発サーバーがある間は backend の単体試験が 1 本も回せなくなる（d893）。
// 判断が外れた時に通ってしまう側（黙って古い生成物のまま試験を走らせる）へ倒さないため、
// 「新しいか」ではなく「同じ内容か」で見る（d904）。
//
// 環境: RETE_PRISMA_GENERATE=force で常に生成する（生成物を取り直したい時）。
// 出力: `[prisma-generate] skip: …` / `[prisma-generate] run: …` の 1 行。
//
// **本体は isMain の時だけ走らせる**（d904 の独立の目）。以前は import しただけで生成判定が走り
// `process.exit(0)` まで進んでいたため、この判定を import して確かめる検査が 1 件も実行されず、
// 判定を古い形へ戻しても緑のままだった（実測 2026-10-28）。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_DIR = join(REPO_ROOT, 'packages', 'backend');
const SCHEMA_PATH = join(BACKEND_DIR, 'prisma', 'schema.prisma');

// 生成時に置き場へ書かれるクエリエンジン本体（library モードの query_engine-*.node、dataProxy 等で使う
// query_engine-*.wasm）。wasm の読み込み役（query_engine_bg.js／query_engine_bg.wasm）は数えない。
// 本体が欠けた置き場を「そろっている」と通さないための関門（d904 の独立の目）。
const ENGINE_FILE = /^query_engine-[\w.-]*\.(node|wasm)$/;
// 中の内容を比べる前に、確かめる生成物の名前（これが無ければ生成し直す）
const REQUIRED_FILES = ['schema.prisma', 'index.js'];

/** 2 つのファイルの中身が同じかを、改行の違いを吸収して比べる（CRLF/LF の差で振れない）。 */
function sameText(pathA, pathB) {
  const norm = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim();
  return norm(pathA) === norm(pathB);
}

/** ファイルとして実在するか（ディレクトリを「ある」と数えない）。 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Prisma が生成物に書く定義の指紋（inlineSchemaHash）を、定義の本文から作り直す。
 * 実装（prisma 6.19.3 の生成器）は sha256(base64(定義の utf8)) の全体。
 * 実測 2026-10-28: 実物の生成物の inlineSchemaHash と一致した。
 * @param {string} schemaText
 * @returns {string} 小文字の 16 進（64 桁）
 */
export function inlineSchemaHashOf(schemaText) {
  return createHash('sha256')
    .update(Buffer.from(schemaText, 'utf8').toString('base64'))
    .digest('hex');
}

/**
 * 生成物の index.js に埋め込まれた定義の本文（読めなければ null）。
 * @param {string} clientDir
 * @returns {string|null}
 */
export function embeddedInlineSchema(clientDir) {
  const raw = readFileSync(join(clientDir, 'index.js'), 'utf8');
  const m = raw.match(/["']?\binlineSchema["']?\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

/**
 * 生成物の index.js が「いまの定義から作られた」ことを、埋め込みの指紋で確かめる。
 * 生成物の schema.prisma だけを差し替えても、index.js の中身が古ければここで食い違う。
 * 指紋が書かれていない生成物（将来の形式）では、判定しない（checked:false）＝
 * 間違った赤を出さず、内容の照合は checkGenerated の schema.prisma の比較が担う。
 *
 * @param {string} clientDir
 * @param {string} schemaText いまの定義の本文
 * @returns {{checked: boolean, same: boolean, why?: string}}
 */
export function inlinedSchemaMatches(clientDir, schemaText) {
  const raw = readFileSync(join(clientDir, 'index.js'), 'utf8');
  const m = raw.match(/["']?\binlineSchemaHash["']?\s*:\s*["']([0-9a-f]{8,})["']/i);
  if (!m) return { checked: false, same: false, why: '生成物に定義の指紋が書かれていない' };
  const want = inlineSchemaHashOf(schemaText);
  const got = m[1].toLowerCase();
  return { checked: true, same: got === want, why: got };
}

/** pnpm のハッシュ付きディレクトリ名に依存せず生成物の置き場を探す（既存検査と同じ探し方）。 */
function findClientDir() {
  // pnpm の仮想ストアはワークスペースのルート（hoist 構成）。backend 配下も見る。
  for (const storeRoot of [join(BACKEND_DIR, 'node_modules'), join(REPO_ROOT, 'node_modules')]) {
    if (!existsSync(storeRoot)) continue;
    const pnpmDir = join(storeRoot, '.pnpm');
    if (!existsSync(pnpmDir)) continue;
    for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('@prisma+client')) continue;
      const probe = join(pnpmDir, entry.name, 'node_modules', '.prisma', 'client');
      if (existsSync(probe)) return probe;
    }
  }
  return null;
}

/**
 * 生成物が schema.prisma の内容を反映しているかを判定する。
 *
 * 見るのは 4 つ。どれかに当たれば生成する（skip しない）。
 *   ① 生成物の名前がそろっている（schema.prisma・index.js。どちらもファイルであること）
 *   ② 生成物の中の schema.prisma が、いまの schema.prisma と同じ内容
 *   ③ クエリエンジン本体（query_engine-*.node / *.wasm）が置き場に実在している
 *   ④ 生成物の index.js に書かれた定義の指紋が、いまの定義と合う（指紋がある時だけ）
 *
 * 更新時刻で見ない理由: 更新時刻は「いまの定義から作った」ことの証拠にならない。
 * schema を古い版へ戻した・取り込みで時計が揃った・生成が途中で落ちた、のどれでも
 * 「新しい」は成り立ち、古い生成物のまま試験だけが緑になる（d904 の実測）。
 *
 * @param {{clientDir?: string|null, schemaPath?: string}} [opts] 確かめる対象（試験から差し替える）
 * @returns {{current: boolean, reason: string}}
 */
export function checkGenerated({ clientDir: given = undefined, schemaPath = SCHEMA_PATH } = {}) {
  const clientDir = given === undefined ? findClientDir() : given;
  if (!clientDir) return { current: false, reason: '生成物がありません' };
  for (const name of REQUIRED_FILES) {
    if (!isFile(join(clientDir, name))) return { current: false, reason: `${name} がありません` };
  }
  const engines = readdirSync(clientDir).filter(
    (name) => ENGINE_FILE.test(name) && isFile(join(clientDir, name)),
  );
  if (engines.length === 0) {
    return { current: false, reason: 'クエリエンジン本体（query_engine-*）が置き場にありません' };
  }
  let source;
  try {
    source = readFileSync(schemaPath, 'utf8');
  } catch (e) {
    return {
      current: false,
      reason: `schema.prisma を読めません（${e?.code ?? e?.message ?? e}）`,
    };
  }
  let generatedSame;
  try {
    generatedSame = sameText(schemaPath, join(clientDir, 'schema.prisma'));
  } catch (e) {
    return {
      current: false,
      reason: `生成物の schema.prisma を読めません（${e?.code ?? e?.message ?? e}）`,
    };
  }
  if (!generatedSame) return { current: false, reason: 'schema.prisma の内容が生成物と違う' };
  let inlined;
  try {
    inlined = inlinedSchemaMatches(clientDir, source);
  } catch (e) {
    return {
      current: false,
      reason: `生成物の index.js を読めません（${e?.code ?? e?.message ?? e}）`,
    };
  }
  if (inlined.checked && !inlined.same) {
    // 改行の違いを吸収して比べ直す（CRLF/LF だけで毎回生成し直さない）。指紋は改行まで含むため、
    // 生成物の schema.prisma 比較（sameText）と同じ寛容さに揃える。
    const inlinedText = embeddedInlineSchema(clientDir);
    const normalized =
      inlinedText != null &&
      inlinedText.replace(/\r\n/g, '\n').trim() === source.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      return { current: false, reason: '生成物の index.js に書かれた定義が、いまの定義と違う' };
    }
  }
  return { current: true, reason: `生成物 ${clientDir}` };
}

/** pretest の本体（生成してよいか決め、必要なら生成する）。戻り値は終了コード。 */
export function main({ env = process.env } = {}) {
  const forced = env.RETE_PRISMA_GENERATE === 'force';
  const state = forced
    ? { current: false, reason: 'RETE_PRISMA_GENERATE=force' }
    : checkGenerated();

  if (state.current) {
    console.log(`[prisma-generate] skip: ${state.reason} は最新です`);
    return 0;
  }

  console.log(`[prisma-generate] run: ${state.reason}`);
  // 実行は backend の script（PRISMA_CLIENT_ENGINE_TYPE=library 固定）へ寄せる。
  // ここで直に prisma を叩くと終了コードの扱いが shell 任せになり、固定値も 2 か所に分かれる。
  const result = spawnSync('pnpm', ['run', 'prisma:generate'], {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(
      '[prisma-generate] 生成に失敗しました。稼働中の開発サーバーがエンジンを握っている場合は、' +
        'サーバーを止めてから `pnpm run prisma:generate` を実行してください。',
    );
    return result.status ?? 1;
  }
  // 生成が成功しても、置き場がそろったかを確かめる（途中で落ちた生成物で試験を走らせない）。
  const after = checkGenerated();
  if (!after.current) {
    console.error(`[prisma-generate] 生成しましたが、置き場がそろっていません: ${after.reason}`);
    return 1;
  }
  return 0;
}

/** このファイルが node から直に起動されたか（import された時は本体を走らせない）。 */
export function isMainModule(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(resolve(argv1)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(main());
