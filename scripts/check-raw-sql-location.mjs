#!/usr/bin/env node
// 「raw SQL は Repository 内へ閉じる」を機械で確かめる（d1101）。
//
// docs/architecture/architecture-invariants.md の Backend boundaries は
//   raw SQL などの例外は Repository 内へ閉じ、必要性と安全性を ADR へ記録する
// と定め、同 Verification が「機械的に強制できる規則は型、test、lint、CI へ置く」と続けている。
// ここでは $queryRaw / $executeRaw（および $queryRawUnsafe / $executeRawUnsafe）の出現位置を見る。
//
// 例外は下の ALLOWED に、理由つきで明示する（増やすほどこの検査の意味が薄れる）。
//
// 使い方: node scripts/check-raw-sql-location.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO_ROOT, 'packages/backend/src');
const DECISIONS = join(REPO_ROOT, 'docs/decisions');

// 例外。Repository 以外で raw SQL を書いてよい箇所と、その理由。
const ALLOWED = new Map([
  // 接続確認の `SELECT 1`。業務データを触らない疎通確認で、Prisma の Client 自身が持つ。
  ['database/prisma.service.ts', '接続確認の SELECT 1 のみ（業務データを触らない）'],
]);

// ADR の本文（記録済みかの照合に使う）。
let ADR_TEXTS = [];
try {
  ADR_TEXTS = readdirSync(DECISIONS)
    .filter((n) => n.endsWith('.md') && /^\d{4}-/.test(n))
    .map((n) => readFileSync(join(DECISIONS, n), 'utf8'));
} catch {
  ADR_TEXTS = [];
}

// raw SQL を持つ Repository（ADR 記録の照合対象）と、記録が見つからないもの。
const withRaw = [];
const unrecorded = [];

const RAW = /\$queryRawUnsafe|\$executeRawUnsafe|\$queryRaw|\$executeRaw/;

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) acc.push(p);
  }
  return acc;
}

const violations = [];
const stale = [];

const scanned = walk(SRC);
// 対象が 0 本なら、置き場の名前が変わったか消えたということ。このまま「違反なし」で
// 通すと、規約が効かないまま緑になる（実測: 許可一覧が空だと静かに通ってしまった）。
if (scanned.length === 0) {
  console.error(`対象のファイルが 1 本も見つかりません（置き場を確かめてください）: ${SRC}`);
  process.exit(1);
}

for (const file of scanned) {
  const rel = relative(SRC, file).split('\\').join('/');
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const hits = [];
  lines.forEach((l, i) => {
    if (RAW.test(l)) hits.push(i + 1);
  });
  if (hits.length === 0) continue;

  const inRepository = /(^|\/)repositories?\//.test(rel) || /\.repository\.ts$/.test(rel);
  if (inRepository || ALLOWED.has(rel)) {
    if (inRepository)
      withRaw.push({ rel, cls: (src.match(/export class (\w+)/) || [])[1] ?? null });
    continue;
  }
  for (const line of hits) violations.push(`${rel}:${line}`);
}

// 不変条件の後半「必要性と安全性を ADR へ記録する」も見る（d1105）。
// ADR はファイルのパスでもクラス名でも指せるので、どちらかで言及されていれば記録済みとみなす。
for (const { rel, cls } of withRaw) {
  const mentioned = ADR_TEXTS.some(
    (t) =>
      t.includes(rel) ||
      t.includes(rel.replace('packages/backend/src/', '')) ||
      (cls && t.includes(cls)),
  );
  if (!mentioned) unrecorded.push(`${rel}${cls ? `（${cls}）` : ''}`);
}

// 例外の置き場所が消えていないか（消えた例外を残すと、許可だけが残る）。
for (const rel of ALLOWED.keys()) {
  try {
    if (!statSync(join(SRC, rel)).isFile()) stale.push(rel);
  } catch {
    stale.push(rel);
  }
}

if (violations.length > 0) {
  console.error('Repository の外で raw SQL を使っています（Repository 内へ閉じてください）:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\n例外にするなら、理由を docs/decisions/ の ADR に書き、' +
      'scripts/check-raw-sql-location.mjs の ALLOWED に理由つきで足してください。',
  );
}
if (stale.length > 0) {
  console.error('ALLOWED に、もう存在しないファイルが残っています:');
  for (const s of stale) console.error(`  - ${s}`);
}
if (unrecorded.length > 0) {
  console.error(
    'raw SQL を使っているのに、ADR に記録がありません（必要性と安全性を残してください）:',
  );
  for (const u of unrecorded) console.error(`  - ${u}`);
  console.error(
    '\ndocs/decisions/ に ADR を足し、affected にそのファイルかクラス名を書いてください。',
  );
}
if (violations.length > 0 || stale.length > 0 || unrecorded.length > 0) process.exit(1);

console.log(
  `OK: raw SQL は Repository 内で ADR に記録済み（例外 ${ALLOWED.size} 件・記録 ${withRaw.length} 件）`,
);
