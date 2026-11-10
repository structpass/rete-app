// cmn-0261: CI ワークフロー側にしか居場所が無い検査の「呼ばれ方」を固定する。
//
// なぜ必要か: knip のスナップショット検査は生成物（shared の dist / Prisma Client / next typegen の
// ルート型）が揃った後でないと偽の赤が出るため、install 前に走る check:repo-invariants の自動探索
// からは外してある（cmn-0261 M2）。結果、実行経路は .github/workflows/test.yml の
// 「Knip snapshot check」ステップ 1 本だけになった。この状態でステップを消す・改名する・env を
// 落とすと、検査は何も落とさずに消える（cmn-0252 の HIGH「CI で一度も回帰を見ていない」と同型）。
// 経路が 1 本しかないものは、その 1 本自体を検査で押さえる。
//
// YAML パーサは使わない（このファイルは install 前に走る＝Node 標準モジュールのみ）。
// 文字列で見る分には十分で、狙いは「消えたら気付く」であって構文解析ではない。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'test.yml');
const DEPLOY_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'deploy.yml');

test('CI: 重複検査が閾値超過を失敗として伝える (d555)', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = yaml.split('\n').filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) =>
    /^\s*-\s+name:\s*Duplication check \(jscpd\)\s*$/.test(line),
  );
  assert.ok(start >= 0, '重複検査の CI ステップがありません');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*-\s/.test(line));
  const step = rest.slice(0, end < 0 ? undefined : end).join('\n');
  assert.match(step, /^\s*run: pnpm run check:duplication\s*$/m);
  assert.doesNotMatch(step, /continue-on-error|\bif\s*:/);
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  // 2026-10-22 実測: jscpd 自身の --threshold は小数第 1 位で比較するため、実測 1.24% が
  // 1〜1.6 のどの閾値でも緑になった。比較は自前の検査（scripts/check-duplication.mjs）が持つ。
  assert.equal(pkg.scripts['check:duplication'], 'node scripts/check-duplication.mjs');
  const config = JSON.parse(readFileSync(join(REPO_ROOT, '.jscpd.json'), 'utf8'));
  // 効かない閾値を設定に戻すと「設定したが効いていない」にまた戻るので置かせない。
  assert.equal(config.threshold, undefined);
});

/**
 * 「Knip snapshot check」ステップの本体（コメント行を除いた区間）を返す。
 *
 * ファイル全体へ素の includes を掛けると、**同じ語を含む解説コメントに当たって guard が no-op になる**
 * （test.yml には KNIP_SNAPSHOT_REQUIRED を説明するコメント行がある）。コメントを落とし、さらに
 * 当該ステップの区間へ絞る＝別ステップに env だけ生き残る形も塞ぐ。
 */
function knipStepBody(yaml) {
  const lines = yaml.split('\n').filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => /^\s*-\s+name:\s*Knip snapshot check\s*$/.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*-\s/.test(line)); // 次のステップの開始
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

test('CI: knip スナップショット検査のステップと env が残っている', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const step = knipStepBody(yaml);

  assert.ok(
    step,
    'test.yml に「Knip snapshot check」ステップがありません＝knip スナップショット検査の唯一の実行経路が無くなりました' +
      '（install 前の check:repo-invariants からは意図的に外してあるため、ここが消えると誰も走らせません）',
  );

  // 起動は package.json の script 経由へ寄せてある（CI 直書きと二重管理にしない）。
  assert.ok(
    step.includes('run: pnpm run check:knip-snapshot'),
    'Knip snapshot check ステップが check:knip-snapshot を起動していません（起動の書き方を変えたら本検査も直す）',
  );

  // node_modules 不在で skip されたら落とす、を CI 側で有効にする env（cmn-0261 L4）。
  assert.ok(
    step.includes('KNIP_SNAPSHOT_REQUIRED'),
    'Knip snapshot check ステップから KNIP_SNAPSHOT_REQUIRED が消えています＝install が壊れた時に検査が skip のまま緑になります',
  );

  // script 自体の存在も見る（ステップだけ残って script が消えると CI で初めて落ちる）。
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(
    typeof pkg.scripts?.['check:knip-snapshot'] === 'string',
    'ルート package.json に check:knip-snapshot がありません（test.yml が呼んでいる script です）',
  );
});

