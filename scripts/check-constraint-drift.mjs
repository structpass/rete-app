#!/usr/bin/env node
// cmn-0077: 手書き CHECK 制約（enum 値リストを持つもの）と、対応する Prisma/TS 側の enum・union 定義の
// ドリフトを機械検証する。マイグレーション SQL に直書きされた CHECK は prisma schema の型検査を通らないため、
// 値集合がずれても実行時までコンパイル時に気づけない（cmn-0017 レビュー指摘）。
//
// 対象外: attachment_target_xor / reaction_target_xor のような「非NULL列の個数を数えるだけ」の構造的 CHECK は
// enum 値リストを持たないため突合対象に含めない（registry に登録しない = スキップ）。

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// 対象マイグレーション（cmn-0077 grounding: 手書き CHECK が存在すると grep 確認済のもの）。
// 新たに手書き CHECK を追加した migration を作ったら、ここへ追記すること。
// 追記を忘れても auditRegistryCoverage()（main() から起動時に常時実行）が
// migrations 配下全体を走査して未登録の enum 系 CHECK を検出し CI を落とすため fail-open にはならない。
// 撤去（DROP CONSTRAINT / DROP TABLE）は auditRegistryCoverage が migrations 配下全体を畳んで扱うため、
// 実行時に存在しない制約は登録漏れとして要求されない（ここに残したままでも問題ない）。
export const TARGET_MIGRATIONS = [
  '20260604013030_add_reaction',
  '20260605000015_add_attachment',
  '20260605000016_attachment_theme_target',
  '20260609131534_add_role_definitions',
  '20260614040000_add_attachment_announcement_target',
  '20260614044757_add_cm2_org_model',
  '20260624060000_add_task_activity_field_check',
  '20260627100000_add_task_activity_outcome_thread',
  '20260630120000_add_attachment_task_comment_target',
  '20260703093500_add_task_activity_comment_add_edit',
  '20260703121500_hom_0072_kind_check_constraint',
  '20261024011000_home_calendar_tag_kind',
];

const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/prisma/migrations');
const SCHEMA_PATH = join(REPO_ROOT, 'packages/backend/prisma/schema.prisma');
// TaskActivityField union の SSOT は @rete/shared（cmn-0211 で backend repository から集約）。
// 本スクリプトはこの union を正規表現で読むため、path・型名・リテラル並びの表記を変える時は
// 同ファイルの JSDoc の指示どおり本定数と codeLabel も併せて直す。
const TASK_ACTIVITY_FIELD_PATH = join(REPO_ROOT, 'packages/shared/src/types/task-activity.ts');
const ANNOUNCEMENT_TYPES_PATH = join(REPO_ROOT, 'packages/shared/src/types/announcement.ts');

/**
 * SQL テキストから `ALTER TABLE "<table>" ADD CONSTRAINT <name> CHECK (<body>)` を全て抽出する。
 * body は入れ子の括弧（XOR の四則演算式や判別共用体の AND/OR）を含み得るため、
 * 単純な `[^)]*` マッチでは崩れる。開き括弧からの深さカウントで対応する閉じ括弧を探す。
 * table も返す＝DROP TABLE で一緒に消える制約を実効集合から外せるようにするため。
 */
export function extractAddConstraints(sql) {
  const results = [];
  const re =
    /ALTER\s+TABLE\s+(?:"([^"]+)"|([A-Za-z0-9_]+))\s+ADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s+CHECK\s*\(/g;
  let m;
  while ((m = re.exec(sql))) {
    const table = m[1] ?? m[2];
    const name = m[3];
    const index = m.index; // DROP 系イベントと出現順で畳むための位置（出現順ソートのキー）。
    const openIdx = re.lastIndex - 1; // '(' の位置
    let depth = 0;
    let i = openIdx;
    for (; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      throw new Error(
        `CHECK 制約 "${name}" の括弧が閉じていません（migration.sql が壊れている可能性）`,
      );
    }
    results.push({ name, table, body: sql.slice(openIdx + 1, i), index });
    re.lastIndex = i + 1;
  }
  return results;
}

/**
 * SQL テキストから `DROP CONSTRAINT "<name>"` を全て抽出する（出現位置つき）。
 * 貼り替え（DROP→ADD）と、後続 migration による恒久的な撤去の両方を畳み込むために使う。
 */
