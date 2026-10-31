import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractAddConstraints,
  extractDropConstraints,
  extractDropTables,
  collectEffectiveConstraints,
  extractSimpleInList,
  extractDiscriminatorValues,
  extractTsUnionLiterals,
  extractTsConstArray,
  extractPrismaEnumValues,
  extractCreateTypeEnums,
  extractAlterTypeAddValues,
  extractDropTypes,
  collectEffectiveMigrationEnums,
  collectPrismaEnums,
  checkEnumDrift,
  checkDrift,
  auditRegistryCoverage,
  listAllMigrationDirs,
  TARGET_MIGRATIONS,
} from './check-constraint-drift.mjs';

test('extractAddConstraints: 単純な IN リストの CHECK を抽出できる', () => {
  const sql = `ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_resource_type_valid" CHECK ("resource_type" IN ('system', 'rete_feature'));`;
  const result = extractAddConstraints(sql);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'role_permissions_resource_type_valid');
  assert.equal(result[0].table, 'role_permissions');
  assert.equal(result[0].body, `"resource_type" IN ('system', 'rete_feature')`);
});

test('extractAddConstraints: 入れ子括弧を含む XOR 制約でも body が壊れない', () => {
  const sql = `ALTER TABLE "attachments" ADD CONSTRAINT attachment_target_xor CHECK ((("task_id" IS NOT NULL)::int + ("chat_message_id" IS NOT NULL)::int) = 1);`;
  const result = extractAddConstraints(sql);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'attachment_target_xor');
  assert.match(result[0].body, /task_id/);
});

test('extractAddConstraints: 複数行にまたがる判別共用体 CHECK も1つのbodyとして抽出できる', () => {
  const sql = `ALTER TABLE "spaces" ADD CONSTRAINT space_kind_shape CHECK (
  (kind = 'CHANNEL' AND project_id IS NOT NULL) OR
  (kind = 'GROUP' AND project_id IS NULL)
);`;
  const result = extractAddConstraints(sql);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'space_kind_shape');
  assert.match(result[0].body, /CHANNEL/);
  assert.match(result[0].body, /GROUP/);
});

test('collectEffectiveConstraints: DROP→ADD の貼り替えを時系列で畳み込み、最新の値だけが残る', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(
      join(root, 'm1', 'migration.sql'),
      `ALTER TABLE "t" ADD CONSTRAINT "field_check" CHECK ("field" IN ('a', 'b'));`,
    );
    mkdirSync(join(root, 'm2'));
    writeFileSync(
      join(root, 'm2', 'migration.sql'),
      `ALTER TABLE "t" DROP CONSTRAINT "field_check";\nALTER TABLE "t" ADD CONSTRAINT "field_check" CHECK ("field" IN ('a', 'b', 'c'));`,
    );

    const effective = collectEffectiveConstraints(['m1', 'm2'], root);
    const entry = effective.get('field_check');
    assert.ok(entry);
    assert.equal(entry.sourceMigration, 'm2');
    assert.deepEqual(extractSimpleInList(entry.body), ['a', 'b', 'c']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractDropConstraints / extractDropTables: 制約撤去と表撤去を抽出する', () => {
  const sql = [
    `ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_resource_type_valid";`,
    `DROP TABLE "role_permissions";`,
    `DROP TABLE IF EXISTS "user_system_access";`,
  ].join('\n');
  assert.deepEqual(
    extractDropConstraints(sql).map((r) => r.name),
    ['role_permissions_resource_type_valid'],
  );
  assert.deepEqual(
    extractDropTables(sql).map((r) => r.table),
    ['role_permissions', 'user_system_access'],
  );
});

