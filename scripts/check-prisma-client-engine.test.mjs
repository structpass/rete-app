// cmn-0321: @prisma/client 生成物が Data Proxy モード (engineType=dataProxy) で生成され
// ていると、backend 起動時に P6001 (InvalidDatasourceError) で落ちる＝SSO 全面停止。
// 実行環境に PRISMA_CLIENT_ENGINE_TYPE 等が紛れても生成物が壊れない様を
// (a) 生成入口 2 つ (pretest / prisma:generate) で library 固定
// (b) 生成物が library でない時は check:repo-invariants が赤
// で二重に押さえる。本検査は (b) 側。
//
// 設計の根拠 (cmn-0321 plan_notes より):
//   - リポ内に engineType 設定は 0 件 (prisma.config.ts も存在しない)
//   - 生成物モードは生成時の実行環境で決まり、事後の原因確定は不能
//   - 「紛れても壊れない・壊れたら気づく」の二段で閉じる
//
// 判定は 2 点 (両方ないと将来の形式変更で無言化する):
//   1. index.js に engineType: "library" が書かれていること
//   2. 通常モードのクエリエンジン本体 (query_engine-*.node) が同梱されていること
// 生成物が無い時は skip + 理由をログに出す (cmn-0261 前例に揃える)＝
// 未生成状態で偽の赤を出さない。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const BACKEND_DIR = join(REPO_ROOT, 'packages', 'backend');

/**
 * @prisma/client 生成物のディレクトリを解決する。
 * pnpm のハッシュ付きディレクトリ名に依存しないため、ワークスペースの node_modules
 * から ".prisma/client" を探す。見つからなければ null。
 * @returns {string|null}
 */
function findPrismaClientDir() {
  // pnpm の仮想ストアはワークスペースのルート（hoist 構成）。backend 配下を先に見て、
  // 無ければルートを見る（backend 配下だけを見ると、ルートに置かれた生成物を「未生成」と
  // 誤って skip する＝engineType の検査が静かに効かなくなる）。
  for (const storeRoot of [join(BACKEND_DIR, 'node_modules'), join(REPO_ROOT, 'node_modules')]) {
    if (!existsSync(storeRoot)) continue;
    const candidates = [];
    // pnpm 形式: node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client
    const pnpmDir = join(storeRoot, '.pnpm');
    if (existsSync(pnpmDir)) {
      for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith('@prisma+client')) continue;
        const probe = join(pnpmDir, entry.name, 'node_modules', '.prisma', 'client');
        if (existsSync(probe)) candidates.push(probe);
      }
    }
    // 直接 hoist 形式: node_modules/.prisma/client
    const hoisted = join(storeRoot, '.prisma', 'client');
    if (existsSync(hoisted)) candidates.push(hoisted);
    if (candidates.length > 0) {
      // 同じパッケージの複数版が同居しうるため、backend が実際に解決する版を採る
      // （先に見つかった版を採ると、別版の生成物を見て赤/緑を決めてしまう）。
      const linked = join(storeRoot, '@prisma', 'client', 'package.json');
      if (existsSync(linked)) {
        const { version } = JSON.parse(readFileSync(linked, 'utf8'));
        const sameVersion = candidates.find((dir) => dir.includes(`@prisma+client@${version}_`));
        if (sameVersion) return sameVersion;
      }
      return candidates[0];
    }
  }
  return null;
}

/**
 * 生成物 index.js から engineType を抽出する。
 * 書かれていなければ null (=判定不能)。
 * @param {string} clientDir
 * @returns {{engineType: string|null, raw: string}}
 */