/**
 * CI: 依存監査の境界検査（sprintf-js）は install 後の専用ステップで走る（d954）。
 *
 * なぜ必要か: この検査は node_modules の実体を読むため install 前の check:repo-invariants から
 * EXCLUDED で外してあり、実行経路は CI の専用ステップ 1 本だけになる。ステップ名・起動 script・
 * package.json の script のどれかが消えると、検査は誰にも走らせられないまま静かに消える。
 */
test('CI: 依存監査の境界検査（sprintf-js）が install 後のステップで走る', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const lines = yaml.split('\n').filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) =>
    /^\s*-\s+name:\s*Dependency audit boundary \(sprintf-js\)\s*$/.test(line),
  );
  assert.ok(
    start >= 0,
    'test.yml に「Dependency audit boundary (sprintf-js)」ステップがありません＝' +
      'install 前の不変条件検査から外してあるため、ここが消えると sprintf-js の到達性監査が誰にも走りません',
  );
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*-\s/.test(line));
  const step = [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
  assert.ok(
    step.includes('run: pnpm run check:audit-boundary'),
    'ステップが check:audit-boundary を起動していません（起動の書き方を変えたら本検査も直す）',
  );

  // install より後ろに置かれていること（node_modules の実体を読む検査なので、前だと必ず赤になる）。
  const installAt = lines.findIndex((line) =>
    /^\s*-\s+name:\s*Install dependencies\s*$/.test(line),
  );
  assert.ok(installAt >= 0, 'test.yml に Install dependencies ステップがありません');
  assert.ok(
    installAt < start,
    'Dependency audit boundary ステップが Install dependencies より前です＝node_modules が無く必ず赤になります',
  );

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(
    typeof pkg.scripts?.['check:audit-boundary'] === 'string',
    'ルート package.json に check:audit-boundary がありません（test.yml が呼んでいる script です）',
  );
});

/**
 * 「Format check」ステップの本体（コメント行を除いた区間）を返す。
 *
 * knip スナップショット検査と同じ運用: format:check も CI ワークフロー側にしか居場所が無い
 * （`pnpm run format:check` を別スクリプトに書いても CI からどう起動するかが固定されない）。
 * ステップが消える・改名する・run を直書きへ変える等で、整形ドリフトの検出が CI から黙って
 * 消える。経路を 1 本に絞ったので、その 1 本自体を検査で押さえる（cmn-0263）。
 */
function formatCheckStepBody(yaml) {
  const lines = yaml.split('\n').filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => /^\s*-\s+name:\s*Format check\s*$/.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*-\s/.test(line));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

test('CI: format:check ステップとルート script が残っている (cmn-0263)', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const step = formatCheckStepBody(yaml);

  assert.ok(
    step,
    'test.yml に「Format check」ステップがありません＝format:check ステップが消えました（cmn-0263 で追加した整形ドリフト検出の唯一の CI 経路）',
  );

  // 起動は package.json の script 経由へ寄せてある（CI 直書きと二重管理にしない）。
  assert.ok(
    step.includes('run: pnpm run format:check'),
    'Format check ステップが format:check を起動していません（起動の書き方を変えたら本検査も直す）',
  );

  // script 自体の存在も見る（ステップだけ残って script が消えると CI で初めて落ちる）。
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(
    typeof pkg.scripts?.['format:check'] === 'string',
    'ルート package.json に format:check がありません（test.yml が呼んでいる script です）',
  );
});

/**
 * 「Unit test (E2E)」ステップと e2e の test:unit script を固定する（cmn-0376）。
 *
 * e2e の支持単体テスト（support/__tests__/*.test.ts）は `node --experimental-strip-types` で
 * TypeScript のまま実行する（Node 22+）ため .nvmrc（20.18.1）では起動しない。CI では独立 job
 * （e2e・node-version: 24）の「Unit test (E2E)」ステップ 1 本だけが実行経路で、これを消す・改名する・
 * script 名を変えると検査が何も落とさずに消える。経路が 1 本しかないものは、その 1 本自体を検査で
 * 押さえる（knip / format の固定と同じ運用・cmn-0376 criteria 5）。
 */
