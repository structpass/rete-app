// Run only against the dedicated disposable API, database, and mail receiver.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

const api = 'http://127.0.0.1:35450/api/v1';
const mail = 'http://127.0.0.1:35449/api/v1';
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid');
if (
  database.protocol !== 'postgresql:' ||
  database.hostname !== '127.0.0.1' ||
  database.port !== '35447' ||
  database.pathname !== '/rete_invite_d847' ||
  database.username !== 'postgres'
) {
  throw new Error('Use the dedicated disposable invite verification database');
}
const { PrismaClient } = createRequire(import.meta.url)('@prisma/client');

function verifyContainer(name, image, ports) {
  const result = spawnSync('docker', ['inspect', name], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot inspect disposable container ${name}`);
  const container = JSON.parse(result.stdout)[0];
  assert.equal(container.State.Running, true);
  assert.equal(container.Config.Image, image);
  assert.equal(container.Config.Labels?.['codex.task'], 'd847');
  for (const [inside, outside] of Object.entries(ports)) {
    assert.deepEqual(container.NetworkSettings.Ports[inside], [
      { HostIp: '127.0.0.1', HostPort: outside },
    ]);
  }
}

function listenerPid() {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot verify API port owner');
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row[0] === 'TCP' && /:35450$/.test(row[1] || '') && row[3] === 'LISTENING')
    .map((row) => `${row[1]}:${row[4]}`)
    .join('\n');
}

async function startApi(storage) {
  if (process.platform !== 'win32') throw new Error('Port ownership verification requires Windows');
  const entry = process.env.INVITE_TEST_ENTRY;
  if (!entry || !path.resolve(entry).startsWith(path.resolve('../../tmp/invite-run-')))
    throw new Error('Run via the disposable environment runner');
  if (listenerPid()) throw new Error('Test API port is already occupied');
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '35450',
      BIND_HOST: '127.0.0.1',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '35448',
      SMTP_USER: '',
      SMTP_PASS: '',
      SMTP_SECURE: 'false',
      MAIL_FROM: 'test@invalid.example',
      FILE_STORAGE_ROOT: storage,
      NODE_PATH: path.resolve('node_modules'),
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Test API failed to start: ${stderr}`);
      const owner = listenerPid();
      if (owner) {
        if (owner !== `127.0.0.1:35450:${child.pid}`)
          throw new Error('Test API port is not exclusively owned by the loopback-bound child');
        return child;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Test API did not start');
  } catch (error) {
    child.kill();
    throw error;
  }
}

function client() {
  let cookie = '';
  return async (path, method = 'GET', body) => {
    const response = await fetch(api + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  };
}

test('invitation email can be accepted exactly once and creates the intended account and membership', async () => {
  if (
    !/^[a-f0-9]{64}$/.test(process.env.INVITE_TEST_DB_CONTAINER || '') ||
    !/^[a-f0-9]{64}$/.test(process.env.INVITE_TEST_MAIL_CONTAINER || '')
  )
    throw new Error('Run via the disposable environment runner');
  verifyContainer(process.env.INVITE_TEST_DB_CONTAINER, 'postgres:16-alpine', {
    '5432/tcp': '35447',
  });
  verifyContainer(process.env.INVITE_TEST_MAIL_CONTAINER, 'axllent/mailpit:latest', {
    '1025/tcp': '35448',
    '8025/tcp': '35449',
  });
  const storage = await mkdtemp(path.resolve('../../tmp/invite-d847-'));
  let child;
  const prisma = new PrismaClient();
  const admin = client();
  const anonymous = client();
  const email = `invite-${randomUUID()}@example.invalid`;
  const spaceId = '00000000-0000-4000-b000-000000000040';
  try {
    child = await startApi(storage);
    assert.equal(
      (
        await admin('/auth/login', 'POST', {
          email: 'admin@rete.local',
          password: 'ReteAdmin1234!',
        })
      ).status,
      200,
    );
    const issued = await admin('/invites', 'POST', { email, spaceId });
    assert.equal(issued.status, 201);
    const inviteId = issued.body.data.id;
    const pending = await prisma.invite.findUniqueOrThrow({ where: { id: inviteId } });
    assert.equal(pending.email, email);
    assert.equal(pending.status, 'PENDING');
    const listing = await (await fetch(`${mail}/search?query=${encodeURIComponent(email)}`)).json();
    assert.equal(listing.messages.length, 1, 'exactly one email for the unique recipient');
    const message = await (await fetch(`${mail}/message/${listing.messages[0].ID}`)).json();
    const link = message.Text.match(/https?:\/\/[^\s]+\/invite\/accept\?token=[^\s]+/);
    assert.ok(link, 'invitation link exists in the delivered email');
    const token = new URL(link[0]).searchParams.get('token');
    assert.ok(token);
    const input = { token, name: '招待 太郎', password: 'ReteDemo1234!' };
    assert.equal((await anonymous('/invites/accept', 'POST', input)).status, 200);
    const account = await prisma.account.findUniqueOrThrow({ where: { email } });
    assert.equal(account.name, '招待 太郎');
    assert.equal(account.role, 'MEMBER');
    assert.equal(account.isActive, true);
    const membership = await prisma.membership.findFirst({
      where: { accountId: account.id, scopeType: 'GROUP', scopeId: spaceId },
    });
    assert.ok(membership);
    assert.equal(membership.role, 'MEMBER');
    const invite = await prisma.invite.findUniqueOrThrow({ where: { id: inviteId } });
    assert.equal(invite.status, 'ACCEPTED');
    assert.ok(invite.acceptedAt);
    assert.equal((await anonymous('/invites/accept', 'POST', input)).status, 400);
    assert.equal(await prisma.account.count({ where: { email } }), 1);
    assert.equal(
      (await client()('/auth/login', 'POST', { email, password: input.password })).status,
      200,
    );
  } finally {
    try {
      await prisma.$disconnect();
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          if (!child.kill()) throw new Error('Could not stop the test API');
          await new Promise((resolve) => child.once('exit', resolve));
        }
      } finally {
        await rm(storage, { recursive: true, force: true });
      }
    }
  }
});
