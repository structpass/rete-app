/**
 * cmn-0408: teardown.ts（resolveTeardownMethod）の Node --test 単体検証。
 *
 * 実行: e2e の `npm run test:unit`（node --experimental-strip-types --test support/__tests__/*.test.ts）
 * → CI では test.yml の e2e 独立 job「Unit test (E2E)」ステップが実行する（cmn-0376 と同経路）。
 *
 * ここが本件の唯一の証明手段なのは、現行の id 記録 POST が全て裸の /api/v1/<resource> で
 * 入れ子 path を通らず、判定が緩くても通しの e2e は緑になるため（cmn-0365 の MEDIUM 1）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTeardownMethod, buildCreatedResourceTeardown } from '../teardown.ts';

test('名指し 3 資源の裸 path は PATCH（archive 消し口）', () => {
  assert.equal(resolveTeardownMethod('/api/v1/organizations'), 'PATCH');
  assert.equal(resolveTeardownMethod('/api/v1/projects'), 'PATCH');
  assert.equal(resolveTeardownMethod('/api/v1/spaces'), 'PATCH');
  // 末尾スラッシュは空セグメントとして無視する（裸 path 扱いのまま）。
  assert.equal(resolveTeardownMethod('/api/v1/spaces/'), 'PATCH');
  // クエリ文字列は資源名と別文字列になるため名指しに一致しない（新旧同挙動＝DELETE）。
  assert.equal(resolveTeardownMethod('/api/v1/spaces?x=1'), 'DELETE');
});

test('名指し以外は DELETE（実在する消し口へ倒す・現行 id 記録 POST の残り 5 資源）', () => {
  assert.equal(resolveTeardownMethod('/api/v1/roles'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/tasks'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/announcements'), 'DELETE');
  // 2 セグメント資源（chat/themes・files/folders）は修正前後とも DELETE（非回帰）。
  assert.equal(resolveTeardownMethod('/api/v1/chat/themes'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/files/folders'), 'DELETE');
});

test('入れ子 path は名指し資源配下でも DELETE（アーカイブ誤射の遮断・cmn-0408）', () => {
  // 第 1 セグメント一致だけだと PATCH へ落ちて「静かな失敗」が戻る形（MEDIUM 1 の穴）。
  assert.equal(resolveTeardownMethod('/api/v1/spaces/sp-1/members'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/organizations/org-1/invites'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/projects/pj-1/tasks'), 'DELETE');
});

// d793: 予定（calendar-events）の消し口は revision を要求する。id だけの path を撃つと 400 で
// 断られ、作った予定が開発 DB に残り続けた。記録の時点で revision を添える。
test('予定は作った直後の revision を添えた消し口で記録する（d793）', () => {
  assert.deepEqual(
    buildCreatedResourceTeardown('/api/v1/calendar-events', {
      id: '4d9fb660-262c-4cff-9f09-c8c8b6f45f80',
      revision: 1,
    }),
    {
      method: 'DELETE',
      path: '/api/v1/calendar-events/4d9fb660-262c-4cff-9f09-c8c8b6f45f80?revision=1',
    },
  );
});

test('予定以外の資源は今までどおり id だけの path で記録する（非回帰）', () => {
  // タスク等の id は数値。予定（UUID）と取り違えない。
  assert.deepEqual(buildCreatedResourceTeardown('/api/v1/tasks', { id: 42, revision: 3 }), {
    method: 'DELETE',
    path: '/api/v1/tasks/42',
  });
  // 名指し資源（archive）の判定は resolveTeardownMethod のまま。
  assert.deepEqual(buildCreatedResourceTeardown('/api/v1/spaces', { id: 'sp-1' }), {
    method: 'PATCH',
    path: '/api/v1/spaces/sp-1',
  });
  // id が文字列でも、予定以外は revision を付けない。
  assert.deepEqual(
    buildCreatedResourceTeardown('/api/v1/announcements', { id: 'a-1', revision: 2 }),
    { method: 'DELETE', path: '/api/v1/announcements/a-1' },
  );
});

test('応答に id が無ければ記録しない（従来の「記録しない」判定の維持）', () => {
  assert.equal(buildCreatedResourceTeardown('/api/v1/tasks', null), null);
  assert.equal(buildCreatedResourceTeardown('/api/v1/tasks', {}), null);
  assert.equal(buildCreatedResourceTeardown('/api/v1/tasks', { id: '' }), null);
});
