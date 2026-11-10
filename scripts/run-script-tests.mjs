#!/usr/bin/env node
// cmn-0250: scripts/ 配下のリポ不変条件テスト（*.test.mjs）をまとめて走らせる。
//
// なぜ薄いランナーを挟むのか（`node --test scripts/` で済まさない理由）:
//   - Node 20 は --test の引数にディレクトリを渡すとテストファイルを自動探索するが、Node 22 以降は
//     引数を glob として扱うためディレクトリ指定が「モジュールが見つからない」で落ちる（手元 v24 で実測）。
//   - `node --test scripts/*.test.mjs` は展開をシェルに委ねるため、Windows の cmd 経由（開発統括のローカル）で
//     展開されず落ちる。
//   - 実行するテストファイルを package.json へ列挙すると、新しい検査を足した時に走らせ忘れる。
// よって「探索は Node 標準の fs で自前に行い、実行は --test へファイルを明示で渡す」形にする。
// 依存インストール前に動くこと（Node 標準モジュールのみ）を既存の制約ドリフト検査から引き継ぐ。
//
// d908: 走らなかった検査が緑にならないよう、各ファイルを tap（機械が読める記録）で走らせ、
// 「走り切ったか」をファイルごとに確かめてから、画面の形（spec）を 1 回だけ出す
// （readTapSummary / countTestsIn / expectRunnerExit）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

// 自動探索から外す検査（cmn-0261 M2）。列挙するのは「入れると偽の赤が出るもの」だけで、
// 探索そのものは従来どおり fs 任せ＝新しい検査を足した時に走らせ忘れる穴は塞いだまま。
// 外したものは下でファイル名と理由をログへ出す（黙って減らさない）。
const EXCLUDED = new Map([
  [
    'check-knip-baseline.test.mjs',
    'knip の検出は生成物（shared の dist / Prisma Client / next typegen のルート型）に依存し、' +
      'install だけのフレッシュクローンでは未解決の import が未使用 export として数え上がる' +
      '（実測: exports 59→93 / types 149→243）。CI は生成の後段に専用ステップを持つのでそちらで走る。' +
      '手元で回す時は生成物を作ってから pnpm run check:knip-snapshot。',
  ],
  [
    'check-sprintf-precision-boundary.test.mjs',
    'node_modules に入った sprintf-js の実体を監査する検査で、実体が無い時に緑へ丸めない設計' +
      '（未検査は赤）。install 前には判定できないため CI は install 後の専用ステップ' +
      '（pnpm run check:audit-boundary）で走らせ、手元・agent 経路では通常の pnpm test に含める。',
  ],
]);

export { EXCLUDED };

const allTestFiles = readdirSync(SCRIPTS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => entry.name)
  .sort();

export { allTestFiles };

