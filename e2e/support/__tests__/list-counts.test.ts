/**
 * 一覧の件数と並び（support/list-counts.ts）の Node --test 単体検証。
 *
 * 実行: e2e の `npm run test:unit`（node --experimental-strip-types --test support/__tests__/*.test.ts）
 *
 * 通しの e2e で確かめられるのは「正しい応答で緑になる」ところまで。**見つからない行**や
 * **順が逆の行**を渡した時に、判定が「緑」に倒れないことは通しでは作れない（作るには
 * サーバーの応答を壊す必要がある）ため、ここで判定だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeListShape, indexOfValue, isAhead, listOf } from '../list-counts.ts';

const rows = [
  { id: 'a', title: 'いちばん新しい' },
  { id: 'b', title: 'まんなか' },
  { id: 'c', title: 'いちばん古い' },
];

test('listOf は素の配列・{items}・{roots} のどれでも要素を返す', () => {
  assert.equal(listOf(rows).length, 3);
  assert.equal(listOf({ items: rows }).length, 3);
  assert.equal(listOf({ roots: rows }).length, 3);
});

test('listOf は一覧でない応答で空を返す（例外にしない・呼び出し側が形を別に確かめる）', () => {
  assert.deepEqual(listOf(null), []);
  assert.deepEqual(listOf({ data: rows }), []);
  assert.deepEqual(listOf('配列ではない'), []);
});

test('describeListShape は空の理由が読める文字列を返す', () => {
  assert.equal(describeListShape(rows), '配列 3 件');
  assert.equal(describeListShape({ items: [] }), '{items} 0 件');
  assert.equal(describeListShape({ data: [] }), '一覧でない（キー: data）');
});

test('indexOfValue は見つかった位置を返し、無ければ -1 を返す', () => {
  assert.equal(indexOfValue(rows, 'id', 'b'), 1);
  assert.equal(indexOfValue(rows, 'id', 'z'), -1);
});

test('indexOfValue は数値の id と文字列の id を取り違えない', () => {
  // id が数値の一覧（タスク等）でも、文字列で渡した値と一致させる。
  const numeric = [{ id: 12 }, { id: 123 }];
  assert.equal(indexOfValue(numeric, 'id', '12'), 0);
  assert.equal(indexOfValue(numeric, 'id', '123'), 1);
});

test('isAhead は先にある時だけ true（後ろなら false）', () => {
  assert.equal(isAhead(rows, 'id', 'a', 'c'), true);
  assert.equal(isAhead(rows, 'id', 'c', 'a'), false);
});

test('isAhead はどちらかが見つからない時 null を返す（順序違反と混ぜない）', () => {
  assert.equal(isAhead(rows, 'id', 'a', 'z'), null);
  assert.equal(isAhead(rows, 'id', 'z', 'a'), null);
});
