#!/usr/bin/env node
// cmn-0355: GHSA-hp3w-g68c-fv3c（sprintf-js@1.0.3 の精度指定で未捕捉 RangeError）について、
// 「公式修正版が無い」監査指摘を、修正や例外握り潰しで消さずに**実呼出元の到達可否**で判定する。
//
// 背景（実測 2026-10-06 / fresh root audit）:
//   @istanbuljs/load-nyc-config@1.1.0 → js-yaml@3.15.2 → argparse@1.0.10 → sprintf-js@1.0.3
//   sprintf の %e / %f / %g は指定精度を native の toExponential / toFixed / toPrecision へ
//   そのまま渡す。範囲外（f/e は 0..100、g は 1..100 の外）で RangeError が上がる。
//   公式修正版は無い（sprintf-js は 1.1.x 系が別実装、1.0.3 に patch は出ていない）。
//
// 何を判定するか:
//   「攻撃者が format 文字列を制御できるか」。制御できないなら、この指摘は Rete に対する
//   到達可能な脆弱性ではなく、依存監査の表示としてのみ残る（no_change）。
//   制御できる経路が実配線で見つかった時だけ、最狭の呼出元を既存の不正入力エラー契約へ繋ぐ。
//
// この検査が守る線引き:
//   - sprintf の例外を握り潰さない / 文字列を返さない / 精度を clamp しない /
//     任意の上限や偽の fixed version を導入しない（ticket の明示指定）。
//   - 到達経路が未確認のまま「安全」とも「危険」とも断定しない。判定は実測だけから出す。
//
// 依存は Node 標準モジュールのみ（check:repo-invariants は install 前に走るため）。
// 対象パッケージは .pnpm 配下に実体がある時だけ読み、無い環境では「未検査」を返して
// 成功に丸めない（fail-closed）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// ESM から CJS の実体（sprintf-js / argparse）を確実に読むための require。
// createRequire は Node 標準で、外部依存は増えない。
const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
const PNPM_DIR = join(REPO_ROOT, 'node_modules', '.pnpm');

// ── 対象の固定（版を上げたらここが赤くなる＝黙って対象がすり替わらない） ──────────────
//
// 監査が指すのは 1.0.3 系。1.1.x は別実装で、この指摘の対象ではない。版が動いた時に
// 「検査は緑のまま対象だけ入れ替わる」のを防ぐため、版を定数で固定して突合する。
export const ADVISORY = {
  id: 'GHSA-hp3w-g68c-fv3c',
  package: 'sprintf-js',
  version: '1.0.3',
  // 公式修正版が無いこと（fixed version を捏造しないための記録）。
  fixed_version: null,
  // 親鎖（実測。この順で require される）。
  chain: [
    '@istanbuljs/load-nyc-config@1.1.0',
    'js-yaml@3.15.2',
    'argparse@1.0.10',
    'sprintf-js@1.0.3',
  ],
};

// 精度の境界。sprintf は match[7]（. の後ろの数字）をそのまま native へ渡す。
// f/e は toFixed/toExponential の 0..100、g は toPrecision の 1..100。
export const PRECISION_LIMITS = {
  e: { min: 0, max: 100, method: 'toExponential' },
  f: { min: 0, max: 100, method: 'toFixed' },
  g: { min: 1, max: 100, method: 'toPrecision' },
};

/** .pnpm 配下の <pkg>@<version>/node_modules/<pkg> を解決する（無ければ null）。 */
export function packageDir(name, version) {
  // pnpm はスコープ付きパッケージのディレクトリ名で `/` を `+` に置き換える
  // （実測: @istanbuljs/load-nyc-config@1.1.0 → @istanbuljs+load-nyc-config@1.1.0）。
  const dirName = `${name.replace('/', '+')}@${version}`;
  const candidate = join(PNPM_DIR, dirName, 'node_modules', name);
  return existsSync(candidate) ? candidate : null;
}