// 消えたら困る既知の検査（cmn-0337）。「新規検査の実行漏れ」を防ぐのではなく「既知の検査が
// 改名・削除で静かに減る」ことを検出するための名簿。実行そのものは自動探索で走るため追記漏れが
// 実行漏れを生むことはないが、名簿へ入れなかった検査は改名・削除を検出できない＝検査を新設したら
// 本名簿へ追記する（v2-238 で追記漏れ2本を実測して補った）。値は scripts/*.test.mjs を実測して
// 確定した（2026-08-09 に 9 本・v2-238 で check-e2e-step-arg-resolution と run-tests-agent を追加）。
// なお run-script-tests.test.mjs 自身は自己参照（この名簿を検証する検査）を避けるため名簿に含めない。
// 未統合の枝でしか実在しない検査名を名簿に置くと、全体の検査が実行前に止まるので置かない
// （d716）。枝を取り込む時は、その枝に無い検査名を外し、枝が足す検査名を戻して名簿を1本にそろえる。
// ただし git の自動結合はこれを揃えない（実測: 枝が名簿の先頭へ足した名と main 側の同じ名が並び、
// security-audit.test.mjs が二重に載る。存在チェックは通るため、二重掲載は
// run-script-tests.test.mjs の「同じ検査名が二重に載っていない」で止める／d717）。
const REQUIRED_TESTS = [
  'check-adr-index.test.mjs',
  'check-ci-workflow.test.mjs',
  'check-constraint-drift.test.mjs',
  'check-duplication.test.mjs',
  'check-css-tokens.test.mjs',
  'check-e2e-step-arg-resolution.test.mjs',
  'check-e2e-type-check-scope.test.mjs',
  'check-ignored-builds.test.mjs',
  'check-inventory-demo.test.mjs',
  'check-prisma-client-engine.test.mjs',
  'check-publish-export.test.mjs',
  // d1139: 新しい検査 2 本（d1101 の raw SQL 置き場所・d1085 の Service/Repository 境界）が
  // 名簿から漏れていた。実行は自動探索で走るため「実行漏れ」にはならないが、改名・削除で
  // 検査が静かに消えることを検出できない＝新設したら名簿へ追記する（この節の冒頭の約束）。
  'check-raw-sql-location.test.mjs',
  'check-service-repository-boundary.test.mjs',
  'check-time-axis-invariants.test.mjs',
  'check-workspace-scripts.test.mjs',
  // d954: 公開物には deploy/scripts を含めないため、公開文脈では不在を許容する（SNAPSHOT_EXCLUDED_TESTS）。
  // 社内文脈では実在を要求し、改名・削除を検出する。
  'production-storage.test.mjs',
  // d904: pretest の生成判定（scripts/prisma-generate-unless-current.mjs）を固定する検査。
  // 時刻の比較へ戻す変異でも赤になるので、名簿に入れて改名・削除を検出できるようにする。
  'prisma-generate-unless-current.test.mjs',
  'run-tests-agent.test.mjs',
  'security-audit.test.mjs',
];

export { REQUIRED_TESTS };

// 公開スナップショット文脈では実在が期待されない検査（targets/*.json の excludeFiles と突合）。
// scripts/publish/ が存在しない = 公開スナップショット文脈とみなし、不在を許容する
// （黙って減る検出はローカル・社内 CI では従来どおり効く）。config 側の除外と二重管理になるが、
// このランナーは config 非依存（install 前に動く・Node 標準のみ）のため、存在チェックで文脈を判定する。
//
// 名簿の意味は「公開物に含めない検査」。値はその理由（不在を許容する時に対で出す）。
//   - check-publish-export: scripts/publish/（公開生成ツール）ごと除外
//   - check-adr-index: docs/decisions/（社内の決定記録）を公開物に含めない
//   - production-storage: deploy/scripts/（本番配備スクリプト）を公開物に含めない
// check-sprintf-precision-boundary は install 後に走らせる検査なので、ここではなく EXCLUDED 側に置く
// （公開物にも含める。公開 CI は install 後に明示ステップで走らせる）。
const PUBLISH_DIR = join(SCRIPTS_DIR, 'publish');
const SNAPSHOT_EXCLUDED_TESTS = new Map([
  ['check-adr-index.test.mjs', 'docs/decisions/（社内の決定記録）を公開物に含めない'],
  ['check-publish-export.test.mjs', 'scripts/publish/（公開生成ツール）ごと除外'],
  ['production-storage.test.mjs', 'deploy/scripts/（本番配備スクリプト）を公開物に含めない'],
]);
export const snapshotExcludes = (name) =>
  SNAPSHOT_EXCLUDED_TESTS.has(name) && !existsSync(PUBLISH_DIR);

