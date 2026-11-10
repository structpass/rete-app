#!/usr/bin/env node
// 「Service は Prisma Client を直接使わない」を機械で確かめる（d1085）。
//
// docs/architecture/architecture-invariants.md の依存方向は
//   Controller -> Service -> Repository -> Prisma
// で、DB に触るのは Repository の役目。不変条件 L33「機械的に強制できる規則は型、test、
// lint、CI へ置く」に従い、ここで service 内の `this.prisma.` を検出する。
// 例外は同文書 L16 に従って ADR へ理由を書いたものだけを、下の ALLOWED に明示する
// （許可を足す時は ADR の番号も同じ行に書く。増やすほどこの検査の意味が薄れる）。
//
// 使い方: node scripts/check-service-repository-boundary.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES_DIR = join(REPO_ROOT, 'packages/backend/src/modules');

// 例外（ADR で理由を記録したものだけ）。ここに足す時は ADR 番号を併記する。
const ALLOWED = new Map([
  // OIDC の payload 掃除は、HTTP filter の外で動くバックグラウンド処理で、
  // 単一の削除文しか持たないため Repository を挟まない（ADR 0073 §4）。
  ['auth/oidc/oidc-purge.service.ts', 'ADR 0073 §4'],
]);

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, acc);
    } else if (e.name.endsWith('.service.ts') && !e.name.endsWith('.spec.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

const services = walk(MODULES_DIR);
// 対象が 0 本なら、置き場の名前が変わったか消えたということ。このまま「違反なし」で
// 通すと、規約が効かないまま緑になる（実測: 許可一覧が空だと静かに通ってしまった）。
if (services.length === 0) {
  console.error(
    `対象の Service が 1 本も見つかりません（置き場を確かめてください）: ${MODULES_DIR}`,
  );
  process.exit(1);
}
const violations = [];

for (const file of services) {
  const rel = relative(MODULES_DIR, file).split('\\').join('/');
  const src = readFileSync(file, 'utf8');
  if (!/this\.prisma\./.test(src)) continue;
  if (ALLOWED.has(rel)) continue;
  const line = src.split('\n').findIndex((l) => /this\.prisma\./.test(l)) + 1;
  violations.push(`${rel}:${line}`);
}

// 例外の置き場所が消えていないかも見る（消えた例外を残すと、許可だけが残る）。
const stale = [...ALLOWED.keys()].filter((rel) => {
  try {
    return !statSync(join(MODULES_DIR, rel)).isFile();
  } catch {
    return true;
  }
});

if (violations.length > 0) {
  console.error('Service が Prisma Client を直接使っています（Repository を経由してください）:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\n例外にするなら、理由を docs/decisions/ の ADR に書き、' +
      'scripts/check-service-repository-boundary.mjs の ALLOWED に ADR 番号つきで足してください。',
  );
}
if (stale.length > 0) {
  console.error('ALLOWED に、もう存在しない Service が残っています:');
  for (const s of stale) console.error(`  - ${s}`);
}
if (violations.length > 0 || stale.length > 0) {
  process.exit(1);
}

console.log(
  `OK: ${services.length} 本の Service を確認（Prisma 直呼びは例外 ${ALLOWED.size} 本のみ）`,
);
