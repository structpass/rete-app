import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { FavoritesRepository } from './favorites.repository';

// Run against a disposable DB initialized from prisma/schema.prisma, never the application DB.
const databaseUrl = process.env.FAVORITES_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('FavoritesRepository PostgreSQL bulk reorder', () => {
  let prisma: PrismaService;
  let repo: FavoritesRepository;
  const accountId = randomUUID();
  const otherAccountId = randomUUID();
  const queries: string[] = [];
  const oldDate = new Date('2020-01-01T00:00:00Z');

  beforeAll(async () => {
    if (new URL(databaseUrl!).pathname !== '/rete_d563_test') {
      throw new Error(
        'FAVORITES_TEST_DATABASE_URL must use the disposable rete_d563_test database',
      );
    }
    prisma = new PrismaService({
      datasources: { db: { url: databaseUrl } },
      log: [{ emit: 'event', level: 'query' }],
    });
    // PrismaService inherits the default log generic; configure the query listener on the base client.
    (prisma as PrismaClient<Prisma.PrismaClientOptions, 'query'>).$on('query', (event) =>
      queries.push(event.query),
    );
    repo = new FavoritesRepository(prisma);
    await prisma.account.createMany({
      data: [accountId, otherAccountId].map((id) => ({
        id,
        email: `${id}@example.invalid`,
        passwordHash: 'unused-test-value',
        name: 'Bulk reorder test',
      })),
    });
  });

  beforeEach(async () => {
    await prisma.userFavorite.deleteMany({
      where: { accountId: { in: [accountId, otherAccountId] } },
    });
    queries.length = 0;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.account.deleteMany({ where: { id: { in: [accountId, otherAccountId] } } });
      await prisma.$disconnect();
    }
  });

  async function seed(count: number, owner = accountId) {
    const ids = Array.from({ length: count }, () => randomUUID());
    await prisma.userFavorite.createMany({
      data: ids.map((id, index) => ({
        id,
        accountId: owner,
        kind: 'task',
        targetRef: id,
        label: `Favorite ${index}`,
        sortOrder: index,
        updatedAt: oldDate,
      })),
    });
    return ids;
  }

  it('persists all 200 positions with one UPDATE and preserves other accounts and fields', async () => {
    const ids = await seed(200);
    await seed(2, otherAccountId);
    const before = await repo.findByAccount(accountId);
    const otherBefore = await repo.findByAccount(otherAccountId);
    queries.length = 0;

    const result = await repo.reorder(accountId, [...ids].reverse());

    expect(result.ok).toBe(true);
    expect(queries.filter((query) => /UPDATE user_favorites/.test(query))).toHaveLength(1);
    const after = await repo.findByAccount(accountId);
    expect(after.map((item) => item.id)).toEqual([...ids].reverse());
    expect(after.map((item) => item.sortOrder)).toEqual(ids.map((_, index) => index));
    for (const item of after) {
      const original = before.find((row) => row.id === item.id)!;
      expect(item).toEqual({ ...original, sortOrder: item.sortOrder, updatedAt: item.updatedAt });
      expect(item.updatedAt.getTime()).toBeGreaterThan(oldDate.getTime());
    }
    expect(await repo.findByAccount(otherAccountId)).toEqual(otherBefore);
    if (result.ok) expect(result.items).toEqual(after);
  });

  it.each(['missing', 'extra', 'duplicate', 'foreign'])(
    'rejects %s IDs without any write',
    async (kind) => {
      const ids = await seed(3);
      const [foreignId] = await seed(1, otherAccountId);
      const before = await repo.findByAccount(accountId);
      const invalid = {
        missing: ids.slice(1),
        extra: [...ids, randomUUID()],
        duplicate: [ids[0], ids[0], ids[2]],
        foreign: [ids[0], ids[1], foreignId],
      }[kind]!;
      queries.length = 0;

      expect(await repo.reorder(accountId, invalid)).toEqual({ ok: false, reason: 'set-mismatch' });
      expect(queries.filter((query) => /UPDATE user_favorites/.test(query))).toHaveLength(0);
      expect(await repo.findByAccount(accountId)).toEqual(before);
    },
  );

  it('accepts an empty existing set without UPDATE', async () => {
    expect(await repo.reorder(accountId, [])).toEqual({ ok: true, items: [] });
    expect(queries.filter((query) => /UPDATE user_favorites/.test(query))).toHaveLength(0);
  });

  it('concurrent opposite requests leave one complete order, never mixed positions', async () => {
    const ids = await seed(200);
    const reversed = [...ids].reverse();
    const results = await Promise.all([
      repo.reorder(accountId, ids),
      repo.reorder(accountId, reversed),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const after = await repo.findByAccount(accountId);
    expect([ids, reversed]).toContainEqual(after.map((item) => item.id));
    expect(after.map((item) => item.sortOrder)).toEqual(ids.map((_, index) => index));
  });
});