function main() {
  // 除外エントリが実在ファイルを指していない = リネーム／移動で除外が死んでいる。黙って自動探索へ
  // 戻ると、手元の post-install 実行でだけ偽の赤が出る形になるので落とす（このファイルの fail-closed と同型）。
  for (const name of EXCLUDED.keys()) {
    if (!allTestFiles.includes(name)) {
      console.error(
        `[run-script-tests] 除外リストの ${name} が scripts/ に存在しません（改名・移動なら EXCLUDED も直してください）`,
      );
      process.exit(1);
    }
  }

  // 既知の検査が改名・削除で静かに減るのを検出する（0 本になる fail-closed だけでは
  // 「1 本減って緑」がすり抜ける）。REQUIRED_TESTS の各名が実在しなければ落とす。
  // 公開スナップショット文脈（scripts/publish/ 不在）では、publish 系検査の不在は許容する
  // （snapshotExcludes・targets/*.json の excludeFiles と突合）。
  for (const name of REQUIRED_TESTS) {
    if (!allTestFiles.includes(name)) {
      if (snapshotExcludes(name)) {
        console.log(
          `[run-script-tests] 公開スナップショット文脈のため ${name} の不在を許容（${SNAPSHOT_EXCLUDED_TESTS.get(name)}）`,
        );
        continue;
      }
      console.error(
        `[run-script-tests] 必須検査の ${name} が scripts/ に存在しません（改名・移動なら REQUIRED_TESTS も直してください）`,
      );
      process.exit(1);
    }
  }

  const testFiles = allTestFiles
    .filter((name) => !EXCLUDED.has(name))
    .map((name) => join(SCRIPTS_DIR, name));

  for (const name of allTestFiles.filter((n) => EXCLUDED.has(n))) {
    console.log(`[run-script-tests] 除外: ${name} — ${EXCLUDED.get(name)}`);
  }

  // 1 本も見つからない = 探索が壊れている。黙って緑にせず落とす（fail-closed）。
  if (testFiles.length === 0) {
    console.error(
      '[run-script-tests] scripts/ 配下に *.test.mjs が 1 本も見つかりません（探索が壊れています）',
    );
    process.exit(1);
  }

  // どの検査を走らせたかを CI ログへ残す。ファイルの改名・削除で検査が静かに減る（0 本にならない限り
  // 上の fail-closed に掛からない）ことへの唯一の気付き口なので、件数だけでなくファイル名まで出す。
  console.log(
    `[run-script-tests] 対象 ${testFiles.length} 本: ${testFiles.map((file) => basename(file)).join(', ')}`,
  );

  // 1 本ずつ、記録（tap）を取りながら走らせ、最後に画面の形（spec）を今までどおり 1 回だけ流す。
  // 出口の数・記録の集計・「書いた検査の本数と走った件数」の三つを、**ファイルごとに**突き合わせる。
  // （全体で 1 回まとめて突き合わせると、どこかのファイルが余分に数えた分が、別のファイルが
  // 丸ごと走らなかった分を埋めてしまい、その穴を見逃す。実測: 全体の本数 298 対 走った 306 で、
  // 6 本が丸ごと落ちても緑だった（d908 の独立の目）。）
  // 記録は標準出力から読む（一時ファイルを作らない・後始末も要らない）。
  const outcomes = [];
  for (const file of testFiles) {
    // どの検査で止まったかを CI のログから辿れるようにする（全部終わるまで何も出さないと、
    // 1 本のハングが「20 分後に canceled」になり、原因のファイルが分からない）。
    console.log(`[run-script-tests] 実行: ${basename(file)}`);
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      // 1 本が返らない時にジョブごと時間切れで消えないよう、ファイル単位で打ち切る。
      // 打ち切られた回は出口が 0/1 でないため、既存の「走り切っていない」判定で赤になる。
      timeout: 180_000,
    });
    outcomes.push({
      file,
      status: result.status,
      error: result.error,
      tap: String(result.stdout ?? ''),
    });
  }

  // 0 を返せるのは、全ファイルが走り切った時だけ（expectRunnerExit を通った時）
  const code = expectRunnerExit(outcomes);
  showResults(outcomes);
  process.exit(code);
}

/**
 * 走らせた結果（ファイルごとの出口と tap の記録）から、ランナーの終了コードを決める。
 * 返すのは 0（緑）か 1（赤）だけで、走っていないのに 0 を返す道をここ 1 か所で閉じる。
 */
