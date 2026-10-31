#!/usr/bin/env node
// ADR 索引の鮮度検査（docs/decisions/README.md のマーカー区間 <-> 各 ADR の frontmatter）。
//
// なぜ必要か: 索引は生成物で、生成を回す手順がコミットにも CI にも無く、ADR を足した後に
// 索引へ載らない ADR が静かに増えた（実測で 1 件ずれていた）。生成は repo 外の道具
// （D:/Dev/tool/scripts/gen-adr-index.mjs）にあり repo からは呼べないため、ここでは索引を
// 書き換えずに「古い／載っていない ADR がある」ことを赤で止める（再生成は手元で回す）。
//
// 正本は各 ADR の frontmatter。期待値は gen-adr-index.mjs と同じ規則で組み立てる
// （表の行の形・状態の印・日付の優先順）。規則を変える時は両方の印をそろえる。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = join(REPO_ROOT, 'docs', 'decisions');

// マーカーの文言は gen-adr-index.mjs が書く行と同一でなければ内外で分からない。
// マーカーは検査の中でだけ読み、外へ出す口は置かない（外から読みたくなった時に開ける）。
const ADR_INDEX_BEGIN =
  '<!-- ADR-INDEX:BEGIN — 自動生成。手編集しない（scripts/gen-adr-index.mjs） -->';
const ADR_INDEX_END = '<!-- ADR-INDEX:END -->';

// 状態の印は docs/decisions/README.md の凡例（状態語義の正本）が挙げる 4 つを写す。
// 語義の正本は README なので、凡例の語が変わったらここも合わせる。
const STATUS_MARK = {
  active: '🟢 active',
  resolved: '✅ resolved',
  'partially-addressed': '🟡 partially-addressed',
  superseded: '⛔ superseded',
};

/** ADR 本体のファイル名か（4 桁連番 + .md）。README 等は拾わない。 */
export function isAdrFile(name) {
  return /^[0-9]{4}-.*\.md$/.test(name);
}

/** frontmatter（--- で囲まれた YAML 風ブロック）を素朴に読む。無ければ null。 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const out = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** frontmatter を持たない ADR 向けの fallback（見出しと散文 Status/Date 行から拾う）。 */
function parseFallback(text, file) {
  const title =
    text.match(/^#\s*(?:ADR\s*)?[0-9]{4}[:—-]?\s*(.+)$/m)?.[1]?.trim() ??
    file.replace(/^[0-9]{4}-/, '').replace(/\.md$/, '');
  const status = text.match(/^- Status:\s*\**([A-Za-z-]+)\**/m)?.[1]?.toLowerCase() ?? '';
  const date = text.match(/^- Date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/m)?.[1] ?? '';
  return { title, status, date };
}

/** decisions ディレクトリの ADR を読み、索引の表に出す 1 行分の値にする。 */
export function collectAdrRows(dir = DEFAULT_DIR) {
  const files = readdirSync(dir).filter(isAdrFile).sort();
  return files.map((file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    // `??` でなく `||` なのは、値なしの `id:` を空文字として通さないため（空欄回帰の防止）。
    const fm = parseFrontmatter(text) ?? parseFallback(text, file);
    return {
      id: fm.id || file.slice(0, 4),
      file,
      title: (fm.title ?? '').replace(/\|/g, '\\|'),
      status: fm.status || '—',
      supersededBy: (fm.superseded_by ?? '').replace(/\|/g, '\\|') || '—',
      date: fm.last_updated || fm.date || '',
    };
  });
}

/** 索引の表の 1 行を組み立てる（gen-adr-index.mjs と同じ形）。 */
export function formatIndexRow(r) {
  return `| [${r.id}](${r.file}) | ${r.title} | ${STATUS_MARK[r.status] ?? r.status} | ${r.supersededBy} | ${r.date} |`;
}

/** 表に載せられない状態を洗う。凡例に無い語は印が付かず素の語で並び、読み手に伝わらない。 */
export function findUnknownStatuses(rows) {
  return rows.filter((r) => !(r.status in STATUS_MARK)).map((r) => `${r.id}: ${r.status}`);
}

/** 状態の語ごとの件数（索引の要約行と同じ数え方。印の付かない語は素の語で数える）。 */
export function countStatuses(rows) {
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

/** マーカー区間の外側（件数の要約・凡例・マーカー行）は生成時の説明文なので比較に含めない。 */
const HEADER_ROW = '| No | 判断 | 状態 | 置換先 | 日付 |';
const SEPARATOR_ROW = '|---|---|---|---|---|';

/**
 * 索引の鮮度を判定する。
 * - マーカーが無ければ例外（読めないまま緑にしない）
 * - staleRows: 表の行が、実体から組み立てた行と不一致（同じ順・同じ数）
 * - missing: 表の行として載っていない ADR（見出しや凡例に番号が出ていても数えない）
 */
export function checkAdrIndex(dir = DEFAULT_DIR) {
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) {
    throw new Error(`索引の README がありません: ${readmePath}`);
  }
  const readme = readFileSync(readmePath, 'utf8');
  const begin = readme.indexOf(ADR_INDEX_BEGIN);
  const end = readme.indexOf(ADR_INDEX_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`索引のマーカー（ADR-INDEX:BEGIN / END）がありません: ${readmePath}`);
  }

  const rows = collectAdrRows(dir);
  const listed = readme
    .slice(begin + ADR_INDEX_BEGIN.length, end)
    .split(/\r?\n/)
    .filter((line) => /^\|\s*\[[0-9]{4}\]\(/.test(line));
  const expected = rows.map(formatIndexRow);

  const staleRows = [];
  const length = Math.max(expected.length, listed.length);
  for (let i = 0; i < length; i++) {
    if (expected[i] !== listed[i])
      staleRows.push({ line: i, expected: expected[i], actual: listed[i] });
  }

  const listedIds = new Set(
    listed.map((line) => line.match(/^\|\s*\[\s*([0-9]{4})\s*\]\(/)?.[1]).filter(Boolean),
  );
  const missing = rows.map((r) => r.id).filter((id) => !listedIds.has(id));

  return {
    dir,
    rows,
    staleRows,
    missing,
    unknownStatuses: findUnknownStatuses(rows),
    statusCounts: countStatuses(rows),
    headerPresent: readme.includes(HEADER_ROW) && readme.includes(SEPARATOR_ROW),
    readmePath,
  };
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const dir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : DEFAULT_DIR;
  try {
    const result = checkAdrIndex(dir);
    const stale = result.staleRows.length > 0 || !result.headerPresent;
    if (stale) {
      console.error(
        `stale: ${result.readmePath} — 索引の表が各 ADR の frontmatter と一致しません。` +
          `node D:/Dev/tool/scripts/gen-adr-index.mjs ${dir} で再生成してください。`,
      );
      for (const m of result.staleRows.slice(0, 5)) {
        console.error(`  + ${m.expected ?? '(行なし)'}`);
        console.error(`  - ${m.actual ?? '(行なし)'}`);
      }
    }
    if (result.missing.length) {
      console.error(
        `missing: ${result.readmePath} — 表に載っていない ADR: ${result.missing.join(', ')}`,
      );
    }
    if (result.unknownStatuses.length) {
      const known = Object.keys(STATUS_MARK).join(' / ');
      console.error(
        `unknown-status: ${result.readmePath} — 凡例に無い状態の語: ${result.unknownStatuses.join(', ')}` +
          `（使える語: ${known}）`,
      );
    }
    if (stale || result.missing.length || result.unknownStatuses.length) process.exit(1);
    console.log(`up-to-date: ${result.readmePath} (${result.rows.length} 件)`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
