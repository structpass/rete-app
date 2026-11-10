// check-raw-sql-location.mjs の試験（d1110）。
//
// 見張りそのものが壊れると「何も検出しないまま緑」になり、規約が静かに効かなくなる。
// 使い捨ての写しを作り、規約どおりの置き方・違反・ADR 記録の 3 点を実際に走らせて確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-raw-sql-location.mjs');

/**
 * 検査を走らせる最小の写しを作る。src と docs/decisions だけを置く。
 * files: { 'src/...': '中身' } / adrs: { '0099-x.md': '中身' }
 */
function fixture(files, adrs = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'raw-sql-'));
  // 作りかけで例外が出ても写しを残さない。呼び出し側の finally は dir を受け取った後しか
  // 効かないため、ここで自分を掃除する手を先に登録する（実測で 10 個残った）。
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'packages/backend/src'), { recursive: true });
    mkdirSync(join(dir, 'docs/decisions'), { recursive: true });
    cpSync(SCRIPT, join(dir, 'scripts/check-raw-sql-location.mjs'));

    // 検査は「許可一覧のファイルが消えていないか」も見るため、実在する許可先を置いておく。
    // （消えた許可を残すと、許可だけが残る。この試験の対象ではないが、写しにも要る）
    mkdirSync(join(dir, 'packages/backend/src/database'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/backend/src/database/prisma.service.ts'),
      'export class PrismaService { async ping() { return this.$queryRaw`SELECT 1`; } }',
    );

    for (const [rel, body] of Object.entries(files)) {
      const p = join(dir, 'packages/backend/src', rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    for (const [name, body] of Object.entries(adrs)) {
      writeFileSync(join(dir, 'docs/decisions', name), body);
    }
    return dir;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function run(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts/check-raw-sql-location.mjs')], {
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const REPO_SERVICE = `export class TagsService { async find() { return this.prisma.tag.findMany(); } }`;
const REPO_WITH_RAW = `export class TagsRepository { async lock() { return this.prisma.$queryRaw\`SELECT 1\`; } }`;

test('Repository 内の raw SQL は通る（ADR 記録あり）', () => {
  const dir = fixture(
    { 'modules/tags/repositories/tags.repository.ts': REPO_WITH_RAW },
    {
      '0099-tags.md': 'affected: packages/backend/src/modules/tags/repositories/tags.repository.ts',
    },
  );
  try {
    const { status } = run(dir);
    assert.equal(status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Repository の外の raw SQL は赤くなる', () => {
  const dir = fixture({
    'modules/tags/tags.service.ts': `export class TagsService { async bad() { return this.prisma.$queryRaw\`SELECT 1\`; } }`,
  });
  try {
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /Repository の外で raw SQL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Repository 内でも ADR に記録が無ければ赤くなる', () => {
  // 「置き場所」だけでなく「記録」も見ていることの確認（d1105）。
  const dir = fixture({ 'modules/tags/repositories/tags.repository.ts': REPO_WITH_RAW });
  try {
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /ADR に記録がありません/);
    assert.match(out, /TagsRepository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ADR がクラス名で指していても記録済みとみなす', () => {
  // ADR 0033 はパスではなくクラス名で指している。パスだけの照合だと取りこぼす。
  const dir = fixture(
    { 'modules/tags/repositories/tags.repository.ts': REPO_WITH_RAW },
    { '0099-tags.md': 'affected: TagsRepository の行ロック' },
  );
  try {
    const { status } = run(dir);
    assert.equal(status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('raw SQL を使わない Service は通る（誤検知しない）', () => {
  const dir = fixture({ 'modules/tags/tags.service.ts': REPO_SERVICE });
  try {
    const { status } = run(dir);
    assert.equal(status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('置き場が無く 1 本も見つからない時は、静かに通さず止まる (d1128)', () => {
  // 置き場の名前が変わった・消えた時に「違反なし」で緑になると、規約が効かないまま
  // 誰も気づけない。対象 0 件は異常として扱う。
  // fixture() は許可先のファイルを必ず置くため、ここでは写しを手で組み立てる。
  const dir = mkdtempSync(join(tmpdir(), 'raw-sql-missing-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'docs/decisions'), { recursive: true });
    cpSync(SCRIPT, join(dir, 'scripts/check-raw-sql-location.mjs'));
    // packages/backend/src を作らない = 置き場が無い状態
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /1 本も見つかりません/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ALLOWED の例外先が消えていたら赤くなる（許可だけが残らない・d1139）', () => {
  // 例外の置き場（database/prisma.service.ts）が改名・移動で消えると、ALLOWED は誰も守らない
  // 名前を指したまま残る。気づかないと「許可だけが残り、新しい場所では違反として赤」になり、
  // 直す側は理由の分からない赤と向き合うことになる。姉妹の
  // check-service-repository-boundary.test.mjs は同等の分岐を試験しており、こちらだけ無かった。
  const dir = mkdtempSync(join(tmpdir(), 'raw-sql-stale-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'packages/backend/src/modules/tags'), { recursive: true });
    mkdirSync(join(dir, 'docs/decisions'), { recursive: true });
    cpSync(SCRIPT, join(dir, 'scripts/check-raw-sql-location.mjs'));
    // 許可先（prisma.service.ts）を置かない = 例外の置き場が消えた状態。
    // 対象 0 本の門には掛からないよう、raw SQL を持たない普通の Service を 1 本置く。
    writeFileSync(
      join(dir, 'packages/backend/src/modules/tags/tags.service.ts'),
      `export class TagsService { async find() { return this.prisma.tag.findMany(); } }`,
    );
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /もう存在しないファイルが残っています/);
    assert.match(out, /database\/prisma\.service\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
