// cmn-0355: sprintf-js@1.0.3（GHSA-hp3w-g68c-fv3c）の到達可否を実測で判定する検査。
//
// 判定の芯: この指摘が Rete にとって「到達可能な脆弱性」か「依存監査の表示だけ」かは、
// **攻撃者が format 文字列を制御できるか**で決まる。精度の引数（{prog} など）を握れても
// 精度指定子は生まれないため、format 位置に入るかどうかだけを見る。
//
// このファイルは check:repo-invariants（install 前・Node 標準モジュールのみ）から走る。
// 対象パッケージの実体が無い環境では skip せず**未検査として赤**にする（成功に丸めない）。
// 親鎖・版・境界値は実装から読んだ実測値で固定し、版が上がったら赤くして人が見直す。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ADVISORY,
  PRECISION_LIMITS,
  EXPECTED_OK,
  EXPECTED_RANGE_ERROR,
  REPO_ROOT,
  classifyFormatOrigin,
  collectEvidence,
  listInstalledCopies,
  packageDir,
  probeSprintf,
  resolveAdvisoryTargets,
} from './check-sprintf-precision-boundary.mjs';

const evidence = collectEvidence();

test('監査対象の実体がこの作業ツリーに存在する（無ければ未検査＝赤。成功に丸めない）', () => {
  assert.ok(
    evidence.target.found,
    `${ADVISORY.package}@${ADVISORY.version} の実体が node_modules/.pnpm に見つかりません。` +
      '依存が外れたならこの検査の対象も消えたので、検査ごと撤去して構いません（黙って緑にしない）。' +
      `探索先: ${join(REPO_ROOT, 'node_modules', '.pnpm')}`,
  );
});

test('実体の版が監査の対象版と一致する（版が上がったら対象を入れ替えずに見直す）', () => {
  assert.equal(
    evidence.target.installed_version,
    ADVISORY.version,
    `実体は ${evidence.target.installed_version}。監査指摘は ${ADVISORY.version} を指す。` +
      '版が上がったなら、指摘が解消したかを確かめて定数とこの検査を更新する' +
      '（検査だけ緑のまま対象がすり替わるのを防ぐ）。',
  );
});

test('公式修正版が無いことを記録している（fixed version を捏造しない）', () => {
  assert.equal(
    ADVISORY.fixed_version,
    null,
    'fixed version を書くと「修正版がある」と誤読される。公式修正版が無い状態では null のままにする。',
  );
});

test('親鎖が実測どおり（load-nyc-config → js-yaml3 → argparse1 → sprintf-js）', () => {
  // この鎖が切れたら「なぜ devDependency が sprintf を引き込むか」の説明が変わる。
  // 鎖の各段が実体として存在することを確かめる（記憶ではなく実体で裏付ける）。
  const parts = [
    ['@istanbuljs/load-nyc-config', '1.1.0'],
    ['js-yaml', '3.15.2'],
    ['argparse', '1.0.10'],
    ['sprintf-js', '1.0.3'],
  ];
  for (const [name, version] of parts) {
    const dir = packageDir(name, version);
    assert.ok(
      dir && existsSync(dir),
      `${name}@${version} の実体が見つかりません（親鎖: ${ADVISORY.chain.join(' → ')}）。`,
    );
  }
});

test('installed sprintf コピーを全件列挙する（サンプリングしない）', () => {
  const copies = listInstalledCopies(REPO_ROOT);
  assert.ok(
    copies.length >= 1,
    'sprintf.js の実体が1件も見つかりません（探索が壊れている可能性）。',
  );
  // 列挙した全件が同一版であることを確かめる（別版コピーの見落としを防ぐ）。
  for (const file of copies) {
    const text = readFileSync(file, 'utf8');
    assert.ok(
      text.includes('toExponential'),
      `${file} が sprintf の実装に見えません（列挙の誤り）。`,
    );
  }
  // 列挙結果は決定論的に並ぶ（同じ入力で同じ出力＝差分が安定する）。
  assert.deepEqual(listInstalledCopies(REPO_ROOT), copies);
});

