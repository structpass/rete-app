import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 打ち切りの実体はプロセスのツリーごと落とすこと。Windows は taskkill、それ以外は
// プロセスグループへ SIGKILL を送る（taskkill は Linux に無く、失敗すると子が残って
// テストが終わらない）。
const isWindows = process.platform === 'win32';

function killTree(child) {
  if (!child || !child.pid) return;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // すでに終わっている
    }
  }
}

const runner = fileURLToPath(new URL('./run-tests-agent.mjs', import.meta.url));
// d894: 入口が「どこまで行ったか」を書く控え（決まったパス。成功した回は消える）
const STAGE_DIR = join(tmpdir(), 'rete-test-agent-stage');

// 打ち切って殺した回は、入口が後片付けを実行できないまま消える。試験が自分で起こした
// 強制終了のぶんは試験側で掃く（放っておくと 1 回の実行ごとに空の入れ物が増え続ける）。
function sweepAgentTempDirs() {
  for (const name of readdirSync(tmpdir())) {
    if (/^rete-test-agent-[A-Za-z0-9]{6}$/.test(name)) {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }
  }
}

function runInline(source, { env = process.env } = {}) {
  return spawnSync(process.execPath, [runner, '--', process.execPath, '-e', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

test('成功時は大量の通過ログを捨て、集計だけを返す', () => {
  const result = runInline(
    `for (let i = 0; i < 500; i++) console.log('passing-line-' + i);
     console.log('Test Suites: 20 passed, 20 total');
     console.log('Tests: 500 passed, 500 total');`,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[test:agent] PASS/);
  assert.match(result.stdout, /Test Suites: 20 passed, 20 total/);
  assert.match(result.stdout, /Tests: 500 passed, 500 total/);
  assert.doesNotMatch(result.stdout, /passing-line-1(?:\D|$)/);
  assert.ok(result.stdout.trim().split(/\r?\n/).length <= 4, result.stdout);
});

test('agent既定経路と通常testの段構成がドリフトしていない', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts.test,
    'pnpm run build:shared && pnpm run check:repo-invariants && pnpm run check:audit-boundary && pnpm --filter "./packages/**" test',
  );
});

test('成功でも警告は隠さない', () => {
  const result = runInline(
    `console.error('DeprecationWarning: synthetic warning');
     console.log('Tests: 1 passed, 1 total');`,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /warnings=1/);
  assert.match(result.stdout, /DeprecationWarning: synthetic warning/);
});

test('失敗時は終了コード、末尾の失敗内容、完全ログの場所を返す', () => {
  const result = runInline(
    // process.exit() はパイプへの書き込みを流し切る前に落ちる（Linux の CI で出力が欠け、
    // 100 行超のログを返す検査が環境で揺れた）。出口は exitCode で伝えて、書き込みを待たせる。
    `for (let i = 0; i < 300; i++) console.log('noise-' + i);
     console.log('Tests: 300 total');
     console.log('✖ failing tests:');
     console.error('Error: synthetic failure');
     process.exitCode = 7;`,
  );

  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, /\[test:agent] FAIL exit=7/);
  assert.match(result.stderr, /Tests: 300 total/);
  assert.match(result.stderr, /Error: synthetic failure/);
  assert.doesNotMatch(result.stderr, /noise-299/);

  const match = result.stderr.match(/full_log=([^\r\n]+)/);
  assert.ok(match, result.stderr);
  const logPath = match[1].trim();
  assert.equal(existsSync(logPath), true, logPath);
  assert.match(readFileSync(logPath, 'utf8'), /noise-0/);
  assert.match(readFileSync(logPath, 'utf8'), /Error: synthetic failure/);
  rmSync(dirname(logPath), { recursive: true, force: true });
});

// d894: 入口は全件（3 段・数分・出力 10 万文字級）を抱える。呼び出し側が待ちを打ち切って殺すと、
// 入口は何も書かずに消え、結果は「緑か分からない」まま残る。緑は子が 0 で終えた時だけだと固定し、
// 止まった時にどこまで行っていたかを残す。
test('d894: 子の出口をそのまま返し、赤の回に PASS を書かない（止めた段も残す）', async () => {
  const ok = runInline('process.exit(0)');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /\[test:agent] PASS/);
  // 成功した回は自分が書いた控えを残さない（置き場に他の回の控えが残っていてもよい）
  const record = ok.stderr.match(/stage_record=([^\r\n]+)/)?.[1]?.trim();
  assert.ok(record, '控えの場所を示す');
  assert.equal(existsSync(record), false, '成功で終えた回は自分の控えを消す');

  const failed = runInline('process.exit(3)');
  assert.equal(failed.status, 3, '子の出口を 1 に丸めず、そのまま返す');
  assert.doesNotMatch(failed.stdout, /\[test:agent] PASS/, '赤の回に PASS を書かない');
  assert.match(failed.stderr, /\[test:agent] FAIL exit=3/);
  assert.match(failed.stderr, /stage=1\/1/, '止めた段を残す（どこまで行って止まったかを追える）');
  // 赤の回は診断用にログを残す作りなので、試験が自分で起こした赤のぶんは自分で片付ける
  // （片付けないと 1 回の実行ごとに空の入れ物が増え続ける。実測で 261 個たまった）。
  const failedLog = failed.stderr.match(/full_log=([^\r\n]+)/)?.[1]?.trim();
  if (failedLog) rmSync(dirname(failedLog), { recursive: true, force: true });
});

