'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Tags } from 'lucide-react';
import toast from 'react-hot-toast';
import { RichTextEditor } from '@/features/desk/components/rich-text-editor';
import { DiscardConfirmDialog } from '@/components/ui/discard-confirm-dialog';
import { AttachmentChip } from '@/features/desk/components/attachment-chip';
import {
  PendingAddButton,
  PendingAttachmentField,
} from '@/features/desk/components/pending-attachment-field';
import { usePendingAttachments } from '@/features/desk/hooks/use-pending-attachments';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { TagIcon } from '@/components/tags/tag-icon';
import { Badge } from '@/components/ui/badge';
import { SelectDropdown } from '@/components/tags/select-dropdown';
import type { UseTagMasterResult } from '@/hooks/use-tag-master';
import { useAnnouncementAttachments } from '../hooks/use-announcement-attachments';
import type { AnnouncementAttachment, AnnouncementInput } from '../lib/api';

/** create 時の初期値（pristine 判定の基準）。 */
const CREATE_BASELINE: AnnouncementInput = {
  title: '',
  body: '',
};

const TITLE_MAX = 200;
const BODY_MAX = 20000;

interface AnnouncementFormProps {
  /** create=新規作成 / edit=既存通知の編集。ボタン文言を切り替える。 */
  mode: 'create' | 'edit';
  /** edit 時の初期値（本文 HTML 込み）。create では未指定。 */
  initial?: AnnouncementInput;
  /** edit 時の対象通知 id（添付の即時 add/remove に使う）。create では未指定。 */
  announcementId?: string;
  /** edit 時の既存添付（詳細 GET 由来・即時 hook の seed）。create では未指定。 */
  initialAttachments?: AnnouncementAttachment[];
  /**
   * edit 時の既存タグ ID 一覧（rete-home-0043）。create では未指定（空配列扱い）。
   * dirty 判定と初期 selectedTagIds の seed として使う。
   */
  initialTagIds?: string[];
  /**
   * タグマスタ（rete-home-0043）。DashboardView から渡す UseTagMasterResult。
   * 未指定の場合はタグセクションを描画しない（テスト・タグ未利用の呼び出し元に後方互換）。
   */
  tagMaster?: UseTagMasterResult;
  saving: boolean;
  canEdit?: boolean;
  onCancel: () => void;
  /**
   * 確定。title/body/tagIds と、create 時の保留添付 fileId 群を渡す。
   * 通知本体の永続化（POST/PATCH）と保留添付の flush（作成後に通知 id へ添付）は呼び出し側に委ねる
   * （edit の添付は本フォーム内で即時反映済みのため pendingFileIds は空で渡る）。
   * tagIds は AnnouncementInput.tagIds に包まれて渡す（呼び出し側で backend body から取り出す）。
   */
  onSubmit: (data: AnnouncementInput, pendingFileIds: string[]) => Promise<void>;
}

/**
 * 編集モードの添付欄（即時 add/remove）。既存通知 id 確定済のため、ファイル選択でその場添付・×で即解除する
 * （desk の既存エンティティ添付と同方針）。チップ体裁・ピッカー起動ボタンは desk 共有部品を再利用（§3）。
 */
function EditAttachmentsBlock({
  announcementId,
  initial,
  disabled,
}: {
  announcementId: string;
  initial: AnnouncementAttachment[];
  disabled: boolean;
}) {
  const { attachments, mutating, add, remove } = useAnnouncementAttachments(
    announcementId,
    initial,
  );
  return (
    <div className="desk-pending-files">
      {attachments.length > 0 && (
        <div className="desk-pending-chips is-flush">
          {attachments.map((att) => (
            <AttachmentChip
              key={att.id}
              name={att.fileName}
              title={`v${att.versionNo}・${att.attachedBy}`}
              onRemove={() => void remove(att.id)}
              removeLabel={`${att.fileName} を解除`}
              removeDisabled={disabled || mutating}
            />
          ))}
        </div>
      )}
      <PendingAddButton onAdd={(fileId) => void add(fileId)} disabled={disabled || mutating} />
    </div>
  );
}

/**
 * 通知の新規作成 / 編集フォーム（右ペイン inline）。
 * 本文は共有リッチエディタ（Tiptap / ADR 0019）を流用し HTML として保持、描画側（RichTextView）と
 * 保存側（backend sanitizeRichText）の双方で sanitize される多層防御に乗る。
 * 認可は backend が ADMIN 限定で enforce するため、本フォームは ADMIN のみへ露出させる前提。
 * 添付ファイル（H0022）: create は保留（作成後に呼び出し側が flush）、edit は即時 add/remove。
 * タグ付与（rete-home-0043）: tagMaster が渡された場合のみセクションを表示。複数選択・toggle 方式。
 */