test('collectEffectiveConstraints: DROP TABLE で同表の制約が実効集合から消える（set-0180 同型）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(
      join(root, 'm1', 'migration.sql'),
      `ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_resource_type_valid" CHECK ("resource_type" IN ('system', 'rete_feature'));`,
    );
    mkdirSync(join(root, 'm2'));
    writeFileSync(join(root, 'm2', 'migration.sql'), `DROP TABLE "role_permissions";`);

    const effective = collectEffectiveConstraints(['m1', 'm2'], root);
    assert.equal(effective.has('role_permissions_resource_type_valid'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectEffectiveConstraints: DROP CONSTRAINT 後に別 migration で同名 ADD されると再登録される', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(
      join(root, 'm1', 'migration.sql'),
      `ALTER TABLE "t" ADD CONSTRAINT "field_check" CHECK ("field" IN ('a'));`,
    );
    mkdirSync(join(root, 'm2'));
    writeFileSync(
      join(root, 'm2', 'migration.sql'),
      `ALTER TABLE "t" DROP CONSTRAINT "field_check";`,
    );
    mkdirSync(join(root, 'm3'));
    writeFileSync(
      join(root, 'm3', 'migration.sql'),
      `ALTER TABLE "t" ADD CONSTRAINT "field_check" CHECK ("field" IN ('a', 'b'));`,
    );

    const effective = collectEffectiveConstraints(['m1', 'm2', 'm3'], root);
    assert.deepEqual(extractSimpleInList(effective.get('field_check').body), ['a', 'b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractSimpleInList: IN リストでない body には null を返す', () => {
  assert.equal(extractSimpleInList(`(("a" IS NOT NULL)::int) = 1`), null);
});

test("extractDiscriminatorValues: kind = 'X' の羅列から重複無しの値集合を取れる", () => {
  const body = `
    (kind = 'CHANNEL' AND a IS NOT NULL) OR
    (kind = 'GROUP' AND a IS NULL) OR
    (kind = 'GROUP' AND b IS NULL)
  `;
  const values = extractDiscriminatorValues(body, 'kind');
  assert.deepEqual(values.sort(), ['CHANNEL', 'GROUP']);
});

test('extractTsUnionLiterals: union type からリテラルを抽出できる（コメント行は無視される）', () => {
  const source = `
export type Foo =
  | 'a'
  // some japanese comment without quotes
  | 'b'
  | 'c';
`;
  assert.deepEqual(extractTsUnionLiterals(source, 'Foo'), ['a', 'b', 'c']);
});

test('extractTsConstArray: const 配列からリテラルを抽出できる', () => {
  const source = `export const RESOURCE_TYPES = ['system', 'rete_feature'] as const;`;
  assert.deepEqual(extractTsConstArray(source, 'RESOURCE_TYPES'), ['system', 'rete_feature']);
});

test('extractPrismaEnumValues: enum ブロックから値を抽出できる', () => {
  const source = `
enum SpaceKind {
  CHANNEL
  GROUP
  PERSONAL_MEMO
  PERSONAL_DM
}
`;
  assert.deepEqual(extractPrismaEnumValues(source, 'SpaceKind'), [
    'CHANNEL',
    'GROUP',
    'PERSONAL_MEMO',
    'PERSONAL_DM',
  ]);
});

test('checkDrift: 一致していれば全件 ok を返す（合成レジストリ）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(
      join(root, 'm1', 'migration.sql'),
      `ALTER TABLE "t" ADD CONSTRAINT "field_check" CHECK ("field" IN ('a', 'b'));`,
    );
    const registry = [
      {
        constraintName: 'field_check',
        sqlExtractor: extractSimpleInList,
        codeLabel: 'test',
        codeValues: ['a', 'b'],
      },
    ];
    const results = checkDrift({ migrationDirs: ['m1'], migrationsRoot: root, registry });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDrift: DB側とコード側の値がずれていれば drift を検出する', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(
      join(root, 'm1', 'migration.sql'),
      `ALTER TABLE "t" ADD CONSTRAINT "field_check" CHECK ("field" IN ('a', 'b'));`,
    );
    const registry = [
      {
        constraintName: 'field_check',
        sqlExtractor: extractSimpleInList,
        codeLabel: 'test',
        codeValues: ['a', 'b', 'c'], // コード側にだけ 'c' が増えている＝ドリフト
      },
    ];
    const results = checkDrift({ migrationDirs: ['m1'], migrationsRoot: root, registry });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'drift');
    assert.deepEqual(results[0].sqlValues, ['a', 'b']);
    assert.deepEqual(results[0].codeValues, ['a', 'b', 'c']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDrift: レジストリに無い制約が対象マイグレーションに無ければ missing を返す', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(join(root, 'm1', 'migration.sql'), `-- no constraints here`);
    const registry = [
      {
        constraintName: 'not_present',
        sqlExtractor: extractSimpleInList,
        codeLabel: 'test',
        codeValues: ['a'],
      },
    ];
    const results = checkDrift({ migrationDirs: ['m1'], migrationsRoot: root, registry });
    assert.equal(results[0].status, 'missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDrift (実データ): 対象12マイグレーション×実コードで現時点はドリフト無し', () => {
  const results = checkDrift();
  assert.equal(TARGET_MIGRATIONS.length, 12);
  const bad = results.filter((r) => r.status !== 'ok');
  assert.deepEqual(
    bad,
    [],
    `drift/missing/unparseable が検出されました: ${JSON.stringify(bad, null, 2)}`,
  );
});

test('auditRegistryCoverage: TARGET_MIGRATIONS に未追記の enum 系 CHECK を検出する（missing-from-target-migrations）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(
      join(root, 'm1', 'migration.sql'),
      `ALTER TABLE "t" ADD CONSTRAINT "field_check" CHECK ("field" IN ('a', 'b'));`,
    );
    mkdirSync(join(root, 'm2_untracked'));
    writeFileSync(
      join(root, 'm2_untracked', 'migration.sql'),
      `ALTER TABLE "t2" ADD CONSTRAINT "another_check" CHECK ("kind" IN ('x', 'y'));`,
    );
    const registry = [
      {
        constraintName: 'field_check',
        sqlExtractor: extractSimpleInList,
        codeLabel: 'test',
        codeValues: ['a', 'b'],
      },
      {
        constraintName: 'another_check',
        sqlExtractor: extractSimpleInList,
        codeLabel: 'test',
        codeValues: ['x', 'y'],
      },
    ];
    // m1 のみを TARGET_MIGRATIONS として渡す → m2_untracked の another_check が漏れとして検出される
    const problems = auditRegistryCoverage({
      migrationsRoot: root,
      targetMigrations: ['m1'],
      registry,
    });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].type, 'missing-from-target-migrations');
    assert.equal(problems[0].constraint, 'another_check');
    assert.equal(problems[0].sourceMigration, 'm2_untracked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditRegistryCoverage: registry に未登録の enum 系 CHECK を検出する（missing-from-registry）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(
      join(root, 'm1', 'migration.sql'),
      `ALTER TABLE "t" ADD CONSTRAINT "unregistered_check" CHECK ("field" IN ('a', 'b'));`,
    );
    // registry を空にする → TARGET_MIGRATIONS には含めても registry 追記漏れとして検出される
    const problems = auditRegistryCoverage({
      migrationsRoot: root,
      targetMigrations: ['m1'],
      registry: [],
    });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].type, 'missing-from-registry');
    assert.equal(problems[0].constraint, 'unregistered_check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditRegistryCoverage: 値リテラルを持たない構造的 CHECK（XOR等）は対象外で漏れ扱いしない', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(
      join(root, 'm1', 'migration.sql'),
      `ALTER TABLE "attachments" ADD CONSTRAINT attachment_target_xor CHECK ((("task_id" IS NOT NULL)::int + ("chat_message_id" IS NOT NULL)::int) = 1);`,
    );
    // TARGET_MIGRATIONS にも registry にも一切含めていないが、リテラル値集合を持たない構造的 CHECK なので検出されない
    const problems = auditRegistryCoverage({
      migrationsRoot: root,
      targetMigrations: [],
      registry: [],
    });
    assert.deepEqual(problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditRegistryCoverage (実データ): migrations 配下全体を走査して未登録の手書き CHECK が無いことを保証する', () => {
  const problems = auditRegistryCoverage();
  assert.deepEqual(
    problems,
    [],
    `未登録の手書き CHECK が検出されました: ${JSON.stringify(problems, null, 2)}`,
  );
});

