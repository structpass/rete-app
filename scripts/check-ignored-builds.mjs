#!/usr/bin/env node
// cmn-0250: pnpm install が「実行を弾いたビルドスクリプト」の一覧が、想定どおりかを突合する。
//
// 背景: rete は install 時に自動実行されるビルドスクリプトを許可制にしている
// （package.json の pnpm.onlyBuiltDependencies）。許可漏れがあっても pnpm は警告を出すだけで先へ進むため、
// 本来必要なビルドが飛んだまま CI が緑になりうる。そこで install ログの「弾かれた一覧」を
// 下の必須集合・許容集合と突合し、必須の欠落・未知の依存があれば CI を赤くする。
//
// 想定集合は「弾かれていて構わない依存」の名簿であり、package.json の onlyBuiltDependencies
// （＝実行を許可する依存の名簿）とは別物。両者を混同して片方をもう片方から生成しないこと。
//
// 使い方: node scripts/check-ignored-builds.mjs <install ログのパス>
// fail-closed: ログが無い / 空 / 検出行が読めない場合も非 0 で終わる（沈黙して緑にしない）。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// install lifecycleを持ち、常に弾かれていることを確認する依存。
export const REQUIRED_IGNORED_BUILDS = ['@scarf/scarf', 'prisma'];
// pnpm 9.15.4はpatch対象を警告に含める場合がある（CI実ログで2件/4件を確認）。
// braces@3.0.3 / magicast@0.5.5にはpreinstall/install/postinstallがなく、
// 配布済みJSへpatchを適用するためbuildは不要。警告が無くても欠落にはしない。
// ビルド実行許可を与える集合ではない。未知の依存は引き続き拒否する。
export const OPTIONAL_IGNORED_BUILDS = ['braces', 'magicast'];
export const EXPECTED_IGNORED_BUILDS = [
  ...REQUIRED_IGNORED_BUILDS,
  ...OPTIONAL_IGNORED_BUILDS,
].sort();

// pnpm の文言はバージョンで揺れるため、既知の 2 表現を両方見る（9.15.4 は前者）。
const MARKER_PATTERNS = [
  /The following dependencies have build scripts that were ignored\s*:\s*(.*)$/i,
  /Ignored build scripts\s*:\s*(.*)$/i,
];

// pnpm は警告を枠線で囲むことがある。枠線・装飾は落としてから読む。
const DECORATION = /[│┃|╭╮╰╯─━┌┐└┘┏┓┗┛]/g;

// 色付き出力（FORCE_COLOR が入った場合など）でも読めるよう ANSI エスケープも落とす。
// 実測では tee 経由の非 TTY 出力に色は付かないが、付いた瞬間に誤判定で赤くなるのを防ぐ保険。
const ANSI = /\u001b\[[0-9;]*m/g;

function normalizeLine(line) {
  return line.replace(ANSI, '').replace(DECORATION, ' ').replace(/\s+/g, ' ').trim();
}

function splitNames(text) {
  return text
    .split(',')
    .map((name) => name.trim().replace(/\.$/, '').trim())
    .filter((name) => name !== '');
}

/**
 * install ログから「弾かれたビルドスクリプト」の依存名を抽出する。
 * 戻り値 found=false は「検出行が無かった」＝呼び出し側が fail-closed 判定する材料。
 */
export function parseIgnoredBuilds(logText) {
  const lines = logText.split(/\r?\n/).map(normalizeLine);

  for (let i = 0; i < lines.length; i += 1) {
    let matched = null;
    for (const pattern of MARKER_PATTERNS) {
      matched = lines[i].match(pattern);
      if (matched) break;
    }
    if (!matched) continue;

    let tail = matched[1].trim();
    // 一覧が行折り返しで続く場合（末尾がカンマ）は次行を連結する。
    let cursor = i;
    while (/,$/.test(tail) && cursor + 1 < lines.length) {
      cursor += 1;
      tail = `${tail} ${lines[cursor]}`.trim();
    }
    return { found: true, names: splitNames(tail) };
  }

  return { found: false, names: [] };
}

/** 必須の欠落と、必須・許容集合にない依存を返す。 */
export function compareIgnoredBuilds(
  actualNames,
  requiredNames = REQUIRED_IGNORED_BUILDS,
  optionalNames = OPTIONAL_IGNORED_BUILDS,
) {
  const actual = new Set(actualNames);
  const allowed = new Set([...requiredNames, ...optionalNames]);
  const unexpected = [...actual].filter((name) => !allowed.has(name)).sort();
  const missing = [...new Set(requiredNames)].filter((name) => !actual.has(name)).sort();
  return { ok: unexpected.length === 0 && missing.length === 0, unexpected, missing };
}

function fail(message) {
  console.error(`[check-ignored-builds] ${message}`);
  process.exit(1);
}

function main() {
  const logPath = process.argv[2];
  if (!logPath) {
    fail(
      'install ログのパスを引数で渡してください（例: node scripts/check-ignored-builds.mjs pnpm-install.log）',
    );
  }
  if (!existsSync(logPath)) {
    fail(`install ログが見つかりません: ${logPath}`);
  }

  const logText = readFileSync(logPath, 'utf8');
  if (logText.trim() === '') {
    fail(`install ログが空です: ${logPath}`);
  }

  const { found, names } = parseIgnoredBuilds(logText);
  if (!found) {
    // cmn-0337: マーカー行の存在確認は想定名簿（EXPECTED_IGNORED_BUILDS）の中身と独立に必須化する。
    // 名簿が空になると「弾かれた依存は無いはず」と素通りする旧実装は、install ログの取得経路が
    // 壊れた（tee が消えた・ログを渡し忘れた）時に無警告で緑になる fail-open だった。マーカー行が
    // 消えるのは「pnpm の文言が変わった / install が no-op になった」のどちらかであり、いずれも
    // この検査を黙らせるべき事象ではない。将来「本当に何も弾かれない」状態になると常時赤になるが、
    // それは名簿と実態のズレを放置させない意図どおりの赤として受け入れる（設計 cmn-0337 項目2）。
    fail(
      'install ログに「弾かれたビルドスクリプト」の行が見つかりませんでした。' +
        ' 疑う順は ①install が no-op になった（node_modules の cache ステップ追加など＝警告自体が出ない）' +
        ' ②pnpm の文言が変わった（MARKER_PATTERNS を更新する）',
    );
  }

  const { ok, unexpected, missing } = compareIgnoredBuilds(names);
  if (!ok) {
    if (unexpected.length > 0) {
      console.error(
        `[check-ignored-builds] 想定外に弾かれた依存: ${unexpected.join(', ')}` +
          '（そのビルドが必要かを確認し、必須・許容集合または pnpm.onlyBuiltDependencies を見直してください）',
      );
    }
    if (missing.length > 0) {
      console.error(
        `[check-ignored-builds] 弾かれる想定だったのにログに無い依存: ${missing.join(', ')}` +
          '（依存の消失や実行許可への移動を確認し、REQUIRED_IGNORED_BUILDS を見直してください）',
      );
    }
    process.exit(1);
  }

  console.log(
    `[check-ignored-builds] OK: 必須の警告が揃い、弾かれた ${names.length} 件は許容集合内（${names.join(', ')}）`,
  );
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}
