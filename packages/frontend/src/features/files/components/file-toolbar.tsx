'use client';

import {
  ClipboardCopy,
  Download,
  FolderPlus,
  MessageSquare,
  RotateCcw,
  Tag,
  Trash2,
  Upload,
} from 'lucide-react';

/**
 * ツールバー（アップロード / ダウンロード / 新規フォルダ / タグ付け / チャット共有 / パスをコピー / 削除）。
 * ダウンロード・チャット共有・パスをコピー・削除は選択が 0 件のとき disabled。
 * 選択項目の扱いは 3 語で言い分ける（d735）: 選ぶ＝行のチェック、移す＝行をフォルダへドラッグ、
 * コピー＝選択項目のパスをクリップボードへ写す（ファイルの複製ではないためボタン文言もそう示す）。
 * タグ付けは「1 件以上選択」のとき有効（ファイル/フォルダ混在可・canTagAssign / rete-files-0033/0034）。
 * 1 件＝置換 / 複数＝追加はオーバーレイ側で出し分ける。
 * タグ管理（マスタ）はサイドバーへ移設（rete-files-0009）。
 * お気に入り登録ボタンは撤去（rete-files-0030・rete-files-0023 関連）。★登録は Home 側導線へ寄せる。
 * 配置は正本 comp-toolbar に従い、一覧に対する主要アクション（新規フォルダ）と表示補助（リセット）を
 * 右端の分離グループへ置き、破壊操作（削除）をその末尾に置く。
 * 削除はモック正本が行内アイコンだが、開発統括判断でツールバー一括削除に寄せた意図的逸脱（docs/decisions 記録）。
 * アップロード（multipart）・ダウンロード（blob 保存）・削除（DELETE API）・新規フォルダ（インライン作成 API）・タグ（CRUD/付与 API）は実挙動。チャット共有は後続フェーズ。
 */
export function FileToolbar({
  selectionCount,
  canTagAssign,
  uploading,
  deleting,
  onUpload,
  onDownload,
  onNewFolder,
  onShareChat,
  onShareClip,
  onTagAssign,
  onReset,
  onDelete,
}: {
  selectionCount: number;
  /** タグ付けボタンの活性（1 件以上選択時 true・ファイル/フォルダ混在可）。 */
  canTagAssign: boolean;
  uploading: boolean;
  deleting: boolean;
  onUpload: () => void;
  onDownload: () => void;
  onNewFolder: () => void;
  onShareChat: () => void;
  onShareClip: () => void;
  onTagAssign: () => void;
  /** ソート順・列幅を既定へリセット（確認なし即実行 / fil-0054）。 */
  onReset: () => void;
  onDelete: () => void;
}) {
  const noSelection = selectionCount === 0;
  return (
    <div className="file-toolbar">
      <button type="button" className="file-tb-btn" onClick={onUpload} disabled={uploading}>
        <Upload className="h-3.5 w-3.5" aria-hidden="true" />
        {uploading ? 'アップロード中…' : 'アップロード'}
      </button>
      <button type="button" className="file-tb-btn" onClick={onDownload} disabled={noSelection}>
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        ダウンロード
      </button>
      <button type="button" className="file-tb-btn" onClick={onTagAssign} disabled={!canTagAssign}>
        <Tag className="h-3.5 w-3.5" aria-hidden="true" />
        タグ付け
      </button>
      <button type="button" className="file-tb-btn" onClick={onShareChat} disabled={noSelection}>
        <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
        チャット共有
      </button>
      <button
        type="button"
        className="file-tb-btn"
        onClick={onShareClip}
        disabled={noSelection}
        title="選択した項目のパスをクリップボードへコピーする"
      >
        <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
        パスをコピー
      </button>
      {/* 正本 comp-toolbar: 主要アクションは右端へ分離し、破壊操作はその側の末尾に置く
          （リセットは表示状態の補助操作＝右端グループの先頭）。 */}
      <span className="file-tb-spacer" aria-hidden="true" />
      <button
        type="button"
        className="file-tb-btn"
        onClick={onReset}
        title="ソート順と列幅を既定へ戻す"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        リセット
      </button>
      <button type="button" className="file-tb-btn" onClick={onNewFolder}>
        <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
        新規フォルダ
      </button>
      <button
        type="button"
        className="file-tb-btn file-tb-btn-danger"
        onClick={onDelete}
        disabled={noSelection || deleting}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        {deleting ? '削除中…' : '削除'}
      </button>
    </div>
  );
}
