'use client';

import { Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { Role } from '@rete/shared';
import { useSession } from '@/features/auth';
import { FormActions, FormButton, FormCard, FormLabel, PageTitle } from './primitives';
import { useFileSettings } from '@/features/files/hooks/use-file-settings';
import {
  ExtensionListEditor,
  FixedExtensionList,
} from '@/features/files/components/extension-list-editor';
import { Spinner } from '@/components/ui/spinner';
import { useDiscardConfirm } from '@/hooks/use-discard-confirm';
import { useEscapeConsume } from '@/hooks/use-escape-consume';
import { DiscardConfirmDialog } from '@/components/ui/discard-confirm-dialog';

/**
 * アップロード設定画面（設定タブ / テナントカテゴリ・set-0043）。
 * Desk/Files が共有する `/files/settings` API・`useFileSettings` hook をそのまま再利用し、
 * 従来 Files タブ内オーバーレイでしか編集できなかった最大サイズ/許可拡張子を設定メニューへ露出する。
 * 既存のオーバーレイ（features/files/components/settings-overlay.tsx）は依頼範囲外のため撤去しない。
 *
 * set-0057: フェッチは useFileSettings hook 内部にあり直接ガードできないため、
 * 外側（本コンポーネント）でセッション判定し、非 ADMIN では Body をマウントしない
 * （= useFileSettings 自体を呼ばせない）。organizations-screen と同型のタイトルのみガード。
 */
export function FileUploadSettingsScreen() {
  const { user, loading: sessionLoading } = useSession();
  const isAdmin = user?.role === Role.ADMIN;

  if (sessionLoading) return null;
  if (!isAdmin) {
    return (
      <main className="sp-page" style={{ overflowY: 'auto' }}>
        <PageTitle title="アップロード設定" />
      </main>
    );
  }

  return <FileUploadSettingsBody />;
}

/** ADMIN 専用の本体（useFileSettings のフェッチはマウント時に走るため非 ADMIN では描画しない）。 */
function FileUploadSettingsBody() {
  const s = useFileSettings();
  const discard = useDiscardConfirm();

  async function handleSave() {
    const res = await s.save();
    if (res.ok) {
      toast.success('アップロード設定を保存しました');
    } else {
      /* v2-198: サーバーが返した検証理由をそのまま出す。固定文言だけだと、どの欄の何を
         直せば保存できるのか画面から分からない（複数項目が不正な時は全部並ぶ）。 */
      toast.error(res.reason);
    }
  }

  /** v2-203: キャンセルは保存せず、途中の追加・解除を取得値へ戻す（要求の 5）。 */
  function handleCancel() {
    discard.request(s.dirty, () => {
      s.reset();
      toast.success('変更を破棄しました');
    });
  }

  // Esc は「キャンセル」と同じ経路にする（UI 共通仕様 escape-key 規約①②。破棄確認の表示中は
  // AlertDialog 側が Esc を消費するため何もしない）。
  useEscapeConsume(handleCancel, {
    enabled: !s.loading && !s.error,
    guardSelector: '[role="alertdialog"]',
  });

  return (
    <main className="sp-page" style={{ overflowY: 'auto' }}>
      <PageTitle title="アップロード設定" />

      <DiscardConfirmDialog
        open={discard.open}
        onConfirm={discard.onConfirm}
        onCancel={discard.onCancel}
      />

      {/* v2-180: 全幅(1153px)で間延びしていたフォームを内容に合う幅へ絞り左寄せにする（表のある画面と同じ 680px）。 */}
      <div style={{ maxWidth: 680 }}>
        <FormCard
          icon={<Upload className="h-4 w-4" />}
          title="アップロード制限"
          description="設定した上限は Files タブ・Desk のファイル添付の両方に反映されます。"
        >
          {/* d754: 読み込みに失敗した理由を捨てずに出す（保存失敗の理由を出す扱い＝v2-198 に揃える）。 */}
          {s.error ? (
            <p className="text-[0.8125rem] text-[var(--sp-text-warm-mute)]">
              {s.loadErrorReason || '設定の読み込みに失敗しました'}
            </p>
          ) : s.loading ? (
            <div className="flex justify-center py-2">
              <Spinner className="h-4 w-4" />
            </div>
          ) : (
            <>
              {/* Files タブの同名オーバーレイ（settings-overlay）と同じ面なので、必須の出し方も揃える。 */}
              <FormLabel htmlFor="upload-max-size" required>
                最大ファイルサイズ（MB）
              </FormLabel>
              <input
                id="upload-max-size"
                type="number"
                min={1}
                max={100}
                aria-required="true"
                className="sp-input"
                value={s.maxSizeMb}
                onChange={(e) =>
                  s.setMaxSizeMb(
                    Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0,
                  )
                }
                style={{
                  /* set-0113: 数値入力の標準幅 4rem */
                  width: '4rem',
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                }}
              />
              <p
                className="text-[0.6875rem] text-[var(--sp-text-warm-mute)]"
                style={{ marginTop: '0.375rem' }}
              >
                1〜100 MB。これを超えるファイルはアップロード時に拒否されます。
              </p>

              <div style={{ marginTop: '1rem' }}>
                <FormLabel htmlFor="upload-allowed-ext">許可する拡張子</FormLabel>
                <ExtensionListEditor
                  id="upload-allowed-ext"
                  inputAriaLabel="許可する拡張子"
                  values={s.allowedExtensions}
                  onAdd={s.addAllowedExtension}
                  onRemove={s.removeAllowedExtension}
                />
                <p
                  className="text-[0.6875rem] text-[var(--sp-text-warm-mute)]"
                  style={{ marginTop: '0.375rem' }}
                >
                  1件ずつ入力して「追加」を押すと下の一覧へ並びます。入力が「pdf」でも「.pdf」
                  として追加されます。1件も無い場合はすべての拡張子を許可します。
                </p>
              </div>

              {/* v2-197 要求版2: 常に拒否する拡張子（コード固定）は編集欄と分けて読み取り専用で出す。
                  編集可能な欄へ混ぜると「外せそう」に見えるため（開発統括の修正依頼）。 */}
              <div style={{ marginTop: '1rem' }}>
                <FormLabel htmlFor="upload-fixed-rejected-ext">常に拒否する拡張子</FormLabel>
                <div
                  id="upload-fixed-rejected-ext"
                  aria-describedby="upload-fixed-rejected-ext-note"
                >
                  <FixedExtensionList values={s.fixedRejectedExtensions} />
                </div>
                <p
                  id="upload-fixed-rejected-ext-note"
                  className="text-[0.6875rem] text-[var(--sp-text-warm-mute)]"
                  style={{ marginTop: '0.375rem' }}
                >
                  実行形式として扱う拡張子です。<strong>この設定では変更できません</strong>
                  （中身が実行形式のファイルは、拡張子に関係なくアップロード時に拒否されます）。
                </p>
              </div>

              {/* v2-197: 追加で拒否する拡張子を管理者が編集できるようにする。 */}
              <div style={{ marginTop: '1rem' }}>
                <FormLabel htmlFor="upload-rejected-ext">追加で拒否する拡張子</FormLabel>
                <ExtensionListEditor
                  id="upload-rejected-ext"
                  inputAriaLabel="追加で拒否する拡張子"
                  values={s.rejectedExtensions}
                  onAdd={s.addRejectedExtension}
                  onRemove={s.removeRejectedExtension}
                />
                <p
                  className="text-[0.6875rem] text-[var(--sp-text-warm-mute)]"
                  style={{ marginTop: '0.375rem' }}
                >
                  1件ずつ入力して「追加」を押すと下の一覧へ並びます。一覧が空の時は、ここで追加した
                  拒否はありません。上の「常に拒否する拡張子」を指定しても保存されません
                  （常に拒否されるため）。
                </p>
              </div>
            </>
          )}

          <FormActions>
            <FormButton variant="ghost" onClick={handleCancel} disabled={s.loading || s.error}>
              キャンセル
            </FormButton>
            <FormButton
              variant="primary"
              onClick={handleSave}
              disabled={s.loading || s.error}
              loading={s.saving}
            >
              保存
            </FormButton>
          </FormActions>
        </FormCard>
      </div>
    </main>
  );
}
