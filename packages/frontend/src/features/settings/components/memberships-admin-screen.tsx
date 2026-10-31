'use client';

import { useCallback, useMemo, useState } from 'react';
import { ChevronRight, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';
import { MembershipScopeType, Role } from '@rete/shared';
import type {
  PermissionMatrixDto,
  PermissionMatrixScopeDto,
  UserGroupScopeGrantDto,
} from '@rete/shared';
import { useSession } from '@/features/auth';
import { cn } from '@/lib/utils';
import { useMountedFetch } from '@/hooks/use-mounted-fetch';
import { useDiscardConfirm } from '@/hooks/use-discard-confirm';
import { DiscardConfirmDialog } from '@/components/ui/discard-confirm-dialog';
import { FilterBar, FilterSearchInput } from '@/components/shared/filter-bar';
import { FormButton, PageTitle } from './primitives';
import { fetchPermissionMatrix } from '../lib/memberships-api';
import { addUserGroupGrant, removeUserGroupGrant } from '../lib/groups-api';
import { apiErrorMessage } from '../lib/api-error';

type MatrixRole = 'ADMIN' | 'MEMBER' | 'NONE';

type MatrixColumn = {
  id: string;
  name: string;
};

/** 3値スイッチの選択肢（v2-178: 表示順は既存ドロップダウン/モックに合わせ「一般・管理者・なし」）。 */
const ROLE_OPTIONS: { role: MatrixRole; label: string }[] = [
  { role: 'MEMBER', label: '一般' },
  { role: 'ADMIN', label: '管理者' },
  { role: 'NONE', label: 'なし' },
];

function cellKey(scope: PermissionMatrixScopeDto, column: MatrixColumn): string {
  return `${scope.scopeType}:${scope.id}:group:${column.id}`;
}

function scopeLabel(scopeType: PermissionMatrixScopeDto['scopeType']): string {
  if (scopeType === MembershipScopeType.ORGANIZATION) return '組織';
  if (scopeType === MembershipScopeType.PROJECT) return 'プロジェクト';
  return 'チャネル';
}

/** v2-188: 明細の未設定ラベルは「（なし）」（編集スイッチの選択肢「なし」とは別表記）。 */
function roleLabel(role: MatrixRole): string {
  if (role === 'ADMIN') return '管理者';
  if (role === 'MEMBER') return '一般';
  return '（なし）';
}

function buildSnapshot(data: PermissionMatrixDto): Record<string, MatrixRole> {
  const snapshot: Record<string, MatrixRole> = {};
  const scopeById = new Map(data.scopes.map((scope) => [`${scope.scopeType}:${scope.id}`, scope]));
  for (const grant of data.grants) {
    const scope = scopeById.get(`${grant.scopeType}:${grant.scopeId}`);
    if (!scope) continue;
    snapshot[`${scope.scopeType}:${scope.id}:group:${grant.groupId}`] = grant.role;
  }
  return snapshot;
}

function changePriority(from: MatrixRole, to: MatrixRole): number {
  if (to === 'ADMIN') return 0;
  if (from === 'NONE' && to === 'MEMBER') return 1;
  if (from === 'ADMIN') return 3;
  return 2;
}

/**
 * 上位未設定の検証（v2-178）: チャネル/プロジェクトを管理者・一般にする時、
 * 上位（チャネル→プロジェクトまたは組織 / プロジェクト→組織）が未設定なら
 * エラーメッセージを返し、この選択を拒否する（draft の途中値も参照する）。
 */
function hierarchyGapMessage(
  scopes: readonly PermissionMatrixScopeDto[],
  scope: PermissionMatrixScopeDto,
  role: MatrixRole,
  roleOfScope: (scopeId: string) => MatrixRole,
): string | null {
  if (role === 'NONE') return null;
  if (scope.scopeType === MembershipScopeType.CHANNEL) {
    const project = scopes.find((s) => s.id === scope.parentId);
    const org = project ? scopes.find((s) => s.id === project.parentId) : null;
    if (!project || roleOfScope(project.id) === 'NONE' || !org || roleOfScope(org.id) === 'NONE') {
      return '上位のプロジェクト、または組織に対する所属が未設定です';
    }
    return null;
  }
  if (scope.scopeType === MembershipScopeType.PROJECT) {
    const org = scopes.find((s) => s.id === scope.parentId);
    if (!org || roleOfScope(org.id) === 'NONE') {
      return '上位の組織に対する所属が未設定です';
    }
  }
  return null;
}

/** 3値の排他スイッチ（ひとつを選択すると他はOFF）。選択中の区分値を強調表示する。 */
function RoleSwitch({
  value,
  onChange,
  disabled,
  label,
}: {
  value: MatrixRole;
  onChange: (role: MatrixRole) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-1.5">
      {ROLE_OPTIONS.map((option) => {
        const active = value === option.role;
        return (
          <button
            key={option.role}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${label} を ${option.label} に設定`}
            disabled={disabled}
            onClick={() => onChange(option.role)}
            className={cn(
              'rounded px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              active
                ? 'bg-[color-mix(in_srgb,hsl(var(--sp-tone-blue))_10%,white)] font-medium text-[hsl(var(--sp-tone-blue))]'
                : 'text-[var(--sp-text-warm-mute)] hover:bg-[var(--sp-accent-soft)] hover:text-[var(--sp-accent-ink)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * v2-180: ヘッダ列の区切り線。
 *
 * この表は共通 .sp-table を使わないマトリクス表のため、ヘッダの区切りがセルの border-r
 * （＝ヘッダ行の上端から下端まで届く縦線）になっていた。他の一覧（.sp-table thead th::after）は
 * 「1px × 0.875rem・上下端に接しない短い線」なので、同じ見た目へ揃える。
 * 位置決めは親の th（position: sticky ＝ positioned）を基準にする。
 */
function HeaderDivider() {
  return (
    <span
      aria-hidden="true"
      data-testid="matrix-header-divider"
      className="pointer-events-none absolute right-0 top-1/2 h-3.5 w-px -translate-y-1/2 bg-[var(--sp-line-warm-2)]"
    />
  );
}

/** 所属管理（system ADMIN 専用）。縦=組織/PJ/チャネル、横=activeな管理グループ。 */
export function MembershipsAdminScreen() {
  const discard = useDiscardConfirm();
  const { user, loading: sessionLoading } = useSession();
  const isAdmin = user?.role === Role.ADMIN;
  const [matrix, setMatrix] = useState<PermissionMatrixDto | null>(null);
  const [snapshot, setSnapshot] = useState<Record<string, MatrixRole>>({});
  const [draft, setDraft] = useState<Record<string, MatrixRole>>({});
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  /** v2-233: matrix の取得失敗（toast で消さず領域内に残す）。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** v2-178: 編集モード中の管理グループ ID（null = 参照モード）。 */
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  const loadMatrix = useCallback(async (alive: () => boolean = () => true) => {
    const data = await fetchPermissionMatrix();
    if (!alive()) return;
    const nextSnapshot = buildSnapshot(data);
    setMatrix(data);
    setSnapshot(nextSnapshot);
    setDraft(nextSnapshot);
  }, []);

  // d659: 取得失敗の表示から再試行できるよう、失敗の受け止め込みで呼べる形にする。
  // 取れたら失敗の表示を消す（取れているのに失敗の文言が残ると成功と失敗が両方出る）。
  const loadMatrixOrError = useCallback(
    async (alive: () => boolean = () => true) => {
      setLoading(true);
      try {
        await loadMatrix(alive);
        if (alive()) setLoadError(null);
      } catch (error) {
        // v2-233: 取得失敗は toast で消さず領域内（role="alert"）に残す（0件と区別できるようにする）。
        if (alive()) setLoadError(apiErrorMessage(error, '所属設定の読み込みに失敗しました'));
      } finally {
        if (alive()) setLoading(false);
      }
    },
    [loadMatrix],
  );

  useMountedFetch(
    async (alive) => {
      if (!isAdmin) {
        setLoading(false);
        return;
      }
      await loadMatrixOrError(alive);
    },
    [isAdmin, loadMatrixOrError],
  );

  const columns = useMemo<MatrixColumn[]>(() => {
    if (!matrix) return [];
    return matrix.groups.map((group) => ({
      id: group.id,
      name: group.name,
    }));
  }, [matrix]);

  const normalizedQuery = query.trim().toLocaleLowerCase('ja');
  const { visibleScopes, searchVisibleColumns } = useMemo(() => {
    const allScopes = matrix?.scopes ?? [];
    if (!normalizedQuery) return { visibleScopes: allScopes, searchVisibleColumns: columns };
    const matchedScopes = allScopes.filter(
      (scope) =>
        scope.name.toLocaleLowerCase('ja').includes(normalizedQuery) ||
        scopeLabel(scope.scopeType).includes(normalizedQuery),
    );
    const matchedColumns = columns.filter((column) =>
      column.name.toLocaleLowerCase('ja').includes(normalizedQuery),
    );
    return {
      // 行だけまたは列だけがヒットした時は、反対軸を残して権限セルを読めるようにする。
      visibleScopes:
        matchedScopes.length > 0 ? matchedScopes : matchedColumns.length > 0 ? allScopes : [],
      searchVisibleColumns:
        matchedColumns.length > 0 ? matchedColumns : matchedScopes.length > 0 ? columns : [],
    };
  }, [columns, matrix, normalizedQuery]);

  /** v2-178: 編集モード中は対象グループの列のみ表示する（他グループの列は隠す）。 */
  const visibleColumns = useMemo(() => {
    if (editingGroupId) return columns.filter((column) => column.id === editingGroupId);
    return searchVisibleColumns;
  }, [columns, editingGroupId, searchVisibleColumns]);

  const grantByKey = useMemo(() => {
    const result = new Map<string, UserGroupScopeGrantDto>();
    if (!matrix) return result;
    for (const grant of matrix.grants) {
      result.set(`${grant.scopeType}:${grant.scopeId}:group:${grant.groupId}`, grant);
    }
    return result;
  }, [matrix]);

  const dirtyKeys = useMemo(() => {
    const keys = new Set([...Object.keys(snapshot), ...Object.keys(draft)]);
    return [...keys].filter((key) => (snapshot[key] ?? 'NONE') !== (draft[key] ?? 'NONE'));
  }, [draft, snapshot]);

  // set-0193: 管理者の選択にも確認ダイアログを挟まない（一般と同じ挙動）。
  function setCellRole(key: string, role: MatrixRole) {
    setDraft((current) => ({ ...current, [key]: role }));
  }

  /** v2-178: スイッチ選択時の上位未設定検証。検証エラーは選択を拒否し toast で知らせる。 */
  function handleRoleChange(
    key: string,
    scope: PermissionMatrixScopeDto,
    column: MatrixColumn,
    role: MatrixRole,
  ) {
    if (!matrix) return;
    const scopes = matrix.scopes;
    const roleOfScope = (scopeId: string): MatrixRole => {
      const parent = scopes.find((s) => s.id === scopeId);
      if (!parent) return 'NONE';
      return draft[`${parent.scopeType}:${parent.id}:group:${column.id}`] ?? 'NONE';
    };
    const error = hierarchyGapMessage(scopes, scope, role, roleOfScope);
    if (error) {
      toast.error(error);
      return;
    }
    setCellRole(key, role);
  }

  async function applyChange(key: string, to: MatrixRole) {
    const [scopeType, scopeId, , groupId] = key.split(':') as [
      MembershipScopeType,
      string,
      string,
      string,
    ];
    const existing = grantByKey.get(key);
    if (to === 'NONE') {
      if (existing) await removeUserGroupGrant(groupId, scopeType, scopeId);
      return;
    }
    await addUserGroupGrant({ groupId, scopeType, scopeId, role: to });
  }

  async function handleSave() {
    if (dirtyKeys.length === 0) return;
    const changes = dirtyKeys
      .map((key) => ({ key, from: snapshot[key] ?? 'NONE', to: draft[key] ?? 'NONE' }))
      .sort((a, b) => changePriority(a.from, a.to) - changePriority(b.from, b.to));
    setSaving(true);
    let applied = 0;
    try {
      for (const change of changes) {
        await applyChange(change.key, change.to);
        applied += 1;
      }
      await loadMatrix();
      setEditingGroupId(null);
      toast.success(`${applied}件の所属設定を更新しました`);
    } catch (error) {
      let reloaded = false;
      try {
        await loadMatrix();
        reloaded = true;
      } catch {
        // 再読込み失敗時も、最初の mutation エラーを優先して表示する。
      }
      const detail = apiErrorMessage(error, '所属設定の更新に失敗しました');
      toast.error(
        `${applied}件は反映済みです。以降の更新を停止しました。${
          reloaded
            ? 'サーバーの状態を再読込しました。'
            : 'サーバー状態の再読込にも失敗しました。画面を再読込してください。'
        }${detail}`,
      );
    } finally {
      setSaving(false);
    }
  }

  /** v2-178: 編集アイコンで編集モードの開始/終了を切り替える。 */
  function toggleEdit(groupId: string) {
    setEditingGroupId((current) => (current === groupId ? null : groupId));
  }

  if (sessionLoading) return null;
  if (!isAdmin) {
    return (
      <main className="sp-page" style={{ overflowY: 'auto' }}>
        <PageTitle title="所属管理" />
      </main>
    );
  }

  return (
    <main className="sp-page flex min-h-0 flex-col" style={{ overflow: 'hidden' }}>
      <PageTitle title="所属管理" />

      <div className="mb-3">
        <FilterBar>
          <div className="w-full max-w-md">
            <FilterSearchInput
              placeholder="組織・プロジェクト・チャネル・管理グループを検索"
              ariaLabel="所属管理を検索"
              value={query}
              onChange={setQuery}
            />
          </div>
        </FilterBar>
      </div>

      {/* v2-186: 外枠（枠線の箱）は表の行・列の寸法に追従して伸縮させ、上限を超えた時だけ内側へ
          スクロールバーを出す。flex-1 で領域いっぱいに伸ばすと、表が小さい時に枠だけの空白が
          残る（起票の指摘）。伸縮は flex の既定（grow 0 / shrink 1 ＋ min-h-0）に任せ、上限は
          横 max-w-full・縦 max-h（アプリヘッダ 31px とページ内の上下＝タイトル・絞り込み・
          操作行・余白 ≒169px を引いた可視領域）で受ける。読み込み中は表の寸法が決まらない
          ため従来どおり領域幅いっぱいに出す。 */}
      <div
        data-testid="permission-matrix-scroll"
        className={cn(
          'mb-3 max-h-[calc(100vh-12.5rem)] min-h-0 overflow-auto rounded-lg border border-[var(--sp-line-warm-2)] bg-white',
          loading || loadError ? 'w-full' : 'w-fit max-w-full',
        )}
      >
        {loading ? (
          <div className="grid h-48 place-items-center text-sm text-[var(--sp-text-warm-mute)]">
            読み込み中…
          </div>
        ) : loadError ? (
          // v2-233: 取得失敗は表を描かず領域内に残す（真0件の「条件に一致するスコープがありません」と区別する）。
          // d659: 再試行を添える（これが無いと、失敗が続く間は画面を開き直すまで戻れない）。
          <div
            role="alert"
            className="grid h-48 place-items-center px-4 text-center text-sm text-[var(--sp-accent-red)]"
          >
            <span>
              {loadError}
              <span className="ml-2 inline-block">
                <FormButton
                  variant="secondary"
                  loading={loading}
                  onClick={() => void loadMatrixOrError()}
                >
                  再試行
                </FormButton>
              </span>
            </span>
          </div>
        ) : (
          <table className="min-w-max border-separate border-spacing-0 text-[0.8125rem]">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-40 min-w-64 border-b border-[var(--sp-line-warm-2)] px-2 py-1.5 text-center text-[0.6875rem] font-normal text-[var(--sp-text-warm-mute)]">
                  組織 / プロジェクト / チャネル
                </th>
                {visibleColumns.map((column, columnIndex) => {
                  const isEditing = editingGroupId === column.id;
                  return (
                    <th
                      key={column.id}
                      className={cn(
                        'sticky top-0 z-30 border-b border-[var(--sp-line-warm-2)] px-2 py-1.5 text-center text-[0.6875rem] font-normal text-[var(--sp-text-warm-mute)]',
                        isEditing ? 'min-w-72 max-w-none' : 'min-w-40 max-w-48',
                      )}
                    >
                      {/* v2-179 修正: ラベル中央寄せ・編集アイコンをラベル後に置いて1行化（段を落としてヘッダ縦幅を圧縮） */}
                      <div className="flex min-w-0 items-center justify-center gap-1">
                        <span className="truncate" title={column.name}>
                          {column.name}
                        </span>
                        <button
                          type="button"
                          aria-label={`管理グループ ${column.name} を編集`}
                          onClick={() => toggleEdit(column.id)}
                          className={cn(
                            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--sp-text-warm-mute)] hover:bg-[var(--sp-accent-soft)] hover:text-[var(--sp-accent-ink)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--sp-focus-border)]',
                            isEditing && 'bg-[var(--sp-accent-soft)] text-[var(--sp-accent-ink)]',
                          )}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      {/* 区切り線は行ヘッダ列と末尾列には出さない（管理グループ列どうしの区切りだけ残す・v2-188 で行ヘッダ列を除外）。 */}
                      {columnIndex < visibleColumns.length - 1 && <HeaderDivider />}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleScopes.map((scope, rowIndex) => {
                // v2-180 / mdl-0022: 明細は偶数行（2,4,…）に縞を敷く（.sp-table tbody tr:nth-child(even) と同じ扱い）。
                // v2-188: 明細は列区切りの縦線を出さない（行区切りの border-b だけ残す）。固定列の右端も線を出さない。
                const striped = rowIndex % 2 === 1;
                return (
                  <tr key={`${scope.scopeType}:${scope.id}`}>
                    <th
                      className="sticky left-0 z-20 border-b border-[var(--sp-line-warm-2)] px-2 py-2 text-left font-normal"
                      style={{
                        paddingLeft: `${1 + scope.depth * 1.25}rem`,
                        // 固定列は不透明でないと横スクロール時に下の列が透ける。縞は白の上へ重ねて塗る
                        // （縞 OFF のときは --sp-row-stripe が transparent になり白のまま残る）。
                        backgroundColor: 'white',
                        backgroundImage: striped
                          ? 'linear-gradient(var(--sp-row-stripe), var(--sp-row-stripe))'
                          : undefined,
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        {scope.depth > 0 && (
                          <ChevronRight
                            className="h-3.5 w-3.5 shrink-0 text-[var(--sp-text-warm-mute)]"
                            aria-hidden="true"
                          />
                        )}
                        <span className="truncate text-[var(--sp-text-warm)]" title={scope.name}>
                          {scope.name}
                        </span>
                      </div>
                    </th>
                    {visibleColumns.map((column) => {
                      const key = cellKey(scope, column);
                      const role = draft[key] ?? 'NONE';
                      const dirty = (snapshot[key] ?? 'NONE') !== role;
                      return (
                        <td
                          key={key}
                          className="border-b border-[var(--sp-line-warm-2)] px-2 py-1"
                          style={{
                            background: dirty
                              ? 'hsl(var(--sp-tone-orange) / 0.1)'
                              : striped
                                ? 'var(--sp-row-stripe)'
                                : 'white',
                          }}
                        >
                          {editingGroupId === column.id ? (
                            <RoleSwitch
                              value={role}
                              onChange={(next) => handleRoleChange(key, scope, column, next)}
                              disabled={saving}
                              label={`${scope.name} × 管理グループ ${column.name} の所属ロール`}
                            />
                          ) : (
                            <span
                              className={cn(
                                'block px-2 py-1 text-center',
                                role === 'NONE'
                                  ? 'text-[var(--sp-text-warm-mute)]'
                                  : 'text-[var(--sp-text-warm)]',
                              )}
                            >
                              {roleLabel(role)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {visibleScopes.length === 0 && (
                <tr>
                  <td
                    colSpan={Math.max(1, visibleColumns.length + 1)}
                    className="p-8 text-center text-[var(--sp-text-warm-mute)]"
                  >
                    条件に一致するスコープがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-auto flex justify-end gap-2 border-t border-[var(--sp-line-warm-2)] pt-3">
        <FormButton
          variant="ghost"
          onClick={() => discard.request(dirtyKeys.length > 0, () => setDraft(snapshot))}
          disabled={saving || dirtyKeys.length === 0}
        >
          キャンセル
        </FormButton>
        <FormButton
          variant="primary"
          onClick={handleSave}
          disabled={dirtyKeys.length === 0}
          loading={saving}
        >
          更新
        </FormButton>
      </div>
      <DiscardConfirmDialog
        open={discard.open}
        onConfirm={discard.onConfirm}
        onCancel={discard.onCancel}
      />
    </main>
  );
}
