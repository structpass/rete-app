'use client';

import { useCallback, useMemo, useState } from 'react';
import { CircleCheckBig, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import { Role } from '@rete/shared';
import type { MemberDto, MemberUpdateInput } from '@rete/shared';
import { useSession } from '@/features/auth';
import { formatDate, formatDateTime } from '@/lib/utils';
import {
  ActionButton,
  FormActions,
  FormButton,
  FormLabel,
  FormCard,
  ListActionRow,
  MemberCell,
  PageTitle,
  Pagination,
  RowEditButton,
  StatusBadge,
  TableCard,
  ToggleSwitch,
} from './primitives';
import {
  FilterBar,
  FilterChipSelect,
  FilterClear,
  FilterSearchInput,
} from '@/components/shared/filter-bar';
import { TableStatusRows } from './table-status-rows';
import type { SettingTone } from '../lib/types';
import {
  downloadMembersCsv,
  fetchMembers,
  resetMemberMfa,
  unlockMember,
  updateMember,
} from '../lib/members-api';
import { apiErrorMessage } from '../lib/api-error';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { OverlayDialog } from '@/components/ui/overlay-dialog';
import { useDiscardConfirm } from '@/hooks/use-discard-confirm';
import { DiscardConfirmDialog } from '@/components/ui/discard-confirm-dialog';
import { useFileDownload } from '@/hooks/use-file-download';
import { useMountedFetch } from '@/hooks/use-mounted-fetch';
import { useAsyncAction } from '@/hooks/use-async-action';
import { highlightMatches } from '@/lib/highlight';

// ─────────────────────────────────────────────────────────────────────────────
// 表示用ヘルパ（純関数）
// ─────────────────────────────────────────────────────────────────────────────

const TONES: SettingTone[] = ['ink', 'teal', 'blue', 'orange', 'muted'];

/** id から決定的にアバタートーンを選ぶ（一覧の色変化を出すだけ・意味は持たせない）。 */
function toneFor(id: string): SettingTone {
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) sum += id.charCodeAt(i);
  return TONES[sum % TONES.length];
}

/** 表示名からイニシャル（姓名頭文字 2 字 / 単語境界が無ければ先頭 2 字）を作る。 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] ?? '') + (parts[parts.length - 1][0] ?? '');
  const compact = name.replace(/\s+/g, '');
  return compact.slice(0, 2);
}

/** ISO 文字列 → YYYY/MM/DD は @/lib/utils の formatDate を使用（cmn-0278 で一本化）。
 *  ここにあった private な同名・別実装（不正値で '—' を返す版）は取り違えの温床だったため撤去。 */

// cmn-0262: ここにあった private な formatDateTime（set-0067）は撤去し、@/lib/utils の
// formatDateTime へ寄せた。同名で実装だけ違う関数が並ぶ状態が取り違えの温床（fil-0111 の
// 原因構造）だったため。出力は同一で、不正値は空文字へ縮退するため呼び出し側で '—' を補う。

const SAVE_VERIFICATION_ERROR =
  '保存後の状態確認に失敗しました。実状態が変更済みの可能性があります。メンバー一覧を再読み込みして再確認してください。';

/**
 * 保存後の状態確認（PATCH 後の再取得 GET 照合）に失敗したことを表す専用エラー。
 * PATCH 自体の失敗（updateMember が throw）と区別するため、onError で instance 判定する
 *（set-0178 MEDIUM: PATCH 失敗を検証失敗と誤ラベルしない）。
 */
class SaveVerificationError extends Error {
  constructor() {
    super(SAVE_VERIFICATION_ERROR);
    this.name = 'SaveVerificationError';
  }
}

/**
 * ログイン試行ロックアウト（set-0025 P4 / lockedUntil）の自動解除までの残り概算分。null=ロックアウトなし / 期限切れ。
 * 秒精度を晒さず分概算のみ（backend と同方針）。最低 1 分・切り上げ。
 */