function e2eUnitStepBody(yaml) {
  const lines = yaml.split('\n').filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => /^\s*-\s+name:\s*Unit test \(E2E\)\s*$/.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*-\s/.test(line));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

test('CI: e2e の単体テスト（test:unit）が実行される経路が残っている (cmn-0376)', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const step = e2eUnitStepBody(yaml);

  assert.ok(
    step,
    'test.yml に「Unit test (E2E)」ステップがありません＝e2e 支持単体テストの唯一の実行経路が無くなりました（support/__tests__/*.test.ts が CI で一度も走らなくなります）',
  );

  // 起動は e2e/package.json の script 経由へ寄せてある（CI 直書きと二重管理にしない）。
  assert.ok(
    step.includes('run: npm run test:unit'),
    'Unit test (E2E) ステップが test:unit を起動していません（起動の書き方を変えたら本検査も直す）',
  );

  // Node 22+ の機能（--experimental-strip-types）を使うため独立 job 側の Node 指定が必要。
  // 素の includes だと e2e job の setup-node コメント行に当たる恐れがあるため、job 区間へ絞る。
  const job = yaml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.ok(
    /e2e:\s*\n\s*runs-on: ubuntu-latest[\s\S]*?node-version: 24/.test(job),
    'test.yml に e2e 独立 job（node-version: 24）がありません＝test:unit が CI の Node 20 で起動せず赤くなります',
  );

  // script 自体の存在も見る（ステップだけ残って script が消えると CI で初めて落ちる）。
  const e2ePkg = JSON.parse(readFileSync(join(REPO_ROOT, 'e2e', 'package.json'), 'utf8'));
  assert.ok(
    typeof e2ePkg.scripts?.['test:unit'] === 'string' &&
      e2ePkg.scripts['test:unit'].includes('--test support/__tests__/*.test.ts'),
    'e2e/package.json に test:unit（support/__tests__/*.test.ts を実行する script）がありません（test.yml が呼んでいる script です）',
  );

  // .nvmrc は「e2e が要る下限（Node 22+）を満たすこと」だけを見る。版を書き下すと、サポート中の
  // Node へ揃える時にこの検査が古い値を守ってしまう（d11 で実際に止まった）。e2e の都合で
  // リポ全体の Node を動かさない、という cmn-0376 criteria 3 は維持したまま下限だけ固定する。
  const nvmrc = readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim();
  const major = Number.parseInt(nvmrc.split('.')[0], 10);
  assert.ok(
    Number.isInteger(major) && major >= 22,
    `.nvmrc（${nvmrc}）が Node 22 未満です＝e2e の支持単体テスト（--experimental-strip-types）が起動しません`,
  );
});

/**
 * 供給網の pin 方針を機械強制する（cmn-0393）。
 *
 * 「第三者 Action は full commit SHA で pin・GitHub 公式（actions/*）はタグ可」という方針は
 * これまで test.yml のコメントにしか無く、緩い指定（可変タグ）を書き足しても CI は緑のままだった。
 * 可変タグは maintainer 側の差し替えがそのまま runner 上の実行内容へ流れ込むため、破ったら赤くする。
 * 対象は .github/workflows 配下の全ワークフロー（ファイルを新設しても自動で対象に入る）。
 * 既知の穴: 検査対象は「uses と値が同一行の block style」のみ。flow mapping（- { uses: x }）や
 * 値の次行折り返しは YAML パーサ不使用の制約上すり抜ける（現行ワークフローに該当書式は無い。
 * 導入する時はこの検査が沈黙する＝書式を揃えるか検査側を拡張する）。
 */
/**
 * main の push で Test が走ることを固定する（d714）。
 *
 * なぜ必要か: test.yml は branches-ignore: [main] で main の push を外しており、main の検査は
 * deploy.yml（CI/CD）の workflow_call だけが経路だった。その deploy.yml が disabled_manually の間は
 * main の push で検査が 1 件も走らず、実際に 2026-08-22 を最後に沈黙した（2026-10-22 実測）。
 * 経路が 1 本しかないものは、その 1 本が止まった瞬間に検査ごと止まる。よって deploy.yml を
 * 検査の唯一の入口にしない＝本ワークフロー自身が main の push でも走る形を、コメントではなく
 * 機械で押さえる（ここを branches-ignore に戻すと本検査が赤くなる）。
 *
 * 見るのは on.push の branches / branches-ignore の**中身まで**。YAML パーサは使わない
 * （install 前に走る＝Node 標準モジュールのみ・本ファイルの他の検査と同理由）。
 */
