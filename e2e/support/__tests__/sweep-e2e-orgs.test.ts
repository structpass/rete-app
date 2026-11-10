/**
 * dsk-0413: sweep-e2e-orgs.ts 純粋関数の Node --test 単体検証。
 *
 * 実行: e2e の `npm run test:unit`（node --experimental-strip-types --test support/__tests__/*.test.ts）
 * → CI では test.yml の e2e 独立 job「Unit test (E2E)」ステップが実行する唯一の経路（cmn-0376）。
 * この経路の存在は scripts/check-ci-workflow.test.mjs が固定している。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isE2ENamedOrg, isE2EOrgName, E2E_ORG_NAME_PATTERNS } from '../sweep-e2e-orgs.ts';

test('e2e 一意名: 全パターン該当名が true', () => {
  assert.equal(isE2EOrgName('org-logistics-1784721769502-bgady1'), true);
  assert.equal(isE2EOrgName('org-refuse-1784721769502-bgady1'), true);
  assert.equal(isE2EOrgName('orgmove-org-1784721769502-bgady1'), true);
  assert.equal(isE2EOrgName('rejoin-org-1784721769502-bgady1'), true);
  assert.equal(isE2EOrgName('chadd-org-1784721769502-bgady1'), true);
  assert.equal(isE2EOrgName('toggle-org-1784721769502-bgady1'), true);
  assert.equal(isE2EOrgName('partner-org-1784721769502-bgady1'), true);
  assert.equal(isE2EOrgName('mgr-org-1784721769502-bgady1'), true);
  assert.equal(isE2EOrgName('del-org-1784721769502-bgady1'), true);
  assert.equal(isE2EOrgName('url-org-1784721769502-bgady1'), true);
});

test('実運用組織名: false', () => {
  assert.equal(isE2EOrgName('部署A'), false);
  assert.equal(isE2EOrgName('プロジェクトX'), false);
  assert.equal(isE2EOrgName('Rete 管理者'), false);
  assert.equal(isE2EOrgName(''), false);
});

test('大文字・タイポ・パターン違い: false', () => {
  // 大文字は意図的に不一致（e2e は lower-kebab 生成）
  assert.equal(isE2EOrgName('ORG-LOGISTICS-1784721769502-BGADY1'), false);
  assert.equal(isE2EOrgName('ORG-REFUSE-1784721769502-bgady1'), false);
  // timestamp 桁数違い
  assert.equal(isE2EOrgName('org-logistics-178472176950-bgady1'), false);
  assert.equal(isE2EOrgName('org-logistics-17847217695021-bgady1'), false);
  // random 部分長違い
  assert.equal(isE2EOrgName('org-logistics-1784721769502-bgady'), false);
  assert.equal(isE2EOrgName('org-logistics-1784721769502-bgady12'), false);
  // 未定義パターン
  assert.equal(isE2EOrgName('unknown-org-1784721769502-bgady1'), false);
});

test('null/undefined: false', () => {
  assert.equal(isE2EOrgName(null), false);
  assert.equal(isE2EOrgName(undefined), false);
});

test('パターン配列長: 11 件固定（固定名 10 + シナリオの一意名 e2e-*）', () => {
  assert.equal(E2E_ORG_NAME_PATTERNS.length, 11);
});

// d969: 残骸の掃除は「e2e の名札の形（14 桁目以降に時刻と乱数が付く）」と「固定の名札の一覧」の両方を対象にする。
test('掃除の対象: e2e の一意名の形と固定の名札は true', () => {
  assert.equal(isE2ENamedOrg('e2e-org-1792929637316-o7mrt5'), true);
  assert.equal(isE2ENamedOrg('e2e-set02-org-1792954739152-d4uum7'), true);
  assert.equal(isE2ENamedOrg('e2e-unseen-vx5p3g-org-1792954739152-d4uum7'), true);
  assert.equal(isE2ENamedOrg('org-logistics-1784721769502-bgady1'), true);
});

test('掃除の対象: 実運用の組織名と空・null は false', () => {
  assert.equal(isE2ENamedOrg('デフォルト組織'), false);
  assert.equal(isE2ENamedOrg('Rete 管理者'), false);
  // 名前に e2e- が途中で入るだけの形は対象にしない。
  assert.equal(isE2ENamedOrg('sales-e2e-team'), false);
  assert.equal(isE2ENamedOrg(''), false);
  assert.equal(isE2ENamedOrg(null), false);
  assert.equal(isE2ENamedOrg(undefined), false);
});

// d1023: 接頭辞だけで判定すると、人が試しに付けた e2e- 名の組織を毎回アーカイブしてしまう。
test('掃除の対象: 人が付けた e2e- 名（時刻と乱数が付かない形）は false', () => {
  assert.equal(isE2ENamedOrg('e2e-try'), false);
  assert.equal(isE2ENamedOrg('e2e-テスト'), false);
  assert.equal(isE2ENamedOrg('e2e-1792954739152'), false);
});
