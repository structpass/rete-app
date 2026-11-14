/**
 * d1276: Dockerfile の pnpm install が、TTY の無い Docker build で「node_modules を作り直す確認」に
 * 止まらないことを固定する。
 *
 * 実測: pnpm 10 は依存の顔ぶれが変わる install（dev→prod の pruning）で node_modules を作り直す前に
 * 確認する。TTY が無いと確認できず ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY で落ち、配布が止まる。
 * よって **pruning を伴う install（--prod / --production）** には CI=true か
 * --config.confirm-modules-purge=false を要求する。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `pnpm install` を含む RUN 命令を取り出す（行継続は 1 命令へ畳む）。
export function installCommands(dockerfile) {
  return dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => /^RUN\b/.test(line) && /\bpnpm\s+install\b/.test(line));
}

/** dev 依存を落とす install（= node_modules を作り直す）か。 */
export function prunesModules(command) {
  return /(^|\s)--prod(uction)?(\s|$)/.test(command);
}

export function hasNonInteractiveGuard(command) {
  // Inline assignments affect only that command, not a later command after &&.
  const pruningCommands = command
    .replace(/^RUN\s+/, '')
    .split(/\s*(?:&&|\|\||;)\s*/)
    .filter((part) => /\bpnpm\s+install\b/.test(part) && prunesModules(part));
  return (
    pruningCommands.length > 0 &&
    pruningCommands.every(
      (part) =>
        /^(?:env\s+)?CI=(?:true|"true"|'true')\s+pnpm\s+install\b/.test(part) ||
        (/^pnpm\s+install\b/.test(part) &&
          /(?:^|\s)--config\.confirm-modules-purge=false(?:\s|$)/.test(part)),
    )
  );
}

test('pruning する pnpm install は TTY 無しでも止まらない設定になっている', () => {
  let checked = 0;
  for (const name of ['backend', 'frontend']) {
    const dockerfile = readFileSync(path.join(root, 'packages', name, 'Dockerfile'), 'utf8');
    for (const command of installCommands(dockerfile)) {
      if (!prunesModules(command)) continue;
      checked++;
      assert.ok(
        hasNonInteractiveGuard(command),
        `${name} の Dockerfile に TTY 無しで止まる pruning install が残っている: ${command.slice(0, 160)}`,
      );
    }
  }
  assert.ok(checked > 0, 'pruning する install が 1 つも見つからない（検査が空回りしている）');
});

test('判定は実物の書き方（CI 無し）を落とし、ガード付きを通す', () => {
  // 実際に落ちた形（EC2 実測のログと同じ並び）。
  const broken = [
    'RUN pnpm install --frozen-lockfile && pnpm --filter @rete/backend prisma:generate && pnpm install --frozen-lockfile --prod',
  ];
  assert.equal(installCommands(broken.join('\n')).length, 1);
  assert.ok(prunesModules(installCommands(broken.join('\n'))[0]));
  assert.equal(hasNonInteractiveGuard(installCommands(broken.join('\n'))[0]), false);

  const fixed = installCommands('RUN CI=true pnpm install --frozen-lockfile --prod');
  assert.equal(fixed.length, 1);
  assert.ok(hasNonInteractiveGuard(fixed[0]));

  // 行継続でも 1 命令として読めること。
  const continued = installCommands('RUN CI=true pnpm install \\\n  --frozen-lockfile --prod');
  assert.equal(continued.length, 1);
  assert.ok(prunesModules(continued[0]));
  assert.ok(hasNonInteractiveGuard(continued[0]));
});

test('a preceding inline assignment cannot guard a later pruning command', () => {
  assert.equal(hasNonInteractiveGuard('RUN CI=true pnpm install && pnpm install --prod'), false);
  assert.equal(hasNonInteractiveGuard('RUN pnpm install && CI=true pnpm install --prod'), true);
  assert.equal(
    hasNonInteractiveGuard('RUN CI=true pnpm install --prod && pnpm install --production'),
    false,
  );
});

test('only an enabled noninteractive setting on the pruning command is accepted', () => {
  for (const value of ['true', '"true"', "'true'"])
    assert.ok(hasNonInteractiveGuard(`RUN CI=${value} pnpm install --prod`));
  assert.ok(hasNonInteractiveGuard('RUN pnpm install --prod --config.confirm-modules-purge=false'));
  for (const command of [
    'RUN CI=false pnpm install --prod',
    'RUN pnpm install --prod --config.confirm-modules-purge=true',
    'RUN echo confirm-modules-purge=false && pnpm install --prod',
    'RUN CI=true pnpm install --prod; pnpm install --prod',
  ])
    assert.equal(hasNonInteractiveGuard(command), false, command);
});