test('auditRegistryCoverage: 後続 migration で撤去済みの制約は登録漏れ扱いしない（DROP TABLE）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, 'm1'));
    writeFileSync(
      join(root, 'm1', 'migration.sql'),
      `ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_resource_type_valid" CHECK ("resource_type" IN ('system', 'rete_feature'));`,
    );
    mkdirSync(join(root, 'm2'));
    writeFileSync(join(root, 'm2', 'migration.sql'), `DROP TABLE "role_permissions";`);

    // registry にも TARGET_MIGRATIONS にも入れていないが、実行時に存在しない制約なので要求されない
    const problems = auditRegistryCoverage({
      migrationsRoot: root,
      targetMigrations: [],
      registry: [],
    });
    assert.deepEqual(problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listAllMigrationDirs: migrations ディレクトリ配下の全ディレクトリ名を辞書順で返す', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-test-'));
  try {
    mkdirSync(join(root, '20260101000000_b'));
    mkdirSync(join(root, '20260101000000_a'));
    writeFileSync(join(root, 'migration_lock.toml'), '# not a directory, ignored');
    const dirs = listAllMigrationDirs(root);
    assert.deepEqual(dirs, ['20260101000000_a', '20260101000000_b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// cmn-0246: migration SQL の enum ドリフト検知
test('extractCreateTypeEnums: CREATE TYPE ... AS ENUM から名前と値集合を抽出する', () => {
  const sql = `CREATE TYPE "FolderGranteeType" AS ENUM ('ROLE', 'USER', 'ALL');`;
  const result = extractCreateTypeEnums(sql);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'FolderGranteeType');
  assert.deepEqual(result[0].values, ['ROLE', 'USER', 'ALL']);
});

test('extractCreateTypeEnums: IF NOT EXISTS 付きの CREATE TYPE も抽出する', () => {
  const sql = `CREATE TYPE IF NOT EXISTS "Status" AS ENUM ('OPEN', 'CLOSED');`;
  const result = extractCreateTypeEnums(sql);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Status');
  assert.deepEqual(result[0].values, ['OPEN', 'CLOSED']);
});

test('extractAlterTypeAddValues: ALTER TYPE ... ADD VALUE を抽出する', () => {
  const sql = `ALTER TYPE "Status" ADD VALUE IF NOT EXISTS 'PENDING';`;
  const result = extractAlterTypeAddValues(sql);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Status');
  assert.equal(result[0].value, 'PENDING');
});

test('collectEffectiveMigrationEnums: 複数 migration に分かれた CREATE TYPE / ALTER TYPE を name ごとに畳む', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-enum-'));
  try {
    mkdirSync(join(root, '20260101000000_create'));
    mkdirSync(join(root, '20260102000000_extend'));
    writeFileSync(
      join(root, '20260101000000_create', 'migration.sql'),
      `CREATE TYPE "FolderPermissionLevel" AS ENUM ('VIEW', 'EDIT');`,
    );
    writeFileSync(
      join(root, '20260102000000_extend', 'migration.sql'),
      `ALTER TYPE "FolderPermissionLevel" ADD VALUE 'MANAGE';`,
    );
    const effective = collectEffectiveMigrationEnums(listAllMigrationDirs(root), root);
    assert.deepEqual([...effective.get('FolderPermissionLevel').values].sort(), [
      'EDIT',
      'MANAGE',
      'VIEW',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractDropTypes: DROP TYPE（IF EXISTS 込み）を抽出する', () => {
  const sql = `DROP TYPE "FolderPermissionLevel";\nDROP TYPE IF EXISTS "FolderGranteeType";`;
  const result = extractDropTypes(sql);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => r.name),
    ['FolderPermissionLevel', 'FolderGranteeType'],
  );
});

test('collectEffectiveMigrationEnums: 後続 migration の DROP TYPE で enum は実効集合から消える（fil-0136 同型）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-enum-drop-'));
  try {
    mkdirSync(join(root, '20260101000000_create'));
    mkdirSync(join(root, '20260102000000_drop'));
    writeFileSync(
      join(root, '20260101000000_create', 'migration.sql'),
      `CREATE TYPE "FolderGranteeType" AS ENUM ('ROLE', 'USER', 'ALL');`,
    );
    writeFileSync(
      join(root, '20260102000000_drop', 'migration.sql'),
      `DROP TABLE "folder_permissions";\nDROP TYPE "FolderGranteeType";`,
    );
    const effective = collectEffectiveMigrationEnums(listAllMigrationDirs(root), root);
    assert.equal(effective.has('FolderGranteeType'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectEffectiveMigrationEnums: 同一ファイルで DROP の後に同名 CREATE TYPE は再登録される', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-enum-recreate-'));
  try {
    mkdirSync(join(root, '20260101000000_recreate'));
    writeFileSync(
      join(root, '20260101000000_recreate', 'migration.sql'),
      `DROP TYPE "Status";\nCREATE TYPE "Status" AS ENUM ('OPEN', 'CLOSED');`,
    );
    const effective = collectEffectiveMigrationEnums(listAllMigrationDirs(root), root);
    assert.deepEqual([...effective.get('Status').values].sort(), ['CLOSED', 'OPEN']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkEnumDrift: 一致する場合は全件 ok を返す', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-enum-match-'));
  try {
    mkdirSync(join(root, '20260101000000_m'));
    writeFileSync(
      join(root, '20260101000000_m', 'migration.sql'),
      `CREATE TYPE "MyEnum" AS ENUM ('A', 'B', 'C');`,
    );
    const schema = `enum MyEnum {
  A
  B
  C
}
`;
    // checkEnumDrift は内部で SCHEMA_PATH を読むため、ここでは結果の構造のみ検証する代わりに
    // collectEffectiveMigrationEnums + collectPrismaEnums を個別に検証。
    const dirs = listAllMigrationDirs(root);
    const sqlEnums = collectEffectiveMigrationEnums(dirs, root);
    const prismaEnums = collectPrismaEnums(schema);
    assert.deepEqual(
      [...sqlEnums.get('MyEnum').values].sort(),
      [...prismaEnums.get('MyEnum')].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkEnumDrift (実データ): migration SQL と schema.prisma の全 enum が一致する', () => {
  const results = checkEnumDrift();
  const failures = results.filter((r) => r.status !== 'ok');
  assert.deepEqual(
    failures,
    [],
    `enum drift が検出されました: ${JSON.stringify(failures, null, 2)}`,
  );
});

test('checkEnumDrift: SQL 側にしか無い enum を sql-only として報告する（取りこぼし防止）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccd-enum-sqlonly-'));
  try {
    mkdirSync(join(root, '20260101000000_m'));
    writeFileSync(
      join(root, '20260101000000_m', 'migration.sql'),
      `CREATE TYPE "SqlOnly" AS ENUM ('X');`,
    );
    // SCHEMA_PATH は実 repo を指すため、ここでは createTemp schema は読まれず sql-only が必ず出る。
    const results = checkEnumDrift({ migrationsRoot: root });
    const sqlOnly = results.find((r) => r.enum === 'SqlOnly');
    assert.ok(sqlOnly, 'sql-only の結果が返ること');
    assert.equal(sqlOnly.status, 'sql-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkEnumDrift: schema 側にしか無い enum を prisma-only として報告する', () => {
  // 実 schema.prisma には存在しないマイグレーションだけ置いた場合、
  // prisma-only が必ず出る（checkEnumDrift は SCHEMA_PATH を実 repo から読むため）。
  const root = mkdtempSync(join(tmpdir(), 'ccd-enum-prismaonly-'));
  try {
    mkdirSync(join(root, '20260101000000_m'));
    // CREATE TYPE を一つも書かない → SQL 側は空 → schema の enum は全て prisma-only になる。
    writeFileSync(join(root, '20260101000000_m', 'migration.sql'), '-- empty migration\n');
    const results = checkEnumDrift({ migrationsRoot: root });
    const prismaOnly = results.filter((r) => r.status === 'prisma-only');
    assert.ok(prismaOnly.length > 0, 'prisma-only の結果が 1 件以上あること');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
