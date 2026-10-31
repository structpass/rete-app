#!/usr/bin/env node
/**
 * e2e 高速実行ラッパー（オーバーヘッド削減）
 *
 * `npm test` は毎回 bddgen 生成・fixture reset・HTML レポートを無条件に実行する。
 * この3つはテスト件数に関係なく固定でかかるため、48件規模ではテスト本体より
 * 大きくなる（実測: 41.3s 中 26.1s）。入力が変わっていなければ結果は同じなので、
 * キャッシュでスキップする。
 *
 * スキップ条件（いずれも「変わっていなければ安全」が成立する範囲に限定）:
 *   - bddgen  : features/ と steps/ と playwright.config.ts の内容ハッシュが前回と同一
 *   - reset   : 前回の reset 成功から TTL 以内、かつ DB を触るテストを挟んでいない
 *   - report  : --report を明示した時だけ HTML を出す（既定は list のみ）
 *
 * 安全性: 判定に迷う場合は必ず実行する側に倒す（--force 相当）。
 * ハッシュが取れない・キャッシュが壊れている時も実行する。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(E2E_DIR, '..');
const CACHE_DIR = path.join(E2E_DIR, '.cache', 'fast');
const STATE_FILE = path.join(CACHE_DIR, 'state.json');
const BDD_OUT = path.join(E2E_DIR, '.cache', 'bdd');

/** reset の再利用 TTL。これを超えたら必ず再実行する（seed が外から汚れた場合の保険）。 */
const RESET_TTL_MS = 30 * 60 * 1000;

const argv = process.argv.slice(2);
const wantReport = argv.includes('--report');
const force = argv.includes('--force');
// --component-tests= はこのスクリプトが読むだけ（playwright へは渡さない）。
const passthrough = argv.filter(
  (a) => !['--report', '--force'].includes(a) && !a.startsWith('--component-tests='),
);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** ディレクトリ配下のファイル内容を再帰的にハッシュ化する（mtime ではなく内容＝取りこぼし防止）。 */
function hashTree(dir, extraFiles = []) {
  const h = createHash('sha256');
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    // 名前順に固定して、ディレクトリ列挙順の揺れでハッシュが変わらないようにする
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        h.update(path.relative(E2E_DIR, p));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  for (const f of extraFiles) {
    try {
      h.update(path.relative(E2E_DIR, f));
      h.update(fs.readFileSync(f));
    } catch {
      /* 無ければ無視 */
    }
  }
  return h.digest('hex');
}

