'use client';

/**
 * タグ選択オーバーレイ共通コア（hom-0055）。
 * プレゼンテーショナル共通コア: 選択肢トグル一覧 + 保存/キャンセル フッター。
 * 永続化（DB 保存）は呼び出し側（onConfirm）が担う。
 * - Files 側: TagAssignOverlay がこのコアをラップし、onConfirm で setFileTags / setFolderTags / assignTagsBatch を呼ぶ。
 * - 部品名は TagPickerOverlay のままだが、タグに限らずロール等の単一選択リストにも使う（ロール選択は
 *   お知らせ側で SelectDropdown へ移行済のため、現利用は Files のタグ付けのみ）。
 *
 * シェルは共通 primitive OverlayDialog（fil-0080・backdrop=曇りガラス・focus trap / inert 隔離 /
 * Esc・破棄確認は primitive 内蔵）。カード面は file-overlay-panel 体裁を children として維持する。
 * 一覧は framed list 意匠（.desk-catset-table / .tag-master-table と同型＝外枠1本＋行間下線・最終行は
 * 線なし）に揃え、最上段に「タグ名」ヘッダを置く（fil-0080・検索フィルタではなく表ヘッダの規約＝
 * .tag-master-th / .desk-catset-th と同型）。キャンセル・保存ボタンは中央寄せ＋フッター上部の区切り線を
 * 撤去するため、共有 .file-overlay-foot に .tag-picker-foot を併記して当該オーバーレイへ閉じ込める。
 */

import { useState } from 'react';
import { Check, Tags } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OverlayCloseButton, OverlayDialog } from '@/components/ui/overlay-dialog';
import { OverlayHeader } from '@/components/ui/overlay-header';
import { Spinner } from '@/components/ui/spinner';
import { TagIcon } from './tag-icon';

export interface TagPickerTag {
  id: string;
  name: string;
  /** アイコン/色は任意（ロール選択等アイコンを持たない選択肢は省略可）。 */
  icon?: string;
  color?: string;
}

export interface TagPickerOverlayProps {
  /** 選択可能な項目一覧（タグマスタ等）。 */
  tags: TagPickerTag[];
  /** 初期選択済み ID 集合。 */
  initialSelected: string[];
  selectionMode?: 'single' | 'multiple';
  /** loading 中かどうか（マスタ取得中はトグル一覧を出さない）。 */
  loading?: boolean;
  /** エラー状態（読み込み失敗）。 */
  error?: boolean;
  /** 保存ラベル（既定「保存」）。Files 追加モードでは「追加」に上書きする。 */
  saveLabel?: string;
  /** 見出し文言（既定「タグ付け」）。 */
  heading?: string;
  /**
   * 保存確定コールバック。呼び出し側が永続化を担う。
   * 引数は確定後の ID 配列（保存後 onClose は呼び出し側が行う）。
   */
  onConfirm: (tagIds: string[]) => void;
  onClose: () => void;
}

/**
 * タグ選択オーバーレイ共通コア。
 * 単一選択版（TagPickerOverlay）と複数選択版（MultiTagAssignOverlay・同パッケージ内）の双方で
 * 同じ CSS クラス（.tag-picker-*）を共有し、一覧を framed list 意匠に揃える。
 */
export function TagPickerOverlay({
  tags,
  initialSelected,
  selectionMode = 'multiple',
  loading = false,
  error = false,
  saveLabel = '保存',
  heading = 'タグ付け',
  onConfirm,
  onClose,
}: TagPickerOverlayProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected));

  // 初期選択集合から変更がある間だけ Esc / 背景 / キャンセルに破棄確認を挟む（mdl-0034 規約②）。
  // ガード自体は OverlayDialog の dirty prop が全閉じ経路（Esc / 背景 / OverlayCloseButton）で担う。
  const dirty =
    selected.size !== initialSelected.length || initialSelected.some((id) => !selected.has(id));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (selectionMode === 'single') next.clear();
        next.add(id);
      }
      return next;
    });
  };

  const handleSave = () => {
    onConfirm([...selected]);
  };

  return (
    <OverlayDialog
      open
      onClose={onClose}
      ariaLabel={heading}
      width="min(540px, 92vw)"
      dirty={dirty}
    >
      <div className="file-overlay-panel max-h-[calc(100vh-4rem)]">
        <OverlayHeader icon={<Tags className="h-4 w-4" aria-hidden="true" />} title={heading} />
        <div className="file-overlay-body">
          {error ? (
            <div className="file-empty">タグの読み込みに失敗しました</div>
          ) : loading ? (
            <div className="flex justify-center py-6">
              <Spinner className="h-4 w-4" />
            </div>
          ) : tags.length === 0 ? (
            <div className="file-empty">
              タグがまだありません。「タグ管理」から先にタグを作成してください。
            </div>
          ) : (
            <table className="desk-catset-table tag-master-table tag-picker-table">
              <thead>
                <tr>
                  <th className="tag-master-th">タグ名</th>
                </tr>
              </thead>
              <tbody>
                {tags.map((t) => {
                  const on = selected.has(t.id);
                  return (
                    <tr key={t.id}>
                      <td className="tag-master-td">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          className={cn('tag-picker-item', on && 'is-on')}
                          onClick={() => toggle(t.id)}
                        >
                          <span className="tag-picker-item-main">
                            {t.icon && <TagIcon name={t.icon} size={14} color={t.color} />}
                            <span className="tag-picker-item-name">{t.name}</span>
                          </span>
                          <span className={cn('tag-picker-check', on && 'is-on')}>
                            {on && <Check className="h-3 w-3" aria-hidden="true" />}
                          </span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="file-overlay-foot tag-picker-foot">
          <OverlayCloseButton className="fo-btn-ghost">キャンセル</OverlayCloseButton>
          <button type="button" className="fo-btn-primary" onClick={handleSave}>
            {saveLabel}
          </button>
        </div>
      </div>
    </OverlayDialog>
  );
}
