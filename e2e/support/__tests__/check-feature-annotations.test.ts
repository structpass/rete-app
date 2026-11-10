import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  annotationsFromFeature,
  compareAnnotations,
  titlesFromReport,
} from '../check-feature-annotations.mjs';

/**
 * d1023: feature の注記（# e2e:verified <track> <pass|fail> "<title>"）を、実行の記録と突き合わせる検査。
 * 読み手が無いまま注記だけが残ると、通過していない項目が「確認済み」と読めてしまう。
 */
test('注記を読む（pass と fail の両方、題名は引用符の中）', () => {
  const text = [
    '  # e2e:verified AUTHZ pass "契約システムの並び替えが一覧の順に反映される"',
    '  # e2e:verified ZZ-HOME-TRACK fail "準備中の項目は押しても動かず、押せない理由が文字で出る"',
    '  # ただのコメント',
  ].join('\n');
  assert.deepEqual(annotationsFromFeature(text), [
    { track: 'AUTHZ', verdict: 'pass', title: '契約システムの並び替えが一覧の順に反映される' },
    {
      track: 'ZZ-HOME-TRACK',
      verdict: 'fail',
      title: '準備中の項目は押しても動かず、押せない理由が文字で出る',
    },
  ]);
});

test('実行の記録から題名ごとの結果を作る（最後の試行を見る）', () => {
  const report = {
    suites: [
      {
        specs: [
          { title: 'A', tests: [{ results: [{ status: 'failed' }, { status: 'passed' }] }] },
          { title: 'B', tests: [{ results: [{ status: 'failed' }] }] },
        ],
        suites: [{ specs: [{ title: 'C', tests: [{ results: [{ status: 'skipped' }] }] }] }],
      },
    ],
  };
  const observed = titlesFromReport(report);
  assert.equal(observed.get('A'), 'passed');
  assert.equal(observed.get('B'), 'failed');
  assert.equal(observed.get('C'), 'failed');
});

test('突き合わせ: 記録が無ければ unknown（落とさない）、食い違えば mismatch', () => {
  const observed = new Map<string, 'passed' | 'failed'>([
    ['通過した', 'passed'],
    ['落ちた', 'failed'],
  ]);
  const rows = compareAnnotations(
    [
      { track: 'AUTHZ', verdict: 'pass', title: '通過した' },
      { track: 'AUTHZ', verdict: 'fail', title: '落ちた' },
      { track: 'AUTHZ', verdict: 'pass', title: '走っていない' },
      { track: 'AUTHZ', verdict: 'pass', title: '落ちた' },
      { track: 'AUTHZ', verdict: 'fail', title: '通過した' },
    ],
    observed,
  );
  assert.deepEqual(
    rows.map((r) => r.state),
    ['ok', 'ok', 'unknown', 'mismatch', 'mismatch'],
  );
});

test('主の feature に fail の注記が戻っていない（読み手が無く、通過と読める形を作らない）', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), 'features');
  const bad = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.feature'))) {
    for (const a of annotationsFromFeature(readFileSync(join(dir, file), 'utf8'))) {
      if (a.verdict === 'fail') bad.push(`${file}: ${a.title}`);
    }
  }
  assert.deepEqual(bad, []);
});