/** 実体の package.json の version を読む（読めなければ null）。 */
export function installedVersion(dir) {
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) return null;
  try {
    return JSON.parse(readFileSync(pj, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * 監査対象の実体を解決する。
 * found=false は「この作業ツリーに実体が無い」＝未検査（呼び出し側が成功に丸めない材料）。
 */
export function resolveAdvisoryTargets(root = REPO_ROOT) {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const entry = join(
    pnpm,
    `${ADVISORY.package}@${ADVISORY.version}`,
    'node_modules',
    ADVISORY.package,
  );
  const srcFile = join(entry, 'src', 'sprintf.js');
  const present = existsSync(srcFile);
  return {
    found: present,
    dir: present ? entry : null,
    source_file: present ? srcFile : null,
    installed_version: present ? installedVersion(entry) : null,
    pnpm_dir: pnpm,
  };
}

/**
 * node_modules 配下の sprintf.js 実体を**全件**列挙する（サンプリングしない）。
 * ticket の要求「全installed sprintfコピーを列挙する」に対応する。
 */
export function listInstalledCopies(root = REPO_ROOT) {
  const nm = join(root, 'node_modules');
  if (!existsSync(nm)) return [];
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === 'sprintf.js') out.push(full);
    }
  };
  walk(nm);
  return out.sort();
}

