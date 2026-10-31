'use client';

import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { highlightMatches } from '@/lib/highlight';
import { kindLabel } from '../lib/format';
import { folderPathSegments } from '../lib/tree';
import { PATH_SEP } from '../lib/path-link';
import type { SearchResultItem, TreeNode } from '../lib/types';
import { FileIcon } from './file-icon';

/** 手動ダブルクリック検出の閾値（ms）。OS のダブルクリック上限を考慮し余裕を持たせる（fil-0046）。 */
const DOUBLE_CLICK_MS = 400;

/** 列定義（種類 / 名前 / 場所）。selectable 時は先頭にチェック列（36px）を足す。 */
function SearchColGroup({ selectable }: { selectable: boolean }) {
  return (
    <colgroup>
      {selectable && <col style={{ width: '36px' }} />}
      <col style={{ width: '96px' }} />
      <col />
      <col style={{ width: '44%' }} />
    </colgroup>
  );
}

/** SearchResults に選択機能を与える時に渡す id 基点の選択ハンドル（fil-0051）。 */
export interface SearchSelection {
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  setMany: (ids: string[], checked: boolean) => void;
}

/**
 * テキスト横断検索・タグ横断検索で共用する右ペイン結果一覧（fil-0045）。
 * 種類 / 名前 / 場所（フルパス）の 3 列テーブル。フォルダ行クリックで
 * フォルダ（自身）へナビゲートする。呼び出し元がエラー文・空文・上限バナー文を渡すことで tag/text 両用に対応する。
 *
 * selection を渡すと（fil-0051）通常表示と同型のチェック選択列を先頭に足す。選択は **id 基点**（複数フォルダ
 * 横断のため別フォルダ同名ファイルが衝突しない）。チェック対象はファイル行のみ＝フォルダ行は選択対象外で、
 * クリック=ナビゲート / ダブルクリック=フォルダを開く の従来挙動を保つ。選択したファイルは呼び出し元の
 * ツールバー（ダウンロード/タグ付け/チャット共有/パスをコピー/削除）が通常表示と同じく扱う。
 */
