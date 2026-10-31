// cmn-0337: 検査ランナー（run-script-tests.mjs）の REQUIRED_TESTS 名簿を実体と突き合わせる。
//
// なぜ必要か: REQUIRED_TESTS は「既知の検査が改名・削除で静かに減る」ことを検出する名簿。
// 名前を間違えて書くと、本来の検査が実在するのに「存在しない」と誤検出して常時赤になる。
// ここで「名簿の各名が実在ファイルを指すこと」と「名簿が実際の検査群と食い違っていないこと」を
// 固定する（名簿の追加漏れはここでは検出しない＝新規検査は自動探索で走る設計のため）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REQUIRED_TESTS,
  EXCLUDED,
  allTestFiles,
  snapshotExcludes,
  readTapSummary,
  countTestsIn,
  expectRunnerExit,
} from './run-script-tests.mjs';

// ── d908: 走らなかった検査を緑にしない門 ──────────────────────────
// 出口の数だけを見ていた時は、検査が import の途中で止まり「走った 1 件」だけが記録された回も
// 0（緑）で通った。書いた検査の本数と走った検査の本数を突き合わせて、その穴を閉じてある。

/** 検査の中身を一時ファイルへ書いて、そのパスを返す下ごしらえ。 */
function tempTestFile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'd908-test-'));
  const path = join(dir, 'sample.test.mjs');
  writeFileSync(path, body, 'utf8');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('d908: tap の集計を読む（読めない形なら null＝出口の数に従う）', () => {
  assert.deepEqual(readTapSummary('# tests 3\n# pass 2\n# fail 1\n'), { pass: 2, fail: 1 });
  assert.deepEqual(readTapSummary('# pass 1\r\n# fail 0\r\n'), { pass: 1, fail: 0 });
  assert.equal(readTapSummary(''), null, '空の記録は形が読めない');
  assert.equal(readTapSummary('いくらかの出力\n'), null, '集計が無い記録は形が読めない');
});

test('d908: 書いた検査の本数を宣言の形から数える（コメント・文字列・正規表現に惑わされない）', () => {
  const { path, cleanup } = tempTestFile(
    [
      "import test, { describe, it } from 'node:test';",
      '// test("コメントは数えない", () => {});',
      'const label = \'test("文字列も数えない", () => {})\';',
      "test('一つめ', () => { const re = /test\\(/; assert.ok(re); });",
      "it('二つめ', () => {});",
      "describe('まとめ', () => { it('中の三つめ', () => {}); });",
    ].join('\n'),
  );
  try {
    assert.equal(countTestsIn(path), 3);
  } finally {
    cleanup();
  }
});

test('d908: 検査が走り切っていない回は、出口が 0 でも緑にしない', () => {
  const { path, cleanup } = tempTestFile(
    [
      "import test from 'node:test';",
      "test('一つめ', () => {});",
      "test('二つめ', () => {});",
    ].join('\n'),
  );
  const ran = (pass) => [{ file: path, status: 0, tap: `# pass ${pass}\n# fail 0\n` }];
  try {
    // 正しい回: 2 件とも走った
    assert.equal(expectRunnerExit(ran(2)), 0);
    // import の途中で止まり、1 件しか走っていないのに node --test が 0 で返した回
    assert.equal(expectRunnerExit(ran(1)), 1);
    // 失敗が記録されていれば赤
    assert.equal(expectRunnerExit([{ file: path, status: 1, tap: '# pass 1\n# fail 1\n' }]), 1);
    // 記録の形が読めない時は、今までどおり出口の数に従う（実在する検査を一括で赤にしない）
    assert.equal(expectRunnerExit([{ file: path, status: 0, tap: '' }]), 0);
    // 走り切らずに落ちた（出口が 0/1 以外＝時間切れなど）も赤
    assert.equal(expectRunnerExit([{ file: path, status: 2, tap: '' }]), 1);
  } finally {
    cleanup();
  }
});

