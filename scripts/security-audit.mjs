import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function isAuditReport(output) {
  try {
    const parsed = JSON.parse(output);
    return Boolean(parsed && parsed.advisories && parsed.metadata?.vulnerabilities);
  } catch {
    return false;
  }
}

// `packageManager` に固定した pnpm で監査する。ローカルに入れた pnpm（devDependency）を
// 入口にすると受け取った引数を解釈し直すことがあり、`--json` が失われる版の混在で
// 監査結果が壊れる。固定版の起動に失敗した時だけ実行時の pnpm へ落とし、
// どちらで走ったかを結果に添えて、黙って別の入口の結果を正本にしない。
export function runPnpmAudit(env = process.env) {
  const options = {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    shell: process.platform === 'win32',
  };
  const pinned = spawnSync(
    'corepack',
    ['pnpm', 'audit', '--json', '--audit-level', 'low'],
    options,
  );
  if (!pinned.error && pinned.status !== null && isAuditReport(pinned.stdout)) {
    pinned.runner = 'corepack';
    return pinned;
  }
  const fallback = spawnSync('pnpm', ['audit', '--json', '--audit-level', 'low'], options);
  fallback.runner = 'pnpm';
  return fallback;
}

function isEmptyInventory(value) {
  return !Array.isArray(value) && Object.keys(value).length === 0;
}

export function evaluateAudit(audit, exceptions, today = new Date().toISOString().slice(0, 10)) {
  const invalid = () => new Error('Dependency audit returned no valid advisory inventory');
  if (!audit || audit.error || !audit.metadata?.vulnerabilities) throw invalid();
  // Object.keys を使う。`!audit.advisories` は空の所見（{}）を「所見なし」と取り違え、
  // 集計に件数があるのに素通りさせる。
  if (Array.isArray(audit.advisories)) throw new Error('Invalid advisory inventory');
  if (
    typeof audit.advisories !== 'object' ||
    audit.advisories === null ||
    isEmptyInventory(audit.advisories)
  )
    throw invalid();
  if (!Array.isArray(exceptions)) throw invalid();
  const failures = [];
  const accepted = [];
  const counts = new Map([
    ['info', 0],
    ['low', 0],
    ['moderate', 0],
    ['high', 0],
    ['critical', 0],
  ]);
  for (const advisory of Object.values(audit.advisories)) {
    if (
      !advisory ||
      !counts.has(advisory.severity) ||
      !advisory.github_advisory_id ||
      !advisory.module_name
    )
      throw new Error('Invalid advisory entry');
    if (
      !Array.isArray(advisory.findings) ||
      advisory.findings.length === 0 ||
      advisory.findings.some(
        (finding) =>
          !Array.isArray(finding?.paths) ||
          finding.paths.length === 0 ||
          finding.paths.some((path) => typeof path !== 'string' || !path.trim()),
      )
    )
      throw new Error('Invalid advisory dependency paths');
    const pathCount = advisory.findings.reduce((total, finding) => total + finding.paths.length, 0);
    counts.set(advisory.severity, counts.get(advisory.severity) + pathCount);
  }
  // 集計は依存経路単位。所見数との大小だけでは、同じ重大度の明細欠落を
  // 正常な複数経路と区別できないため、findings.paths の実数と完全一致させる。
  const advisories = Object.values(audit.advisories);
  for (const [severity, count] of counts) {
    const reportedCount = audit.metadata.vulnerabilities[severity];
    if (!Number.isSafeInteger(reportedCount) || reportedCount < 0 || reportedCount !== count)
      throw new Error('Filtered or incomplete advisory inventory');
  }
  for (const advisory of advisories) {
    const exception = exceptions.find(
      (e) => e.id === advisory.github_advisory_id && e.package === advisory.module_name,
    );
    if (exception && exception.expiresOn >= today && advisory.patched_versions === '<0.0.0') {
      accepted.push({ id: exception.id, reason: exception.reason });
    } else {
      failures.push({
        id: advisory.github_advisory_id,
        package: advisory.module_name,
        severity: advisory.severity,
        fixed: advisory.patched_versions,
      });
    }
  }
  return { failures, accepted };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = runPnpmAudit();
    if (result.error || ![0, 1].includes(result.status))
      throw new Error('Dependency audit could not complete');
    if (!isAuditReport(result.stdout)) {
      // 固定版の pnpm が無い環境で実行時 pnpm（未固定）の出力を監査結果と取り違えないようにする。
      throw new Error('Dependency audit returned no valid advisory inventory');
    }
    const exceptions = JSON.parse(
      readFileSync(join(root, 'scripts/security-audit-exceptions.json'), 'utf8'),
    );
    const report = evaluateAudit(JSON.parse(result.stdout), exceptions);
    // 固定版で走れたかを残す。落ちた時だけ実行時 pnpm に落ちていることが分かるようにする。
    report.runner = result.runner;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.failures.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
