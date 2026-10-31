'use client';

import { ArrowLeft, ArrowRight, ChevronRight, RotateCcw, Search } from 'lucide-react';
import { FavoriteToggle, type FavoriteTarget } from '@/features/shell';
import { cn } from '@/lib/utils';
import type { FolderCrumb } from '../lib/types';
// fil-0094: TagDto.archived 必須化に伴い、useTagMaster の TagLike（archived 任意の最小形）で受ける。
// 本コンポーネントは TagFilterDropdown へ渡すだけで archived を参照しない。
import type { TagLike } from '../hooks/use-tag-master';
import { TagFilterDropdown } from '@/components/tags/tag-filter-dropdown';

/** ピッカー流用時（タグ props 未指定）のフォールバック。空集合と no-op で TagFilterDropdown を無害化する。 */
const EMPTY_TAG_FILTER: Set<string> = new Set();
const noop = () => {};

/**
 * トップバー（パンくずアドレスバー + グローバル検索 + タグ絞り込み / モック file-topbar 移植）。
 * パンくずの祖先セグメントはクリックで当該フォルダへ移動（最後＝現在地は非リンク）。
 * 戻る/進むボタンは意匠のみ（モック同様 no-op）。
 * 検索ボックスは type=search＝値ありでブラウザ標準の×を出す（旧・独自×は mdl-0033 で撤去）。
 * 検索欄フォーカス中の Esc で入力を即クリアする（IME 変換確定の Esc は誤クリアしない・Desk 同挙動 / rete-files-0039）。
 * 検索の右隣にタグ絞り込みドロップダウンを置く（rete-files-0013・旧 TagFilterBar を置換）。
 * 検索・タグ群は右寄せをやめ、パンくずの直後に左詰めで連結する（rete-files-0015/0016）。
 * stacked=true（メインの File タブ）では 3 段構成（①ディレクトリ管理 ②フィルタ ③ファイル操作）に積む（rete-files-0038）。
 * 添付ピッカー流用時は stacked 未指定で従来の 1 行レイアウトを保つ。
 */