function pushBranchFilters(yaml) {
  const lines = yaml.split('\n').filter((line) => !/^\s*#/.test(line));
  const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (onIndex < 0) return null;
  const pushIndex = lines.findIndex((line, i) => i > onIndex && /^ {2}push:\s*$/.test(line));
  if (pushIndex < 0) return null;
  const rest = lines.slice(pushIndex + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line)); // 次のイベント（workflow_dispatch 等）
  const block = rest.slice(0, end < 0 ? undefined : end);
  const read = (key) => {
    const at = block.findIndex((line) => new RegExp(`^\\s*${key}:`).test(line));
    if (at < 0) return null;
    // インライン配列（key: ['**'] / key: [main]）と、行下のリストの両方を読む。
    return [block[at], ...block.slice(at + 1)]
      .filter((line) => /^\s*(-|\w+:)/.test(line))
      .map((line) => line.replace(/^[^:]*:/, '').replace(/^[\s-]+/, ''))
      .join(' ');
  };
  return { branches: read('branches'), branchesIgnore: read('branches-ignore') };
}

test('CI: main の push でも Test ワークフローが走る (d714)', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const push = pushBranchFilters(yaml);
  assert.ok(push, 'test.yml に on.push がありません＝push 起因の検査が無くなりました');
  assert.equal(
    push.branchesIgnore,
    null,
    'test.yml の on.push に branches-ignore があります＝main の push を外すと、配備ワークフロー' +
      '（deploy.yml）が止まっている間は main の検査が 1 件も走りません（2026-08-22〜10-22 に実際に起きた）',
  );
  // tag を含める形（tags: だけ・tags-ignore だけ）にすると、GitHub の仕様でブランチ push が
  // 未定義の ref 扱いになり一切発火しない（cmn-0342 で 3 週間沈黙した真因）。全ブランチに限る。
  // インライン配列（['**']）と行下のリスト（- '**'）のどちらでも通す。値そのものだけを見る。
  const patterns = (push.branches ?? '')
    .replace(/[[\]'"]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  assert.deepEqual(
    patterns,
    ['**'],
    "test.yml の on.push.branches が全ブランチ（'**'）ではありません＝tag 側のフィルタを書くとブランチ push が" +
      '未定義の ref になり 1 件も走らなくなります（cmn-0342 と同型）',
  );
});

/**
 * 「Build shared」ステップの存在と、生成物依存ステップより前にあることを固定する（rev-arch B4）。
 *
 * なぜ必要か: backend / frontend は `@rete/shared` を pnpm の symlink 先 package.json の
 * main/types（= dist/）で解決する。dist/ は gitignore・未追跡のため fresh runner には存在せず、
 * Build shared を Type check / Coverage より後に動かす（または消す）と
 * `Cannot find module '@rete/shared'` で CI が赤くなる。順序自体は正しいが、これまで検査が無く
 * 黙って壊せた。ローカル側の同型欠陥（ルート type-check が shared を build しない）は
 * rev-arch B1 で別途修正済み＝CI だけが正しい状態だった。
 *
 * 「生成物より前」の判定は、name 行の出現位置で行う（YAML パーサ不使用・install 前に走るため）。
 */
