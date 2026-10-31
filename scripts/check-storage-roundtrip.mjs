// Optional local integration check. Uses only uniquely named disposable containers/databases.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = `${process.pid}-${Date.now()}`;
const db = `rete-security-restore-${stamp}`;
const old = `rete-security-legacy-${stamp}`;
const app = `rete-security-mounted-${stamp}`;
mkdirSync(join(root, 'tmp'), { recursive: true });
const fixture = mkdtempSync(join(root, 'tmp/storage-roundtrip-'));
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  assert.equal(r.status, 0, `${command} ${args.slice(0, 2).join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const docker = (...args) => run('docker', args);
const psql = (database, sql) =>
  docker('exec', db, 'psql', '-U', 'test', '-d', database, '-Atqc', sql);
const nodeServer = `const fs=require('fs');const p='/app/packages/backend/storage/files/probe/version';require('http').createServer((q,s)=>{try{s.end(fs.readFileSync(p))}catch(e){s.statusCode=500;s.end(e.message)}}).listen(8080,'0.0.0.0')`;
async function serve(storage) {
  docker(
    'run',
    '-d',
    '--name',
    app,
    '--user',
    '1001:1001',
    '-p',
    '127.0.0.1::8080',
    '--mount',
    `type=bind,source=${storage},target=/app/packages/backend/storage`,
    'node:24-alpine',
    'node',
    '-e',
    nodeServer,
  );
  const port = docker('port', app, '8080/tcp').split(':').at(-1);
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}`);
      assert.equal(r.status, 200);
      assert.equal(await r.text(), 'synthetic-upload-bytes');
      return;
    } catch (e) {
      if (i === 29) throw e;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
try {
  docker(
    'run',
    '-d',
    '--name',
    db,
    '-e',
    'POSTGRES_USER=test',
    '-e',
    'POSTGRES_PASSWORD=synthetic-only',
    '-e',
    'POSTGRES_DB=probe',
    'postgres:16-alpine',
  );
  for (let i = 0; ; i++) {
    const ready = spawnSync('docker', ['exec', db, 'pg_isready', '-U', 'test', '-d', 'probe']);
    if (ready.status === 0) break;
    assert.ok(i < 40, 'disposable PostgreSQL readiness');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  psql(
    'probe',
    "CREATE TABLE file_versions (id text primary key); INSERT INTO file_versions VALUES ('probe/version')",
  );
  docker(
    'run',
    '--name',
    old,
    'node:24-alpine',
    'node',
    '-e',
    "const fs=require('fs');fs.mkdirSync('/app/packages/backend/storage/files/probe',{recursive:true});fs.writeFileSync('/app/packages/backend/storage/files/probe/version','synthetic-upload-bytes')",
  );
  docker(
    'run',
    '--rm',
    '--mount',
    'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--mount',
    `type=bind,source=${fixture},target=/work`,
    '--mount',
    `type=bind,source=${join(root, 'deploy/scripts/prepare-storage.sh')},target=/prepare.sh,readonly`,
    '-e',
    'DEPLOY_ROOT=/work',
    '-e',
    'DEPLOY_LOCK_FILE=/work/lock',
    '-e',
    `RETE_BACKEND_CONTAINER=${old}`,
    '-e',
    `RETE_DATABASE_CONTAINER=${db}`,
    'docker:cli',
    'sh',
    '-ec',
    'apk add --no-cache bash util-linux >/dev/null; bash /prepare.sh',
  );
  const storage = join(fixture, 'storage');
  assert.equal(
    readFileSync(join(storage, 'files/probe/version'), 'utf8'),
    'synthetic-upload-bytes',
  );
  await serve(storage);
  docker('rm', '-f', app);
  await serve(storage);
  docker('rm', '-f', app);
  const backup = join(fixture, 'backups', readdirSync(join(fixture, 'backups'))[0]);
  docker('exec', db, 'createdb', '-U', 'test', 'restored');
  run(
    'docker',
    ['exec', '-i', db, 'pg_restore', '-U', 'test', '-d', 'restored', '--exit-on-error'],
    { input: readFileSync(join(backup, 'database.dump')) },
  );
  assert.equal(psql('restored', 'SELECT id FROM file_versions'), 'probe/version');
  const restored = join(fixture, 'restored');
  mkdirSync(restored);
  docker(
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${backup},target=/backup,readonly`,
    '--mount',
    `type=bind,source=${restored},target=/restore`,
    'node:24-alpine',
    'sh',
    '-ec',
    'cd /backup; sha256sum -c SHA256SUMS; tar -xf storage.tar -C /restore',
  );
  await serve(join(restored, 'storage'));
  console.log(
    'PASS: legacy migration, UID 1001 download, container replacement, checksums, database restore and blob restore',
  );
  console.log(`Evidence fixture retained: ${fixture}`);
} finally {
  for (const name of [app, old, db]) spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
}