export function expectRunnerExit(outcomes) {
  const problems = [];
  for (const { file, status, error, tap } of outcomes) {
    const name = basename(file);
    if (error) {
      problems.push(`${name}（起動できていない: ${error.message}）`);
      continue;
    }
    const exit = Number(status);
    // ファイルごとの出口: 赤があれば 1、走り切れば 0、import の途中で止まると 1。
    // それ以外（時間切れで殺された場合など）は「走り切っていない」として扱う。
    if (exit !== 0 && exit !== 1) {
      problems.push(`${name}（走り切っていない: 当人が 0 でも 1 でもなく終えた: ${exit}）`);
      continue;
    }
    const summary = readTapSummary(tap);
    if (summary == null) {
      // 記録の形が読めない（Node の版で tap の形が変わった）→ 出口の数だけに従う（今までどおり）。
      if (exit !== 0) problems.push(`${name}（失敗: 出口 ${exit}）`);
      continue;
    }
    if (summary.fail > 0) {
      problems.push(`${name}（失敗 ${summary.fail} 件）`);
      continue;
    }
    const written = countTestsIn(file);
    // 書いた本数を 0 と数えた立派なファイル（慣用の書き方ゆえ数えられない）は、下の突き合わせだけでは
    // 見逃す。宣言を 1 つも含まない……ではなく、**宣言はあるのに 1 件も走っていない**回を拾う。
    // （実測: 試験ファイルが import の途中で止まると「0 件走って exit 0」になる。書いた本数が
    // 0 と数えられていれば 0 < 0 で通っていた。ここを片側で閉じる）
    if (written > 0 && summary.pass === 0) {
      problems.push(
        `${name}（書いた ${written} 件が 1 件も走っていない。` +
          'import の途中で止まった検査は `node --test` が「0 件・exit 0」で返すことがある）',
      );
      continue;
    }
    const ran = summary.pass + summary.fail;
    if (ran < written) {
      problems.push(
        `${name}（書いた ${written} 件のうち ${ran} 件しか走っていない。` +
          'import の途中で止まった検査は `node --test` が「1 件」と数えて 0 で返すことがある）',
      );
    }
  }
  if (problems.length === 0) return 0;

  console.error(`[run-script-tests] 緑にできない: ${problems.length} 本に問題がある`);
  for (const line of problems) console.error(`  - ${line}`);
  return 1;
}

/** 各ファイルを画面の形（spec）で出す。表示のために検査をもう一度走らせない（記録から作る）。 */
function showResults(outcomes) {
  for (const { file, status, error, tap } of outcomes) {
    console.log(`\n▶ ${basename(file)}`);
    if (error) {
      console.log(`  ✖ 起動できていない: ${error.message}`);
      continue;
    }
    const lines = String(tap)
      .split(/\r?\n/)
      .filter((line) => /^(not ok|ok) \d+ - /.test(line));
    for (const line of lines) {
      const fail = line.startsWith('not ok');
      const name = line.replace(/^(not ok|ok) \d+ - /, '');
      console.log(`  ${fail ? '✖' : '✔'} ${name}`);
    }
    if (lines.length === 0) console.log('  （検査の記録がない＝走り切っていない）');
  }
}

// ── 「走った」を数える門（d908）────────────────────────────────
// 実測（d904 の作業中）: 試験ファイルの import の途中でスクリプトが `process.exit(0)` で終わると、
// `node --test` はそのファイルを「走った 1 件」として数え、**exit 0** を返す。ランナーはその出口を
// そのまま通していたので、残りの検査が 1 件も走っていなくても緑になった。
// 出口の数だけでは足りないので、書いた検査の本数と、走った記録（tap の集計）を突き合わせる。
//
// 突き合わせは**ファイルごと**に行う（全体の本数で比べると、どこかのファイルが余分に数えた分が
// 別のファイルの穴を埋めてしまう）。本数の数え方（countTestsIn）は形を読むだけなので誤差がありうるぶん、
// 「本数が足りない＝赤」の側に倒す。誤差の分だけ赤に近づくが、読めない記録の時と無関係な 0 件の時は、
// 今までどおり出口の数に従う（記録の形が Node の版で変わっても、実在する検査を一括で赤にしない）。