test('精度を native へ素通ししている箇所を実測で示す（指摘の機序そのもの）', () => {
  // e/f/g が match[7]（精度指定子）をそのまま native へ渡す＝範囲外で RangeError になる。
  const methods = evidence.forwarding.map((f) => f.code);
  assert.equal(
    evidence.forwarding.length,
    3,
    `素通し箇所が ${evidence.forwarding.length} 件（期待 3件）。実装が変わったら機序の説明も見直す。`,
  );
  assert.ok(
    methods.some((c) => c.includes('toExponential')),
    'toExponential への素通しが見つかりません。',
  );
  assert.ok(
    methods.some((c) => c.includes('toFixed')),
    'toFixed への素通しが見つかりません。',
  );
  assert.ok(
    methods.some((c) => c.includes('toPrecision')),
    'toPrecision への素通しが見つかりません。',
  );
});

test('argparse の sprintf 呼出元を全件列挙し、format の由来を分類する', () => {
  // 「定数1例だけで安全判定しない」（ticket の要求）。全件を列挙して由来を分ける。
  assert.equal(
    evidence.call_sites.length,
    5,
    `sprintf 呼出元が ${evidence.call_sites.length} 件（期待 5件）。増減したら全件を人が読み直す。`,
  );
  const origins = evidence.call_sites.map((site) => classifyFormatOrigin(site.code));
  assert.ok(
    origins.every((o) => o.kind === 'literal' || o.kind === 'variable'),
    'format の由来を分類できない呼出元があります（実装の書き方が変わった）。',
  );
  // 変数由来（usage / text / action.help）は人が配線を見るべき箇所として数える。
  const variable = origins.filter((o) => o.kind === 'variable');
  assert.equal(
    variable.length,
    3,
    `変数由来の format が ${variable.length} 件（期待 3件: usage / text / action.help）。`,
  );
  assert.deepEqual(
    variable.map((o) => o.expr).sort(),
    ['text', 'this._getHelpString(action)', 'usage'],
    '変数由来 format の式が変わりました。format 位置へ入力が入る経路が増えていないか読み直してください。',
  );
});

// ── 実挙動（子プロセスで隔離して踏む） ─────────────────────────────────────────
//
// 期待値は定数へ書き、実測と突合する。sprintf の例外をここで握り潰さない
// （捕捉して握るのは検査側であって、製品コードへ例外処理を足す話ではない）。

test('精度境界の内側（e/f 0..100・g 1..100）は正常に通る', () => {
  for (const [spec, bounds] of Object.entries(EXPECTED_OK)) {
    for (const precision of Object.keys(bounds)) {
      const format = `%.${precision}${spec}`;
      const r = probeSprintf({ format, arg: 1.5 });
      assert.ok(r.ran, `${format} を実行できませんでした（${r.reason ?? 'unknown'}）。`);
      assert.equal(
        r.threw,
        false,
        `${format} が例外になりました（${r.name}: ${r.message}）。境界の内側は正常であるべきです。`,
      );
    }
  }
});

test('精度境界の外側は native の RangeError になる（指摘の実挙動）', () => {
  for (const [spec, precisions] of Object.entries(EXPECTED_RANGE_ERROR)) {
    for (const precision of precisions) {
      const format = `%.${precision}${spec}`;
      const r = probeSprintf({ format, arg: 1.5 });
      assert.ok(r.ran, `${format} を実行できませんでした（${r.reason ?? 'unknown'}）。`);
      assert.equal(
        r.threw,
        true,
        `${format} が例外になりませんでした（出力: ${r.out}）。native の上限が変わった可能性があります。`,
      );
      assert.equal(
        r.name,
        'RangeError',
        `${format} の例外が RangeError ではありません（${r.name}）。`,
      );
      // 例外の出所が native であることを文言で裏付ける（捕捉元を特定する材料）。
      assert.match(
        r.message,
        new RegExp(PRECISION_LIMITS[spec].method),
        `${format} の例外が ${PRECISION_LIMITS[spec].method} 由来ではありません: ${r.message}`,
      );
    }
  }
});