function stepIndex(yaml, name) {
  const lines = yaml.split('\n').filter((line) => !/^\s*#/.test(line));
  return lines.findIndex((line) => new RegExp(`^\\s*-\\s+name:\\s*${name}\\s*$`).test(line));
}

test('CI: Build shared が Type check / Coverage より前に実行される (rev-arch B4)', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');

  const buildShared = stepIndex(yaml, 'Build shared');
  const typeCheck = stepIndex(yaml, 'Type check');
  const coverage = stepIndex(yaml, 'Coverage threshold \\(all packages\\)');

  assert.ok(
    buildShared >= 0,
    'test.yml に「Build shared」ステップがありません＝backend / frontend が @rete/shared の dist を' +
      '解決できず、fresh runner で Cannot find module になります',
  );
  assert.ok(typeCheck >= 0, 'test.yml に「Type check」ステップがありません');

  // ステップが在るだけでは足りない。中身が type-check を呼んでいることまで見る（d1070）。
  // 存在と順序だけを見ていたため、実行行を echo に差し替えても緑のままだった。
  assert.ok(
    yaml.includes('run: pnpm run type-check'),
    'Type check ステップが pnpm run type-check を起動していません（型検査が CI で走らない）',
  );
  assert.ok(
    buildShared < typeCheck,
    'Build shared が Type check より後にあります＝shared の dist が無いまま型検査が走り、' +
      "Cannot find module '@rete/shared' で赤くなります",
  );
  if (coverage >= 0) {
    assert.ok(
      buildShared < coverage,
      'Build shared が Coverage threshold より後にあります＝テスト側でも shared の dist を解決できません',
    );
  }

  // 起動は package.json の script 経由へ寄せる（CI 直書きと二重管理にしない）。
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(
    typeof pkg.scripts?.['build:shared'] === 'string',
    'ルート package.json に build:shared がありません（CI とローカル type-check が共有する起動口です）',
  );
});

