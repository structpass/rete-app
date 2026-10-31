// Windows-only disposable end-to-end environment. Never reuse an existing container.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('This runner requires Windows');
const require = createRequire(import.meta.url);
const root = process.cwd();
const temp = await mkdtemp(path.resolve(root, '../../tmp/invite-run-'));
const ids = [];
const suffix = randomUUID();
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL:
    'postgresql://postgres:disposable@127.0.0.1:35447/rete_invite_d847?connection_limit=5&pool_timeout=20',
  FILE_STORAGE_ROOT: path.join(temp, 'seed-files'),
};
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr || result.error || result.status}`);
  return result.stdout?.trim() ?? '';
}
function node(script, args = []) {
  run(process.execPath, [script, ...args], { stdio: 'inherit' });
}
try {
  if (process.env.DOCKER_HOST) throw new Error('DOCKER_HOST overrides are not supported');
  const contexts = JSON.parse(run('docker', ['context', 'inspect']));
  if (
    contexts.length !== 1 ||
    !['npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine'].includes(
      contexts[0].Endpoints?.docker?.Host,
    )
  ) {
    throw new Error('A local Windows Docker daemon is required');
  }
  const webpackConfig = path.join(temp, 'webpack.cjs');
  await writeFile(
    webpackConfig,
    `module.exports = (options) => ({ ...options, entry: ${JSON.stringify(path.join(root, 'src/main.ts'))}, output: { ...options.output, path: ${JSON.stringify(path.join(temp, 'dist'))} } });`,
  );
  const nestConfig = path.join(temp, 'nest-cli.json');
  await writeFile(
    nestConfig,
    JSON.stringify({ sourceRoot: 'src', compilerOptions: { deleteOutDir: false, webpack: true } }),
  );
  node(require.resolve('@nestjs/cli/bin/nest.js'), [
    'build',
    '--config',
    path.relative(root, nestConfig),
    '--path',
    'tsconfig.json',
    '--webpackPath',
    path.relative(root, webpackConfig),
  ]);
  env.INVITE_TEST_ENTRY = path.join(temp, 'dist', 'main.js');
  ids.push(
    run('docker', [
      'create',
      '--name',
      `invite-db-${suffix}`,
      '--label',
      'codex.task=d847',
      '-e',
      'POSTGRES_PASSWORD=disposable',
      '-e',
      'POSTGRES_DB=rete_invite_d847',
      '-p',
      '127.0.0.1:35447:5432',
      'postgres:16-alpine',
    ]),
  );
  run('docker', ['start', ids[0]]);
  ids.push(
    run('docker', [
      'create',
      '--name',
      `invite-mail-${suffix}`,
      '--label',
      'codex.task=d847',
      '-p',
      '127.0.0.1:35448:1025',
      '-p',
      '127.0.0.1:35449:8025',
      'axllent/mailpit:latest',
    ]),
  );
  run('docker', ['start', ids[1]]);
  env.INVITE_TEST_DB_CONTAINER = ids[0];
  env.INVITE_TEST_MAIL_CONTAINER = ids[1];
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const probe = spawnSync(
      'docker',
      ['exec', ids[0], 'pg_isready', '-U', 'postgres', '-d', 'rete_invite_d847'],
      { stdio: 'ignore' },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Disposable database did not start');
  run('docker', [
    'exec',
    ids[0],
    'psql',
    '-U',
    'postgres',
    '-d',
    'rete_invite_d847',
    '-c',
    `COMMENT ON DATABASE rete_invite_d847 IS '${suffix}'`,
  ]);
  const { PrismaClient } = require('@prisma/client');
  const probe = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const rows =
      await probe.$queryRaw`SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`;
    if (rows.length !== 1 || rows[0].marker !== suffix)
      throw new Error('Host database is not the created disposable container');
  } finally {
    await probe.$disconnect();
  }
  node(require.resolve('prisma/build/index.js'), ['migrate', 'deploy']);
  node(require.resolve('ts-node/dist/bin.js'), ['prisma/seed.ts']);
  node('--test', ['test/invite-accept.integration.mjs']);
} finally {
  const failures = [];
  for (const id of ids.reverse()) {
    const result = spawnSync('docker', ['rm', '-f', '-v', id], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(id);
  }
  await rm(temp, { recursive: true, force: true });
  if (failures.length)
    throw new Error(`Failed to remove disposable containers: ${failures.join(', ')}`);
}