export function extractDropConstraints(sql) {
  const results = [];
  const re = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/g;
  let m;
  while ((m = re.exec(sql))) {
    results.push({ name: m[1], index: m.index });
  }
  return results;
}

/**
 * SQL テキストから `DROP TABLE [IF EXISTS] "<name>"` を全て抽出する（出現位置つき）。
 * テーブルごと消えると、そのテーブルに付いていた CHECK 制約も同時に消える。
 * set-0180 の role_permissions 削除のように、制約名を指定せず表ごと落とす撤去を取りこぼさないために使う。
 */
export function extractDropTables(sql) {
  const results = [];
  const re = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/g;
  let m;
  while ((m = re.exec(sql))) {
    results.push({ table: m[1], index: m.index });
  }
  return results;
}

/**
 * 対象マイグレーション群を時系列順（引数の並び順）に畳み込み、各制約名の「最終的に有効な」body を求める。
 * DROP CONSTRAINT → ADD CONSTRAINT の貼り替え運用（同名制約の再定義）を、名前キーの上書きでそのまま表現する。
 * 撤去も畳む: DROP CONSTRAINT はその制約を、DROP TABLE はそのテーブルに付いていた制約を実効集合から外す
 * （後続 migration で消えた制約を「存在するのに値が一致しない」と誤判定しないため）。同一ファイル内の
 * 出現順で畳むため、DROP の後に同名 ADD が来る貼り替えも正しく再登録される。
 */
export function collectEffectiveConstraints(migrationDirs, migrationsRoot) {
  const effective = new Map(); // name -> { body, table, sourceMigration }
  for (const dir of migrationDirs) {
    const sqlPath = join(migrationsRoot, dir, 'migration.sql');
    const sql = readFileSync(sqlPath, 'utf8');
    const events = [
      ...extractAddConstraints(sql).map((c) => ({ ...c, kind: 'add' })),
      ...extractDropConstraints(sql).map((c) => ({ ...c, kind: 'drop-constraint' })),
      ...extractDropTables(sql).map((c) => ({ ...c, kind: 'drop-table' })),
    ].sort((a, b) => a.index - b.index);

    for (const event of events) {
      if (event.kind === 'drop-constraint') {
        effective.delete(event.name);
        continue;
      }
      if (event.kind === 'drop-table') {
        for (const [name, entry] of effective) {
          if (entry.table === event.table) effective.delete(name);
        }
        continue;
      }
      effective.set(event.name, { body: event.body, table: event.table, sourceMigration: dir });
    }
  }
  return effective;
}

