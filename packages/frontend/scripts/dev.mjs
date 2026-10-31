#!/usr/bin/env node
/**
 * クロスプラットフォームな dev サーバー起動ラッパー。
 *
 * ポートはハードコードせず env / .env.local から取る。開発統括ローカルは .env.local で
 * 上書きし、譲渡先は .env.example の素直な値 (3000) を使う想定（12-factor）。
 *
 * package.json の `next dev -p ${PORT:-3000}` 形式は POSIX シェル前提で Windows
 * (PowerShell / cmd) では展開されないため、Node で port を解決してから next を起動する。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePort } from './resolve-port.mjs';

const port = resolvePort();

// d915: `next` を bare 名で shell 経由に起動すると、この環境では `'next' is not recognized` で
// 起動直後に落ちる（PATH に package の node_modules/.bin が無い。実測: 27 秒で exit 1、画面は無応答）。
// 同じ package の node_modules から next の実体を名指しで起動し、PATH に依存させない。
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const nextBin = join(packageRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
if (!existsSync(nextBin)) {
  console.error(`[dev] next が見つからない: ${nextBin}（pnpm install を先に走らせてください）`);
  process.exit(1);
}

// --turbopack: dev のルート別 on-demand コンパイルを webpack より大幅に高速化する
// （タブ初回クリックの待ち短縮）。本番ビルド（next build）は webpack のまま不変。
// shell は使わない（空白入りのパスを壊さない・引数の連結に寄らない）。
const child = spawn(process.execPath, [nextBin, 'dev', '--turbopack', '-p', port], {
  stdio: 'inherit',
  cwd: packageRoot,
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
