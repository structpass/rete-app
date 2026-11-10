import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { people, spaces, threads, tasks, id } from './demo/inventory-scenario.mjs';
import { documentDefs } from './demo/inventory-documents.mjs';
import {
  assertLocalTarget,
  validateScenario,
  seedInventoryProject,
} from './demo/seed-inventory-project.mjs';

test('本番・外部・管理用DBと環境指定なしを拒否する', () => {
  for (const env of [
    { NODE_ENV: 'production', DATABASE_URL: 'postgresql://a:b@localhost/rete' },
    { NODE_ENV: 'development', DATABASE_URL: 'postgresql://a:b@db.example/rete' },
    { NODE_ENV: 'development', DATABASE_URL: 'postgresql://a:b@localhost/rete_production' },
    { NODE_ENV: 'test', DATABASE_URL: 'postgresql://a:b@localhost/postgres' },
    { DATABASE_URL: 'postgresql://a:b@localhost/rete' },
  ])
    assert.throws(() => assertLocalTarget(env));
  assert.equal(
    assertLocalTarget({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://a:b@127.0.0.1/rete_test' })
      .hostname,
    '127.0.0.1',
  );
});

test('顧客向け会話・資料と社内の検討を混在させない', () => {
  const customers = new Set(people.filter((p) => !p.internal).map((p) => p.key));
  const privateSpaces = new Set(spaces.filter((s) => !s.customer).map((s) => s.key));
  for (const t of threads.filter((t) => privateSpaces.has(t.space)))
    assert.ok(t.messages.every((m) => !customers.has(m[0])));
  for (const d of documentDefs.filter((d) => d.tag === '社内検討'))
    assert.ok(privateSpaces.has(d.space));
  assert.ok(
    threads.some(
      (t) =>
        t.messages.some((m) => customers.has(m[0])) && t.messages.some((m) => !customers.has(m[0])),
    ),
  );
  assert.ok(
    tasks.some((t) => t.status === 'DONE') &&
      tasks.some((t) => t.status === 'IN_REVIEW') &&
      tasks.some((t) => t.status === 'IN_PROGRESS') &&
      tasks.some((t) => t.status === 'TODO'),
  );
});

test('資料実体と一貫した日付・担当・関連を持つ', async () => {
  const plan = await validateScenario();
  assert.deepEqual(
    [plan.people, plan.channels, plan.tasks, plan.messages, plan.files, plan.versions],
    [8, 4, 24, 52, 16, 18],
  );
});

test(
  '専用DBで重複・編集消失・ファイル欠落・担当越境がないことを確認する',
  { skip: !process.env.DEMO_VERIFY_DB },
  async () => {
    assert.ok(
      new URL(process.env.DATABASE_URL).pathname.startsWith('/hub_d993_'),
      '専用の検証DB以外では実行しない',
    );
    const require = createRequire(new URL('../packages/backend/package.json', import.meta.url));
    const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient();
    const root = process.env.DEMO_VERIFY_STORAGE;
    const counts = async () =>
      Promise.all(
        [
          'account',
          'task',
          'taskActivity',
          'taskComment',
          'chatTheme',
          'chatMessage',
          'folder',
          'file',
          'fileVersion',
          'membership',
          'announcement',
          'calendarEvent',
          'attachment',
        ].map((m) => db[m].count()),
      );
    try {
      const first = await seedInventoryProject(db, root);
      const before = await counts();
      const original = await db.task.findUniqueOrThrow({ where: { id: first.taskIds.stock } });
      await db.task.update({
        where: { id: original.id },
        data: { description: '<p>利用者が追記した検証メモ</p>' },
      });
      const second = await seedInventoryProject(db, root);
      assert.deepEqual(await counts(), before);
      assert.deepEqual(second.taskIds, first.taskIds);
      assert.equal(
        (await db.task.findUniqueOrThrow({ where: { id: original.id } })).description,
        '<p>利用者が追記した検証メモ</p>',
      );
      await db.task.update({
        where: { id: original.id },
        data: { description: original.description },
      });
      const customerMemberships = await db.membership.findMany({
        where: { accountId: { in: people.filter((p) => !p.internal).map((p) => p.id) } },
      });
      assert.ok(
        customerMemberships.every(
          (m) =>
            (m.scopeType === 'ORGANIZATION' && m.scopeId === id(202)) ||
            (m.scopeType === 'PROJECT' && m.scopeId === id(203)) ||
            (m.scopeType === 'CHANNEL' && spaces.some((s) => s.customer && s.id === m.scopeId)),
        ),
      );
      const allTasks = await db.task.findMany({
        where: { spaceId: { in: spaces.map((s) => s.id) } },
      });
      assert.ok(allTasks.filter((t) => t.status === 'DONE').every((t) => t.tenmatsu));
      const versions = await db.fileVersion.findMany({
        where: { id: { startsWith: '99300000-' } },
      });
      for (const v of versions)
        assert.equal(BigInt((await stat(join(root, v.storageKey))).size), v.byteSize);
      const outsider = await db.account.create({
        data: {
          id: id(99999),
          email: 'untouched@fixture.example',
          name: '既存の試験利用者',
          passwordHash: 'unchanged-hash',
          role: 'MEMBER',
        },
      });
      await seedInventoryProject(db, root);
      assert.deepEqual(await db.account.findUnique({ where: { id: outsider.id } }), outsider);
      // 名前空間の衝突では既存アカウントを流用・上書きしない。
      const pm = people[0];
      await db.account.update({ where: { id: pm.id }, data: { email: 'renamed@fixture.example' } });
      const failedBefore = await counts();
      await assert.rejects(seedInventoryProject(db, root), /衝突/);
      assert.deepEqual(await counts(), failedBefore);
      await db.account.update({ where: { id: pm.id }, data: { email: pm.email } });
      const bytes = await readFile(join(root, versions[0].storageKey));
      assert.ok(bytes.length > 0);
    } finally {
      await db.$disconnect();
    }
  },
);
