// d1023: feature の注記（# e2e:verified <track> <pass|fail> "<title>"）のうち、観測の結果と食い違う
// （pass なのに走った記録が無い・fail なのに通過している・どこにも記録が無い）ものを一覧する（読み取りだけ）。
//
// 使い方:
//   node e2e/support/check-feature-annotations.mjs --report <playwright の JSON レポート> [--features e2e/features]
//
// 結果の意味:
//   - pass で、レポートに通過の記録がある             → ok
//   - fail で、レポートに失敗の記録がある             → ok
//   - 記録が無い（その回に走っていない）              → unknown（落とさない。注記が古いだけかもしれない）
//   - pass なのに失敗の記録 / fail なのに通過の記録   → mismatch（終了コード 1）
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
// `--name=値` と `--name 値` の両方を受ける（この PC の PowerShell からは `--name 値` の形が
// node 自身の引数として食われて届かないため、= の形を主に使う・d1023）。
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};

/** Playwright の JSON レポートから「題名 → 結果（passed/failed/skipped）」を作る。 */
export function titlesFromReport(report) {
  const observed = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const results = spec.tests?.flatMap((t) => t.results ?? []) ?? [];
      const last = results[results.length - 1]?.status ?? spec.tests?.[0]?.status;
      if (spec.title && last) observed.set(spec.title, last === 'passed' ? 'passed' : 'failed');
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return observed;
}

/** feature の本文から注記を読む（例: `# e2e:verified AUTHZ pass "…"`）。 */
export function annotationsFromFeature(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*# e2e:verified\s+(\S+)\s+(pass|fail)\s+"(.*)"\s*$/.exec(line);
    if (m) out.push({ track: m[1], verdict: m[2], title: m[3] });
  }
  return out;
}

/** 注記と観測の突き合わせ。 */
export function compareAnnotations(annotations, observed) {
  return annotations.map((a) => {
    const seen = observed.get(a.title);
    if (!seen) return { ...a, state: 'unknown' };
    const agree =
      (a.verdict === 'pass' && seen === 'passed') || (a.verdict === 'fail' && seen === 'failed');
    return { ...a, state: agree ? 'ok' : 'mismatch', observed: seen };
  });
}

// 直接呼ばれた時だけ本文を走らせる（試験から import した時に引数を解釈しない）。
const isMain = (() => {
  try {
    return import.meta.filename === process.argv[1];
  } catch {
    return false;
  }
})();
if (isMain) {
  // 既定の置き場はこのファイル（e2e/support/）から見た e2e/features。どの作業ディレクトリから呼んでも同じ。
  const featuresDir = flag(
    'features',
    join(dirname(fileURLToPath(import.meta.url)), '..', 'features'),
  );
  const reportPath = flag('report');
  if (!reportPath) {
    console.error(
      '使い方: node e2e/support/check-feature-annotations.mjs --report <playwright JSON レポート>',
    );
    process.exit(2);
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const observed = titlesFromReport(report);
  const results = [];
  for (const file of readdirSync(featuresDir).filter((f) => f.endsWith('.feature'))) {
    const text = readFileSync(join(featuresDir, file), 'utf8');
    for (const r of compareAnnotations(annotationsFromFeature(text), observed)) {
      results.push({ file, ...r });
    }
  }
  const counts = { ok: 0, unknown: 0, mismatch: 0 };
  for (const r of results) counts[r.state] += 1;
  for (const r of results.filter((r) => r.state === 'mismatch')) {
    console.log(`mismatch: ${r.file} [${r.verdict} → ${r.observed}] ${r.title}`);
  }
  console.log(JSON.stringify({ checked: results.length, ...counts }));
  process.exitCode = counts.mismatch > 0 ? 1 : 0;
}
