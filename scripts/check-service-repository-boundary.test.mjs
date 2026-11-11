// check-service-repository-boundary.mjs の試験（d1111）。
//
// 見張りそのものが壊れると「何も検出しないまま緑」になり、依存方向の規約が静かに効かなくなる。
// 使い捨ての写しを作り、規約どおりの Service・違反・例外の扱いを実際に走らせて確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-service-repository-boundary.mjs');

/** 検査を走らせる最小の写しを作る。 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'svc-boundary-'));
  // 作りかけで例外が出ても写しを残さない（呼び出し側の finally は dir を受け取った後しか効かない）。
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'packages/backend/src/modules'), { recursive: true });
    cpSync(SCRIPT, join(dir, 'scripts/check-service-repository-boundary.mjs'));
    // d1216: 検査は「例外の理由が実在する ADR に書かれているか」まで見る。社内リポジトリの
    // 文脈（scripts/publish が存在する）と、例外の ADR を写しにも置かないと全試験が赤くなる。
    mkdirSync(join(dir, 'scripts/publish'), { recursive: true });
    mkdirSync(join(dir, 'docs/decisions'), { recursive: true });
    writeFileSync(
      join(dir, 'docs/decisions/0073-oidc-sso-decisions-consolidated.md'),
      '# ADR 0073\n\n| [OidcPurgeService](../../packages/backend/src/modules/auth/oidc/oidc-purge.service.ts) | 例外の理由 |\n',
    );

    // 検査は「例外の許可先が実体とずれていないか」も見る。許可一覧に入っている実在の
    // 例外（oidc-purge）を写しにも置いておかないと、すべての試験がその欠落で赤くなる。
    const allowed = join(dir, 'packages/backend/src/modules/auth/oidc');
    mkdirSync(allowed, { recursive: true });
    writeFileSync(
      join(allowed, 'oidc-purge.service.ts'),
      'export class OidcPurgeService { async purge() { return this.prisma.oidcPayload.deleteMany(); } }',
    );

    for (const [rel, body] of Object.entries(files)) {
      const p = join(dir, 'packages/backend/src/modules', rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    return dir;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function run(dir) {
  const r = spawnSync(
    process.execPath,
    [join(dir, 'scripts/check-service-repository-boundary.mjs')],
    {
      encoding: 'utf8',
    },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('Repository 経由なら通る（Service が Prisma を直に使わない）', () => {
  const dir = fixture({
    'tags/tags.service.ts': `export class TagsService {
      constructor(private readonly repo: TagsRepository) {}
      async find() { return this.repo.findAll(); }
    }`,
  });
  try {
    assert.equal(run(dir).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Service が Prisma を直接使うと赤くなる', () => {
  const dir = fixture({
    'tags/tags.service.ts': `export class TagsService {
      async bad() { return this.prisma.tag.findMany(); }
    }`,
  });
  try {
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /Prisma Client を直接使っています/);
    assert.match(out, /tags\.service\.ts:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('試験のファイル（.spec.ts）は対象外', () => {
  // spec は試験の下ごしらえとして Prisma を触ることがある。本番経路ではない。
  const dir = fixture({
    'tags/tags.service.spec.ts': `describe('x', () => { it('y', async () => { await this.prisma.tag.findMany(); }); });`,
  });
  try {
    assert.equal(run(dir).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('例外の許可先が実体とずれると赤くなる', () => {
  // 許可だけが残ると、存在しない例外を守り続けることになる。検査はそれを咎める。
  // 写しから許可先のファイルを消して、欠落として出ることを見る。
  const dir = fixture({ 'tags/tags.service.ts': 'export class TagsService {}' });
  try {
    rmSync(join(dir, 'packages/backend/src/modules/auth/oidc/oidc-purge.service.ts'), {
      force: true,
    });
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /もう存在しない Service が残っています/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Service が 1 本も無い置き場では、静かに通さず止まる (d1128)', () => {
  // fixture() は許可先のファイルを必ず置くため、ここでは写しを手で組み立てる。
  const dir = mkdtempSync(join(tmpdir(), 'svc-empty-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(SCRIPT, join(dir, 'scripts/check-service-repository-boundary.mjs'));
    // packages/backend/src/modules を作らない = 置き場が無い状態
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /1 本も見つかりません/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// d1216: 「例外は ADR に理由を書いたものだけ」を宣言で終わらせず、ADR の実在と実体への言及まで見る。
test('例外の ADR が見つからないと赤くなる（d1216）', () => {
  const dir = fixture({ 'tags/tags.service.ts': 'export class TagsService {}' });
  try {
    rmSync(join(dir, 'docs/decisions/0073-oidc-sso-decisions-consolidated.md'), { force: true });
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /ADR 0073 が見つからない/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('例外の実体が ADR に書かれていないと赤くなる（d1216）', () => {
  const dir = fixture({ 'tags/tags.service.ts': 'export class TagsService {}' });
  try {
    writeFileSync(
      join(dir, 'docs/decisions/0073-oidc-sso-decisions-consolidated.md'),
      '# ADR 0073\n\n例外の理由はここに書くが、対象の実体には触れない。\n',
    );
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /ADR 0073 に実体の記載が無い/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('例外の理由に ADR 番号が無いと赤くなる（d1216）', () => {
  const dir = fixture({ 'tags/tags.service.ts': 'export class TagsService {}' });
  try {
    const scriptPath = join(dir, 'scripts/check-service-repository-boundary.mjs');
    const source = readFileSync(scriptPath, 'utf8');
    assert.ok(source.includes("'ADR 0073 §4'"), 'fixture の前提（許可の理由）が変わっている');
    writeFileSync(scriptPath, source.replace("'ADR 0073 §4'", "'ADR に記録済み'"));
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /理由に ADR 番号が無い/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('公開スナップショット（scripts/publish が無い）では ADR 照合をしない（d1216）', () => {
  const dir = fixture({ 'tags/tags.service.ts': 'export class TagsService {}' });
  try {
    rmSync(join(dir, 'scripts/publish'), { recursive: true, force: true });
    rmSync(join(dir, 'docs/decisions'), { recursive: true, force: true });
    const { status, out } = run(dir);
    assert.equal(status, 0, out);
    assert.match(out, /ADR 照合は公開スナップショットのため対象外/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