// ── 呼出元の列挙（argparse の sprintf 呼出しを実測で拾う） ─────────────────────────
//
// sprintf の「format 文字列」と「引数」を分けて記録するのが要点。脆弱性が成立するのは
// format 文字列側に攻撃者入力が入った時で、引数側（{prog} など）が入っても精度は変わらない。
export function listSprintfCallSites(argparseDir) {
  if (!argparseDir || !existsSync(argparseDir)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.js')) {
        const text = readFileSync(full, 'utf8');
        text.split(/\r?\n/).forEach((line, i) => {
          if (/\bsprintf\s*\(/.test(line) && !/require\(/.test(line)) {
            out.push({
              file: relative(argparseDir, full).split(sep).join('/'),
              line: i + 1,
              code: line.trim(),
            });
          }
        });
      }
    }
  };
  walk(argparseDir);
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ── format 文字列の由来を静的に分類する ─────────────────────────────────────────
//
// 「定数（開発者が書いた literal）」と「変数（実行時に決まる）」を分ける。変数だから即
// 危険ではないが、**呼出元の実配線を人が見るべき箇所**として列挙する（定数1例で安全判定
// しない、という ticket の要求を機械側でも守る）。
export function classifyFormatOrigin(code) {
  const m = code.match(/sprintf\s*\(\s*([^,]+?)\s*,/);
  if (!m) return { kind: 'unknown', expr: null };
  const expr = m[1].trim();
  if (/^['"`]/.test(expr)) return { kind: 'literal', expr };
  return { kind: 'variable', expr };
}

// ── 実挙動プローブ（子プロセスで隔離し、RangeError を実測する） ─────────────────────
//
// 精度境界の実挙動は「100 までは正常・101 で RangeError」を実際に踏んで確かめる。
// 期待値をここに書いて、実測がそれと一致するかを見る（実装をなぞるだけのテストにしない）。

/** 正常に通るべき境界（実測で確定した値）。 */
export const EXPECTED_OK = {
  f: { 0: true, 100: true },
  e: { 0: true, 100: true },
  g: { 1: true, 100: true },
};

/** 例外になるべき境界（native の上限外）。 */
export const EXPECTED_RANGE_ERROR = {
  f: [101, 1000],
  e: [101, 1000],
  g: [0, 101, 1000],
};

/**
 * sprintf の実挙動を子プロセスで1件だけ確かめる。
 *
 * `call.entry` は同義の入口（既定 `sprintf`、`vsprintf` も選べる）。format 1件だけを見て
 * 安全判定しないため、入口違いも同じ境界で踏めるようにする。
 * 対象が無い時は {ran:false, reason:'missing'} を返し、成功扱いにしない。
 */
export function probeSprintf(call, { timeoutMs = 10000 } = {}) {
  const target = resolveAdvisoryTargets();
  if (!target.found) return { ran: false, reason: 'missing' };
  const entry = call.entry === 'vsprintf' ? 'vsprintf' : 'sprintf';
  const script = `
    const mod = require(${JSON.stringify(join(target.dir, 'src', 'sprintf.js'))});
    const fmt = ${JSON.stringify(call.format)};
    const arg = ${JSON.stringify(call.arg)};
    try {
      // sprintf は可変長、vsprintf は配列を受ける（同義の入口で境界を踏む）。
      const out = ${entry === 'vsprintf' ? 'mod.vsprintf(fmt, [arg])' : 'mod.sprintf(fmt, arg)'};
      process.stdout.write(JSON.stringify({ threw: false, out: String(out) }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ threw: true, name: e && e.constructor && e.constructor.name, message: e && e.message }));
    }
  `;
  // 子プロセスは短い timeout で隔離する（巨大 decimal でハングしない）。
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (r.error && r.error.code === 'ETIMEDOUT') return { ran: true, timedOut: true };
  if (r.status !== 0) return { ran: true, failed: true, stderr: (r.stderr || '').slice(0, 400) };
  try {
    return { ran: true, ...JSON.parse(r.stdout) };
  } catch {
    return { ran: true, failed: true, stdout: (r.stdout || '').slice(0, 400) };
  }
}

// ── js-yaml CLI の caller 実配線を確かめる材料 ─────────────────────────────────
//
// js-yaml@3.15.2 の CLI（bin/js-yaml.js）が argparse の formatter へ到達するか、
// 到達する時に format 文字列がどこから来るかを実体から読む。
export function inspectJsYamlCli(jsYamlDir) {
  if (!jsYamlDir || !existsSync(jsYamlDir)) return { found: false };
  const bin = join(jsYamlDir, 'bin', 'js-yaml.js');
  if (!existsSync(bin)) return { found: false };
  const text = readFileSync(bin, 'utf8');
  // prog / help の由来を実際のソースから拾う（人が読む材料を機械で固定する）。
  const progMatch = text.match(/prog:\s*([^,\n]+)/);
  const helpLines = [...text.matchAll(/help:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  // ユーザー入力を format 位置へ渡す呼出し（addText / addUsage の実引数）があるか。
  const textCalls = [...text.matchAll(/addText\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  const usageCalls = [...text.matchAll(/addUsage\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  // options.file（CLI 引数＝攻撃者が握れる）がどう使われるか。
  const fileUses = [...text.matchAll(/.{0,40}options\.file.{0,40}/g)].map((m) => m[0].trim());
  return {
    found: true,
    path: bin,
    prog: progMatch ? progMatch[1].trim() : null,
    help_literals: helpLines,
    add_text_args: textCalls,
    add_usage_args: usageCalls,
    attacker_input_uses: fileUses,
    // format 位置へ渡る引数があるか（あれば人が見るべき箇所）。
    reaches_formatter_with_input: textCalls.length > 0 || usageCalls.length > 0,
  };
}

/** 実体の sprintf.js が精度を native へ素通ししている箇所を実測で示す。 */
export function precisionForwardingSites(target) {
  if (!target?.found) return [];
  const text = readFileSync(target.source_file, 'utf8');
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/toExponential|toFixed|toPrecision/.test(line)) {
      out.push({ line: i + 1, code: line.trim() });
    }
  });
  return out;
}

/** 一連の判定材料を1つの object にまとめる（人が読む材料と機械の材料を分けない）。 */
export function collectEvidence(root = REPO_ROOT) {
  const target = resolveAdvisoryTargets(root);
  const copies = listInstalledCopies(root);
  const argparseDir = packageDir('argparse', '1.0.10');
  const jsYamlDir = packageDir('js-yaml', '3.15.2');
  return {
    advisory: ADVISORY,
    target,
    installed_copies: copies,
    copy_count: copies.length,
    argparse_dir: argparseDir,
    call_sites: listSprintfCallSites(argparseDir),
    forwarding: precisionForwardingSites(target),
    js_yaml_cli: inspectJsYamlCli(jsYamlDir),
    generated_at: new Date().toISOString(),
  };
}
