'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { extractErrorMessage, extractErrorStatus } from '@/lib/error-utils';
import {
  createAttachment as createAttachmentApi,
  deleteAttachment as deleteAttachmentApi,
  type Attachment,
} from '../lib/api';
import {
  useDeskAttachments,
  type AttachmentTarget,
  type UseDeskAttachmentsResult,
} from './use-desk-attachments';
import { PENDING_ID_PREFIX } from '../lib/attachment-status';

export interface UseDeferredAttachmentsResult extends UseDeskAttachmentsResult {
  /** 保留中の添付変更（追加/解除）があるか。編集フォームの dirty（破棄ガード）へ合流させる。 */
  dirty: boolean;
  /**
   * 保留中の変更を一括確定する（追加分 create + 解除分 delete → 再取得）。一部でも失敗したら全体を
   * 失敗（false）とし、保留を保持したまま呼び出し側が編集モードに留まって再試行できるようにする。
   * 成功済み分の再送は create=409（既に添付済み）/ delete=404（既に解除済み）を成功扱いにして冪等化する
   * （重複防止はサーバ側 @@unique / 404 に委ねる・dsk-0265 設計）。
   */
  commit: () => Promise<boolean>;
  /** 保留中の変更を破棄する（サーバ未通信のためローカル state のクリアのみ）。キャンセル確定時に呼ぶ。 */
  discard: () => void;
}

/** API エラーの HTTP status 判定（commit の 409/404 許容用）。 */
function hasStatus(e: unknown, status: number): boolean {
  return extractErrorStatus(e) === status;
}

/**
 * deferred-commit 添付（dsk-0265）。既存エンティティの「編集モード」のように、添付の追加・解除を
 * その場でサーバ反映せず「保存」ボタンで一括確定したい局面で使う。即時反映の useDeskAttachments を
 * 内包して確定一覧を取得しつつ、追加・解除は保留（ローカル state）に積み、合成一覧
 * （確定 − 解除保留 + 追加保留）を UseDeskAttachmentsResult 互換で返す——表示部品
 * （AttachmentChipsRow / AttachmentAddButton）は差し替え無しでそのまま使える。
 *
 * 使い分け（FL-3 添付 hook 3 種）:
 * - useDeskAttachments … 既存エンティティへの即時添付（詳細画面の閲覧モード等）
 * - usePendingAttachments … 未確定エンティティ（新規作成コンポーザ）の保留 + flush
 * - useDeferredAttachments … 既存エンティティの編集モード（保留 + 保存時 commit / キャンセルで discard）
 *
 * チャットメッセージ編集（dsk-0265）のほか、タスク詳細本体（dsk-0272）・タスクスレッド編集（dsk-0279）
 * が同じ非対称（即時確定 vs 保存で確定）の解消に本 hook を再利用する前提（§3 コピペ禁止）。
 */