function readEngineType(clientDir) {
  const indexPath = join(clientDir, 'index.js');
  if (!existsSync(indexPath)) return { engineType: null, raw: '' };
  const raw = readFileSync(indexPath, 'utf8');
  // 例: engineType: "library" / "engineType": "library"（Prisma 6.19 は鍵を引用符で包む）
  const m = raw.match(/["']?engineType["']?\s*:\s*["']([^"']+)["']/);
  return { engineType: m ? m[1] : null, raw };
}

/**
 * 同梱されているクエリエンジン本体を探す。
 * 通常モード (library) なら query_engine-windows.dll.node / query_engine-darwin-arm64.dylib / ...
 * 等のいずれかが同梱されている。Data Proxy モードならこれらは無い (dataProxy は
 * クライアントがリモートエンジンへ接続するためローカル同梱不要)。
 * @param {string} clientDir
 * @returns {string[]}
 */
function findEngineBinaries(clientDir) {
  if (!existsSync(clientDir)) return [];
  return readdirSync(clientDir).filter((name) => name.startsWith('query_engine-'));
}

test('check:prisma-client-engine — 生成物が存在し library モード (cmn-0321)', () => {
  const clientDir = findPrismaClientDir();
  if (!clientDir) {
    // 生成物が無い = フレッシュクローン or 依存未インストール。
    // check-knip-baseline と同じ前例で skip（黙って緑にしない）。
    console.log(
      '[check:prisma-client-engine] skip: @prisma/client 生成物が見つかりません ' +
        '(`pnpm install` 後に `pnpm run prisma:generate` を実行してから再走させてください)',
    );
    return;
  }

  const { engineType, raw } = readEngineType(clientDir);
  const engines = findEngineBinaries(clientDir);

  // 失敗文言は「次の一手」と「backend 起動不能・reference の SSO 停止への波及」を含める (criteria 5)。
  const remediation =
    '修正: cd packages/backend && pnpm run prisma:generate を実行し、' +
    '生成物が library モードで再生成されていることを確認してください。' +
    'この故障は backend 起動不能 (P6001) → reference の SSO ログイン全面停止に直結します。';

  assert.ok(
    raw.length > 0,
    `生成物の index.js が空です=${clientDir}/index.js が壊れている可能性があります。${remediation}`,
  );

  assert.equal(
    engineType,
    'library',
    `@prisma/client 生成物の engineType が "library" ではありません (実際: ${engineType ?? 'undefined'})。` +
      `Data Proxy モードで生成されているため backend 起動時に P6001 で落ちます。${remediation}`,
  );

  assert.ok(
    engines.length > 0,
    `クエリエンジン本体 (query_engine-*.node 等) が同梱されていません。` +
      `library モードでは必須なので、生成物が壊れているか別モードで生成されています。${remediation}`,
  );
});

test('check:prisma-client-engine — packages/backend の pretest / prisma:generate が library 固定 (cmn-0321 criteria 1)', () => {
  const pkgPath = join(BACKEND_DIR, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const scripts = pkg.scripts || {};

  // 生成の入口は 2 つ。pretest は生成物が古い時だけ generate を走らせる入口（d893）で、
  // 実体の生成は prisma:generate に寄せてある。よって library 固定は prisma:generate が持ち、
  // pretest はそのスイッチ（下の test）を持たない。pretest が prisma:generate を通さず直接
  // 生成する形へ戻ると、固定値が 2 か所に分かれて片側だけ古くなる。
  const script = scripts['prisma:generate'];
  assert.ok(
    typeof script === 'string',
    `packages/backend/package.json に scripts.prisma:generate がありません`,
  );
  assert.ok(
    /cross-env/.test(script) && /PRISMA_CLIENT_ENGINE_TYPE\s*=\s*library/.test(script),
    `scripts.prisma:generate が cross-env PRISMA_CLIENT_ENGINE_TYPE=library 固定ではありません ` +
      `(実際: "${script}")。実行環境の env に左右されず library モードで生成させるために明示固定が必要です。`,
  );
  assert.ok(
    typeof scripts.pretest === 'string' &&
      /prisma-generate-unless-current\.mjs/.test(scripts.pretest),
    `scripts.pretest が scripts/prisma-generate-unless-current.mjs を通していません ` +
      `(実際: "${scripts.pretest}")。`,
  );
});