test('CI: 第三者 Action は full commit SHA で pin されている（actions/* のみタグ可・cmn-0393）', () => {
  const wfDir = join(REPO_ROOT, '.github', 'workflows');
  const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(
    files.length > 0,
    '.github/workflows にワークフローがありません（検査対象ゼロは fail-open）',
  );

  const violations = [];
  for (const file of files) {
    const lines = readFileSync(join(wfDir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return; // コメント行は対象外
      const m = line.match(/^\s*-?\s*uses:\s*(\S+)/);
      if (!m) return;
      const ref = m[1];
      if (ref.startsWith('actions/')) return; // GitHub 公式 org はタグ参照可（意図的な差）
      if (ref.startsWith('./')) return; // 同一リポジトリの reusable workflow は SHA 固定の対象外
      if (!/@[0-9a-f]{40}(\s|$)/.test(ref + ' ')) {
        violations.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    '第三者 Action が full commit SHA（40 桁 hex）で pin されていません。可変タグは maintainer 側の' +
      '差し替えがそのまま runner 上の実行内容に流れ込みます（供給網方針・test.yml のコメント参照）:\n' +
      violations.join('\n'),
  );
});

/**
 * deploy.yml の「CI 成功後の同一 SHA 配布」の配線を固定する（v2-238）。
 *
 * なぜ必要か: 本ファイルの検査は test.yml（CI）だけを対象にしており、CD 側の deploy.yml は
 * ステップ改名も env の貼り替えも検査外だった。第三者 Action の SHA pin だけは workflows
 * ディレクトリ全体を走査するため deploy.yml にも効いているが、「CI が成功した同一 commit SHA を
 * CD へ渡す」（AGENTS.md §Git and delivery）という契約自体は誰も押さえていなかった。
 * deploy.yml は workflow_dispatch でも手動実行できるため、配線が壊れても気付くのは本番デプロイの
 * 失敗時（または CI を通っていない版の配布）になる。経路が 1 本しかないものは、その 1 本自体を
 * 検査で押さえる（knip / format / build:shared の固定と同じ運用）。
 *
 * 見るのは 4 点。YAML パーサは使わない（install 前に走る＝Node 標準モジュールのみ・test.yml 側と同理由）:
 *   - 「Deploy exact SHA via SSM」ステップが存在する（改名・削除で配布の配線が消えるのを検出）
 *   - そのステップの env が SHA: ${{ github.sha }} を固定している（配布元 SHA の取り違えを検出）
 *   - そのステップが対象 SHA を detach checkout している（EC2 上で最新版へ追従させない）
 *   - deploy ジョブが main 限定で、needs に test（CI）を持つ（CI 成功前の配布を検出）
 */
function deployStepBody(yaml) {
  const lines = yaml.split('\n').filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) =>
    /^\s*-\s+name:\s*Deploy exact SHA via SSM\s*$/.test(line),
  );
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*-\s/.test(line)); // 次のステップの開始
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** ジョブ区間（インデント2の `<job>:` から次のジョブまで）を返す。 */
function jobBody(yaml, job) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^  ${job}:\\s*$`).test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

// 公開版（スナップショット）には deploy.yml を載せない（scripts/publish/targets/rete.json の
// excludeFiles）。そのため公開版のリポジトリでは deploy.yml が存在せず、この CD 検査は必ず読取で落ちる。
// 判定の基準は scripts/run-script-tests.mjs と同じ「scripts/publish/ があるか」＝社内の開発元か、
// 公開版かの区別。社内文脈では deploy.yml の不在を必ず赤にし（社内の配備契約を守る）、公開文脈では
// 不在を「配備を持たない」という境界として確かめる。どちらの文脈でも、黙って skip はしない。
const IS_PUBLICATION = !existsSync(join(REPO_ROOT, 'scripts', 'publish'));

test('CD: deploy.yml が CI 成功後の同一 SHA を配布する配線を保っている (v2-238)', () => {
  if (IS_PUBLICATION) {
    assert.equal(
      existsSync(DEPLOY_WORKFLOW_PATH),
      false,
      '公開版に deploy.yml（本番配備）が入っています＝公開スナップショットは配備を持たない境界です' +
        '（scripts/publish/targets/rete.json の excludeFiles を確認してください）',
    );
    return;
  }
  assert.ok(
    existsSync(DEPLOY_WORKFLOW_PATH),
    '社内（開発元）に deploy.yml がありません＝main の同一 SHA 配備の配線が消えています',
  );
  const yaml = readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');

  const step = deployStepBody(yaml);
  assert.ok(
    step,
    'deploy.yml に「Deploy exact SHA via SSM」ステップがありません＝同一 SHA 配布の唯一の実行経路が' +
      '無くなりました（改名したなら本検査も直してください）',
  );
  assert.ok(
    step.includes('SHA: ${{ github.sha }}'),
    'Deploy exact SHA via SSM ステップの env から SHA: ${{ github.sha }} が消えています＝' +
      '配布する SHA が workflow の起点（CI を通った commit）と一致しなくなります',
  );
  assert.ok(
    step.includes('git checkout --force --detach'),
    'Deploy exact SHA via SSM ステップが対象 SHA を detach checkout していません＝' +
      'EC2 上が最新版へ追従し、CI を通った SHA と配布物がずれます',
  );

  const job = jobBody(yaml, 'deploy');
  assert.ok(job, 'deploy.yml に deploy ジョブがありません');
  assert.match(
    job,
    /^\s{4}if: github\.ref == 'refs\/heads\/main'$/m,
    "deploy ジョブの main 限定（if: github.ref == 'refs/heads/main'）が変わっています＝" +
      'main 以外の ref を配布できる経路ができます（手動実行の追加は本検査も直してください）',
  );
  assert.match(
    job,
    /^\s{4}needs:.*\btest\b/m,
    'deploy ジョブの needs に test（CI）がありません＝CI 成功前の配布が起きます',
  );
});

/**
 * 台本から heredoc の区間を取り出す（区切り子の名前と引用の有無は問わない）。
 *
 * 名前を固定しないのは、区切り子を改名するだけの正当な書き換えで赤にしないため。
 * 見るのは「案内文の台本が unquoted heredoc で組まれているか」＝台本の中に
 * 展開されないプレースホルダ（WORKFLOW_URL_PLACEHOLDER）があり、区切り子が引用されていない、
 * という組み合わせ（2026-10-21 の事故と同じ形）。
 */
export function unquotedNoticeHeredocs(yaml) {
  const lines = yaml.split('\n');
  const found = [];
  lines.forEach((line, start) => {
    const open = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!open) return;
    const [, quote, delimiter] = open;
    const end = lines.findIndex((l, i) => i > start && l.trim() === delimiter);
    const body = end < 0 ? lines.slice(start) : lines.slice(start, end);
    const expands = quote === '';
    const hasPlaceholder = body.some((l) => l.includes('WORKFLOW_URL_PLACEHOLDER'));
    const hasInstruction = body.some((l) => l.includes('approve production-login'));
    found.push({ delimiter, expands, hasPlaceholder, hasInstruction });
  });
  return found;
}

test('CD: 本番ログイン確認の案内文が、記号の解釈で空にならない形で作られる (d712)', () => {
  // 公開版には deploy.yml が無い（同ファイル冒頭の IS_PUBLICATION を参照）。読む前に境界を確かめ、
  // 公開文脈では「配備を持たない」ことを固定して終わる（読取で ENOENT にしない）。
  if (IS_PUBLICATION) {
    assert.equal(
      existsSync(DEPLOY_WORKFLOW_PATH),
      false,
      '公開版に deploy.yml（本番配備）が入っています＝公開スナップショットは配備を持たない境界です' +
        '（scripts/publish/targets/rete.json の excludeFiles を確認してください）',
    );
    return;
  }
  const heredocs = unquotedNoticeHeredocs(readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8'));
  const notice = heredocs.filter((h) => h.hasPlaceholder);
  assert.ok(
    notice.length > 0,
    'deploy.yml に案内文の台本（WORKFLOW_URL_PLACEHOLDER を含む heredoc）がありません＝' +
      '案内文の組み立てごと消えています',
  );
  for (const h of notice) {
    // 区切り子が引用されている（<<'EOF'）＝本文の中の $ や ` をシェルが解釈しない。
    // unquoted に戻すと `…` がコマンド置換になり、何を書き込むかの行が消える（2026-10-21 の事故）。
    assert.equal(
      h.expands,
      false,
      `案内文の heredoc（区切り子 ${h.delimiter}）が unquoted です＝本文の記号がシェルに解釈され、` +
        "書き込みの指示行が空になります（<<'…' の形にしてください）",
    );
    // 書き込みの指示行が本文に残っている（空行になった事故の再発防止）。
    assert.ok(
      h.hasInstruction,
      '案内文の heredoc に「approve production-login」の指示行がありません＝何を書き込むか分かりません',
    );
  }
});

