#!/usr/bin/env node
// 「Service は Prisma Client を直接使わない」を機械で確かめる（d1085）。
//
// docs/architecture/architecture-invariants.md の依存方向は
//   Controller -> Service -> Repository -> Prisma
// で、DB に触るのは Repository の役目。不変条件 L33「機械的に強制できる規則は型、test、
// lint、CI へ置く」に従い、ここで service 内の `this.prisma.` を検出する。
// 例外は同文書 L16 に従って ADR へ理由を書いたものだけを、下の ALLOWED に明示する
// （許可を足す時は ADR の番号も同じ行に書く。増やすほどこの検査の意味が薄れる）。
// d1216: 「ADR に理由を書いた」を宣言だけで終わらせず、その ADR が実在して例外の実体へ
// 言及していることまで見る（raw SQL 側の check-raw-sql-location.mjs と同水準）。
// 公開スナップショットは社内の ADR を持たないため、ADR 照合は社内リポジトリでだけ行う。
//
// 使い方: node scripts/check-service-repository-boundary.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES_DIR = join(REPO_ROOT, 'packages/backend/src/modules');
const DECISIONS = join(REPO_ROOT, 'docs/decisions');
// 公開スナップショットは社内の ADR を持たない（scripts/publish ごと公開除外される）。
// その文脈では ADR の実在を確かめられないので、例外の実体と許可の一致だけを見る。
const IS_PUBLIC_SNAPSHOT = !existsSync(join(REPO_ROOT, 'scripts/publish'));

/** 例外の理由（例: ADR 0073 §4）から ADR 番号（4 桁）を取り出す。無ければ null。 */
function adrNumberOf(reason) {
  const match = String(reason).match(/ADR\s*(\d{1,4})/);
  return match ? match[1].padStart(4, '0') : null;
}

/** 例外の実体（ファイルパスかクラス名）が ADR 本文に書かれているか。 */
function adrMentionsException(adrText, rel, className) {
  return adrText.includes(rel) || (className ? adrText.includes(className) : false);
}

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

// 例外の理由が ADR に実在して実体へ言及しているか（d1216）。
// 許可一覧に存在しない ADR 番号を書いても緑のままだと、生煮えの例外が静かに増やせる。
const unrecorded = [];
if (!IS_PUBLIC_SNAPSHOT) {
  for (const [rel, reason] of ALLOWED) {
    const number = adrNumberOf(reason);
    if (!number) {
      unrecorded.push(`${rel}（理由に ADR 番号が無い: "${reason}"）`);
      continue;
    }
    let adrText = null;
    try {
      const name = readdirSync(DECISIONS).find(
        (n) => n.startsWith(`${number}-`) && n.endsWith('.md'),
      );
      if (name) adrText = readFileSync(join(DECISIONS, name), 'utf8');
    } catch {
      adrText = null;
    }
    if (adrText === null) {
      unrecorded.push(`${rel}（ADR ${number} が見つからない）`);
      continue;
    }
    let className = null;
    try {
      className =
        (readFileSync(join(MODULES_DIR, rel), 'utf8').match(/export class (\w+)/) || [])[1] ?? null;
    } catch {
      className = null;
    }
    if (!adrMentionsException(adrText, rel, className)) {
      unrecorded.push(
        `${rel}（ADR ${number} に実体の記載が無い: ${rel}${className ? ` / ${className}` : ''}）`,
      );
    }
  }
}

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
if (unrecorded.length > 0) {
  console.error(
    '例外の理由が ADR に記録されていません（例外は ADR に理由を書いたものだけ・d1216）:',
  );
  for (const u of unrecorded) console.error(`  - ${u}`);
  console.error(
    '\nADR を足すか、理由に実在する ADR 番号（例: ADR 0073 §4）を書き、その ADR に例外の実体（パスかクラス名）を記載してください。',
  );
}
if (violations.length > 0 || stale.length > 0 || unrecorded.length > 0) {
  process.exit(1);
}

console.log(
  `OK: ${services.length} 本の Service を確認（Prisma 直呼びは例外 ${ALLOWED.size} 本のみ・` +
    `ADR 照合は${IS_PUBLIC_SNAPSHOT ? '公開スナップショットのため対象外' : '実在と記載まで確認'}` +
    '）',
);
