'use client';

import { Settings } from 'lucide-react';
import toast from 'react-hot-toast';
import { OverlayCloseButton, OverlayDialog } from '@/components/ui/overlay-dialog';
import { OverlayHeader } from '@/components/ui/overlay-header';
import { RequiredMark } from '@/components/ui/required-mark';
import { Spinner } from '@/components/ui/spinner';
import { useFileSettings } from '../hooks/use-file-settings';
import { ExtensionListEditor, FixedExtensionList } from './extension-list-editor';

/**
 * アップロード設定オーバーレイ（最大ファイルサイズ / 許可拡張子）。
 * 表示時に現在値を取得し、保存で PATCH /files/settings を叩く（FB-3 実挙動）。
 * focus trap・ESC・背景 inert 隔離は共通部品 OverlayDialog に委譲する（fil-0060）。
 */
export function SettingsOverlay({ onClose }: { onClose: () => void }) {
  const s = useFileSettings();

  const handleSave = async () => {
    const res = await s.save();
    if (res.ok) {
      onClose();
      toast.success('アップロード設定を保存しました');
    } else {
      /* v2-198: 設定画面（/settings/file-upload）と同じく、サーバーが返した検証理由をそのまま出す
         （同じ設定を編集する2面で扱いを揃える）。オーバーレイは開いたままにして直せるようにする。 */
      toast.error(res.reason);
    }
  };

  return (
    <OverlayDialog
      open
      onClose={onClose}
      ariaLabel="アップロード設定"
      width="min(540px, 92vw)"
      dirty={s.dirty}
    >
      <div className="file-overlay-panel">
        <OverlayHeader
          icon={<Settings className="h-4 w-4" aria-hidden="true" />}
          title="アップロード設定"
        />
        <div className="file-overlay-body">
          {/* d754: 読み込みに失敗した理由を捨てずに出す（設定タブの同名画面と扱いを揃える）。 */}
          {s.error ? (
            <div className="file-empty">{s.loadErrorReason || '設定の読み込みに失敗しました'}</div>
          ) : s.loading ? (
            <div className="file-empty">
              <Spinner className="h-4 w-4 inline-block" />
            </div>
          ) : (
            <div className="settings-form">
              <label className="settings-field">
                {/* 最大サイズは未入力で保存できない（1〜100 の必須項目）＝正本 comp-form-field の必須バッジを出す。
                    設定タブの同名画面（file-upload-settings-screen）と同じマークを使い、出し方を揃える。 */}
                <span className="settings-label">
                  最大ファイルサイズ（MB）
                  <RequiredMark />
                </span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  aria-required="true"
                  className="settings-input"
                  value={s.maxSizeMb}
                  onChange={(e) =>
                    s.setMaxSizeMb(
                      Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0,
                    )
                  }
                />
                <span className="settings-hint">
                  1〜100 MB。アップロード時にこのサイズを超えるファイルは拒否されます。
                </span>
              </label>
              <div className="settings-field">
                <span className="settings-label">許可する拡張子</span>
                <ExtensionListEditor
                  id="overlay-allowed-ext"
                  inputAriaLabel="許可する拡張子"
                  values={s.allowedExtensions}
                  onAdd={s.addAllowedExtension}
                  onRemove={s.removeAllowedExtension}
                />
                <span className="settings-hint">
                  1件ずつ入力して「追加」を押すと下の一覧へ並びます。入力が「pdf」でも「.pdf」
                  として追加されます。1件も無い場合はすべての拡張子を許可します。
                </span>
              </div>
              {/* v2-197 要求版2: 常に拒否する拡張子（コード固定）は読み取り専用で出し、編集欄と分ける。 */}
              <div className="settings-field">
                <span className="settings-label">常に拒否する拡張子</span>
                <FixedExtensionList values={s.fixedRejectedExtensions} />
                <span className="settings-hint">
                  実行形式として扱う拡張子です。この設定では変更できません（中身が実行形式のファイルは、
                  拡張子に関係なく拒否されます）。
                </span>
              </div>
              {/* v2-197: 設定メニュー（/settings/file-upload）と同じ項目。Files タブから編集しても
                  設定が食い違わないよう、同じ hook の値をそのまま出す。 */}
              <div className="settings-field">
                <span className="settings-label">追加で拒否する拡張子</span>
                <ExtensionListEditor
                  id="overlay-rejected-ext"
                  inputAriaLabel="追加で拒否する拡張子"
                  values={s.rejectedExtensions}
                  onAdd={s.addRejectedExtension}
                  onRemove={s.removeRejectedExtension}
                />
                <span className="settings-hint">
                  1件ずつ入力して「追加」を押すと下の一覧へ並びます。一覧が空の時は、ここで追加した
                  拒否はありません。
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="file-overlay-foot">
          <OverlayCloseButton className="fo-btn-ghost">キャンセル</OverlayCloseButton>
          <button
            type="button"
            className="fo-btn-primary"
            onClick={handleSave}
            disabled={s.loading || s.saving || s.error}
          >
            {s.saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </OverlayDialog>
  );
}
