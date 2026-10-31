import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  COMPARE_DECIMALS,
  DUPLICATION_THRESHOLD_PERCENT,
  isOverThreshold,
  readTotals,
} from './check-duplication.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 2026-10-22 の実測（81 クローン・972/78298 行）。jscpd 自身の --threshold はこの値に対して
// 1.2425 以上 1.25 未満のどこに置いても緑になった（1.242 は赤）ため、比較を自前で行う
// （この試験はその穴の再発を防ぐ）。
const REPORT = {
  statistics: {
    total: { clones: 81, duplicatedLines: 972, lines: 78298 },
  },
};

test('readTotals: jscpd の報告から件数と重複率を出す', () => {
  const totals = readTotals(REPORT);
  assert.equal(totals.duplicatedLines, 972);
  assert.equal(totals.lines, 78298);
  assert.equal(totals.clones, 81);
  // 実測値は 1.2414…%。2 桁に丸めて 1.24 になる。
  assert.equal(totals.percent.toFixed(4), '1.2414');
  assert.equal(totals.percent.toFixed(2), '1.24');
});

test('readTotals: 件数が読めない報告は例外（沈黙して緑にしない）', () => {
  assert.throws(() => readTotals({}));
  assert.throws(() => readTotals({ statistics: { total: { lines: 0, duplicatedLines: 0 } } }));
  assert.throws(() => readTotals({ statistics: { total: { lines: 'x', duplicatedLines: 1 } } }));
});

test('isOverThreshold: 閾値をわずかに超えた重複は赤になる', () => {
  // jscpd の --threshold が取りこぼしていた領域。
  for (const threshold of [1, 1.21, 1.2, 0.5]) {
    assert.equal(isOverThreshold(1.242, threshold), true, `threshold=${threshold}`);
  }
});

test('isOverThreshold: 閾値ちょうど・下回る時は緑（超えた時だけ赤）', () => {
  assert.equal(isOverThreshold(1.24, 1.24), false);
  assert.equal(isOverThreshold(1.242, 1.25), false);
  assert.equal(isOverThreshold(1.242, DUPLICATION_THRESHOLD_PERCENT), false);
  assert.equal(isOverThreshold(1.242, 1.5), false);
});

test('isOverThreshold: 比較は小数第 2 位まで（既定の閾値ちょうどの重複率）', () => {
  assert.equal(COMPARE_DECIMALS, 2);
  // 1.501〜1.504 は四捨五入で 1.5 なので超えたことにしない（閾値ちょうどは超えた側に数えない）。
  assert.equal(isOverThreshold(1.504, 1.5), false);
  assert.equal(isOverThreshold(1.505, 1.5), true);
  assert.equal(isOverThreshold(1.506, 1.5), true);
  // 1.5% ちょうど（丸めても 1.5）は赤にしない。
  assert.equal(isOverThreshold(1.4999, 1.5), false);
});

test('通常の閾値で緑・下げた閾値で赤（実物の走査で）', () => {
  const ok = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/check-duplication.mjs')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (ok.error) throw ok.error;
  // jscpd を動かすには node_modules が要る（CI では install 後）。install 前しか走らない
  // 文脈（check:repo-invariants の install 前ステップ）だけ飛ばす。それ以外は黙って緑にしない。
  const preInstall = !existsSync(join(REPO_ROOT, 'node_modules'));
  if (preInstall) {
    console.log('node_modules が無い（install 前の文脈）ため実物の走査は飛ばす');
    return;
  }
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /重複検査: 1\.\d+% \(/);

  const ng = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts/check-duplication.mjs'), '--percent=0.5'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (ng.error) throw ng.error;
  assert.equal(ng.status, 1, ng.stdout);
  assert.match(ng.stderr, /重複行が上限を超えた/);
});