// 品質の歯止めになる CI の実行行が、中身ごと残っていることを 1 か所で見る（d1071）。
//
// d1070 で型検査だけを塞いだ時、同じ穴が他のステップにも残っていた。ステップの存在や順序だけを
// 見ていると、実行行を echo に差し替えられても緑のままになり、歯止めが黙って外れる。
// ここでは「そのコマンドを起動している行が test.yml に在るか」だけを、歯止めごとに並べて見る。
// 起動の書き方（script 名・filter）を変える時は、この一覧も同じ変更で直す。
//
// d1139: 見るのは**そのステップの区間の中**だけにする。ファイル全体の部分一致だと、
// コメント行や到達しない別ジョブ・別ステップへ移しても緑になり、歯止めが効かない場所に
// あっても検査が通る（knip / format / e2e の検査は最初からステップ区間に絞ってある）。
//
// d1139（独立の目）: ステップ区間へ絞っただけでは、**ステップごと到達しないジョブへ移す**形が
// 抜けた（別ジョブに同名のステップを置いても、最初に見つかった name 行を読むため緑になった）。
// よって「どのジョブの中のステップか」まで固定する。ジョブ名は workflow の job キーと一致させる。
// 加えて `if:`／`continue-on-error` を持つステップは、実行行が在っても走らないことがあるため赤にする
// （jscpd ステップの検査が既に同じ厳しさで見ている）。
// ステップ名・ジョブ名は workflow の name / job キーと一致させる（改名したらこの一覧も直す）。
const REQUIRED_CI_RUN_LINES = [
  ['test', 'Repo invariant checks', 'pnpm run check:repo-invariants', 'リポジトリ不変条件の検査'],
  [
    'test',
    'Dependency audit boundary (sprintf-js)',
    'pnpm run check:audit-boundary',
    '依存監査の境界検査',
  ],
  ['test', 'Dependency security audit', 'pnpm run check:security', '依存の脆弱性監査'],
  ['test', 'Type check', 'pnpm run type-check', '型検査'],
  ['test', 'Lint check', 'pnpm run lint:check', 'lint'],
  ['test', 'Format check', 'pnpm run format:check', '整形ドリフトの検出'],
  ['test', 'Coverage threshold (all packages)', 'pnpm run test:cov', '被覆率の下限を縛る試験'],
  ['test', 'Duplication check (jscpd)', 'pnpm run check:duplication', '重複の閾値検査'],
  [
    'test',
    'Knip snapshot check',
    'pnpm run check:knip-snapshot',
    '不要コードのスナップショット検査',
  ],
  ['test', 'OIDC credential lifecycle', 'pnpm run check:oidc-flow', 'OIDC 資格情報フローの検査'],
  [
    'test',
    'Service/Repository boundary',
    'pnpm run check:service-boundary',
    'Service/Repository 境界の検査',
  ],
  ['test', 'Raw SQL stays in repositories', 'pnpm run check:raw-sql', 'raw SQL の置き場所の検査'],
  // e2e は workspace に取り込まれず独自の依存と tsconfig で型検査するため、test ジョブの
  // `pnpm run type-check` とは別の実行行になる（test.yml の e2e ジョブ）。こちらも見る（d1077）。
  ['e2e', 'Type check (E2E)', 'npm run type-check', 'e2e の型検査'],
];