// d894: 待ちを打ち切って殺された回は、入口が FAIL を書く間もなく消える（実測: 残るのは
// 「running stage=N/M」だけ）。殺した側が「緑ではなかった・どこまで行ったか」を追えるよう、
// 走っている段を控えに残すことを、実際にツリーごと落として固定する。
// 控えの場所は回ごとに分かれるので、入口が最初の段で出す stage_record= の行から名指しで読む。
test('d894: 打ち切られて殺された回は、走っていた段を控えに残す', async () => {
  rmSync(STAGE_DIR, { recursive: true, force: true });
  const child = spawn(
    process.execPath,
    [runner, '--', process.execPath, '-e', 'setInterval(()=>{},1000)'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWindows,
    },
  );
  let err = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => (err += d));

  // 控えの場所が示され、走っている段が書かれるまで待つ（書かれた＝走っている）。
  const waitFor = async () => {
    for (let i = 0; i < 100; i += 1) {
      const named = err.match(/stage_record=([^\r\n]+)/);
      if (named && existsSync(named[1].trim())) return named[1].trim();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };
  try {
    const record = await waitFor();
    assert.ok(record, `走っている段が控えに書かれていない: ${err}`);
    // 打ち切りの実体はツリーの強制終了（Windows の node へは合図が届かない）
    killTree(child);
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(existsSync(record), true, '殺された回は控えを残す');
    assert.match(readFileSync(record, 'utf8'), /^running 1\/1 /, 'どこまで行ったかを残す');
  } finally {
    rmSync(STAGE_DIR, { recursive: true, force: true });
    sweepAgentTempDirs();
  }
});

// d894: 同種の検査を同時に走らせても、先に成功した回が、もう一方の回の控えを消さない
// （実測: 置き場を共有して 1 枚に書いていた時は、先に成功した回の片付けが他方の控えごと消し、
// 打ち切られた側は「どこまで行ったか」を追えなくなった）。
test('d894: 同時に走らせても、先に成功した回が他の回の控えを消さない', async () => {
  rmSync(STAGE_DIR, { recursive: true, force: true });
  const slow = spawn(
    process.execPath,
    [runner, '--', process.execPath, '-e', 'setInterval(()=>{},1000)'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWindows,
    },
  );
  let err = '';
  slow.stdout.on('data', () => {});
  slow.stderr.on('data', (d) => (err += d));

  const waitFor = async () => {
    for (let i = 0; i < 100; i += 1) {
      const named = err.match(/stage_record=([^\r\n]+)/);
      if (named && existsSync(named[1].trim())) return named[1].trim();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };
  try {
    const record = await waitFor();
    assert.ok(record, `長く走る回の控えが書かれていない: ${err}`);

    // 同じ置き場を使う、すぐ終わる回を走らせる（これが成功しても、上の回の控えを消さない）
    const quick = runInline('process.exit(0)');
    assert.equal(quick.status, 0);
    // 回ごとに別の控えへ書く（同じ 1 枚を共有しない）
    assert.notEqual(quick.stderr.match(/stage_record=([^\r\n]+)/)?.[1]?.trim(), record);
    assert.equal(existsSync(record), true, '先に成功した回が、他の回の控えを消している');

    // 打ち切り（ツリーごと落とす）。落とした後も段が残ることを確かめる
    killTree(slow);
    for (let i = 0; i < 30 && slow.exitCode === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(readFileSync(record, 'utf8'), /^running 1\/1 /, '打ち切られた回の段が残る');
  } finally {
    // 走っている回が残ると置き場を消せないので、必ず落としてから片付ける
    if (slow.exitCode === null) {
      killTree(slow);
    }
    rmSync(STAGE_DIR, { recursive: true, force: true });
    sweepAgentTempDirs();
  }
});
