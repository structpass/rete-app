#!/usr/bin/env node
// d555: 重複コード検出を検査として効かせる。
//
// 背景: jscpd 自身の --threshold は、報告の重複率を 2 桁に丸めて比べるため、緑になる境界は
// 丸めの境目（実測 1.2414% に対して約 1.2425）に揃わず、1.2425 以上 1.25 未満のどこに設定しても
// 赤にならなかった（2026-10-22 に 1.242→赤・1.2425/1.25/1.3/1.4→緑を実測）。設定ファイルの
// threshold をいくつにしても、その帯の重複は検出されない。
// そこで jscpd は JSON で件数を出させ（--silent で終了値は使わない）、ここで
// 実値（小数第 2 位まで）と閾値を比べる。
//
// 使い方:
//   node scripts/check-duplication.mjs             … 全体を走査して閾値と比べる
//   node scripts/check-duplication.mjs --percent=1 … 閾値（%）を差し替える（負の試験で使う）
//
// fail-closed: jscpd が走らない・報告が読めない・件数が読めない場合も非 0 で終わる（沈黙して緑にしない）。

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 重複行の上限（%）。超えたら赤。 */
export const DUPLICATION_THRESHOLD_PERCENT = 1.5;

/** jscpd の走査を待つ上限（実測は数秒）。超えたら失敗扱いにする。 */
export const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

/** 比較に使う桁数。jscpd が返す 1.2421… を 1.24 に丸めて比べる。 */
export const COMPARE_DECIMALS = 2;

/**
 * 重複率（%）と閾値を比べる。閾値を「超えた」時だけ赤。
 * @param {number} percent 実測の重複率（%）
 * @param {number} threshold 閾値（%）
 */
export function isOverThreshold(percent, threshold) {
  const scale = 10 ** COMPARE_DECIMALS;
  const rounded = Math.round(percent * scale) / scale;
  return rounded > threshold;
}

/** 報告から重複率と件数を取り出す。読めない時は例外。 */
export function readTotals(report) {
  const total = report?.statistics?.total;
  const lines = Number(total?.lines);
  const duplicatedLines = Number(total?.duplicatedLines);
  if (!Number.isFinite(lines) || lines <= 0 || !Number.isFinite(duplicatedLines)) {
    throw new Error('jscpd の報告に件数が無い（lines / duplicatedLines を読めない）');
  }
  // jscpd の percentage は整数の件数から計算するので、同じ値を使って食い違わせない。
  const percent = (duplicatedLines / lines) * 100;
  return { lines, duplicatedLines, clones: Number(total?.clones ?? 0), percent };
}

function parseThreshold(argv) {
  const arg = argv.find((a) => a.startsWith('--percent='));
  if (!arg) return DUPLICATION_THRESHOLD_PERCENT;
  const value = Number(arg.slice('--percent='.length));
  if (!Number.isFinite(value)) throw new Error(`--percent の値が数でない: ${arg}`);
  return value;
}

/**
 * jscpd の入口（bin）を、このリポジトリの依存から直接見つける。
 * pnpm の置き場は OS ごとに異なるので、依存の package.json の bin を辿る（PATH に頼らない）。
 */
export function resolveJscpdBin() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('jscpd/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.jscpd;
  if (!bin) throw new Error('jscpd の package.json に bin が無い');
  return join(dirname(pkgPath), bin);
}

function main() {
  const threshold = parseThreshold(process.argv.slice(2));
  const outDir = mkdtempSync(join(tmpdir(), 'rete-duplication-'));
  try {
    const run = spawnSync(
      process.execPath,
      [resolveJscpdBin(), '--silent', '--reporters', 'json', '--output', outDir],
      // 走査は数秒で終わる。固まったまま CI を job の打ち切りまで止めないよう上限を置く
      // （打ち切られたら報告が無い＝下で非 0 になる）。
      { stdio: 'inherit', timeout: SCAN_TIMEOUT_MS },
    );
    if (run.error) throw run.error;
    if (run.signal)
      throw new Error(`jscpd が ${SCAN_TIMEOUT_MS}ms 以内に終わらない（${run.signal}）`);
    // jscpd は閾値超過で非 0 を返すことがあるが、この検査は自前の比較を使う。
    // 走査自体の失敗（例外・設定不備）は報告が無いことで下で拾う。
    const report = JSON.parse(readFileSync(join(outDir, 'jscpd-report.json'), 'utf8'));
    const totals = readTotals(report);
    const percent = totals.percent.toFixed(COMPARE_DECIMALS + 1);
    if (isOverThreshold(totals.percent, threshold)) {
      console.error(
        `ERROR: 重複行が上限を超えた（${percent}% > ${threshold}%）。` +
          `重複 ${totals.clones} 件・${totals.duplicatedLines}/${totals.lines} 行`,
      );
      return 1;
    }
    console.log(
      `重複検査: ${percent}% (${totals.duplicatedLines}/${totals.lines} 行, ${totals.clones} 件) <= ${threshold}%`,
    );
    return 0;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `ERROR: 重複検査を実行できない: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