export function FileTopbar({
  crumb,
  search,
  onSearchChange,
  onNavigate,
  hideNav = false,
  favorite,
  tags = [],
  tagFilterActive,
  tagFilterLoading = false,
  onTagToggle,
  onTagClear,
  onClearFilters,
  stacked = false,
}: {
  crumb: FolderCrumb[];
  search: string;
  onSearchChange: (value: string) => void;
  /** クリックした祖先パンくずのフォルダ id へ移動。 */
  onNavigate: (folderId: string) => void;
  /** 戻る/進む（意匠のみ no-op）を隠す。添付ピッカーでは不要（rete-desk-0099）。 */
  hideNav?: boolean;
  /** 現在フォルダの★トグル対象（HM-1-4）。未指定（フォルダ未確定 / 添付ピッカー）なら★非表示。 */
  favorite?: FavoriteTarget;
  /**
   * タグ絞り込み（rete-files-0013）。マスタ一覧 + 選択集合 + 増減/全解除ハンドラ。
   * 添付ピッカー（file-picker-overlay）はタグ絞り込みを出さないため任意（未指定＝ボタン非表示）。
   */
  tags?: TagLike[];
  tagFilterActive?: Set<string>;
  tagFilterLoading?: boolean;
  onTagToggle?: (id: string) => void;
  onTagClear?: () => void;
  /** フィルタ一括クリア（検索＋タグ絞り込みを両方リセット・Desk 意匠 / rete-files-0036）。未指定＝クリアボタン非表示。 */
  onClearFilters?: () => void;
  /** メイン File タブの 3 段レイアウト（rete-files-0038）。添付ピッカーは未指定＝従来 1 行。 */
  stacked?: boolean;
}) {
  return (
    <div className={cn('file-topbar', stacked && 'is-stacked')}>
      <div className="file-topbar-crumb">
        {!hideNav && (
          <>
            <span className="tc-nav">
              <button type="button" className="tc-nav-btn" title="戻る" aria-label="戻る">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <button type="button" className="tc-nav-btn" title="進む" aria-label="進む">
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </span>
            <span className="tc-sep" />
          </>
        )}
        {/* fil-0068: tc-path{flex:1} でウィンドウ右端へ押し出されないよう★をパンくず直後へ寄せるが、
            tc-path 自体は overflow:hidden の省略対象（長いパスでセグメントが切れる）なので、★を
            tc-path の内側に置くと長いパスで★ごとクリップされ押せなくなる（code-reviewer 検出 HIGH）。
            tc-path-row（overflow なし）で外側を包み、★は tc-path の外・tc-path-row の末尾に置くことで
            クリップ対象から外しつつ、パンくず直後の隣接表示は保つ。 */}
        <span className="tc-path-row">
          <span className="tc-path">
            {crumb.map((seg, i) => {
              const isLast = i === crumb.length - 1;
              // d524: 現在フォルダ名は★（お気に入り）と同じボタンの中へ移した（下の FavoriteToggle）。
              // 名前とアイコンを 1 つのオブジェクトにするため、パンくず側では名前を描かない。
              const nameInFavorite = isLast && favorite != null;
              return (
                <span key={`${seg.id}-${i}`} className="tc-seg">
                  {/* d524: パンくず先頭のフォルダアイコンは置かない（開発統括指示）。
                      現在フォルダ名の右に付くハートで対象は分かるため、行頭の飾りを削る。
                      区切り（＞）は祖先との関係を示すので残す。 */}
                  {i > 0 && <ChevronRight className="h-3 w-3" aria-hidden="true" />}
                  {isLast ? (
                    nameInFavorite ? null : (
                      <span className="tc-current">{seg.name}</span>
                    )
                  ) : (
                    <button type="button" className="tc-link" onClick={() => onNavigate(seg.id)}>
                      {seg.name}
                    </button>
                  )}
                </span>
              );
            })}
          </span>
          {/* d524: 現在フォルダは「名前＋ハート」の 1 ボタン。ツールチップ・読み上げも名前込みで
              1 行になり、何に係っているかがその場で分かる。tc-path（省略対象）の外に置く理由は
              fil-0068（長いパスでアイコンごとクリップされる）と同じ。 */}
          {favorite && <FavoriteToggle target={favorite} showLabel />}
        </span>
      </div>
      <div className="file-topbar-tools">
        <div className="file-topbar-search">
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          <input
            // mdl-0033: 「値あり」表現を Desk 形へ統一＝type=search（入力中はブラウザ標準の×）。
            // 旧・独自×ボタン（rete-files-0014 の .file-topbar-search-clear）は標準×と二重になるため撤去。
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            // Esc で入力をクリア（IME 変換確定の Esc は誤クリアしない・Desk 同挙動 / rete-files-0039）。
            // メイン File タブ（stacked）限定。添付ピッカー流用時（stacked=false）は Esc を素通しして
            // オーバーレイの「Esc で閉じる」（file-picker-overlay の window keydown）を壊さない。
            onKeyDown={(e) => {
              if (stacked && e.key === 'Escape' && !e.nativeEvent.isComposing) onSearchChange('');
            }}
            placeholder="ファイルの検索"
            autoComplete="off"
            aria-label="ファイルの検索"
          />
        </div>
        <TagFilterDropdown
          tags={tags}
          active={tagFilterActive ?? EMPTY_TAG_FILTER}
          loading={tagFilterLoading}
          onToggle={onTagToggle ?? noop}
          onClear={onTagClear ?? noop}
        />
        {/* フィルタ一括クリア（検索＋タグ絞り込みを両方リセット・Desk 意匠 / rete-files-0036）。
            条件の有無に関わらず常時表示（Desk のクリアボタンに倣う）。 */}
        {onClearFilters && (
          <button
            type="button"
            className="file-filter-clear"
            title="フィルタをクリア"
            aria-label="フィルタをクリア"
            onClick={onClearFilters}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>クリア</span>
          </button>
        )}
      </div>
    </div>
  );
}
