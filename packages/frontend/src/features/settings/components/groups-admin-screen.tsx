'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus } from 'lucide-react';
import { Role } from '@rete/shared';
import type { UserGroupDto } from '@rete/shared';
import { useSession } from '@/features/auth';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAsyncAction } from '@/hooks/use-async-action';
import { useDeleteConfirm } from '@/hooks/use-delete-confirm';
import { useMountedFetch } from '@/hooks/use-mounted-fetch';
import {
  ActionButton,
  ListActionRow,
  PageTitle,
  Pagination,
  RowDeleteButton,
  RowEditButton,
  TableCard,
} from './primitives';
import { TableStatusRows } from './table-status-rows';
import { deleteUserGroup, fetchUserGroups } from '../lib/groups-api';
import { apiErrorMessage } from '../lib/api-error';

/**
 * 管理グループの一覧画面（set-0188・システム ADMIN 専用）。
 * 管理グループはユーザーを束ねるだけの器で、参加先は所属管理で設定する。
 * set-0188: アーカイブ/復元を撤去し、一覧は「作成サブ画面へ進む」「編集サブ画面へ進む」「物理削除する」の
 * 3 操作だけを持つ（一覧そのものに作成欄・改名欄・メンバー編集欄を置かない）。
 */
export function GroupsAdminScreen() {
  const { user, loading: sessionLoading } = useSession();
  const isAdmin = user?.role === Role.ADMIN;
  const router = useRouter();

  const [groups, setGroups] = useState<UserGroupDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [acting, setActing] = useState(false);
  /** v2-233: 一覧の取得失敗（toast で消さず領域内に残す）。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const { run } = useAsyncAction();

  // d659: 取得失敗の表示から再試行できるよう、取り直しを名付けて初回ロードと再試行の両方から呼ぶ。
  const loadGroups = useCallback(async (alive: () => boolean) => {
    setIsLoading(true);
    try {
      const list = await fetchUserGroups();
      if (alive()) {
        setGroups(list);
        // 前の失敗の表示を残さない（取れたのに失敗の文言が残ると、成功と失敗の両方が出る）。
        setLoadError(null);
      }
    } catch (err) {
      // v2-233: 取得失敗は toast で消さず領域内（role="alert"）に残す（0件と区別できるようにする）。
      if (alive()) setLoadError(apiErrorMessage(err, '管理グループの読み込みに失敗しました'));
    } finally {
      if (alive()) setIsLoading(false);
    }
  }, []);

  useMountedFetch(
    async (alive) => {
      if (!isAdmin) return; // set-0057: 非 ADMIN はフェッチしない
      await loadGroups(alive);
    },
    [isAdmin, loadGroups],
  );

  // 削除は確認ダイアログの OK 後（cmn-0112 の useDeleteConfirm: close-first）。
  const { deleteTarget, setDeleteTarget, handleDelete } = useDeleteConfirm<UserGroupDto>({
    remove: async (id) => {
      let ok = false;
      await run(
        async () => {
          await deleteUserGroup(String(id));
          ok = true;
        },
        {
          onBusyChange: setActing,
          onError: (err) => toast.error(apiErrorMessage(err, '削除に失敗しました')),
        },
      );
      return ok;
    },
    onSuccess: (id, target) => {
      setGroups((cur) => cur.filter((group) => group.id !== id));
      toast.success(`管理グループ「${target.name}」を削除しました`);
    },
  });

  if (sessionLoading) return null;
  if (!isAdmin) {
    return (
      <main className="sp-page" style={{ overflowY: 'auto' }}>
        <PageTitle title="管理グループ" />
      </main>
    );
  }

  return (
    <main className="sp-page" style={{ overflowY: 'auto' }}>
      <PageTitle title="管理グループ" />

      {/* v2-167: 一覧ブロックの幅を組織管理に合わせて lg 幅で4割に絞る（左端はタイトルと同じ） */}
      <div className="lg:w-[40%]">
        <ListActionRow>
          <ActionButton
            icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            ariaLabel="管理グループを新規作成"
            onClick={() => router.push('/settings/groups/new')}
            disabled={acting}
          >
            新規作成
          </ActionButton>
        </ListActionRow>

        <TableCard hoverBand>
          <table className="sp-table sp-table--hoverband">
            <thead>
              <tr>
                <th>名称</th>
                <th style={{ width: 120 }}>ユーザー数</th>
                <th style={{ width: 120, textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id} className="sp-row-pillable">
                  <td>
                    <span className="text-[var(--sp-text-warm)]">{group.name}</span>
                  </td>
                  <td>{group.memberCount ?? 0}人</td>
                  <td style={{ textAlign: 'right' }}>
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: '0.375rem',
                      }}
                    >
                      <RowEditButton
                        label={`${group.name} を編集`}
                        disabled={acting}
                        onClick={() => router.push(`/settings/groups/${group.id}`)}
                      />
                      <RowDeleteButton
                        label={`${group.name} を削除`}
                        disabled={acting}
                        onClick={() => setDeleteTarget(group)}
                      />
                    </div>
                  </td>
                </tr>
              ))}

              <TableStatusRows
                colSpan={3}
                isLoading={isLoading}
                empty={groups.length === 0}
                emptyLabel="管理グループがありません"
                errorLabel={loadError}
                onRetry={() => void loadGroups(() => true)}
              />
            </tbody>
          </table>
          <Pagination
            total={isLoading || loadError ? '全 — 件' : `全 ${groups.length} 件`}
            pageLabel={isLoading || loadError ? '' : undefined}
          />
        </TableCard>
      </div>

      {/* 削除確認（グループ・所属ユーザー・所属設定が同時に消える＝destructive） */}
      <ConfirmDialog
        open={deleteTarget !== null}
        busy={acting}
        message={
          deleteTarget
            ? `管理グループ「${deleteTarget.name}」を削除しますか？所属ユーザーと所属設定（組織・プロジェクト・チャネルへの参加ロール）も同時に削除され、元に戻せません。`
            : '管理グループを削除しますか？'
        }
        destructive
        onConfirm={() => {
          if (!acting) void handleDelete();
        }}
        onCancel={() => {
          if (!acting) setDeleteTarget(null);
        }}
      />
    </main>
  );
}