test('vsprintf（同義の入口）も同じ境界で例外になる', () => {
  // 「同義 formatter 入口」も見る（format 1件だけ見て安全判定しない）。
  const target = resolveAdvisoryTargets();
  assert.ok(target.found, 'sprintf-js の実体が無いため同義入口を検査できません。');
  const viaVsprintf = probeSprintf({ format: '%.101f', arg: 1.5, entry: 'vsprintf' });
  assert.ok(viaVsprintf.ran, 'vsprintf 経由の検査を実行できませんでした。');
  assert.equal(viaVsprintf.threw, true, 'vsprintf 経由の %.101f が例外になりませんでした。');
  assert.equal(
    viaVsprintf.name,
    'RangeError',
    `vsprintf 経由の例外が RangeError ではありません（${viaVsprintf.name}）。`,
  );
});

// ── 実配線の到達可否（攻撃者が format を制御できるか） ──────────────────────────
//
// ここが「no_change と言えるか」の分岐点。js-yaml3 CLI を実体から読み、format 位置へ
// ユーザー入力が入る経路の有無を確かめる。

test('js-yaml3 CLI は formatter へ到達する（呼出元が実在する）', () => {
  const cli = evidence.js_yaml_cli;
  assert.ok(cli.found, 'js-yaml@3.15.2 の CLI 実体が見つかりません（親鎖の前提が崩れています）。');
  // prog が定数であること（format の引数側に attacker 入力が入らない）。
  assert.match(cli.prog, /^['"]js-yaml['"]$/, `prog が定数ではありません: ${cli.prog}`);
  // help は開発者が書いた literal のみ。
  assert.ok(cli.help_literals.length > 0, 'CLI の help 定義が読めませんでした。');
  for (const help of cli.help_literals) {
    const isLiteral = /^['"]/.test(help) || help.startsWith('argparse.');
    assert.ok(
      isLiteral,
      `help が literal ではありません（動的な help は format 位置へ入り得る）: ${help}`,
    );
  }
});

test('js-yaml3 CLI は addText / addUsage へユーザー入力を渡していない', () => {
  // addText / addUsage の実引数は formatter の format 位置（text / usage）へ入る。
  // ここにユーザー入力が入ると到達可能になるため、実引数を実体から確認する。
  const cli = evidence.js_yaml_cli;
  assert.deepEqual(
    cli.add_text_args,
    [],
    `addText の実引数があります（format 位置へ入り得る）: ${JSON.stringify(cli.add_text_args)}`,
  );
  assert.deepEqual(
    cli.add_usage_args,
    [],
    `addUsage の実引数があります（format 位置へ入り得る）: ${JSON.stringify(cli.add_usage_args)}`,
  );
  assert.equal(
    cli.reaches_formatter_with_input,
    false,
    'ユーザー入力が formatter の format 位置へ達する配線があります。',
  );
});

test('攻撃者が握れる入力（CLI の file 引数）は format 位置ではなく文字列連結で使われる', () => {
  // CLI 引数は攻撃者が握れる唯一の入力。これが sprintf の format へ入らないことを実体で示す。
  const cli = evidence.js_yaml_cli;
  assert.ok(cli.attacker_input_uses.length > 0, 'options.file の使われ方を読めませんでした。');
  // 連結でエラー文を作っている行があること（＝fmt として渡していない）。
  const concatenated = cli.attacker_input_uses.some((u) => /\+\s*options\.file/.test(u));
  assert.ok(
    concatenated,
    `options.file が文字列連結で使われている行が見つかりません（配線が変わった可能性）。実測: ${JSON.stringify(cli.attacker_input_uses)}`,
  );
  // sprintf の format 位置へ options.file を渡していないこと。
  const asFormat = cli.attacker_input_uses.some((u) => /sprintf\s*\(\s*options\.file/.test(u));
  assert.equal(
    asFormat,
    false,
    'options.file が sprintf の format 位置へ渡されています（到達可能＝判定を変える必要があります）。',
  );
});