/**
 * tap の末尾の集計（`# pass 3` / `# fail 0`）を引く。
 * 集計の行が無い・数として読めない時は null（＝記録の形が読めない）。
 */
export function readTapSummary(tap) {
  const text = String(tap ?? '').replace(/\r\n/g, '\n');
  const num = (key) => {
    const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const pass = num('pass');
  const fail = num('fail');
  return pass == null || fail == null ? null : { pass, fail };
}

/**
 * 検査の宣言（`test()` / `it()`、説明の文字列を伴うもの）の数を、宣言の形から数える。
 * 入れ子の `describe()` の中の `it()` も数える（`describe()` 自体は数えない）。
 */
export function countTestsIn(path) {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  let count = 0;
  let quote = null; // 文字列の中に居る時は閉じる文字（テンプレートは `${` の入れ子も追う）
  let template = 0; // `${` の入れ子の深さ
  // 直前の有意な文字。`/` が割り算か正規表現の始まりかは、この文字で見分ける
  // （`= ( , : [ { ; !` などの後は正規表現、名前・`)`・`]`・数字の後は割り算・`//` コメント）。
  let prev = '';
  // 正規表現はテストの中で多用される。そのまま読むと、中身の括弧・引用符を数えたり引用符を開きっぱなしに
  // したりして、以降の本数が丸ごとずれる（実測: `() => { const re = /x(/; }` の後に書いた 2 件が数えられず、
  // `0` になった）。値の位置の `/` だけを正規表現の始まりとして、終わりの `/` まで飛ばす。
  const regexAllowed = () => prev === '' || '=([{,;:!&|?+-*%<>~^.'.includes(prev) || prev === '\n';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (quote === '`' && ch === '$' && text[i + 1] === '{') {
        template += 1;
        quote = null;
        i += 1;
        prev = '{';
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\n') {
      prev = '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end - 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      // 正規表現の始まり。名前付きの括弧 `(?<name>` も含め、終わりの `/` まで飛ばす。
      let inClass = false;
      for (let j = i + 1; j < text.length; j += 1) {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '\n') break;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) {
          i = j;
          break;
        }
      }
      prev = '/';
      continue;
    }
    if (ch === '}') {
      if (template > 0) {
        template -= 1;
        quote = '`';
      }
    }
    // 括弧の深さは追わない（`test(` / `it(` の頭はどこに現れても同じ 1 件）。深さを持つと、読み違え
    // 1 か所（正規表現・テンプレート）で以降の本数が丸ごとずれる。
    // 数の梃子は「`test(` / `it(` のすぐ後の、説明の引用符」で、数えたら閉じる引用符まで飛ばす
    // （説明の中の `test(` や括弧で二重に数えない）。
    if (ch === '(' && isCallHead(text, i)) {
      count += 1;
      const end = skipString(text, i);
      if (end < 0) return count; // 閉じない引用符（壊れたファイル）は、そこで数え終える
      i = end;
    }
    prev = ch;
  }
  return count;
}

// `test('名前', …)` / `test("名前", …)` / `test(\`名前\`, …)` の頭だけを数える（`assert.equal(…)` などを
// 取り違えないよう、説明の引用符まで見る）。引用符は 1 文字ずつ比べる（文字クラスに並べると、
// この文字列の中の綴りが読み手と取り違えやすい）。
const CALL_HEAD = new RegExp('\\b(?:test|it)\\s*\\(\\s*[\'"`]');
const isCallHead = (text, open) => CALL_HEAD.test(text.slice(Math.max(0, open - 8), open + 2));

/** `open` の直後の文字列リテラルの終わりまで飛ばし、閉じる引用符の位置を返す。閉じなければ -1。 */
function skipString(text, open) {
  let i = open + 1;
  while (i < text.length && text[i] !== "'" && text[i] !== '"' && text[i] !== '`') i += 1;
  const q = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === q) return j;
  }
  return -1;
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}
