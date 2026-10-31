/**
 * 構造参照の解決の純粋処理（FL+1・設計 §2.2 / §2.3）。DB を知らず、素材だけを受ける。
 *
 * - 入力 ids の正規化（カンマ区切り・重複除去・上限 REF_RESOLVE_MAX での切り捨て）
 * - 祖先の辿り（1 クエリでは取れない親の段を、与えられた引く関数で集める）
 * - パス表記（root → 対象の順に名前を連結する）
 *
 * サービスはここを通してパスを組み、テストは素材だけで表記を固定できる。
 *
 * 注意: 祖先の辿りは Map ではなく「親 id の連なりを表す配列（chain）」で持つ。
 * 単純な Map の反復で書くと、この repo の型検査設定（target ES2021・Map 反復）で
 * 変換後に反復が空振りする実測があり、テストで A ＞ C のように祖先が落ちる。
 * 配列なら変換に依存しない。
 */
import { FOLDER_MAX_DEPTH, REF_PATH_SEP, REF_RESOLVE_MAX } from './files.constants';

/** 参照の対象になりうるフォルダ 1 行（spaceId は対象なら必須・祖先なら不要）。 */
export interface RefFolderRow {
  id: string;
  name: string;
  parentFolderId: string | null;
  spaceId?: string;
}

/** フォルダ行の並びから、id で行を引く（Map の反復を使わない素朴な検索）。 */
function findRow(rows: RefFolderRow[], id: string): RefFolderRow | undefined {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].id === id) return rows[i];
  }
  return undefined;
}

/** 行の並びに無い id を、重複を除いて足す。 */
function addRows(rows: RefFolderRow[], add: RefFolderRow[]): RefFolderRow[] {
  const out = rows.slice();
  for (let i = 0; i < add.length; i++) {
    if (!findRow(out, add[i].id)) out.push(add[i]);
  }
  return out;
}

/**
 * カンマ区切りの id を、空・重複を除いた上限つきの配列にする（設計 §2.3 の 20 件固定上限）。
 * 空白は前後だけ落とす（id は UUID なので内部の空白はそのまま＝存在しない id として扱われる）。
 */
export function parseRefIds(rawIds: string | undefined): string[] {
  if (!rawIds) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of rawIds.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= REF_RESOLVE_MAX) break;
  }
  return out;
}

/**
 * パス表記に要る祖先を root まで辿れる形へ揃える。
 *
 * 初段（対象・所属フォルダ）を鍵にした範囲を必ず辿り直し、その範囲で行の無い id だけを
 * `fetch` で引く（既知の行が混ざっていても、対象から root までの鎖を欠かさない）。
 * 深度上限で必ず止まり、引けなかった id（不在・非可視）は再試行しない。
 * `fetch` は space で絞られた行を返す前提（他 space の名前をパスへ混ぜない）。
 */
export async function collectRefAncestors(
  seedIds: string[],
  knownTargets: RefFolderRow[],
  knownParents: RefFolderRow[],
  fetch: (ids: string[]) => Promise<RefFolderRow[]>,
): Promise<RefFolderRow[]> {
  let rows = addRows(addRows([], knownParents), knownTargets);

  // 対象から上へ辿り、行の無い id（引き残し）を集める。試行済みの id は除く。
  const missingFromSeeds = (attempted: string[]): string[] => {
    const out: string[] = [];
    const visited: string[] = [];
    let frontier: string[] = [];
    for (let i = 0; i < seedIds.length; i++) {
      if (frontier.indexOf(seedIds[i]) === -1) frontier.push(seedIds[i]);
    }
    for (let depth = 0; depth <= FOLDER_MAX_DEPTH && frontier.length > 0; depth++) {
      const parents: string[] = [];
      for (let i = 0; i < frontier.length; i++) {
        const id = frontier[i];
        if (visited.indexOf(id) !== -1) continue;
        visited.push(id);
        const row = findRow(rows, id);
        if (!row) {
          if (attempted.indexOf(id) === -1 && out.indexOf(id) === -1) out.push(id);
          continue;
        }
        const parent = row.parentFolderId;
        if (parent && visited.indexOf(parent) === -1 && parents.indexOf(parent) === -1)
          parents.push(parent);
      }
      frontier = parents;
    }
    return out;
  };

  const attempted: string[] = [];
  let pending = missingFromSeeds(attempted);
  for (let depth = 0; depth <= FOLDER_MAX_DEPTH && pending.length > 0; depth++) {
    for (let i = 0; i < pending.length; i++) attempted.push(pending[i]);
    const fetched = await fetch(pending);
    rows = addRows(rows, fetched);
    // 引けなかった id（不在・非可視）は再試行しない（同じ結果になる）。
    pending = missingFromSeeds(attempted);
  }
  return rows;
}

/** 対象の親から root までの名前を root の順で並べる（循環しても既訪で止まる）。 */
function ancestorNames(rows: RefFolderRow[], folderId: string): string[] {
  const names: string[] = [];
  const seen: string[] = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].id === folderId) seen.push(folderId);
  let current: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].id === folderId) {
      current = rows[i].parentFolderId;
      break;
    }
  }
  let depth = 0;
  while (current && depth <= FOLDER_MAX_DEPTH) {
    depth += 1;
    let hit = false;
    for (let i = 0; i < seen.length; i++) if (seen[i] === String(current)) hit = true;
    if (hit) break;
    seen.push(String(current));
    let row: RefFolderRow | undefined = undefined;
    for (let i = 0; i < rows.length; i++) if (rows[i].id === current) row = rows[i];
    if (!row) break;
    names.unshift(row.name);
    current = row.parentFolderId;
  }
  return names;
}

/**
 * 対象の現在のパス表記（root → 祖先 → 対象名を REF_PATH_SEP で連結）。
 * 対象自身の行は名前を別に受け取るので親から辿る（対象の名前を二重に載せない）。
 */
export function refPath(rows: RefFolderRow[], folderId: string, name: string): string {
  const names = ancestorNames(rows, folderId);
  return [...names, name].join(REF_PATH_SEP);
}

/** フォルダの帰属 space（対象自身か祖先の spaceId から引く・引けなければ null）。 */
export function spaceIdOfRef(rows: RefFolderRow[], folderId: string): string | null {
  const own = findRow(rows, folderId);
  if (own?.spaceId) return own.spaceId;
  const seen: string[] = [folderId];
  let current: string | null = own?.parentFolderId ?? null;
  for (let depth = 0; depth <= FOLDER_MAX_DEPTH && current; depth++) {
    if (seen.indexOf(current) !== -1) break;
    seen.push(current);
    const row = findRow(rows, current);
    if (row?.spaceId) return row.spaceId;
    current = row?.parentFolderId ?? null;
  }
  return null;
}