export function useDeferredAttachments(target: AttachmentTarget): UseDeferredAttachmentsResult {
  const { targetType, targetId, enabled = true } = target;
  const base = useDeskAttachments(target);
  const { attachments: confirmedAttachments, loading, error, mutating, reload } = base;
  const [pendingAdds, setPendingAdds] = useState<{ fileId: string; fileName: string }[]>([]);
  const [pendingRemoveIds, setPendingRemoveIds] = useState<string[]>([]);
  const [committing, setCommitting] = useState(false);

  // 対象が切り替わったら保留を破棄する（別メッセージ/別対象へ編集を移った時に前の保留を持ち越さない）。
  useEffect(() => {
    setPendingAdds([]);
    setPendingRemoveIds([]);
  }, [targetType, targetId, enabled]);

  // 合成一覧 = 確定（解除保留を隠す）+ 追加保留（合成チップ）。追加保留は確定済みと fileId 重複したら
  // 出さない（commit 途中失敗後の再取得で確定側に現れた分が二重表示にならないように）。
  const attachments = useMemo(() => {
    const removeSet = new Set(pendingRemoveIds);
    const confirmedFileIds = new Set(confirmedAttachments.map((a) => a.fileId));
    const confirmed = confirmedAttachments.filter((a) => !removeSet.has(a.id));
    const pendings = pendingAdds
      .filter((p) => !confirmedFileIds.has(p.fileId))
      .map(
        (p): Attachment => ({
          // versionNo:0 = 保留（未確定）の印。確定時にサーバが最新版を固定するため版はまだ無い。
          id: `${PENDING_ID_PREFIX}${p.fileId}`,
          fileId: p.fileId,
          fileName: p.fileName,
          versionNo: 0,
          byteSize: 0,
          mimeType: '',
          attachedBy: '',
          createdAt: '',
        }),
      );
    return [...confirmed, ...pendings];
  }, [confirmedAttachments, pendingAdds, pendingRemoveIds]);

  /** 添付をローカル保留に積む（サーバ未通信）。確定済み・保留済みと重複する fileId は黙って no-op。 */
  const add = useCallback(
    async (fileId: string, fileName?: string): Promise<boolean> => {
      if (committing) return false;
      const confirmedMatch = confirmedAttachments.find((a) => a.fileId === fileId);
      if (confirmedMatch) {
        // 解除保留中の確定添付を再追加 → 解除の取り消し（create し直すのではなく保留を戻すだけ）。
        setPendingRemoveIds((prev) => prev.filter((id) => id !== confirmedMatch.id));
        return true;
      }
      setPendingAdds((prev) =>
        prev.some((p) => p.fileId === fileId)
          ? prev
          : [...prev, { fileId, fileName: fileName ?? 'ファイル' }],
      );
      return true;
    },
    [committing, confirmedAttachments],
  );

  /** 添付をローカル保留で解除する（サーバ未通信）。保留追加チップは取り下げ、確定添付は解除保留に積む。 */
  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (committing) return;
      if (id.startsWith(PENDING_ID_PREFIX)) {
        setPendingAdds((prev) => prev.filter((p) => `${PENDING_ID_PREFIX}${p.fileId}` !== id));
        return;
      }
      setPendingRemoveIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    },
    [committing],
  );

  const commit = useCallback(async (): Promise<boolean> => {
    if (pendingAdds.length === 0 && pendingRemoveIds.length === 0) return true;
    setCommitting(true);
    try {
      let ok = true;
      for (const p of pendingAdds) {
        try {
          await createAttachmentApi({ targetType, targetId, fileId: p.fileId });
        } catch (e) {
          // 409 = 既に添付済み（前回 commit の途中成功分の再送）→ 確定済みとして成功扱い。
          if (hasStatus(e, 409)) continue;
          ok = false;
          toast.error(extractErrorMessage(e, `「${p.fileName}」の添付に失敗しました`));
        }
      }
      for (const id of pendingRemoveIds) {
        try {
          await deleteAttachmentApi(id);
        } catch (e) {
          // 404 = 既に解除済み（前回 commit の途中成功分の再送）→ 成功扱い。
          if (hasStatus(e, 404)) continue;
          ok = false;
          const name = confirmedAttachments.find((a) => a.id === id)?.fileName;
          toast.error(
            extractErrorMessage(
              e,
              name ? `「${name}」の解除に失敗しました` : '添付の解除に失敗しました',
            ),
          );
        }
      }
      if (!ok) return false;
      // 再取得で確定一覧を最新化してから保留を空にする（合成一覧が fileId 重複を隠すため隙間でもちらつかない）。
      await reload();
      setPendingAdds([]);
      setPendingRemoveIds([]);
      return true;
    } finally {
      setCommitting(false);
    }
  }, [pendingAdds, pendingRemoveIds, targetType, targetId, confirmedAttachments, reload]);

  const discard = useCallback(() => {
    setPendingAdds([]);
    setPendingRemoveIds([]);
  }, []);

  return {
    attachments,
    loading,
    error,
    mutating: mutating || committing,
    add,
    remove,
    reload,
    dirty: pendingAdds.length > 0 || pendingRemoveIds.length > 0,
    commit,
    discard,
  };
}