function lockoutMinutesLeft(lockedUntil: string | null): number | null {
  if (!lockedUntil) return null;
  const ms = new Date(lockedUntil).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** 現在ロックアウト中（lockedUntil が未来）か。isActive のロック（管理者手動無効化）とは別軸。 */
function isLockedOut(m: { lockedUntil: string | null }): boolean {
  return lockoutMinutesLeft(m.lockedUntil) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 行編集オーバーレイ（ロック/解除・ステータス）
// ─────────────────────────────────────────────────────────────────────────────

interface EditorState {
  id: string;
  name: string;
  /** 姓（set-0096・編集可）。 */
  familyName: string;
  /** 名（set-0096・編集可・空可）。 */
  givenName: string;
  /** メールアドレス（=ログイン識別子・set-0097・編集可）。 */
  email: string;
  isActive: boolean;
  /** ログイン試行ロックアウト解除予定（ISO・null=なし）。手動解除セクションの表示・即時クリア用（set-0030）。 */
  lockedUntil: string | null;
  /** 二段階認証（MFA）を有効化済みか。管理者強制リセットセクションの表示用（set-0033）。 */
  mfaEnabled: boolean;
  /** 編集開始時のスナップショット。保存時にこの基準から差分のある項目だけ送る（rete-settings-0020）。 */
  initial: {
    isActive: boolean;
    familyName: string;
    givenName: string;
    /** 編集開始時の email（set-0097）。差分検出と確認ダイアログ表示判定の基準。 */
    email: string;
  };
}

/** set-0135: 姓・名・メール行の局所 helper（settings 横断 FieldRow は範囲外）。 */
function MemberEditorTextField({
  label,
  type = 'text',
  value,
  onChange,
  testId,
}: {
  label: string;
  type?: 'text' | 'email';
  value: string;
  onChange: (value: string) => void;
  testId: string;
}) {
  return (
    <div style={{ marginBottom: '0.875rem' }}>
      <FormLabel>{label}</FormLabel>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="sp-input"
        style={{ width: '100%' }}
      />
    </div>
  );
}

function MemberEditor({
  editor,
  saving,
  unlocking,
  resettingMfa,
  onChange,
  onUnlock,
  onResetMfa,
  onSave,
  onCancel,
}: {
  editor: EditorState;
  saving: boolean;
  unlocking: boolean;
  resettingMfa: boolean;
  onChange: (
    patch: Partial<Pick<EditorState, 'isActive' | 'familyName' | 'givenName' | 'email'>>,
  ) => void;
  onUnlock: () => void;
  onResetMfa: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  // ログイン試行ロックアウト中（lockedUntil が未来）なら手動即時解除セクションを出す（set-0030）。
  const minutesLeft = lockoutMinutesLeft(editor.lockedUntil);
  // MFA リセットは不可逆（TOTP secret＋バックアップコード全消去）。誤クリック・画面共有中の操作ミスを防ぐため
  // 実行前に確認ダイアログを挟む（set-0039・可逆操作のロック解除には確認を付けない＝不可逆操作のみ）。
  const [mfaResetConfirm, setMfaResetConfirm] = useState(false);
  // set-0097: email 変更（=ログイン識別子の変更）は保存前に確認必須。次回から新 email でログインする旨を伝える。
  const [emailChangeConfirm, setEmailChangeConfirm] = useState(false);
  // set-0097: email 変更の確認ダイアログ判定。set-0178 HIGH 修正で backend の正規化
  // （trim + 小文字化・members.service.ts:147）と揃え、case-only 変更で偽の確認ダイアログを出さない。
  const emailChanged = editor.email.trim().toLowerCase() !== editor.initial.email;
  const discard = useDiscardConfirm();
  const dirty =
    editor.familyName !== editor.initial.familyName ||
    editor.givenName !== editor.initial.givenName ||
    editor.email !== editor.initial.email ||
    editor.isActive !== editor.initial.isActive;

  // set-0069: 画面下インラインではなく中央オーバーレイ（OverlayDialog）で編集する。
  // 保存中は Esc / 背景クリックでの閉じを抑止（criteria・従来どおり）。
  const handleClose = () => {
    if (!saving) discard.request(dirty, onCancel);
  };

  // 保存ボタン押下: email 変更ありなら確認ダイアログを先に出す（confirm 後→onSave で実 PATCH）。
  const handleSaveClick = () => {
    if (emailChanged) {
      setEmailChangeConfirm(true);
      return;
    }
    onSave();
  };

  return (
    <OverlayDialog open onClose={handleClose} ariaLabel="メンバーの編集" width="min(520px, 92vw)">
      <DiscardConfirmDialog
        open={discard.open}
        onConfirm={discard.onConfirm}
        onCancel={discard.onCancel}
      />
      {/* set-0119 rework: ヘッダの氏名ライブ計算（メール非表示・入力欄と重複するメールは出さない）。
        familyName/givenName から都度算出し、編集中に追従する（editor.name は編集開始時固定値で
        追従しない設計のため再計算式を採用・詳細は plan_notes 参照）。 */}
      <FormCard
        title="メンバーの編集"
        description={[editor.familyName, editor.givenName].filter(Boolean).join(' ')}
      >
        {/* ログイン試行ロックアウト（連続失敗の自動防御）— ロックアウト中のみ表示・手動即時解除。例外として最上部維持（set-0119） */}
        {minutesLeft !== null && (
          <div
            style={{
              marginBottom: '0.875rem',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              background: 'hsl(var(--warning) / 0.10)',
              border: '1px solid hsl(var(--warning) / 0.35)',
            }}
          >
            <FormLabel>ログイン試行ロックアウト</FormLabel>
            <p
              className="text-[0.8125rem] text-[var(--sp-text-warm)]"
              style={{ margin: '0 0 0.5rem' }}
            >
              連続したログイン失敗でロックされています（自動解除まで約 {minutesLeft} 分）。
            </p>
            <FormButton variant="primary" onClick={onUnlock} loading={unlocking}>
              今すぐロックを解除
            </FormButton>
          </div>
        )}

        {/* set-0119 順: 姓・名 → メール → ステータス → MFA（基本情報を先・セキュリティ系を末尾） */}
        {/* set-0096: 姓・名の2入力（表示名 name は保存時に backend で再組み立て） */}
        {/* set-0119: 姓・名は縦 1 列に積む。set-0135: 同型 3 行を局所 helper で畳む（横断 FieldRow は範囲外）。 */}
        {(
          [
            {
              label: '姓',
              type: 'text' as const,
              value: editor.familyName,
              testId: 'member-editor-family-name',
              patch: (v: string) => onChange({ familyName: v }),
            },
            {
              label: '名',
              type: 'text' as const,
              value: editor.givenName,
              testId: 'member-editor-given-name',
              patch: (v: string) => onChange({ givenName: v }),
            },
            {
              label: 'メールアドレス',
              type: 'email' as const,
              value: editor.email,
              testId: 'member-editor-email',
              patch: (v: string) => onChange({ email: v }),
            },
          ] as const
        ).map((field) => (
          <MemberEditorTextField
            key={field.testId}
            label={field.label}
            type={field.type}
            value={field.value}
            onChange={field.patch}
            testId={field.testId}
          />
        ))}

        {/* ステータス（トグルスイッチ・set-0070） */}
        <div style={{ marginBottom: '0.875rem' }}>
          <FormLabel>ステータス</FormLabel>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
            <ToggleSwitch
              checked={editor.isActive}
              onChange={(next) => onChange({ isActive: next })}
              ariaLabel={editor.isActive ? 'アカウントをロックする' : 'アカウントを有効にする'}
            />
            <span
              className="text-[0.8125rem] text-[var(--sp-text-warm)]"
              data-testid="member-editor-status-label"
            >
              {editor.isActive ? '有効' : 'ロック（ログイン不可）'}
            </span>
          </div>
        </div>

        {/* 二段階認証（MFA）— 状態表示 + 管理者強制リセット（set-0033）。set-0119 で末尾へ。有効時のみリセット導線。 */}
        <div style={{ marginBottom: '0.875rem' }}>
          <FormLabel>二段階認証（MFA）</FormLabel>
          {editor.mfaEnabled ? (
            <div
              style={{
                padding: '0.75rem',
                borderRadius: '0.5rem',
                background: 'hsl(var(--warning) / 0.10)',
                border: '1px solid hsl(var(--warning) / 0.35)',
              }}
            >
              {/* set-0112: 非可逆の注意文は確認ダイアログ側のみ（本文との二重掲示を解消） */}
              <p
                className="text-[0.8125rem] text-[var(--sp-text-warm)]"
                style={{ margin: '0 0 0.5rem' }}
              >
                この利用者は二段階認証を有効化しています。
              </p>
              <FormButton
                variant="primary"
                onClick={() => setMfaResetConfirm(true)}
                loading={resettingMfa}
                // 確認ダイアログ表示中／リセット処理中はボタンを無効化（set-0039・処理中の再表示を防ぐ）。
                disabled={mfaResetConfirm || resettingMfa}
              >
                二段階認証をリセット
              </FormButton>
            </div>
          ) : (
            <p className="text-[0.8125rem] text-[var(--sp-text-warm-mute)]" style={{ margin: 0 }}>
              二段階認証は設定されていません
            </p>
          )}
          {/* 不可逆な MFA リセットの確認ダイアログ（set-0039）。確定ボタンは destructive（赤）＝非可逆を色でも明示。 */}
          <ConfirmDialog
            open={mfaResetConfirm}
            message={`${editor.name} の二段階認証をリセットしますか？認証アプリとバックアップコードが全て消去され、元に戻せません（対象は次回ログインで再設定が必要になります）。`}
            destructive
            onConfirm={() => {
              setMfaResetConfirm(false);
              onResetMfa();
            }}
            onCancel={() => setMfaResetConfirm(false)}
          />
        </div>

        <FormActions>
          <FormButton variant="ghost" onClick={handleClose} disabled={saving}>
            キャンセル
          </FormButton>
          <FormButton variant="primary" onClick={handleSaveClick} loading={saving}>
            保存
          </FormButton>
        </FormActions>

        {/* set-0097: email 変更時の確認ダイアログ。=ログイン識別子変更のため次回から新 email が必要。 */}
        {/* AlertDialog は createPortal で document.body 直下へ描画され、ESC は内部で stopPropagation する */}
        {/* （alert-dialog.tsx:52-58）ため OverlayDialog には伝播せず、OverlayDialog は開いたまま残せる。       */}
        <ConfirmDialog
          open={emailChangeConfirm}
          message={`ログイン用メールアドレスを「${editor.email.trim()}」へ変更しますか？次回から新しいメールアドレスでログインします。`}
          destructive={false}
          onConfirm={() => {
            setEmailChangeConfirm(false);
            onSave();
          }}
          onCancel={() => setEmailChangeConfirm(false)}
        />
      </FormCard>
    </OverlayDialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MembersScreen（エントリーポイント）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * メンバー画面（設定タブ・アカウント管理 / ST-4）。既存 Account のメンバー情報を
 * 束ねて一覧・行編集する。backend `api/v1/members`（ADMIN 限定）に接続。
 */
export function MembersScreen() {
  const { user, loading: sessionLoading } = useSession();
  const isAdmin = user?.role === Role.ADMIN;

  const [members, setMembers] = useState<MemberDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  /** v2-233: 一覧の取得失敗（toast で消さず領域内に残す）。 */
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'locked'>('all');

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [resettingMfa, setResettingMfa] = useState(false);
  const { downloading: exporting, download } = useFileDownload();
  const { run } = useAsyncAction();

  // ── 初回ロード（メンバー + 契約システム）── set-0057: 非 ADMIN はフェッチしない
  // d659: 取得失敗の表示から再試行できるよう、取り直しを名付けて useMountedFetch と再試行の両方から呼ぶ。
  const loadMembers = useCallback(async (alive: () => boolean) => {
    setIsLoading(true);
    try {
      const memberList = await fetchMembers();
      if (!alive()) return;
      setMembers(memberList);
      // 前の失敗の表示を残さない（再試行で取れた画面に失敗の文言を残すと、成功と失敗の両方が出る）。
      setLoadError(null);
    } catch {
      // v2-233: 取得失敗は toast で消さず領域内（role="alert"）に残す（0件と区別できるようにする）。
      if (alive()) setLoadError('メンバーの読み込みに失敗しました');
    } finally {
      if (alive()) setIsLoading(false);
    }
  }, []);

  useMountedFetch(
    async (alive) => {
      if (!isAdmin) return;
      await loadMembers(alive);
    },
    [isAdmin, loadMembers],
  );

  // set-0180: system タブ撤去後は「全アカウント」1枚のみの装飾タブとなり、PageTabs ごと削除した。

  const rows = useMemo(() => {
    const byStatus =
      status === 'all'
        ? members
        : members.filter((m) => (status === 'locked' ? !m.isActive : m.isActive));
    const q = search.trim().toLowerCase();
    return q
      ? byStatus.filter(
          (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
        )
      : byStatus;
  }, [members, status, search]);

  // 上部 SummaryGrid 用 activeCount/lockedCount は set-0065 で削除。下部件数は rows ベース。
  const rowsActive = rows.filter((m) => m.isActive).length;
  const rowsLocked = rows.length - rowsActive;

  // ── 編集オーバーレイ ──
  function openEdit(m: MemberDto) {
    // set-0070: システムアクセスは UI 撤去（ロールベースのアクセス制御へ一本化）ため snapshot にも載せない。
    // set-0096: 姓・名を編集可能にし、差分送信の基準に含める。
    // set-0097: email も編集可能にし、差分送信の基準に含める（=ログイン識別子なので保存前に確認必須）。
    const snapshot = {
      isActive: m.isActive,
      familyName: m.familyName,
      givenName: m.givenName,
      email: m.email,
    };
    setEditor({
      id: m.id,
      name: m.name,
      lockedUntil: m.lockedUntil,
      mfaEnabled: m.mfaEnabled,
      ...snapshot,
      initial: snapshot,
    });
  }

  // ── ログイン試行ロックアウトの手動即時解除（set-0030）──
  async function handleUnlock() {
    if (!editor || unlocking) return;
    await run(
      async () => {
        const updated = await unlockMember(editor.id);
        // 一覧と編集中エディタの両方へ反映（lockedUntil クリア → ロックアウトセクションが消える）。
        setMembers((cur) => cur.map((m) => (m.id === updated.id ? updated : m)));
        setEditor((cur) =>
          cur && cur.id === updated.id ? { ...cur, lockedUntil: updated.lockedUntil } : cur,
        );
        toast.success('ロックを解除しました');
      },
      {
        onBusyChange: setUnlocking,
        onError: (err) => toast.error(apiErrorMessage(err, 'ロック解除に失敗しました')),
      },
    );
  }

  // ── 二段階認証（MFA）の管理者強制リセット（set-0033）──
  async function handleResetMfa() {
    if (!editor || resettingMfa) return;
    await run(
      async () => {
        const updated = await resetMemberMfa(editor.id);
        // 一覧と編集中エディタの両方へ反映（mfaEnabled=false → リセットセクションが消える）。
        setMembers((cur) => cur.map((m) => (m.id === updated.id ? updated : m)));
        setEditor((cur) =>
          cur && cur.id === updated.id ? { ...cur, mfaEnabled: updated.mfaEnabled } : cur,
        );
        toast.success('二段階認証をリセットしました');
      },
      {
        onBusyChange: setResettingMfa,
        onError: (err) => toast.error(apiErrorMessage(err, '二段階認証のリセットに失敗しました')),
      },
    );
  }

  function changeField(
    patch: Partial<Pick<EditorState, 'isActive' | 'familyName' | 'givenName' | 'email'>>,
  ) {
    setEditor((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  // ── CSV エクスポート ──
  async function handleExport() {
    await download(() => downloadMembersCsv(), 'members.csv', {
      onError: (err) => toast.error(apiErrorMessage(err, 'エクスポートに失敗しました')),
    });
  }

  async function handleSave() {
    if (!editor || saving) return;
    const targetId = editor.id;
    const { initial } = editor;
    // 差分送信（rete-settings-0020）: 編集開始時のスナップショットから変わった項目だけ送る。
    const input: MemberUpdateInput = {};
    if (editor.isActive !== initial.isActive) input.isActive = editor.isActive;
    // 姓・名は片方でも変われば両方送る（backend が name を再組み立て）。
    // set-0178 HIGH 修正: backend は familyName/givenName を .trim() して保存する（members.service.ts:127-128）。
    // initial は backend 保存済み（trim 済み）なので、入力値も trim してから比較・送信する（前後空白で
    // 誤って差分と判定されないように）。
    const normalizedFamilyName = editor.familyName.trim();
    const normalizedGivenName = editor.givenName.trim();
    if (normalizedFamilyName !== initial.familyName || normalizedGivenName !== initial.givenName) {
      input.familyName = normalizedFamilyName;
      input.givenName = normalizedGivenName;
    }
    // set-0097: email は trim 後の値で比較し、変わった時だけ送る。空白だけ／空文字は差分扱いしない
    // （バックエンドの BadRequest 前に UI で止める方が親切だが、backend が trim+空文字拒否するので防御線あり）。
    // set-0178 HIGH 修正: backend は email を trim+小文字化して保存する（members.service.ts:147）。
    // 照合値と送信値を揃えるため、trim+小文字化した値で送信・照合する（case-only 変更で偽の
    // SAVE_VERIFICATION_ERROR にならないように）。
    const normalizedEmail = editor.email.trim().toLowerCase();
    if (normalizedEmail !== initial.email) {
      input.email = normalizedEmail;
    }
    // システムアクセスは set-0070 で UI 撤去：save body にも載せない（ロールベースのアクセス制御へ一本化）。
    // 変更なし → PATCH せず閉じる（無編集保存の無駄打ち + 上記レースを回避）。
    if (
      input.isActive === undefined &&
      input.familyName === undefined &&
      input.givenName === undefined &&
      input.email === undefined
    ) {
      setEditor(null);
      return;
    }
    await run(
      async () => {
        await updateMember(targetId, input);

        let refreshed: MemberDto[];
        try {
          refreshed = await fetchMembers();
        } catch {
          throw new SaveVerificationError();
        }
        const confirmed = refreshed.find((member) => {
          if (member.id !== targetId) return false;
          // 保存後検証（set-0178）: PATCH 成功をそのまま信じず、送信した diff の各フィールドを
          // 再取得結果と照合してから成功扱いする。isActive に限らず input に載せた項目を対象にする。
          if (input.isActive !== undefined && member.isActive !== input.isActive) return false;
          if (input.familyName !== undefined && member.familyName !== input.familyName)
            return false;
          if (input.givenName !== undefined && member.givenName !== input.givenName) return false;
          if (input.email !== undefined && member.email !== input.email) return false;
          return true;
        });
        if (!confirmed) throw new SaveVerificationError();

        setMembers(refreshed);
        toast.success('メンバーを更新しました');
        setEditor(null);
      },
      {
        onBusyChange: setSaving,
        onError: (err) => {
          // set-0178 MEDIUM: PATCH 自体の失敗（backend メッセージ無し）は「更新に失敗」、
          // 保存後の状態確認の失敗は専用文言で区別する（Payload 側の updateMember が throw した時は
          // backend の意味あるメッセージを優先表示する）。
          const fallback =
            err instanceof SaveVerificationError ? SAVE_VERIFICATION_ERROR : '更新に失敗しました';
          toast.error(apiErrorMessage(err, fallback));
        },
      },
    );
  }

  // ── 権限ガード（set-0057: organizations-screen と同型・タイトルのみ表示） ──
  if (sessionLoading) return null;
  if (!isAdmin) {
    return (
      <main className="sp-page" style={{ overflowY: 'auto' }}>
        <PageTitle title="メンバー" />
      </main>
    );
  }

  return (
    <main className="sp-page" style={{ overflowY: 'auto' }}>
      {/* set-0062: メンバー画面のパンくずは不要のため削除（他 settings 画面は対象外） */}
      {/* set-0063: 見出し下の説明サブテキストは不要のため description を外す */}
      <PageTitle title="メンバー" />

      {/* set-0065: 上部サマリーカード4枚（総数/有効/ロック/契約 system）は不要のため削除。下部 Pagination は残す */}
      {/* set-0180: system タブ撤去後は「全アカウント」1枚のみの装飾タブとなったため PageTabs ごと削除 */}

      <FilterBar>
        <FilterSearchInput
          placeholder="氏名 / メールで検索..."
          value={search}
          onChange={setSearch}
        />
        <FilterChipSelect
          icon={CircleCheckBig}
          label="状態"
          ariaLabel="状態で絞り込み"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'すべて' },
            { value: 'active', label: '有効' },
            { value: 'locked', label: 'ロック中' },
          ]}
        />
        <FilterClear
          onClick={() => {
            setSearch('');
            setStatus('all');
          }}
        />
      </FilterBar>

      {/* set-0152: アクションは絞り込み帯の外・表の直上の独立行へ（右寄せは ListActionRow 内部の ActionGroup が担う）。
          v2-180: 全幅(約1151px)で右端まで伸びていた表を内容に合う幅へ絞り左寄せにする。表だけを絞ると右寄せの
          アクション行はページ全幅のままなので、CSV 出力ボタンが表の右端から外れて宙に浮く（実測 473px ずれ）。
          アクション行と TableCard を同じ max-width の枠へ入れて右端を揃える（ページャ上罫線も表と同じ幅になる）。
          実測: members は 660px で折り返しなし・set-0157 の .sp-table--narrow 50% は 576px で狭すぎるため個別指定。 */}
      <div style={{ maxWidth: 680 }}>
        <ListActionRow>
          <ActionButton
            icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
            ariaLabel="メンバーを CSV 出力"
            onClick={handleExport}
            disabled={exporting}
          >
            CSV 出力
          </ActionButton>
        </ListActionRow>

        <TableCard hoverBand>
          <table className="sp-table sp-table--hoverband">
            <thead>
              <tr>
                <th>ユーザー名</th>
                <th>メールアドレス</th>
                <th style={{ width: 100 }}>作成日</th>
                <th style={{ width: 140 }}>最終更新日</th>
                <th style={{ width: 64, textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const locked = !m.isActive;
                // ロック行は全列をミュート色に（モック settings/index.html の挙動に一致）。
                const cellColor = locked ? 'var(--sp-text-warm-mute)' : 'var(--sp-text-warm-2)';
                return (
                  <tr key={m.id} className="sp-row-pillable">
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          flexWrap: 'wrap',
                        }}
                      >
                        <MemberCell
                          initials={initialsOf(m.name)}
                          tone={toneFor(m.id)}
                          name={m.name}
                          locked={locked}
                          highlight={search}
                        />
                        {/* ログイン試行ロックアウト中（連続失敗の自動防御）を一覧で識別できるバッジ（isActive ロックとは別軸）。 */}
                        {isLockedOut(m) && (
                          <StatusBadge tone="orange" strong>
                            ロックアウト中
                          </StatusBadge>
                        )}
                      </div>
                    </td>
                    <td style={{ color: cellColor }}>{highlightMatches(m.email, search)}</td>
                    <td style={{ color: cellColor }}>{formatDate(m.createdAt)}</td>
                    <td style={{ color: cellColor }}>{formatDateTime(m.updatedAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {/* 保存中は別行を開かせない（開くと進行中の保存完了で別エディタが無音で閉じるため）。 */}
                      <RowEditButton
                        label={`${m.name} を編集`}
                        onClick={() => openEdit(m)}
                        disabled={saving}
                      />
                    </td>
                  </tr>
                );
              })}
              <TableStatusRows
                colSpan={5}
                isLoading={isLoading}
                empty={rows.length === 0}
                emptyLabel={search ? 'メンバーが見つかりませんでした' : 'メンバーがいません'}
                // 取得失敗は「見つかりませんでした」（0 件の文言）へ落とさない（空一覧と区別する表示）。
                errorLabel={loadError ? 'メンバーの読み込みに失敗しました' : null}
                onRetry={() => void loadMembers(() => true)}
              />
            </tbody>
          </table>
          {/* 取得に失敗した時に「全 0 件」と出すと、本当に 0 件の一覧と読み分けられない（d536 と同じ扱い）。 */}
          <Pagination
            total={
              loadError
                ? '全 — 件'
                : `全 ${rows.length} 件 (有効 ${rowsActive} / ロック ${rowsLocked})`
            }
          />
        </TableCard>
      </div>

      {editor && (
        <MemberEditor
          editor={editor}
          saving={saving}
          unlocking={unlocking}
          resettingMfa={resettingMfa}
          onChange={changeField}
          onUnlock={handleUnlock}
          onResetMfa={handleResetMfa}
          onSave={handleSave}
          onCancel={() => setEditor(null)}
        />
      )}
    </main>
  );
}
