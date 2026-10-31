'use client';
import {
  FilterBar,
  FilterChipSelect,
  FilterClear,
  FilterSearchInput,
} from '@/components/shared/filter-bar';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ListActionRow, PageTitle } from '@/features/settings/components/primitives';
import { Archive } from 'lucide-react';
import toast from 'react-hot-toast';
import { useOrganizationManagement } from '../hooks/use-organization-management';
import { ChannelPane } from './organization-management/channel-pane';
import { NameDialog } from './organization-management/name-dialog';
import { OrgPane } from './organization-management/org-pane';
import { PaneAddButton } from './organization-management/pane-add-button';
import { PaneHeader } from './organization-management/pane-header';
import { ProjectPane } from './organization-management/project-pane';

export function OrganizationsScreen() {
  const {
    sessionLoading,
    isAdmin,
    archiveFilter,
    setArchiveFilter,
    includeArchived,
    search,
    setSearch,
    projectArchiveFilter,
    setProjectArchiveFilter,
    projectIncludeArchived,
    projectSearch,
    setProjectSearch,
    channelArchiveFilter,
    setChannelArchiveFilter,
    channelIncludeArchived,
    channelSearch,
    setChannelSearch,
    dialog,
    setDialog,
    saving,
    selectedOrgId,
    selectedProjectId,
    orgCrud,
    projectsLoading,
    projectsBusy,
    projectsError,
    channelsLoading,
    channelsBusy,
    channelsError,
    reloadOrgs,
    reloadProjects,
    reloadChannels,
    handleSelectOrg,
    handleSelectProject,
    query,
    projectQuery,
    channelQuery,
    visibleOrgs,
    visibleProjects,
    visibleChannels,
    handleDialogSave,
    handleOrgRestore,
    handleProjectRestore,
    handleChannelRestore,
    deleteTarget,
    setDeleteTarget,
    handleDelete,
    selectedOrg,
    selectedProject,
  } = useOrganizationManagement();

  // ── 権限ガード ──
  if (sessionLoading) return null;
  if (!isAdmin) {
    return (
      <main className="sp-page" style={{ overflowY: 'auto' }}>
        <PageTitle title="組織管理" />
      </main>
    );
  }

  return (
    <main className="sp-page" style={{ overflowY: 'auto' }}>
      <PageTitle title="組織管理" />

      {/* 3 ペイン縦積み */}
      <div className="grid grid-cols-1 items-start gap-4 lg:w-[40%]">
        {/* 左: 組織 */}
        <section aria-label="組織一覧">
          <PaneHeader title="組織" />
          <FilterBar>
            <FilterSearchInput placeholder="組織名で検索..." value={search} onChange={setSearch} />
            <FilterChipSelect
              icon={Archive}
              label="状態"
              ariaLabel="状態で絞り込み"
              value={archiveFilter}
              onChange={setArchiveFilter}
              options={[
                { value: 'active', label: '有効のみ' },
                { value: 'all', label: 'アーカイブ済も表示' },
              ]}
            />
            <FilterClear
              onClick={() => {
                setSearch('');
                setArchiveFilter('active');
              }}
            />
          </FilterBar>
          <ListActionRow>
            <PaneAddButton
              label="組織を追加"
              onClick={() => setDialog({ kind: 'create-org' })}
              disabled={orgCrud.creating}
            />
          </ListActionRow>
          <OrgPane
            orgs={visibleOrgs}
            isLoading={orgCrud.isLoading}
            selectedOrgId={selectedOrgId}
            updating={orgCrud.updating}
            searching={query !== ''}
            includeArchived={includeArchived}
            error={orgCrud.error}
            onRetry={reloadOrgs}
            onSelect={handleSelectOrg}
            onRename={(org) => setDialog({ kind: 'rename-org', id: org.id, currentName: org.name })}
            onArchive={(org) =>
              setDeleteTarget({ action: 'archive', kind: 'org', id: org.id, name: org.name })
            }
            onRestore={handleOrgRestore}
            onDelete={(org) =>
              setDeleteTarget({ action: 'delete', kind: 'org', id: org.id, name: org.name })
            }
          />
        </section>

        {/* 中央: PJ（選択組織配下） */}
        <section aria-label="プロジェクト一覧">
          <PaneHeader title="プロジェクト" />
          <FilterBar>
            <FilterSearchInput
              placeholder="プロジェクト名で検索..."
              value={projectSearch}
              onChange={setProjectSearch}
            />
            <FilterChipSelect
              icon={Archive}
              label="状態"
              ariaLabel="プロジェクトの状態で絞り込み"
              value={projectArchiveFilter}
              onChange={setProjectArchiveFilter}
              options={[
                { value: 'active', label: '有効のみ' },
                { value: 'all', label: 'アーカイブ済も表示' },
              ]}
            />
            <FilterClear
              onClick={() => {
                setProjectSearch('');
                setProjectArchiveFilter('active');
              }}
            />
          </FilterBar>
          <ListActionRow>
            <PaneAddButton
              label="プロジェクトを追加"
              onClick={
                selectedOrg
                  ? () => setDialog({ kind: 'create-project', orgId: selectedOrg.id })
                  : () => {
                      toast.error('先に組織を選択してください');
                    }
              }
              disabled={projectsBusy}
            />
          </ListActionRow>
          <ProjectPane
            projects={visibleProjects}
            isLoading={projectsLoading}
            selectedProjectId={selectedProjectId}
            updating={projectsBusy}
            searching={projectQuery !== ''}
            includeArchived={projectIncludeArchived}
            error={projectsError}
            onRetry={() => void reloadProjects()}
            onSelect={handleSelectProject}
            onRename={(p) => setDialog({ kind: 'rename-project', id: p.id, currentName: p.name })}
            onArchive={(p) =>
              setDeleteTarget({ action: 'archive', kind: 'project', id: p.id, name: p.name })
            }
            onRestore={handleProjectRestore}
            onDelete={(p) =>
              setDeleteTarget({ action: 'delete', kind: 'project', id: p.id, name: p.name })
            }
          />
        </section>

        {/* 右: チャネル（選択 PJ 配下） */}
        <section aria-label="チャネル一覧">
          <PaneHeader title="チャネル" />
          <FilterBar>
            <FilterSearchInput
              placeholder="チャネル名で検索..."
              value={channelSearch}
              onChange={setChannelSearch}
            />
            <FilterChipSelect
              icon={Archive}
              label="状態"
              ariaLabel="チャネルの状態で絞り込み"
              value={channelArchiveFilter}
              onChange={setChannelArchiveFilter}
              options={[
                { value: 'active', label: '有効のみ' },
                { value: 'all', label: 'アーカイブ済も表示' },
              ]}
            />
            <FilterClear
              onClick={() => {
                setChannelSearch('');
                setChannelArchiveFilter('active');
              }}
            />
          </FilterBar>
          <ListActionRow>
            <PaneAddButton
              label="チャネルを追加"
              onClick={
                selectedProject
                  ? () => setDialog({ kind: 'create-channel', projectId: selectedProject.id })
                  : () => {
                      toast.error('先にプロジェクトを選択してください');
                    }
              }
              disabled={channelsBusy}
            />
          </ListActionRow>
          <ChannelPane
            channels={visibleChannels}
            isLoading={channelsLoading}
            updating={channelsBusy}
            searching={channelQuery !== ''}
            includeArchived={channelIncludeArchived}
            error={channelsError}
            onRetry={() => void reloadChannels()}
            onRename={(ch) =>
              setDialog({ kind: 'rename-channel', id: ch.id, currentName: ch.name })
            }
            onArchive={(ch) =>
              setDeleteTarget({ action: 'archive', kind: 'channel', id: ch.id, name: ch.name })
            }
            onRestore={handleChannelRestore}
            onDelete={(ch) =>
              setDeleteTarget({ action: 'delete', kind: 'channel', id: ch.id, name: ch.name })
            }
          />
        </section>
      </div>

      {/* ── ダイアログ ── */}
      {dialog?.kind === 'create-org' && (
        <NameDialog
          title="組織を追加"
          saving={saving}
          onSave={handleDialogSave}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename-org' && (
        <NameDialog
          title="組織名を変更"
          initialName={dialog.currentName}
          saving={saving}
          onSave={handleDialogSave}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'create-project' && (
        <NameDialog
          title="プロジェクトを追加"
          saving={saving}
          onSave={handleDialogSave}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename-project' && (
        <NameDialog
          title="プロジェクト名を変更"
          initialName={dialog.currentName}
          saving={saving}
          onSave={handleDialogSave}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'create-channel' && (
        <NameDialog
          title="チャネルを追加"
          saving={saving}
          onSave={handleDialogSave}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename-channel' && (
        <NameDialog
          title="チャネル名を変更"
          initialName={dialog.currentName}
          saving={saving}
          onSave={handleDialogSave}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* 確認（アーカイブ / 削除）。削除は紐づきがあれば backend が 409・メッセージはエラートーストで表示 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        message={
          deleteTarget
            ? deleteTarget.action === 'archive'
              ? `${deleteTarget.kind === 'org' ? '組織' : deleteTarget.kind === 'project' ? 'プロジェクト' : 'チャネル'}「${deleteTarget.name}」をアーカイブしますか？${
                  deleteTarget.kind === 'org'
                    ? '配下のプロジェクトも連鎖してアーカイブされます。'
                    : deleteTarget.kind === 'project'
                      ? '配下のチャネルも連鎖してアーカイブされます。'
                      : '一覧から表示されなくなります。'
                }`
              : `${deleteTarget.kind === 'org' ? '組織' : deleteTarget.kind === 'project' ? 'プロジェクト' : 'チャネル'}「${deleteTarget.name}」を削除しますか？削除すると元に戻せません。配下のデータがある場合は削除できません（アーカイブしてください）。`
            : ''
        }
        destructive
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}
