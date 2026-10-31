/**
 * 「実測して挙動が決まった」の控え（support/verified-cases.ts）の Node --test 単体検証（d824）。
 *
 * 実行: e2e の `npm run test:unit`（node --experimental-strip-types --test support/__tests__/*.test.ts）
 *
 * 実測 2026-10-26: mfa-login.feature の 2 番目のシナリオが落ちたのに、1 番目の「確認済みにする」の
 * 控えが残った（後続のシナリオは落ちても、その時点で控えは書き終えていたため）。通しの e2e では
 * 「落ちた後の控え」を作れない（落とすには製品を壊す）ので、番号と結果の組み合わせだけをここで固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginScenario,
  endScenario,
  markVerifiedCase,
  resetVerifiedCases,
  verifiedCasesFor,
} from '../verified-cases.ts';

test('全部通れば、控えた ID はそのシナリオの後始末で残る', () => {
  resetVerifiedCases();
  const id = beginScenario();
  markVerifiedCase('S-OPS-03');
  assert.deepEqual(verifiedCasesFor(), ['S-OPS-03']);
  endScenario(id, 'passed');
});

test('後ろのシナリオの後始末では、前のシナリオの控えを採らない（実測 2026-10-26 の形）', () => {
  resetVerifiedCases();
  const first = beginScenario();
  markVerifiedCase('S-OPS-03');
  // 1 番目の後始末の時点（まだ落ちていない）は残る。後始末はこの値で控えを書く。
  assert.deepEqual(verifiedCasesFor(), ['S-OPS-03']);
  endScenario(first, 'passed');

  const second = beginScenario();
  // 2 番目が実行中に落ちた後、後始末では 1 番目の控えも採らない（後続の失敗で状態を動かさない）。
  endScenario(second, 'failed');
  assert.deepEqual(verifiedCasesFor(), []);
});

test('落ちたシナリオ自身が控えた ID は採らない', () => {
  resetVerifiedCases();
  const id = beginScenario();
  markVerifiedCase('S-OPS-10');
  endScenario(id, 'failed');
  assert.deepEqual(verifiedCasesFor(), []);
});

test('一度落ちたら、その後の緑のシナリオの控えも採らない（落ちた所から先は確かめ直し）', () => {
  resetVerifiedCases();
  const first = beginScenario();
  endScenario(first, 'failed');
  const second = beginScenario();
  markVerifiedCase('S-OPS-04');
  assert.deepEqual(verifiedCasesFor(), []);
  endScenario(second, 'passed');
});

test('同じ ID を 2 回控えても 1 回だけ数える（d771）', () => {
  resetVerifiedCases();
  const first = beginScenario();
  markVerifiedCase('S-OPS-03');
  endScenario(first, 'passed');
  const second = beginScenario();
  markVerifiedCase('S-OPS-03');
  assert.deepEqual(verifiedCasesFor(), ['S-OPS-03']);
});

test('控えを要求していない ID は返さない', () => {
  resetVerifiedCases();
  const id = beginScenario();
  endScenario(id, 'passed');
  assert.deepEqual(verifiedCasesFor(), []);
});