// d908 の独立の目の指摘: 突き合わせを全体で 1 回行うと、あるファイルの余分な数えが別のファイルの
// 穴を埋める（実測: 全体 298 対 走った 306 で、6 本が丸ごと落ちても緑だった）。ファイルごとに見る。
test('d908: 走らなかったファイルは、ほかのファイルの余分で埋まらない', () => {
  const a = tempTestFile(["test('a1', () => {});", "test('a2', () => {});"].join('\n'));
  const b = tempTestFile(["test('b1', () => {});", "test('b2', () => {});"].join('\n'));
  const c = tempTestFile("test('c1', () => {});");
  try {
    // 全体の合計（5 件）は書いた本数（5 件）に届くが、b は 1 件しか走っていない（2 件書いてある）。
    // 合計だけを見ていたら緑になる並び。ファイルごとに見るので赤。
    assert.equal(
      expectRunnerExit([
        { file: a.path, status: 0, tap: '# pass 3\n# fail 0\n' },
        { file: b.path, status: 0, tap: '# pass 1\n# fail 0\n' },
        { file: c.path, status: 0, tap: '# pass 1\n# fail 0\n' },
      ]),
      1,
    );
    // b が 0 件で終わった（node --test が「0 件」を返した）→ 赤
    assert.equal(
      expectRunnerExit([
        { file: a.path, status: 0, tap: '# pass 2\n# fail 0\n' },
        { file: b.path, status: 0, tap: '# pass 0\n# fail 0\n' },
        { file: c.path, status: 0, tap: '# pass 1\n# fail 0\n' },
      ]),
      1,
    );
  } finally {
    a.cleanup();
    b.cleanup();
    c.cleanup();
  }
});

// d908: 「書いた本数」を 0 と数えてしまう形（独立の目の指摘）では、突き合わせ（走った < 書いた）が
// 0 < 0 で通る。書いた本数が分かるのに 1 件も走っていない回は、片側から赤にする。
test('d908: 1 件も走っていない回は、書いた本数の数え方によらず緑にしない', () => {
  const { path, cleanup } = tempTestFile(
    ["test('一つめ', () => {});", "test('二つめ', () => {});"].join('\n'),
  );
  try {
    assert.equal(expectRunnerExit([{ file: path, status: 0, tap: '# pass 0\n# fail 0\n' }]), 1);
  } finally {
    cleanup();
  }
});

test('REQUIRED_TESTS の各名が scripts/ に実在する（cmn-0337）', () => {
  for (const name of REQUIRED_TESTS) {
    if (snapshotExcludes(name)) continue; // 公開スナップショット文脈（scripts/publish/ 不在）では不在を許容
    assert.ok(
      allTestFiles.includes(name),
      `REQUIRED_TESTS の ${name} が scripts/ に存在しません（改名・移動なら REQUIRED_TESTS も直してください）`,
    );
  }
});

test('REQUIRED_TESTS と EXCLUDED に重複が無い（cmn-0337）', () => {
  for (const name of REQUIRED_TESTS) {
    assert.ok(
      !EXCLUDED.has(name),
      `${name} が REQUIRED_TESTS と EXCLUDED の両方に載っています（片方にしてください）`,
    );
  }
});

// d717: 枝を main へ取り込むと、git の自動結合は名簿を同じ名の二重掲載にすることがある
// （実測: security-audit.test.mjs が先頭と末尾に並んだ）。存在チェックは二重掲載を通すため、
// 取り込みを実行する側が直すまで黙って緑にならないよう、名簿自身の重複をここで止める。
test('REQUIRED_TESTS に同じ検査名が二重に載っていない（d717）', () => {
  const duplicates = REQUIRED_TESTS.filter((name, index) => REQUIRED_TESTS.indexOf(name) !== index);
  assert.deepEqual(
    duplicates,
    [],
    `${[...new Set(duplicates)].join(', ')} が REQUIRED_TESTS に二重に載っています（取り込みの自動結合で並んだなら1つにしてください）`,
  );
});
