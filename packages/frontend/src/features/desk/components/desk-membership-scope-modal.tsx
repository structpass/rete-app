'use client';

import { useCallback, useEffect, useState, useMemo, useRef, type ReactNode } from 'react';
import { Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { MembershipScopeType, type SpaceDto, type MembershipDto } from '@rete/shared';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import {
  fetchMemberships,
  addMembership,
  updateMembershipRole,
  removeMembership,
} from '@/features/settings/lib/memberships-api';
import { DeskMemberPicker } from './desk-member-picker';
import type { Account } from '@/features/tasks/lib/api';
import { apiErrorMessage } from '../lib/api-error';
import { avatarClassFor, avatarChar } from '../lib/avatar';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { OverlayDialog } from '@/components/ui/overlay-dialog';
import { useDeleteConfirm } from '@/hooks/use-delete-confirm';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

/**
 * スコープ（GROUP / PROJECT）共通メンバー管理モーダル。
 *
 * dsk-0306（DeskGroupMemberModal・GROUP scope）と dsk-0309（PROJECT scope・参照権限管理）の
 * 雛形を共通化した実装。既存 memberships-api.ts の fetchMemberships / addMembership /
 * removeMembership と DeskMemberPicker（dsk-0308 汎用版）を再利用し、新規クライアント実装を
 * 行わない（dsk-0309 criteria 2）。role=MEMBER 固定（ロール変更は本チケットのスコープ外、
 * design-reviewer 末尾）。scope-ADMIN 権限はバックエンドが判定し、非 ADMIN の追加/削除試行は
 * 403 をトースト表示（dsk-0306/0309 共通）。
 *
 * 呼び出し側ラベル差分（"メンバー" / "参照権限" など）は scopeLabel / scopeEntityName props で
 * 吸収する。section 見出しと空状態文言も同じく props で呼び出し側に寄せる（既定は scopeLabel
 * から導出）。
 *
 * dsk-0329 項目 2/3/4: 削除は ConfirmDialog を必須挟み（誤削除防止・同系パターン揃え）、
 * 追加/削除/再読込 失敗時は inline 赤帯 + toast.error の両方を出す（crud-ui 標準）。
 */
interface DeskMembershipScopeModalProps {
  open: boolean;
  onClose: () => void;
  scopeType: MembershipScopeType;
  /** スコープ対象 id（GROUP→Space.id / PROJECT→Project.id）。バックエンドが scopeType と整合検証。 */
  scopeId: string;
  /** 表示ヘッダ右側ラベル。「${scopeEntityName} の ${scopeLabel}」。例: 'メンバー' / '参照権限'。 */
  scopeLabel: string;
  /** 表示名（aria-label にも使用）。例: group.name / project.name。 */
  scopeEntityName: string;
  /** ピッカーセクション見出し。既定: '${scopeLabel}を追加'。 */
  pickerSectionLabel?: string;
  /** メンバー一覧セクション見出し。既定: '現在の${scopeLabel}'。 */
  listSectionLabel?: string;
  /** 0 件時の文言。既定: '${scopeLabel}はまだいません'。 */
  emptyMembersMessage?: string;
  /** ピッカー入力欄 placeholder（dsk-0309 は '追加する相手を検索' などへ上書き可）。 */
  pickerPlaceholder?: string;
  /** ピッカー入力欄 aria-label。 */
  pickerAriaLabel?: string;
  /** 候補ゼロ時のメッセージ。 */
  pickerEmptyMessage?: string;
  /**
   * 見出し（可視タイトル）。省略時は `${scopeEntityName} の ${scopeLabel}`。
   * メンバー管理だけでない画面（dsk-0364 のグループ設定）は役割に合わせて上書きする。
   */
  titleText?: string;
  /**
   * dialog の aria-label。省略時は可視タイトルを流用。
   * dsk-0306 の既存呼び出しは「${group.name} のメンバー設定」を維持するため wrapper 側で明示指定する
   * （silent regression 回避）。
   */
  ariaLabel?: string;
  /** 全アカウント候補（既存メンバーは本コンポーネントで除外する）。 */
  accounts: Account[];
  /**
   * メンバー行で role（ADMIN/MEMBER）を変更できるか（dsk-0366）。GROUP スコープのみ true。
   * PROJECT（参照権限）は role の意味論が別論点のため据え置き（false＝従来のラベル表示）。
   */
  canEditRole?: boolean;
  /**
   * dsk-0364: 呼び出し側が差し込む任意スロット。header=メンバー追加ピッカーの上 / footer=メンバー一覧の下。
   * GROUP（グループ設定）は header にグループ名編集・footer にアーカイブを差す。未指定なら何も描かない
   * （PROJECT の参照権限モーダルは従来どおりの画面構成のまま）。
   */
  headerSlot?: ReactNode;
  footerSlot?: ReactNode;
}

export function DeskMembershipScopeModal({
  open,
  onClose,
  scopeType,
  scopeId,
  scopeLabel,
  scopeEntityName,
  pickerSectionLabel,
  listSectionLabel,
  emptyMembersMessage,
  pickerPlaceholder = '名前で検索',
  pickerAriaLabel = '追加する相手を検索',
  pickerEmptyMessage = '追加できるメンバーがいません',
  titleText,
  ariaLabel,
  accounts,
  canEditRole = false,
  headerSlot,
  footerSlot,
}: DeskMembershipScopeModalProps) {
  const [members, setMembers] = useState<MembershipDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // dsk-0329 項目 2: 削除対象候補。null=未選択（=ダイアログ閉じ）。確認で確定すると removeMembership を呼び一覧更新。
  // cmn-0353: useDeleteConfirm へ移行（close-first・onSuccess 第 2 引数で確定時点の displayName を使う）。
  const {
    deleteTarget: removeTarget,
    setDeleteTarget: setRemoveTarget,
    handleDelete,
  } = useDeleteConfirm<{ id: string; displayName: string }>({
    remove: async (id) => {
      // busy 中は多重確定しない（フックの close-first と合わせて確定直後の再確定窓を塞ぐ）。
      if (busy) return false;
      setBusy(true);
      setActionError(null);
      try {
        await removeMembership(String(id));
        await reload();
        return true;
      } catch (e) {
        const msg = apiErrorMessage(e, 'メンバーの削除に失敗しました');
        setActionError(msg);
        toast.error(msg);
        return false;
      } finally {
        setBusy(false);
      }
    },
    onSuccess: (_id, target) => {
      toast.success(`「${target.displayName}」を削除しました`);
    },
  });

  // open のまま scopeId が切り替わる時（例: 別プロジェクトの「参照権限を管理」を連続で開く）、
  // 先発リクエストが後発より遅れて解決すると古い scopeId の結果で新しい表示を上書きしうる。
  // 世代トークンで「自分が最新の reload か」を確認してから setMembers する（stale response 対策）。
  const reloadTokenRef = useRef(0);

  const reload = useCallback(async () => {
    const token = ++reloadTokenRef.current;
    setLoading(true);
    try {
      const data = await fetchMemberships(scopeType, scopeId);
      if (token !== reloadTokenRef.current) return;
      setMembers(data);
    } catch (e) {
      if (token !== reloadTokenRef.current) return;
      // dsk-0329 項目 4: 一覧再読込失敗も inline 赤帯 + toast.error の両方を出す（crud-ui 標準）。
      const msg = apiErrorMessage(e, 'メンバー一覧の取得に失敗しました');
      setActionError(msg);
      toast.error(msg);
    } finally {
      if (token === reloadTokenRef.current) setLoading(false);
    }
  }, [scopeType, scopeId]);

  useEffect(() => {
    if (!open) return;
    setActionError(null);
    void reload();
  }, [open, reload]);

  // Esc の持ち主は共通 OverlayDialog 1つだけ（パネルの onKeyDown で stopPropagation する）。
  // ここで document capture の useEscapeConsume を併設すると、先に閉じて OverlayDialog の
  // stopPropagation が走らず、同じキーが desk-shell の closeAll にも届いて後ろのペインまで閉じる。
  // 削除確認（ConfirmDialog）表示中の Esc は AlertDialog 側が stopPropagation して消費する（dsk-0329 維持）。

  const memberIds = useMemo(() => new Set(members.map((m) => m.accountId)), [members]);
  const candidates = useMemo(
    () => accounts.filter((a) => !memberIds.has(a.id)),
    [accounts, memberIds],
  );

  async function handleAdd(accountId: string): Promise<SpaceDto | null> {
    if (busy) return null;
    setBusy(true);
    setActionError(null);
    try {
      await addMembership({
        accountId,
        scopeType,
        scopeId,
        role: 'MEMBER',
      });
      toast.success('メンバーを追加しました');
      await reload();
      // 戻り値は DeskMemberPicker の close 判定に使われる（truthy なら picker が閉じる）。複数追加を
      // 連続で行う導線のため null を返し、ピッカーは開いたままにする（dsk-0306 と同方針）。
      return null;
    } catch (e) {
      const msg = apiErrorMessage(e, 'メンバーの追加に失敗しました');
      setActionError(msg);
      toast.error(msg);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // dsk-0366: ロール変更（GROUP スコープのみ・canEditRole）。既存 PATCH /memberships/:id を再利用し、
  // settings 所属管理画面（memberships-admin-screen）と同じ ADMIN/MEMBER の二値 select で切り替える。
  async function handleRoleChange(m: MembershipDto, newRole: 'ADMIN' | 'MEMBER') {
    if (busy || newRole === m.role) return;
    setBusy(true);
    setActionError(null);
    try {
      await updateMembershipRole(m.id, newRole);
      toast.success('ロールを変更しました');
      await reload();
    } catch (e) {
      const msg = apiErrorMessage(e, 'ロールの変更に失敗しました');
      setActionError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const title = titleText ?? `${scopeEntityName} の ${scopeLabel}`;
  const pickerLabel = pickerSectionLabel ?? `${scopeLabel}を追加`;
  const listLabel = listSectionLabel ?? `現在の${scopeLabel}`;
  const emptyMsg = emptyMembersMessage ?? `${scopeLabel}はまだいません`;

  // document.body へ portal（desk-sidebar が position:sticky のため子孫の fixed が
  // スタッキングコンテキストに埋もれるのを避ける）。
  // 正本 comp-overlay-dialog: 重ね表示は共通 OverlayDialog 1枚（fixed div の手組み禁止）。
  // backdrop の曇りガラス・z 10050・Esc・focus trap・inert 隔離・フォーカス復帰は primitive が担う。
  const dialog = (
    <OverlayDialog
      open={open}
      onClose={onClose}
      ariaLabel={ariaLabel ?? title}
      width="min(480px, 92vw)"
      className="desk-catset-overlay"
      dirty={busy}
    >
      <div className="desk-catset-card" data-testid="desk-membership-scope-card">
        <div className="desk-catset-head">
          <h2 className="desk-catset-title">{title}</h2>
          <button
            type="button"
            className="desk-catset-icon-btn"
            aria-label="閉じる"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {actionError && (
          <p className="desk-catset-error" role="alert">
            {actionError}
          </p>
        )}

        {headerSlot}

        <h3 className="desk-group-manage-subtitle">{pickerLabel}</h3>
        <DeskMemberPicker
          light
          candidates={candidates}
          onPick={handleAdd}
          onClose={onClose}
          submitting={busy}
          placeholder={pickerPlaceholder}
          ariaLabel={pickerAriaLabel}
          emptyMessage={pickerEmptyMessage}
        />

        <h3 className="desk-group-manage-subtitle">{listLabel}</h3>
        {loading ? (
          <p className="desk-catset-empty flex items-center justify-center gap-2">
            <Spinner className="h-4 w-4" />
            読み込み中…
          </p>
        ) : members.length === 0 ? (
          <p className="desk-catset-empty">{emptyMsg}</p>
        ) : (
          <ul className="desk-group-manage-list">
            {members.map((m, i) => (
              <li key={m.id} className="desk-group-manage-row">
                <span className={cn('sidebar-member-avatar', avatarClassFor(i))}>
                  {avatarChar(m.accountName ?? '')}
                </span>
                <span className="desk-group-manage-name">{m.accountName ?? m.accountId}</span>
                {canEditRole ? (
                  /* set-0142: 行内2値ロール select → 共通 Select（compact・幅は wrapper が持つ）。 */
                  <div style={{ width: '7rem' }}>
                    <Select
                      value={m.role}
                      disabled={busy}
                      onValueChange={(v) => void handleRoleChange(m, v as 'ADMIN' | 'MEMBER')}
                    >
                      <SelectTrigger
                        aria-label={`${m.accountName ?? m.accountId} のロール`}
                        className="sp-select-compact"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MEMBER">MEMBER</SelectItem>
                        <SelectItem value="ADMIN">ADMIN</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <span className="desk-catset-row-meta">{m.role}</span>
                )}
                <div className="desk-catset-row-actions">
                  {/* dsk-0329 項目 2: 即削除せず ConfirmDialog を挟む。押下では state 設定のみ。 */}
                  <button
                    type="button"
                    className="desk-catset-icon-btn is-destructive"
                    title="削除"
                    aria-label={`${m.accountName ?? m.accountId} を削除`}
                    disabled={busy}
                    onClick={() =>
                      setRemoveTarget({ id: m.id, displayName: m.accountName ?? m.accountId })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {footerSlot}
      </div>
    </OverlayDialog>
  );

  // dsk-0329 項目 2: 削除確認ダイアログ。AlertDialog は内部で body へ portal するため
  // OverlayDialog の上に後着で乗る（Esc は AlertDialog 側が stopPropagation して消費する）。
  return (
    <>
      {dialog}
      <ConfirmDialog
        open={removeTarget !== null}
        message={`「${removeTarget?.displayName ?? ''}」を削除しますか？この操作は取り消せません。`}
        destructive
        onConfirm={() => void handleDelete()}
        onCancel={() => setRemoveTarget(null)}
      />
    </>
  );
}