export function SearchResults({
  results,
  tree,
  loading,
  error,
  truncated = false,
  errorText,
  emptyText,
  truncatedText,
  onNavigate,
  onOpenFolder,
  selection,
  keyword,
}: {
  results: SearchResultItem[];
  tree: TreeNode[];
  loading: boolean;
  error: boolean;
  /** 結果が上限に達して切り詰められている場合 true（タグ検索の fil-0043 対応）。 */
  truncated?: boolean;
  /** エラー時に右ペインに表示するメッセージ。 */
  errorText: string;
  /** ヒット 0 件時に右ペインに表示するメッセージ。 */
  emptyText: string;
  /** truncated=true のとき表示するバナーテキスト（省略時は非表示）。 */
  truncatedText?: string;
  /** ヒット行クリックの遷移先フォルダ id（フォルダ=自身 / ファイル=所属フォルダ）。 */
  onNavigate: (folderId: string) => void;
  /** 検索ハイライト対象キーワード（fil-0065）。空/未指定はハイライトなし。 */
  keyword?: string;
  /**
   * フォルダ行をダブルクリックした時に呼ぶハンドラ（fil-0046）。
   * native onDoubleClick ではなく、閾値内の同一フォルダ行への 2 回目クリックを手動検出して呼ぶ
   * （1 クリック目の onNavigate→selectFolder の再レンダーで native dblclick が不発になる実機バグへの対応）。
   * タグ絞込結果で「フォルダを開く＋フィルタ解除」を同時に行うために使う。
   */
  onOpenFolder?: (folderId: string) => void;
  /**
   * id 基点の選択ハンドル（fil-0051）。渡すとチェック選択列を出し、ファイル行を選択できる。
   * 未指定なら従来どおり選択列なし（ファイル行クリック=所属フォルダへナビゲート）。
   */
  selection?: SearchSelection;
}) {
  const selectable = !!selection;
  // 選択対象（ファイルのみ・フォルダは選択対象外）の id 集合。全選択チェックボックスの基準に使う。
  const fileIds = useMemo(
    () => results.filter((it) => it.kind === 'file').map((it) => it.id),
    [results],
  );
  const selectedCount = selection ? fileIds.filter((id) => selection.has(id)).length : 0;
  const allChecked = selectable && fileIds.length > 0 && selectedCount === fileIds.length;
  const indeterminate = selectable && selectedCount > 0 && selectedCount < fileIds.length;

  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  // フォルダ行の「ダブルクリックで開く」を手動検出する（fil-0046 真因対応）。
  // native の onDoubleClick は、1 クリック目の onNavigate→selectFolder が再レンダーを起こすと
  // ブラウザの dblclick 合体判定が壊れて発火しないことがある（実マウスで再現・合成 dblclick では再現せず）。
  // click は各クリックで必ず発火するため、直近クリックの id と時刻を ref（再レンダー耐性）で追い、
  // 同一フォルダ行への閾値内 2 回目クリックを「開く」として扱う。
  const lastFolderClickRef = useRef<{ id: string; t: number } | null>(null);
  // 結果集合が切り替わったら直近クリックを破棄する（旧画面のクリックが新画面の同 id フォルダで誤発火するのを防ぐ）。
  useEffect(() => {
    lastFolderClickRef.current = null;
  }, [results]);

  if (error) {
    return (
      <section className="sp-card file-list-card">
        <div className="file-empty">{errorText}</div>
      </section>
    );
  }
  return (
    <section className="sp-card file-list-card">
      <div className="file-list-head">
        <table className="sp-table file-table tag-search-table">
          <SearchColGroup selectable={selectable} />
          <thead>
            <tr>
              {selectable && (
                <th className="col-check">
                  <input
                    ref={allRef}
                    type="checkbox"
                    checked={allChecked}
                    disabled={fileIds.length === 0}
                    onChange={(e) => selection!.setMany(fileIds, e.target.checked)}
                    aria-label="すべて選択"
                  />
                </th>
              )}
              <th>種類</th>
              <th>名前</th>
              <th>場所</th>
            </tr>
          </thead>
        </table>
      </div>
      <div className="file-list-scroll">
        <table className="sp-table file-table tag-search-table">
          <SearchColGroup selectable={selectable} />
          <tbody>
            {results.length === 0 && (
              <tr>
                <td colSpan={selectable ? 4 : 3} className="file-empty">
                  {loading ? <Spinner className="h-4 w-4 inline-block" /> : emptyText}
                </td>
              </tr>
            )}
            {results.map((it) => {
              // フォルダ・ファイルとも「場所」は所属（親）フォルダのフルパス。クリック遷移先はフォルダ=自身 / ファイル=親。
              const segs = it.parentFolderId ? folderPathSegments(tree, it.parentFolderId) : [];
              const path = segs.join(PATH_SEP);
              const navTo = it.kind === 'folder' ? it.id : it.parentFolderId;
              const isFile = it.kind === 'file';
              const isSelected = selectable && isFile && selection!.has(it.id);
              // selectable モードのファイル行は通常表示と同じく行クリック=選択トグル（ナビゲートしない）。
              // フォルダ行は従来どおりクリック=ナビゲート / ダブルクリック=フォルダを開く。
              // ダブルクリックは native onDoubleClick ではなく手動検出する（fil-0046・上記 ref コメント参照）。
              const handleClick = (e: React.MouseEvent) => {
                if ((e.target as HTMLElement).closest('input, a')) return;
                if (selectable && isFile) {
                  // フォルダ以外のクリックは直近フォルダクリックの追跡を破棄する
                  // （folder→file→folder の連打で 2 回目フォルダが誤って open しないように・fil-0046）。
                  lastFolderClickRef.current = null;
                  selection!.toggle(it.id);
                  return;
                }
                if (it.kind === 'folder' && onOpenFolder) {
                  const now = Date.now();
                  const last = lastFolderClickRef.current;
                  if (last && last.id === it.id && now - last.t < DOUBLE_CLICK_MS) {
                    // 閾値内の同一フォルダ行への 2 回目＝ダブルクリック → フォルダを開く（＋呼び出し元でフィルタ解除）。
                    lastFolderClickRef.current = null;
                    onOpenFolder(it.id);
                    return;
                  }
                  // 1 回目＝単クリック。従来どおりナビゲートし、2 回目に備えて時刻を記録。
                  lastFolderClickRef.current = { id: it.id, t: now };
                } else {
                  // フォルダを開くパス以外（onOpenFolder 未指定 / ファイル行のナビゲート等）はクリック追跡を破棄。
                  lastFolderClickRef.current = null;
                }
                if (navTo) onNavigate(navTo);
              };
              return (
                <tr
                  key={`${it.kind}:${it.id}`}
                  className={cn('file-row', 'tag-search-row', isSelected && 'is-selected')}
                  onClick={handleClick}
                >
                  {selectable && (
                    <td>
                      {isFile ? (
                        <input
                          type="checkbox"
                          className="file-check"
                          checked={isSelected}
                          onChange={() => selection!.toggle(it.id)}
                          aria-label={`${it.name} を選択`}
                        />
                      ) : null}
                    </td>
                  )}
                  <td className="col-kind">{kindLabel(it)}</td>
                  <td className="col-name">
                    <div className="file-name-cell">
                      <FileIcon item={{ kind: it.kind, name: it.name }} />
                      <span title={it.name}>{highlightMatches(it.name, keyword)}</span>
                    </div>
                  </td>
                  <td className="tag-search-loc" title={path}>
                    {path || '（ルート）'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="file-list-foot">
        <span>
          {loading && results.length === 0 ? '検索中…' : `${results.length} 件ヒット`}
          {selectable && selectedCount > 0 && ` — ${selectedCount} 件選択中`}
        </span>
        {truncated && truncatedText && (
          <span className="tag-search-truncated-notice">{truncatedText}</span>
        )}
      </div>
    </section>
  );
}
