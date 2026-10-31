/**
 * d859: response-fingerprint.ts（応答の形の比べ方）の Node --test 単体検証。
 *
 * 実行: e2e の `npm run test:unit`（node --experimental-strip-types --test support/__tests__/*.test.ts）。
 *
 * ここで固定するのは 3 つ:
 *   - 文言（code・message・可変の値）を替えても指紋が同じ（どの改修で赤になったか読める）
 *   - 骨組み（鍵の有無・値の型・状態コード）が違えば指紋が違う（漏れを隠さない）
 *   - 叩いた id が本文に写っていれば照合で拾える（存在すると読み分けられない）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { echoesExternalId, responseFingerprint, tappedIdsOf } from '../response-fingerprint.ts';

const NOT_FOUND_TREE =
  '{"success":false,"error":{"code":"NOT_FOUND","message":"対象が見つかりません"}}';
const NOT_FOUND_THEME =
  '{"success":false,"error":{"code":"NOT_FOUND","message":"チャットテーマが見つかりません"}}';
const EMPTY_LIST = '{"success":true,"data":[],"meta":{"total":0,"page":1,"limit":20}}';
const OWN_TREE = '{"success":true,"data":{"roots":[]}}';

test('文言の違う 2 つの 404 は同じ形になる（一覧の語をそろえても赤くならない）', () => {
  assert.equal(responseFingerprint(404, NOT_FOUND_TREE), responseFingerprint(404, NOT_FOUND_THEME));
});

test('可変の値（id・件数・鍵の並び）が違っても形は同じ', () => {
  const a = '{"success":true,"data":[{"id":"x","n":1}],"meta":{"total":3,"page":1}}';
  const reordered = '{"meta":{"page":1,"total":3},"data":[{"n":1,"id":"x"}],"success":true}';
  assert.equal(responseFingerprint(200, a), responseFingerprint(200, reordered));
  // 要素の骨組みが同じなら、要素数が違っても形は同じ（数は別に「0 件」を確かめる）。
  const many =
    '{"success":true,"data":[{"id":"y","n":2},{"id":"z","n":3}],"meta":{"total":9,"page":1}}';
  assert.equal(responseFingerprint(200, a), responseFingerprint(200, many));
});

test('中身のある器が 200 空で返る変化は、形の違いとして拾う', () => {
  // 自分の器（200 空）と他人の器（404）は形が違う。
  assert.notEqual(responseFingerprint(200, OWN_TREE), responseFingerprint(404, NOT_FOUND_TREE));
});

test('鍵や値の型が増えれば形が変わる', () => {
  const base = responseFingerprint(200, EMPTY_LIST);
  const withExtra = '{"success":true,"data":[],"meta":{"total":0,"page":1,"limit":20,"x":1}}';
  const wrongType = '{"success":true,"data":{},"meta":{"total":0,"page":1,"limit":20}}';
  assert.notEqual(responseFingerprint(200, withExtra), base);
  assert.notEqual(responseFingerprint(200, wrongType), base);
});

test('状態コードは形に含める（404 と 400 は読み分けの度合いが違う）', () => {
  const body = '{"success":false,"error":{"code":"BAD_REQUEST","message":"x"}}';
  assert.notEqual(responseFingerprint(404, body), responseFingerprint(400, body));
});

test('JSON でない本文も落ちない（長さと型で表す）', () => {
  assert.equal(responseFingerprint(502, '<html>bad gateway</html>'), '502:non-json(24)');
  assert.equal(responseFingerprint(404, ''), '404:');
});

test('叩いた id が本文に写っていれば、照合で拾う', () => {
  const id = '75532aa4-4727-46cf-8e0b-052619fc44db';
  const other = '4c5f36a3-f0d1-4b41-bba1-58ddec6d07d5';
  assert.equal(echoesExternalId(`{"id":"${id}"}`, [id]), id);
  assert.equal(echoesExternalId(NOT_FOUND_TREE, [id]), null);
  // 2 つ目に写っていても拾う（URL に複数の id が入る時）。
  assert.equal(echoesExternalId(`{"id":"${other}"}`, [id, other]), other);
  // 叩いた id が控えられていない（照合の対象が無い）時は、何も拾わない。
  assert.equal(echoesExternalId(NOT_FOUND_TREE, []), null);
});

test('叩いた先の URL から id を拾う（外部から入れた値は URL だけで決まる）', () => {
  const a = '75532aa4-4727-46cf-8e0b-052619fc44db';
  const b = '4c5f36a3-f0d1-4b41-bba1-58ddec6d07d5';
  assert.deepEqual(tappedIdsOf(`/api/v1/files/tree?spaceId=${a}&projectId=${b}`), [a, b]);
  // 控えた id は小文字で持つ（照合は本文の生値で行う）ので、拾う時も小文字に揃える。
  assert.deepEqual(tappedIdsOf(`/api/v1/chat/themes?spaceId=${a.toUpperCase()}`), [a]);
  assert.deepEqual(tappedIdsOf('/api/v1/files/tree?spaceId=not-a-uuid'), []);
  assert.deepEqual(tappedIdsOf('/api/v1/spaces'), []);
});
