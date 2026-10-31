import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAudit } from './security-audit.mjs';

const advisory = {
  github_advisory_id: 'GHSA-test',
  module_name: 'tool',
  patched_versions: '<0.0.0',
  severity: 'high',
  findings: [{ version: '1.0.0', paths: ['app>tool'] }],
};
const audit = (a) => ({
  advisories: { 1: a },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
});
const exception = {
  id: 'GHSA-test',
  package: 'tool',
  expiresOn: '2026-11-22',
  reason: 'bounded trusted-tool caller',
};
test('new, expired, mismatched-package and newly patched advisories fail closed', () => {
  assert.equal(evaluateAudit(audit(advisory), [], '2026-10-22').failures.length, 1);
  assert.equal(evaluateAudit(audit(advisory), [exception], '2026-11-23').failures.length, 1);
  assert.equal(
    evaluateAudit(audit({ ...advisory, module_name: 'other' }), [exception], '2026-10-22').failures
      .length,
    1,
  );
  assert.equal(
    evaluateAudit(audit({ ...advisory, patched_versions: '>=2' }), [exception], '2026-10-22')
      .failures.length,
    1,
  );
  assert.equal(evaluateAudit(audit(advisory), [exception], '2026-10-22').accepted.length, 1);
});
test('network failure or missing inventory never becomes a clean audit', () => {
  for (const value of [{}, { error: { code: 'ENOTFOUND' } }, null]) {
    assert.throws(() => evaluateAudit(value, []));
  }
});
test('filtered or malformed advisories cannot hide a nonzero vulnerability count', () => {
  // 中身が空の所見は、集計に件数が立っていれば通してはいけない。
  for (const advisories of [{}, []]) {
    assert.throws(() => evaluateAudit({ ...audit(advisory), advisories }, []));
  }
  // 型が壊れた所見は、集計が 0 でも機械が読み違えないよう止める。
  for (const advisories of ['invalid', { 1: null }]) {
    const report = {
      advisories,
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
    };
    assert.throws(() => evaluateAudit(report, []));
  }
});
test('advisory count may only reach the reported total through dependency paths', () => {
  const toml = {
    github_advisory_id: 'GHSA-toml',
    module_name: 'smol-toml',
    patched_versions: '>=1.9.0',
    severity: 'moderate',
    findings: [
      { version: '1.0.0', paths: ['app>a>smol-toml', 'app>b>smol-toml', 'app>c>smol-toml'] },
    ],
  };
  const report = (advisories, moderate) => ({
    advisories,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate, high: 0, critical: 0 } },
  });
  assert.throws(() => evaluateAudit(report({ 1: { ...advisory, severity: 'moderate' } }, 2), []));
  assert.throws(() => evaluateAudit(report({}, 1), []));
  assert.throws(() => evaluateAudit(report({ 1: { ...advisory, severity: 'moderate' } }, 0), []));
  const paths = evaluateAudit(report({ 1: toml }, 3), []);
  assert.deepEqual(
    paths.failures.map((f) => f.package),
    ['smol-toml'],
  );
});

test('accepted exception cannot mask missing details at another or the same severity', () => {
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    const input = audit(advisory);
    input.metadata.vulnerabilities[severity] += 1;
    assert.throws(() => evaluateAudit(input, [exception], '2026-10-22'), /incomplete/);
  }
  const input = audit({ ...advisory, findings: [{ paths: ['a>tool', 'b>tool'] }] });
  input.metadata.vulnerabilities.high = 2;
  assert.equal(evaluateAudit(input, [exception], '2026-10-22').accepted.length, 1);
});
test('all versions contribute their paths and malformed path inventories fail closed', () => {
  const input = audit({ ...advisory, findings: [{ paths: ['a>tool'] }, { paths: ['b>tool'] }] });
  input.metadata.vulnerabilities.high = 2;
  assert.equal(evaluateAudit(input, [exception], '2026-10-22').accepted.length, 1);
  for (const findings of [
    undefined,
    null,
    [],
    [{}],
    [{ paths: [] }],
    [{ paths: [''] }],
    [{ paths: [2] }],
  ]) {
    assert.throws(() => evaluateAudit(audit({ ...advisory, findings }), [exception]));
  }
  for (const count of [-1, 1.5, Infinity, NaN, '1', null]) {
    const report = audit(advisory);
    report.metadata.vulnerabilities.high = count;
    assert.throws(() => evaluateAudit(report, [exception]));
  }
});
