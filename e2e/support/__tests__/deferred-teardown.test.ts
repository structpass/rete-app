/**
 * 途中でも済ませる後始末（support/deferred-teardown.ts）の Node --test 単体検証。
 *
 * 実行: e2e の `npm run test:unit`（node --experimental-strip-types --test support/__tests__/*.test.ts）
 *
 * 通しの e2e で確かめられるのは「成功した時に設定が戻る」ところまで。シナリオが途中で落ちた時に
 * 戻し手順が残っているかは通しでは作れないため、ここで判定だけを固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deferredTeardownValues,
  pendingTeardownSteps,
  splitActorSuffix,
  type DeferredStep,
} from '../deferred-teardown.ts';

const step = (path: string, settled = false): DeferredStep => ({
  path,
  body: '{"allowedExtensions":[]}',
  email: 'admin@rete.local',
  settled,
});

test('末尾の印を切り出す（本文は印の手前まで）', () => {
  assert.deepEqual(
    splitActorSuffix('"/api/v1/files/settings" => システムADMIN "admin@rete.local"'),
    {
      text: '"/api/v1/files/settings"',
      email: 'admin@rete.local',
    },
  );
  // 印の無い手順はそのまま（既存の手順に副作用を与えない）。
  assert.deepEqual(splitActorSuffix('"/api/v1/files/folders"'), {
    text: '"/api/v1/files/folders"',
    email: null,
  });
});

test('印が本文の途中にあっても末尾の 1 つだけを落とす', () => {
  const r = splitActorSuffix(
    '{"memo":"=> システムADMIN \\"x@y\\""} => システムADMIN "admin@rete.local"',
  );
  assert.equal(r.email, 'admin@rete.local');
  assert.equal(r.text, '{"memo":"=> システムADMIN \\"x@y\\""}');
});

test('後始末は登録の逆順で、最後に変えた分を先に戻す', () => {
  assert.deepEqual(
    pendingTeardownSteps([step('/api/v1/a'), step('/api/v1/b')]).map((s) => s.path),
    ['/api/v1/b', '/api/v1/a'],
  );
});

test('戻し終えた行（settled）は後始末で流さない＝成功時に二重実行しない', () => {
  // 手順どおり進んだ結果: 変更行も戻し行も settled になる。
  assert.deepEqual(pendingTeardownSteps([step('/api/v1/a', true), step('/api/v1/b', true)]), []);
  // 途中で落ちた: 戻し行に届いていないため、戻し手順が 1 度だけ残る。
  assert.deepEqual(
    pendingTeardownSteps([step('/api/v1/a')]).map((s) => s.path),
    ['/api/v1/a'],
  );
});

test('後始末の値は解決関数を通す（引数を素で送らない）', () => {
  const resolved = deferredTeardownValues(
    [{ ...step('/api/v1/files/folders/{{folderId}}'), body: '{"x":"{{folderId}}"}' }],
    { folderId: 'f-1' },
    (text, vars) => text.replaceAll('{{folderId}}', vars.folderId ?? ''),
  );
  assert.deepEqual(resolved, [
    {
      path: '/api/v1/files/folders/f-1',
      body: '{"x":"f-1"}',
      email: 'admin@rete.local',
      settled: false,
    },
  ]);
});
