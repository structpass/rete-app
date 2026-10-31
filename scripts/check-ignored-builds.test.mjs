import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  EXPECTED_IGNORED_BUILDS,
  parseIgnoredBuilds,
  compareIgnoredBuilds,
} from './check-ignored-builds.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// CI run 31238015292（feat/2026-07-20 / 2026-08-08）の install ステップ出力に一致する形。
// cmn-0343 で run 30417883753（2026-07-29）から差し替えた＝@nestjs/core が弾かれなくなったため。
const REAL_LOG = [
  'Scope: all 4 workspace projects',
  'Lockfile is up to date, resolution step is skipped',
  'Progress: resolved 1, reused 0, downloaded 0, added 0',
  'The following dependencies have build scripts that were ignored: @scarf/scarf, prisma',
  'Done in 21.4s',
].join('\n');

test('parseIgnoredBuilds: pnpm 9.15 の文言から依存名を抽出する', () => {
  const result = parseIgnoredBuilds(REAL_LOG);
  assert.equal(result.found, true);
  assert.deepEqual(result.names, ['@scarf/scarf', 'prisma']);
});
test('parseIgnoredBuilds: pnpm 10 version suffixes preserve scoped package names', () => {
  assert.deepEqual(
    parseIgnoredBuilds('Ignored build scripts: @scarf/scarf@1.4.0, prisma@6.19.3.').names,
    ['@scarf/scarf', 'prisma'],
  );
});

test('parseIgnoredBuilds: 枠線付き警告（Ignored build scripts 表現）でも読める', () => {
  const log = [
    '╭ Warning ─────────────────────────────────────────────╮',
    '│   Ignored build scripts: @nestjs/core, prisma.        │',
    '╰──────────────────────────────────────────────────────╯',
  ].join('\n');
  const result = parseIgnoredBuilds(log);
  assert.equal(result.found, true);
  assert.deepEqual(result.names, ['@nestjs/core', 'prisma']);
});

test('parseIgnoredBuilds: 色付き出力（ANSI エスケープ）でも読める', () => {
  const esc = String.fromCharCode(27);
  const log = `${esc}[33mThe following dependencies have build scripts that were ignored: @nestjs/core, prisma${esc}[0m`;
  assert.deepEqual(parseIgnoredBuilds(log).names, ['@nestjs/core', 'prisma']);
});

test('parseIgnoredBuilds: 一覧が行折り返しでも連結して読む', () => {
  const log = [
    'The following dependencies have build scripts that were ignored: @nestjs/core,',
    '@scarf/scarf, prisma',
    'Done in 21.4s',
  ].join('\n');
  assert.deepEqual(parseIgnoredBuilds(log).names, ['@nestjs/core', '@scarf/scarf', 'prisma']);
});

test('parseIgnoredBuilds: 検出行が無ければ found=false（呼び出し側が fail-closed 判定する）', () => {
  const result = parseIgnoredBuilds('Lockfile is up to date\nDone in 3s');
  assert.equal(result.found, false);
  assert.deepEqual(result.names, []);
});

test('CLI: マーカー行が欠落したログでは非 0 終了する（cmn-0337・想定名簿と独立に必須化）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cib-marker-'));
  const logPath = join(dir, 'install.log');
  try {
    // ログは空でないが「弾かれたビルドスクリプト」の行が無い＝install が no-op になった等の形。
    writeFileSync(logPath, 'Lockfile is up to date\nDone in 3s\n');
    const here = join(dirname(fileURLToPath(import.meta.url)), 'check-ignored-builds.mjs');
    const result = spawnSync(process.execPath, [here, logPath], { encoding: 'utf8' });
    assert.equal(
      result.status,
      1,
      `マーカー行欠落で 1 で終わるべき（stderr: ${result.stderr?.slice(0, 300)}）`,
    );
    assert.match(result.stderr ?? '', /見つかりませんでした/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compareIgnoredBuilds: 想定と一致すれば ok（順序は問わない）', () => {
  assert.deepEqual(compareIgnoredBuilds(['prisma', '@scarf/scarf']), {
    ok: true,
    unexpected: [],
    missing: [],
  });
});

test('compareIgnoredBuilds: 許可漏れ（想定外に弾かれた依存）を検出する', () => {
  const result = compareIgnoredBuilds([...EXPECTED_IGNORED_BUILDS, 'sharp']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpected, ['sharp']);
  assert.deepEqual(result.missing, []);
});

test('compareIgnoredBuilds: 想定にあるのにログから消えた依存も検出する', () => {
  // cmn-0343 の実発火ケース＝弾かれる想定だった依存が postinstall を落として消えた形。
  const result = compareIgnoredBuilds(['prisma']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['@scarf/scarf']);
  assert.deepEqual(result.unexpected, []);
});

test('（実データ）想定集合が実ログと一致し、許可名簿とは別物である', () => {
  const parsed = parseIgnoredBuilds(REAL_LOG);
  assert.deepEqual(compareIgnoredBuilds(parsed.names).ok, true);

  // 想定集合（弾かれてよい依存）と onlyBuiltDependencies（実行を許可する依存）は交わらないこと。
  const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const allowed = rootManifest.pnpm?.onlyBuiltDependencies ?? [];
  assert.ok(allowed.length > 0, 'onlyBuiltDependencies が読めること');
  const overlap = EXPECTED_IGNORED_BUILDS.filter((name) => allowed.includes(name));
  assert.deepEqual(overlap, [], `許可名簿と想定集合が矛盾しています: ${overlap.join(', ')}`);
});

// 許可名簿（onlyBuiltDependencies）そのものを期待集合として固定する。
// 供給網リスクとして重いのは「弾かれた側」より「許可を足した側」＝ install 時に任意コード（postinstall）を
// 走らせる依存が増える変更なので、増やすならこのテストの編集を伴わせ差分レビューへ必ず現れるようにする。
const EXPECTED_ALLOWED_BUILDS = [
  '@prisma/client',
  '@prisma/engines',
  'esbuild',
  'sharp',
  'unrs-resolver',
];

test('（実データ）install スクリプトの許可名簿が想定どおり（増減はテスト編集を伴う）', () => {
  const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const allowed = [...(rootManifest.pnpm?.onlyBuiltDependencies ?? [])].sort();
  assert.deepEqual(
    allowed,
    [...EXPECTED_ALLOWED_BUILDS].sort(),
    'onlyBuiltDependencies が変わっています。ビルドスクリプト実行の許可を足す/外す判断を意図して行ったなら EXPECTED_ALLOWED_BUILDS を更新してください',
  );
});
