import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { globMatch } from './check-e2e-type-check-scope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patchFiles = Object.values(
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).pnpm?.patchedDependencies ?? {},
);

function contextFiles(files, ignore) {
  return new Set(
    files.filter((file) => {
      let excluded = false;
      for (const raw of ignore
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'))) {
        const include = raw.startsWith('!');
        const pattern = raw.replace(/^!/, '').replace(/^\/+|\/+$/g, '');
        const parts = file.split('/');
        const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
        if (candidates.some((p) => globMatch(pattern, p))) excluded = !include;
      }
      return !excluded;
    }),
  );
}

// Track the declared package and patch inputs through COPY and stage inheritance.
// This checks the files seen by every installer, rather than prescribing a COPY line.
function verifyInstallInputs(dockerfile, patches, context) {
  const stages = new Map();
  let stage,
    sequence = 0,
    installs = 0;
  const lines = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const line of lines.map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))) {
    const [instruction, ...words] = line.split(/\s+/);
    if (instruction === 'FROM') {
      const parent = stages.get(words[0]);
      stage = { cwd: parent?.cwd ?? '/', files: new Set(parent?.files ?? []) };
      stages.set(String(sequence++), stage);
      if (words[1]?.toUpperCase() === 'AS') stages.set(words[2], stage);
    } else if (instruction === 'WORKDIR') stage.cwd = path.posix.resolve(stage.cwd, words[0]);
    else if (instruction === 'COPY') {
      const from = words.find((s) => s.startsWith('--from='))?.slice(7);
      const paths = words.filter((s) => !s.startsWith('--'));
      const destination = paths.pop();
      const files = from ? stages.get(from)?.files : context;
      assert.ok(files, `Unknown COPY source stage ${from}`);
      for (const rawSource of paths) {
        const source = path.posix.normalize(rawSource).replace(/\/$/, '');
        const target = path.posix.resolve(stage.cwd, destination);
        for (const file of files) {
          if (file === source) {
            const directory = paths.length > 1 || destination.endsWith('/') || destination === '.';
            stage.files.add(
              directory ? path.posix.join(target, path.posix.basename(file)) : target,
            );
          } else if (source === '.' || file.startsWith(source + '/')) {
            stage.files.add(
              path.posix.join(target, source === '.' ? file : file.slice(source.length + 1)),
            );
          }
        }
      }
    } else if (instruction === 'RUN' && /\bpnpm\s+install\b/.test(words.join(' '))) {
      installs++;
      const manifest = [...stage.files].find((file) => file.endsWith('/package.json'));
      assert.ok(manifest, 'Installer has no workspace package.json');
      for (const patch of patches)
        assert.ok(
          stage.files.has(path.posix.join(path.posix.dirname(manifest), patch)),
          `Installer is missing declared patch ${patch}`,
        );
    }
  }
  assert.ok(installs > 0, 'No pnpm installer was checked');
}

test('every production Docker install receives all declared dependency patches', () => {
  for (const file of patchFiles)
    assert.ok(existsSync(path.join(root, file)), `Declared patch is absent: ${file}`);
  const context = contextFiles(
    ['package.json', ...patchFiles],
    readFileSync(path.join(root, '.dockerignore'), 'utf8'),
  );
  for (const name of ['backend', 'frontend'])
    verifyInstallInputs(
      readFileSync(path.join(root, 'packages', name, 'Dockerfile'), 'utf8'),
      patchFiles,
      context,
    );
});

test('a later production stage cannot use patches copied only into a different stage', () => {
  const context = new Set(['package.json', 'patches/fix.patch']);
  const dockerfile =
    'FROM node AS deps\nWORKDIR /app\nCOPY . .\nRUN pnpm install\nFROM node AS production\nWORKDIR /app\nCOPY package.json ./\nRUN pnpm install --prod';
  assert.throws(
    () => verifyInstallInputs(dockerfile, ['patches/fix.patch'], context),
    /missing declared patch/,
  );
});

test('whole-context copies and inherited stages preserve patch inputs', () => {
  const dockerfile =
    'FROM node AS deps\nWORKDIR /app\nCOPY . .\nRUN pnpm install\nFROM deps AS production\nRUN pnpm install --prod';
  verifyInstallInputs(
    dockerfile,
    ['patches/fix.patch'],
    new Set(['package.json', 'patches/fix.patch']),
  );
});

test('a patch excluded from the Docker context cannot satisfy the install contract', () => {
  const context = contextFiles(['package.json', 'patches/fix.patch'], 'patches/');
  assert.throws(
    () =>
      verifyInstallInputs(
        'FROM node\nWORKDIR /app\nCOPY . .\nRUN pnpm install',
        ['patches/fix.patch'],
        context,
      ),
    /missing declared patch/,
  );
});

test('runtime blobs and private backups are excluded while storage implementation remains in context', () => {
  const privateFiles = [
    'backups/env.applied',
    'backups/database.dump',
    'storage/files/id/version',
    'tmp/probe',
  ];
  const implementation = 'packages/backend/src/modules/files/storage/local-fs-storage.service.ts';
  const context = contextFiles(
    [...privateFiles, implementation],
    readFileSync(path.join(root, '.dockerignore'), 'utf8'),
  );
  for (const file of privateFiles)
    assert.equal(
      context.has(file),
      false,
      `Private runtime file would enter Docker context: ${file}`,
    );
  assert.ok(context.has(implementation), 'Application storage code must remain in the build');
});