export function AnnouncementForm({
  mode,
  initial,
  announcementId,
  initialAttachments = [],
  initialTagIds,
  tagMaster,
  saving,
  canEdit = true,
  onCancel,
  onSubmit,
}: AnnouncementFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  // 選択中のタグ ID 集合（rete-home-0043）。edit 時は initialTagIds を初期状態にする。
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(initialTagIds ?? []);
  // 破棄確認ダイアログの開閉（rete-home-0017）。
  const [confirmOpen, setConfirmOpen] = useState(false);
  const titleId = useId();
  // Esc ガードでフォーム内のドロップダウン開閉を判定するためのルート参照（hom-0099）。
  const formRef = useRef<HTMLFormElement>(null);

  // 新規作成時の保留添付（id 未確定のためローカル保持し、作成成功後に呼び出し側が flush する / desk と同方針）。
  // 編集時は EditAttachmentsBlock 内の即時 hook が担うため本 pending は使わない（常に空）。
  const pendingAttachments = usePendingAttachments();

  // mdl-0035: ラベル正規化＝作成/更新の言い換えをやめ基底語「保存」へ統一。
  const submitLabel = '保存';
  const formLabel = mode === 'create' ? '通知の新規作成' : '通知の編集';

  // 入力が初期値から変化しているか（編集されているか）。create は空フォームを基準にする。
  const baseline = initial ?? CREATE_BASELINE;
  // タグ dirty 判定（rete-home-0043）。initialTagIds が未指定（create）は空配列基準。
  const baselineTagIds = initialTagIds ?? [];
  const tagsChanged =
    selectedTagIds.length !== baselineTagIds.length ||
    selectedTagIds.some((id) => !baselineTagIds.includes(id));
  const isDirty =
    title !== baseline.title ||
    body !== baseline.body ||
    tagsChanged ||
    // create 時は保留添付があれば dirty（破棄確認の対象）。edit の添付は即時反映で form dirty に含めない。
    pendingAttachments.count > 0;

  // キャンセル試行（rete-home-0016/0017）: 編集中なら破棄確認、未編集ならそのまま閉じる。
  const attemptCancel = useCallback(() => {
    if (saving) return;
    if (isDirty) {
      setConfirmOpen(true);
      return;
    }
    onCancel();
  }, [saving, isDirty, onCancel]);

  // ESC でキャンセル処理を実行する（rete-home-0016 / Desk と同様の挙動）。IME 変換確定中の ESC は無視。
  // 二重発火の回避（code-review HIGH/MEDIUM）:
  //  - 確認ダイアログ表示中（confirmOpen）は自身の AlertDialog の ESC に委ねる
  //  - 検索ボックス（type=search）発の ESC は値クリアを優先（オーバーレイは閉じない）
  //  - 他のモーダル（削除確認 AlertDialog など）が開いている時はそのダイアログの ESC に委ねる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (confirmOpen) return;
      const target = e.target;
      if (target instanceof HTMLInputElement && target.type === 'search') return;
      if (document.querySelector('[role="alertdialog"],[role="dialog"][aria-modal="true"]')) return;
      // 本フォーム内の軽量ドロップダウン（タグ設定・hom-0099）が開いている間はそちらの Esc（閉じる）に
      // 委ねる。無関係な画面のメニューを巻き込まないようフォーム配下に限定して探索する。
      if (formRef.current?.querySelector('[role="menu"]')) return;
      e.preventDefault();
      attemptCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmOpen, attemptCancel]);

  const handleSubmit = async () => {
    if (saving || !canEdit) return;
    const t = title.trim();
    if (!t) {
      toast.error('タイトルを入力してください');
      return;
    }
    if (t.length > TITLE_MAX) {
      toast.error(`タイトルは ${TITLE_MAX} 文字以内で入力してください`);
      return;
    }
    if (body.length > BODY_MAX) {
      toast.error('本文が長すぎます');
      return;
    }
    // create は保留添付の fileId 群を渡す（作成成功後に呼び出し側が通知 id へ flush）。edit は即時反映済で空。
    // tagIds は AnnouncementInput.tagIds に包んで渡す（呼び出し側の handleSubmit が取り出して API へ送る / rete-home-0043）。
    await onSubmit(
      {
        title: t,
        body,
        tagIds: selectedTagIds,
      },
      pendingAttachments.pending.map((p) => p.fileId),
    );
  };

  return (
    <>
      <form
        ref={formRef}
        aria-label={formLabel}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        className="flex h-full flex-col gap-2.5 overflow-y-auto p-4"
      >
        {/* hom-0052: 生<button>を Button primitive（variant=sp-action）へ統一。副次アクション=ink 文字/透過背景。
          hom-0057: -mb-0.5 でボタン行↔タイトル間の gap を詰める（他フィールド間は維持）。
          mdl-0025: 項目間は compact フォーム共通 10px（gap-2.5・旧 gap-4）。 */}
        <div className="-mb-0.5 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="sp-action"
            size="sp-compact"
            onClick={attemptCancel}
            disabled={saving}
          >
            キャンセル
          </Button>
          <Button
            type="submit"
            variant="sp-primary"
            size="sp-compact"
            disabled={saving || !canEdit}
            loading={saving}
            aria-busy={saving}
          >
            {submitLabel}
          </Button>
        </div>
        {!canEdit && (
          <p role="alert" className="text-sm text-[var(--sp-accent-red)]">
            編集権限がありません
          </p>
        )}

        {/* mdl-0025: 本フォームは compact 密度（入力 32px=.settings-input）のためラベル間隔・ラベル見た目も compact で統一。 */}
        <FormField label="タイトル" htmlFor={titleId} required compact>
          <input
            id={titleId}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="通知のタイトル"
            maxLength={TITLE_MAX}
            autoComplete="off"
            disabled={saving}
            className="settings-input w-full"
          />
        </FormField>

        {/* 内容（本文）。hom-0087: このフォームの時だけ背景を薄水色にする（af-content-blue・共有 RichTextEditor は無改修）。
          hom-0098: flex-1（縦スペース吸い込み）を除去し、本文量に応じた自然な高さへ（ファイル欄が直下に詰まる）。
          hom-0109: フィールド並び順を「タイトル→内容→ファイル→通知先ロール→タグ」に変更（掲示板/FAQ 共通）。 */}
        <div className="flex flex-col gap-[var(--sp-form-label-gap-compact)]">
          <label className="block text-xs font-semibold text-[var(--sp-text-warm)]">内容</label>
          <div className="af-content-blue flex flex-col">
            <RichTextEditor
              value={body}
              onChange={setBody}
              ariaLabel="本文"
              placeholder="本文を入力…"
              minRows={8}
            />
          </div>
        </div>

        {/* 添付ファイル。hom-0087: rete-home-0029 で撤去したラベルを指示スクショに従い復元。
          rete-home-0030: Desk のチャット明細メッセージ入力欄と同様に本文の直下へ寄せる配置は維持。
          hom-0109: フィールド並び順変更により内容→ファイルの直下配置になる。 */}
        <div className="space-y-[var(--sp-form-label-gap-compact)]">
          <label className="block text-xs font-semibold text-[var(--sp-text-warm)]">ファイル</label>
          {mode === 'edit' && announcementId ? (
            <EditAttachmentsBlock
              announcementId={announcementId}
              initial={initialAttachments}
              disabled={saving}
            />
          ) : (
            <PendingAttachmentField
              pending={pendingAttachments.pending}
              onAdd={pendingAttachments.add}
              onRemove={pendingAttachments.remove}
              disabled={saving}
              flush
            />
          )}
        </div>

        {/* タグ付与セクション（hom-0055）。tagMaster が渡された場合のみ表示。hom-0087: 項目ラベル追加＋チップ→リンクの
          並びへ統一（hom-0143 撤去前の通知先ロールと同じ並び規則）。 */}
        {tagMaster && (
          <div className="space-y-[var(--sp-form-label-gap-compact)]">
            {/* hom-0100: 項目ラベルの右隣に「編集」ボタン（見出し行）。チップは下の独立行（通知先ロールと同型）。 */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[var(--sp-text-warm)]">タグ</span>
              {/* hom-0099: 全画面オーバーレイ → ボタン真下の軽量ドロップダウンへ置換（通知先設定と同部品）。 */}
              <SelectDropdown
                items={tagMaster.tags.map((t) => ({
                  id: t.id,
                  name: t.name,
                  icon: <TagIcon name={t.icon} size={14} color={t.color} />,
                }))}
                selectedIds={selectedTagIds}
                onToggle={(id) =>
                  setSelectedTagIds((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                  )
                }
                onClear={() => setSelectedTagIds([])}
                triggerLabel="編集"
                menuLabel="タグ設定"
                triggerAriaLabel="タグを編集"
                triggerIcon={<Tags className="h-3.5 w-3.5" aria-hidden="true" />}
                emptyText={tagMaster.loading ? '読み込み中…' : 'タグが登録されていません'}
                disabled={saving}
              />
            </div>
            {/* hom-0108: 通知先ロールと同じ理由で min-h-5 を常時確保（レイアウトシフト防止）。 */}
            <div className="flex min-h-5 flex-wrap items-center gap-2">
              {/* 選択中タグのチップ表示（アイコン + ラベル）。 */}
              {selectedTagIds
                .map((id) => tagMaster.tags.find((t) => t.id === id))
                .filter(Boolean)
                .map((t) => t!)
                .map((t) => (
                  <Badge key={t.id} variant="outline">
                    <TagIcon name={t.icon} size={12} color={t.color} />
                    <span>{t.name}</span>
                  </Badge>
                ))}
            </div>
          </div>
        )}
      </form>
      {/* 編集中のキャンセルで内容破棄を確認（rete-home-0017 / Desk と同じ共有ダイアログ）。 */}
      <DiscardConfirmDialog
        open={confirmOpen}
        onConfirm={() => {
          setConfirmOpen(false);
          onCancel();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