/** `"col" IN ('a', 'b', ...)` 形式から値配列を抽出。該当しなければ null。 */
export function extractSimpleInList(body) {
  const m = body.match(/"?(\w+)"?\s+IN\s*\(([^)]*)\)/);
  if (!m) return null;
  return [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

/** space_kind_shape のような判別共用体 CHECK から `<column> = '...'` の値集合を抽出（重複除去）。 */
export function extractDiscriminatorValues(body, columnName) {
  const re = new RegExp(`${columnName}\\s*=\\s*'([^']+)'`, 'g');
  const values = [...body.matchAll(re)].map((x) => x[1]);
  return [...new Set(values)];
}

/** TS union type（`export type Foo = | 'a' | 'b' ... ;`）からリテラル値を抽出。 */
export function extractTsUnionLiterals(source, typeName) {
  const m = source.match(new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`));
  if (!m) throw new Error(`TS union type が見つかりません: ${typeName}`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

/** `export const NAME = [...] as const;` 形式のリテラル配列から値を抽出。 */
export function extractTsConstArray(source, constName) {
  const m = source.match(new RegExp(`export const ${constName}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`TS const 配列が見つかりません: ${constName}`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

/** Prisma `enum Name { ... }` ブロックから値集合を抽出（行コメント `//` は除去）。 */
export function extractPrismaEnumValues(source, enumName) {
  const m = source.match(new RegExp(`enum ${enumName}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`Prisma enum が見つかりません: ${enumName}`);
  return m[1]
    .split('\n')
    .map((line) => line.split('//')[0].trim())
    .filter(Boolean);
}

/**
 * cmn-0246: SQL テキストから `CREATE TYPE "<name>" AS ENUM ('a', 'b', ...)` を全て抽出する。
 * 大文字小文字は区別する（PostgreSQL の DDL 規約＝大文字）。改行・空白を含む値リテラルは
 * 想定しない（schema.prisma の enum 値識別子と一致する ASCII のみ）。
 */
export function extractCreateTypeEnums(sql) {
  const results = [];
  // CREATE TYPE [IF NOT EXISTS] "name" AS ENUM ('a','b',...)
  const re =
    /CREATE\s+TYPE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([A-Za-z_][A-Za-z0-9_]*)"\s+AS\s+ENUM\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1];
    const values = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    if (values.length === 0) {
      throw new Error(
        `CREATE TYPE "${name}" の値リストが空です（migration.sql が壊れている可能性）`,
      );
    }
    results.push({ name, values, index: m.index });
  }
  return results;
}

/**
 * cmn-0246: SQL テキストから `ALTER TYPE "<name>" ADD VALUE '...'` を全て抽出する。
 * PostgreSQL の ADD VALUE は複数回に分けて値を足せる形式（cmn-0246 時点では実例ゼロだが
 * 将来に備え畳み込み対象として認識する）。
 */
export function extractAlterTypeAddValues(sql) {
  const results = [];
  const re =
    /ALTER\s+TYPE\s+"([A-Za-z_][A-Za-z0-9_]*)"\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']*)'(?:\s+BEFORE\s+'([^']*)')?/g;
  let m;
  while ((m = re.exec(sql))) {
    results.push({ name: m[1], value: m[2], index: m.index });
  }
  return results;
}

/**
 * rev-quality 2026-08-05: SQL テキストから `DROP TYPE "<name>"` を全て抽出する。
 * fil-0136 が per-folder ACL 撤去で 2 enum を DROP TYPE した際、畳み込みが DROP を知らず
 * 「migration SQL に CREATE TYPE があるが schema.prisma に無い」の偽ドリフトを吐いたため追加。
 */
export function extractDropTypes(sql) {
  const results = [];
  const re = /DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?"([A-Za-z_][A-Za-z0-9_]*)"/g;
  let m;
  while ((m = re.exec(sql))) {
    results.push({ name: m[1], index: m.index });
  }
  return results;
}

/**
 * cmn-0246: 全 migration を時系列順に走査し、enum 名ごとに CREATE TYPE で開始した値集合へ
 * ALTER TYPE ... ADD VALUE を順に畳み込んだ「migration 側の実効値集合」を返す。
 * 既に同名 CREATE TYPE があり値が重複したら ALTER 側で除外（fail-open にしない）。
 * DROP TYPE（rev-quality 2026-08-05 追加）は当該 enum を実効集合から除去する＝後続 migration で
 * 落ちた enum は schema.prisma 側に無くてもドリフトにならない。同一ファイル内で DROP の後に
 * 同名 CREATE TYPE が来る再作成も、出現順に畳むため正しく再登録される。
 */
export function collectEffectiveMigrationEnums(migrationDirs, migrationsRoot) {
  const effective = new Map(); // name -> { values: Set, sourceMigrations: string[] }
  for (const dir of migrationDirs) {
    const sqlPath = join(migrationsRoot, dir, 'migration.sql');
    const sql = readFileSync(sqlPath, 'utf8');
    const events = [
      ...extractCreateTypeEnums(sql).map((e) => ({ ...e, kind: 'create' })),
      ...extractAlterTypeAddValues(sql).map((e) => ({ ...e, kind: 'alter' })),
      ...extractDropTypes(sql).map((e) => ({ ...e, kind: 'drop' })),
    ].sort((a, b) => a.index - b.index);
    for (const event of events) {
      if (event.kind === 'drop') {
        effective.delete(event.name);
        continue;
      }
      const entry = effective.get(event.name) ?? { values: new Set(), sourceMigrations: [] };
      if (event.kind === 'create') {
        for (const v of event.values) entry.values.add(v);
      } else {
        entry.values.add(event.value);
      }
      if (!entry.sourceMigrations.includes(dir)) entry.sourceMigrations.push(dir);
      effective.set(event.name, entry);
    }
  }
  return effective;
}

/**
 * cmn-0246: schema.prisma の全 enum 名を `extractPrismaEnumValues` で取得する。
 * 返り値は name -> values の Map。
 */
export function collectPrismaEnums(schemaSource) {
  const out = new Map();
  const re = /enum\s+([A-Z][A-Za-z0-9_]*)\s*\{/g;
  let m;
  while ((m = re.exec(schemaSource))) {
    out.set(m[1], new Set(extractPrismaEnumValues(schemaSource, m[1])));
  }
  return out;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * 突合レジストリ: 手書き CHECK 制約名 → (SQL 側の値抽出方法, コード側の正本と値抽出方法)。
 * 値リストを持たない構造的 CHECK（attachment_target_xor / reaction_target_xor）は登録しない = 突合対象外。
 * 新しい enum 系手書き CHECK を追加した時はここへ追記する。
 * 追記漏れは auditRegistryCoverage() が検出する（missing-from-registry）。
 */
export function buildRegistry() {
  const schemaSource = readFileSync(SCHEMA_PATH, 'utf8');
  const taskActivitySource = readFileSync(TASK_ACTIVITY_FIELD_PATH, 'utf8');
  const announcementTypesSource = readFileSync(ANNOUNCEMENT_TYPES_PATH, 'utf8');
  // cmn-0084: kind は Prisma enum でなく String 運用のため、コード側正本は shared ANNOUNCEMENT_KINDS SSOT。
  const announcementKindValues = extractTsConstArray(announcementTypesSource, 'ANNOUNCEMENT_KINDS');
  // d855/d862: お知らせタグの種別は予定（calendar）を含むため ANNOUNCEMENT_KINDS より 1 種多い。
  // 別集合を正本にしないと、DB 側の CHECK（'calendar' を含む）と常にずれて既定の検査が赤のまま残る。
  const announcementTagKindValues = extractTsConstArray(
    announcementTypesSource,
    'ANNOUNCEMENT_TAG_KINDS',
  );

  return [
    {
      constraintName: 'task_activities_field_check',
      sqlExtractor: extractSimpleInList,
      codeLabel: 'packages/shared/src/types/task-activity.ts の TaskActivityField union',
      codeValues: extractTsUnionLiterals(taskActivitySource, 'TaskActivityField'),
    },
    {
      constraintName: 'announcements_kind_check',
      sqlExtractor: extractSimpleInList,
      codeLabel: 'packages/shared/src/types/announcement.ts の ANNOUNCEMENT_KINDS',
      codeValues: announcementKindValues,
    },
    {
      constraintName: 'announcement_tags_kind_check',
      sqlExtractor: extractSimpleInList,
      codeLabel: 'packages/shared/src/types/announcement.ts の ANNOUNCEMENT_TAG_KINDS',
      codeValues: announcementTagKindValues,
    },
    {
      constraintName: 'space_kind_shape',
      sqlExtractor: (body) => extractDiscriminatorValues(body, 'kind'),
      codeLabel: 'packages/backend/prisma/schema.prisma の enum SpaceKind',
      codeValues: extractPrismaEnumValues(schemaSource, 'SpaceKind'),
    },
  ];
}

/** migrations ディレクトリ配下の全マイグレーションディレクトリ名を返す（ディレクトリ名先頭のタイムスタンプにより辞書順=時系列順）。 */
export function listAllMigrationDirs(migrationsRoot) {
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * CHECK 制約の body が enum 値リテラル（'...'）を含むか。
 * attachment_target_xor / reaction_target_xor のような「非NULL列の個数を数えるだけ」の
 * 構造的 CHECK は文字列リテラルを持たないため false になり、突合対象外として自然にスキップされる。
 */
function hasEnumLiteral(body) {
  return /'[^']*'/.test(body);
}

/**
 * 横断監査（fail-closed 化）: migrations 配下の全マイグレーションを走査し、
 * enum 値リストを持つ手書き CHECK 制約（IN(...) や判別共用体）を新規追加した際に
 * TARGET_MIGRATIONS / buildRegistry() への追記を忘れていないかを機械検証する。
 *
 * checkDrift() 単体は TARGET_MIGRATIONS / registry に「既に登録された」制約同士の値集合しか
 * 突合しないため、登録漏れ自体は検出できない（fail-open）。本関数はその穴を埋める：
 * 未登録の enum 系 CHECK が1件でも見つかれば problems を返し、CI を落とす。
 */
export function auditRegistryCoverage({
  migrationsRoot = MIGRATIONS_DIR,
  targetMigrations = TARGET_MIGRATIONS,
  registry = null,
} = {}) {
  const reg = registry ?? buildRegistry();
  const registeredNames = new Set(reg.map((entry) => entry.constraintName));
  const targetSet = new Set(targetMigrations);
  const problems = [];

  // 走査対象の全 migration を時系列で畳み、実行時に存在しない制約を除く。
  // 後続 migration が DROP CONSTRAINT / DROP TABLE で落とした制約は登録を要求しない
  // （要求すると、撤去のたびに registry へ「消えた制約」を残す運用になってしまう）。
  const allDirs = listAllMigrationDirs(migrationsRoot);
  const effectivelyExisting = new Set(collectEffectiveConstraints(allDirs, migrationsRoot).keys());

  for (const dir of allDirs) {
    let sql;
    try {
      sql = readFileSync(join(migrationsRoot, dir, 'migration.sql'), 'utf8');
    } catch {
      continue; // migration.sql を持たないディレクトリ（無い想定だが念のためスキップ）
    }
    for (const { name, body } of extractAddConstraints(sql)) {
      if (!hasEnumLiteral(body)) continue; // 構造的 CHECK（XOR等）は突合対象外
      if (!effectivelyExisting.has(name)) continue; // 後続 migration で撤去済み

      if (!targetSet.has(dir)) {
        problems.push({
          type: 'missing-from-target-migrations',
          constraint: name,
          sourceMigration: dir,
          message: `enum 値リストを持つ手書き CHECK "${name}"（${dir}）が TARGET_MIGRATIONS に未登録です。check-constraint-drift.mjs の TARGET_MIGRATIONS へ追記してください。`,
        });
      }
      if (!registeredNames.has(name)) {
        problems.push({
          type: 'missing-from-registry',
          constraint: name,
          sourceMigration: dir,
          message: `enum 値リストを持つ手書き CHECK "${name}"（${dir}）が buildRegistry() に未登録です。突合先のコード側 enum/union を registry へ追記してください。`,
        });
      }
    }
  }
  return problems;
}

/**
 * 突合本体。テストから差し替えられるよう migrationDirs / migrationsRoot / registry を引数で受け取る。
 */
export function checkDrift({
  migrationDirs = TARGET_MIGRATIONS,
  migrationsRoot = MIGRATIONS_DIR,
  registry = null,
} = {}) {
  const effective = collectEffectiveConstraints(migrationDirs, migrationsRoot);
  const reg = registry ?? buildRegistry();
  const results = [];

  for (const entry of reg) {
    const found = effective.get(entry.constraintName);
    if (!found) {
      results.push({
        constraint: entry.constraintName,
        status: 'missing',
        message: `対象マイグレーション群に CHECK 制約 "${entry.constraintName}" が見つかりません`,
      });
      continue;
    }
    const sqlValues = entry.sqlExtractor(found.body);
    if (!sqlValues) {
      results.push({
        constraint: entry.constraintName,
        status: 'unparseable',
        message: `CHECK 制約 "${entry.constraintName}" の値リストを抽出できませんでした（body: ${found.body}）`,
      });
      continue;
    }
    if (sameSet(sqlValues, entry.codeValues)) {
      results.push({ constraint: entry.constraintName, status: 'ok' });
    } else {
      results.push({
        constraint: entry.constraintName,
        status: 'drift',
        sqlValues,
        codeValues: entry.codeValues,
        codeLabel: entry.codeLabel,
        sourceMigration: found.sourceMigration,
      });
    }
  }
  return results;
}

/**
 * cmn-0246: migration SQL の enum 定義（CREATE TYPE / ALTER TYPE ADD VALUE）と
 * schema.prisma の enum 値集合を突き合わせる。
 *
 * 検出するズレ:
 * - 値の過不足（同じ enum 名で値集合が一致しない）
 * - 片側にしか無い enum（schema に無い SQL / SQL に無い schema）
 *
 * 返り値の各要素: { enum, status: 'ok'|'drift'|'sql-only'|'prisma-only', ... }
 */
export function checkEnumDrift({ migrationDirs = null, migrationsRoot = MIGRATIONS_DIR } = {}) {
  const dirs = migrationDirs ?? listAllMigrationDirs(migrationsRoot);
  const sqlEnums = collectEffectiveMigrationEnums(dirs, migrationsRoot);
  const schemaSource = readFileSync(SCHEMA_PATH, 'utf8');
  const prismaEnums = collectPrismaEnums(schemaSource);
  const results = [];

  // SQL 側にある enum は全て報告（schema に無いものは sql-only）。
  for (const [name, entry] of sqlEnums.entries()) {
    const prismaValues = prismaEnums.get(name);
    if (!prismaValues) {
      results.push({
        enum: name,
        status: 'sql-only',
        sqlValues: [...entry.values],
        sourceMigrations: entry.sourceMigrations,
        message: `migration SQL に CREATE TYPE "${name}" があるが schema.prisma に enum "${name}" が無い`,
      });
      continue;
    }
    const sqlVals = [...entry.values];
    const prismaVals = [...prismaValues];
    if (sameSet(sqlVals, prismaVals)) {
      results.push({ enum: name, status: 'ok' });
    } else {
      results.push({
        enum: name,
        status: 'drift',
        sqlValues: sqlVals,
        prismaValues: prismaVals,
        sourceMigrations: entry.sourceMigrations,
        message: `enum "${name}" の値集合が migration SQL と schema.prisma で不一致`,
      });
    }
  }
  // schema 側にしか無い enum も報告。
  for (const [name, values] of prismaEnums.entries()) {
    if (sqlEnums.has(name)) continue;
    results.push({
      enum: name,
      status: 'prisma-only',
      prismaValues: [...values],
      message: `schema.prisma に enum "${name}" があるが migration SQL に CREATE TYPE "${name}" が無い`,
    });
  }
  return results;
}

function main() {
  const results = checkDrift();
  let hasFailure = false;
  for (const r of results) {
    if (r.status === 'ok') {
      console.log(`OK    ${r.constraint}`);
    } else if (r.status === 'drift') {
      hasFailure = true;
      console.error(`DRIFT ${r.constraint}（発生源: ${r.sourceMigration}）`);
      console.error(`  DB CHECK           : ${JSON.stringify(r.sqlValues)}`);
      console.error(`  code(${r.codeLabel}) : ${JSON.stringify(r.codeValues)}`);
    } else {
      hasFailure = true;
      console.error(`ERROR ${r.constraint}: ${r.message}`);
    }
  }

  // cmn-0246: enum ドリフトの突き合わせ（migration SQL ↔ schema.prisma）。
  const enumResults = checkEnumDrift();
  for (const r of enumResults) {
    if (r.status === 'ok') {
      console.log(`OK    enum:${r.enum}`);
    } else {
      hasFailure = true;
      if (r.status === 'drift') {
        console.error(`DRIFT enum:${r.enum}（発生源: ${r.sourceMigrations.join(', ')}）`);
        console.error(`  migration SQL : ${JSON.stringify(r.sqlValues)}`);
        console.error(`  schema.prisma : ${JSON.stringify(r.prismaValues)}`);
      } else if (r.status === 'sql-only') {
        console.error(
          `DRIFT enum:${r.enum}（SQL のみ・発生源: ${r.sourceMigrations.join(', ')}）: ${r.message}`,
        );
      } else if (r.status === 'prisma-only') {
        console.error(`DRIFT enum:${r.enum}（schema のみ）: ${r.message}`);
      }
    }
  }

  const coverageProblems = auditRegistryCoverage();
  for (const p of coverageProblems) {
    hasFailure = true;
    console.error(`UNREGISTERED ${p.constraint}（発生源: ${p.sourceMigration}）: ${p.message}`);
  }

  if (hasFailure) {
    console.error(
      '\ncheck-constraint-drift: 手書き CHECK 制約 / enum 定義に不一致、または未登録があります。',
    );
    process.exitCode = 1;
  } else {
    console.log('check-constraint-drift: 全て一致しています。');
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}
