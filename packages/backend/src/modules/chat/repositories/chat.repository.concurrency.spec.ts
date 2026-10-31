import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../database/prisma.service';
import { ChatRepository } from './chat.repository';

// Opt-in real PostgreSQL regression: RETE_CHAT_CONCURRENCY_TEST=1 pnpm exec jest
// --runInBand chat.repository.concurrency.spec.ts (from packages/backend).
// Always creates its own disposable DB; never reads DATABASE_URL or uses a business DB.
const describePostgres = process.env.RETE_CHAT_CONCURRENCY_TEST === '1' ? describe : describe.skip;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

describePostgres('ChatRepository concurrent posts (PostgreSQL)', () => {
  const container = `rete-chat-concurrency-${randomUUID()}`;
  let started = false;
  let prisma: PrismaClient | undefined;
  let authorId: string;

  function docker(...args: string[]) {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
  }

  beforeAll(async () => {
    docker(
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=rete_chat_concurrency',
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    );
    started = true;
    const deadline = Date.now() + 25_000;
    for (;;) {
      try {
        docker('exec', container, 'pg_isready', '-U', 'postgres');
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((done) => setTimeout(done, 200));
      }
    }
    docker(
      'exec',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'rete_chat_concurrency',
      '-c',
      'CREATE EXTENSION pg_trgm; CREATE EXTENSION citext',
    );
    const port = docker('port', container, '5432/tcp').split(':').at(-1);
    const url = `postgresql://postgres@127.0.0.1:${port}/rete_chat_concurrency`;
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'db',
        'push',
        '--skip-generate',
        '--schema',
        resolve(__dirname, '../../../../prisma/schema.prisma'),
      ],
      { env: { ...process.env, DATABASE_URL: url }, timeout: 30_000, stdio: 'pipe' },
    );
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const author = await prisma.account.create({
      data: { email: 'concurrency@example.invalid', name: 'Test', passwordHash: 'unused' },
    });
    authorId = author.id;
  }, 90_000);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      if (started) docker('rm', '--force', container);
    }
  });

  it.each([false, true])(
    'persists both posts and keeps the newest timestamp (delay older update: %s)',
    async (delayOlder) => {
      const db = prisma!;
      const theme = await db.chatTheme.create({
        data: { title: 'Concurrent posts', authorId, lastMessageAt: new Date('2020-01-01') },
      });
      const bothInserted = gate();
      const olderMayUpdate = gate();
      const olderInserted = gate();
      let inserted = 0;
      // All queries go through real Prisma/PostgreSQL. Only pause after the actual INSERT,
      // while each transaction holds its FK KEY SHARE, to force the failing interleaving.
      const repository = new ChatRepository({
        $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          db.$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '8s'");
              const messages = new Proxy(tx.chatMessage, {
                get(target, property) {
                  if (property !== 'create') return Reflect.get(target, property);
                  return async (args: Prisma.ChatMessageCreateArgs) => {
                    const older = args.data.body === 'older';
                    const message = await target.create(args);
                    inserted++;
                    if (older) olderInserted.release();
                    if (inserted === 2) bothInserted.release();
                    // Bound the barrier as well, so a moved-before-INSERT lock fails clearly.
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                      await Promise.race([
                        bothInserted.promise,
                        new Promise((_, reject) => {
                          timer = setTimeout(
                            () => reject(new Error('INSERT barrier timed out')),
                            5000,
                          );
                        }),
                      ]);
                    } finally {
                      clearTimeout(timer);
                    }
                    if (older && delayOlder) await olderMayUpdate.promise;
                    return message;
                  };
                },
              });
              return work(
                new Proxy(tx, {
                  get(target, property) {
                    return property === 'chatMessage' ? messages : Reflect.get(target, property);
                  },
                }),
              );
            },
            { timeout: 15_000 },
          ),
      } as unknown as PrismaService);

      const older = repository.createMessage(theme.id, authorId, {
        body: 'older',
        mentionAccountIds: [authorId],
      });
      // Start the second transaction after the first INSERT (DB now() is transaction time).
      await olderInserted.promise;
      // Keep timestamps distinct even after Prisma converts PostgreSQL microseconds to JS ms.
      await db.$queryRaw`SELECT pg_sleep(0.02)::text`;
      const newer = repository
        .createMessage(theme.id, authorId, { body: 'newer', mentionAccountIds: [authorId] })
        .finally(() => olderMayUpdate.release());
      const results = await Promise.allSettled([older, newer]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const messages = await db.chatMessage.findMany({
        where: { themeId: theme.id },
        include: { mentions: true },
      });
      expect(messages).toHaveLength(2);
      expect(messages.map((message) => message.body).sort()).toEqual(['newer', 'older']);
      expect(
        messages.find((message) => message.body === 'newer')!.createdAt.getTime(),
      ).toBeGreaterThan(messages.find((message) => message.body === 'older')!.createdAt.getTime());
      expect(messages.every((message) => message.mentions[0]?.accountId === authorId)).toBe(true);
      const updated = await db.chatTheme.findUniqueOrThrow({ where: { id: theme.id } });
      expect(updated.lastMessageAt.getTime()).toBe(
        Math.max(...messages.map((message) => message.createdAt.getTime())),
      );
    },
    30_000,
  );
});