/**
 * 指定した job の中の、指定した name のステップの本体（コメント行を除いた区間）を返す。無ければ null。
 *
 * ファイル全体へ素の includes を掛けると、コメント行や別ジョブの同じ語に当たって歯止めが no-op になる。
 * さらに job を指定しないと、ステップごと到達しないジョブへ移す形が抜ける（d1139 の独立の目）。
 */
function stepBodyByName(yaml, job, name) {
  const jobBlock = jobBody(yaml, job);
  if (jobBlock === null) return null;
  const lines = jobBlock.split('\n').filter((line) => !/^\s*#/.test(line));
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s*-\\s+name:\\s*${escaped}\\s*$`).test(line),
  );
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*-\s/.test(line)); // 次のステップの開始
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

test('CI: 品質の歯止めになる実行行が、中身ごと残っている (d1071)', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const missing = [];
  for (const [job, stepName, cmd, label] of REQUIRED_CI_RUN_LINES) {
    const step = stepBodyByName(yaml, job, stepName);
    if (step === null) {
      missing.push(`  - ${label}: 「${stepName}」ステップが ${job} ジョブにありません`);
      continue;
    }
    if (
      !new RegExp(`^\\s*run: ${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(step)
    ) {
      missing.push(
        `  - ${label}: run: ${cmd}（${job} ジョブ「${stepName}」ステップの区間内にありません）`,
      );
      continue;
    }
    // 実行行が在っても、条件や失敗の握り潰しで走らないことがある（jscpd の検査と同じ厳しさ）。
    if (/continue-on-error|\bif\s*:/.test(step)) {
      missing.push(
        `  - ${label}: 「${stepName}」ステップが if: ／ continue-on-error を持っています` +
          '（実行行が在っても走らない・失敗が素通りします）',
      );
    }
  }

  assert.deepEqual(
    missing,
    [],
    'test.yml から次の実行行が消えています（ステップが在っても、中身が別のコマンド・別のステップ・' +
      'コメント行・到達しない別ジョブ・条件付きのステップだと歯止めが効きません）。' +
      '消す・書き換える時は本検査も同じ変更で直してください:\n' +
      missing.join('\n'),
  );
});

// lint の警告は、件数を固定して「増えたら止まる」形にしている（d1117・d1118）。
// 上限を外すと警告が素通りし、構造上限の規則がまた効かなくなる。
// shared は警告 0 件なので上限を持たない（0 件を保てている）。
for (const pkgName of ['frontend', 'backend']) {
  test(`${pkgName} の lint:check は警告の件数を固定している (d1117・d1118)`, () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, `packages/${pkgName}/package.json`), 'utf8'),
    );
    const script = pkg.scripts?.['lint:check'] ?? '';

    assert.match(
      script,
      /--max-warnings \d+/,
      `${pkgName} の lint:check から --max-warnings が消えています。外すと警告が増えても CI が` +
        '緑のままになり、長すぎる関数・複雑すぎる関数が素通りします。',
    );
  });
}