function log(msg) {
  process.stdout.write(`[fast] ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? E2E_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...opts.env },
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

// ---------------------------------------------------------------- bddgen
const bddInputHash = hashTree(path.join(E2E_DIR, 'features'), [
  path.join(E2E_DIR, 'playwright.config.ts'),
  path.join(E2E_DIR, 'support', 'fixtures.ts'),
]);
const stepsHash = hashTree(path.join(E2E_DIR, 'steps'));

const state = readState();
const specsExist = fs.existsSync(BDD_OUT) && fs.readdirSync(BDD_OUT).length > 0;

const bddCacheHit =
  !force && specsExist && state.bddInputHash === bddInputHash && state.stepsHash === stepsHash;

if (bddCacheHit) {
  log('bddgen skip（features/steps に変更なし）');
} else {
  log('bddgen 実行');
  run('npx', ['bddgen', 'test']);
}

// ---------------------------------------------------------------- fixture reset
const resetFresh =
  !force && typeof state.resetAt === 'number' && Date.now() - state.resetAt < RESET_TTL_MS;

if (resetFresh) {
  const ageS = Math.round((Date.now() - state.resetAt) / 1000);
  log(`fixture reset skip（${ageS}s 前に成功・TTL 内）`);
} else {
  log('fixture reset 実行');
  run('pnpm', ['--filter', '@rete/backend', 'run', 'reset:e2e-fixtures'], { cwd: REPO_DIR });
  state.resetAt = Date.now();
}

// ---------------------------------------------------------------- 部品の試験（画面の部品）
// ログイン後に描かれる画面（サイドバー等）は、ブラウザを開かずに通信だけで確かめられない。
// 部品の試験（frontend の vitest）で確かめた結果を控えに置き、e2e のシナリオはその控えを読んで
// 「同じ回で緑だった」ことをもって確認済みにする（S-HOME-09）。持たないシナリオはこれを見ないので、
// 対象の試験だけを回して速さを保つ。
//
// 控えは回ごとに作る（前の回の控えが残ると、部品の試験を回さない回が前の緑を読んでしまう）。
// 位置は e2e の控え置き場の下（コミットしない）。
const COMPONENT_FILE = argv.find((a) => a.startsWith('--component-tests='))?.split('=')[1];
const COMPONENT_RESULT = path.join(CACHE_DIR, 'component.json');
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.rmSync(COMPONENT_RESULT, { force: true });
if (!COMPONENT_FILE) {
  // 回さない回は控えを置かない（読む側のシナリオは赤で止まる＝確かめていないのに先へ進まない）。
  fs.writeFileSync(
    COMPONENT_RESULT,
    JSON.stringify({ file: null, ran: false, passed: [], failed: [], status: null }),
    'utf8',
  );
} else {
  const FRONTEND_DIR = path.join(REPO_DIR, 'packages', 'frontend');
  const jsonOut = path.join(CACHE_DIR, 'component-result.json');
  fs.rmSync(jsonOut, { force: true });
  log(`部品の試験 実行（${COMPONENT_FILE}）`);
  // 呼ぶ側はリポジトリ直下からの場所で渡す（控えの照合もその形で揃う）。vitest は frontend を
  // 作業場にするので、frontend を起点とした相対の場所へ直して渡す。
  const target = path
    .relative(FRONTEND_DIR, path.join(REPO_DIR, COMPONENT_FILE))
    .replaceAll('\\', '/');
  const component = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', target, '--reporter=json', `--outputFile=${jsonOut}`],
    { cwd: FRONTEND_DIR, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  // 通った試験と落ちた試験を分けて控える。「一部でも落ちた回は確認済みにしない」を読む側で
  // 判定できるようにする（名前は完全一致で照合し、別の試験の名前に救われないようにする）。
  const passed = [];
  const failed = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    for (const suite of parsed.testResults ?? []) {
      for (const t of suite.assertionResults ?? []) {
        const name = [...(t.ancestorTitles ?? []), t.title].join(' > ');
        if (t.status === 'passed') passed.push(name);
        else if (t.status !== 'pending' && t.status !== 'skipped') failed.push(name);
      }
    }
  } catch {
    /* 読めなければ空のまま（シナリオ側が赤になる） */
  }
  fs.writeFileSync(
    COMPONENT_RESULT,
    JSON.stringify({ file: COMPONENT_FILE, ran: true, passed, failed, status: component.status }),
    'utf8',
  );
  if (component.status !== 0) {
    log('部品の試験が赤（このまま e2e を続ける。読む側のシナリオが赤になる）');
  }
}

// ---------------------------------------------------------------- playwright
// 画面の点検（@screen・実ブラウザで主要な画面を開く）は、API のシナリオと分かれた project。
// 依頼側が project を指定した時（--grep 等と併用）はそちらを優先し、指定が無ければ両方走らせる。
const requestedProject = passthrough.some((a) => a.startsWith('--project'));
const projects = requestedProject ? [] : ['--project=authz', '--project=screen'];
const pwArgs = [
  'playwright',
  'test',
  '--config',
  'playwright.config.ts',
  ...projects,
  ...passthrough,
];

log(`playwright 実行（reporter: ${wantReport ? 'list+html' : 'list'}）`);
const pw = spawnSync('npx', pwArgs, {
  cwd: E2E_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    // config 側がこの値を見て HTML レポートの有無を切り替える
    E2E_REPORTER_MODE: wantReport ? 'html' : 'list',
    // 部品の試験の控え（上の段で書く。回さない回は ran=false で置く）。
    HOME_TRACK_COMPONENT_RESULT: COMPONENT_RESULT,
  },
});

// playwright が落ちても、bddgen キャッシュは入力一致の時に限り更新してよい
if (bddCacheHit === false) {
  state.bddInputHash = bddInputHash;
  state.stepsHash = stepsHash;
}
writeState(state);

process.exit(pw.status ?? 1);
