'use client';
import { useSession } from '@/features/auth';
import { useEntityCrud } from '@/features/settings/hooks/use-entity-crud';
import { apiErrorMessage } from '@/features/settings/lib/api-error';
import {
  adminUpdateOrganization,
  adminUpdateProject,
  createOrganization,
  createProjectAdmin,
  deleteOrganization,
  deleteProject,
  fetchOrganizationsAdmin,
  fetchProjectsAdmin,
} from '@/features/settings/lib/orgs-api';
import {
  adminUpdateChannel,
  createChannelAdmin,
  deleteChannel,
  fetchChannelsByProjectAdmin,
} from '@/features/settings/lib/spaces-api';
import { useAsyncAction } from '@/hooks/use-async-action';
import { useDeleteConfirm } from '@/hooks/use-delete-confirm';
import type { OrganizationDto, ProjectDto, SpaceDto } from '@rete/shared';
import { Role, SpaceKind } from '@rete/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type { DeleteTarget, DialogMode } from '../lib/organization-management-types';

export function useOrganizationManagement() {
  const { user, loading: sessionLoading } = useSession();
  const isAdmin = user?.role === Role.ADMIN;

  // 各ペインの絞り込み（set-0149 / set-0177）: 状態チップ + 検索窓。
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'all'>('active');
  const includeArchived = archiveFilter === 'all';
  const [search, setSearch] = useState('');
  const [projectArchiveFilter, setProjectArchiveFilter] = useState<'active' | 'all'>('active');
  const projectIncludeArchived = projectArchiveFilter === 'all';
  const [projectSearch, setProjectSearch] = useState('');
  const [channelArchiveFilter, setChannelArchiveFilter] = useState<'active' | 'all'>('active');
  const channelIncludeArchived = channelArchiveFilter === 'all';
  const [channelSearch, setChannelSearch] = useState('');
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [saving, setSaving] = useState(false);
  const { run } = useAsyncAction();

  // ── 選択状態（ドリルダウン連動）──
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // 初期表示のみ先頭 PJ を自動選択する（criterion 1）。組織クリック後の再ロードでは
  // 自動選択せずチャネル空白を維持する（criterion 2 の非対称）。削除・アーカイブで
  // 選択 PJ が消えた場合はフラグに関係なく先頭へフォールバックする（criterion 5）。
  const [autoSelectFirstProject, setAutoSelectFirstProject] = useState(true);

  // ── 組織 CRUD ──
  const fetchOrgs = useCallback(() => fetchOrganizationsAdmin(includeArchived), [includeArchived]);
  const orgCrud = useEntityCrud<OrganizationDto>({
    fetchFn: fetchOrgs,
    createFn: (name) => createOrganization({ name }),
    updateFn: (id, patch) => adminUpdateOrganization(id, patch),
    // v2-410: 取得失敗は組織ペイン内の role="alert" へ出す（正本 ui.ts:109）。
    loadErrorMessage: '組織の取得に失敗しました',
  });

  // ── PJ CRUD（選択組織配下・admin 経路）──
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsBusy, setProjectsBusy] = useState(false);
  /** v2-410: 直近の取得成功で消える、現世代の PJ 一覧取得失敗（ペイン内 role="alert" へ接続）。 */
  const [projectsError, setProjectsError] = useState<string | null>(null);
  // 世代カウンタ: 組織 A→B の素早い切替で A の応答が後着して B の一覧を上書きしないようにする
  // （set-0150 の use-entity-crud 同型パターン・set-0162）。
  const projectsGenerationRef = useRef(0);
  const loadProjects = useCallback(async () => {
    // null 遷移（選択解除・組織切替）でも世代を進め、進行中の旧フェッチを無効化する
    // （後着応答がクリア済み一覧を上書きしないように・set-0162）。
    const generation = ++projectsGenerationRef.current;
    if (!selectedOrgId) {
      setProjects([]);
      // 選択解除はこのペインの失敗表示も消す（v2-410）。
      setProjectsError(null);
      // v2-421: 対象が外れた時も読み込み中を下ろす。ここで下ろさないと、進行中の旧取得が
      // 世代ガードで捨てられる（finally も世代不一致で下ろせない）ため「読み込み中」が残る。
      setProjectsLoading(false);
      return;
    }
    setProjectsLoading(true);
    try {
      // system ADMIN 経路（membership 非依存）。
      const list = await fetchProjectsAdmin(selectedOrgId, projectIncludeArchived);
      if (generation !== projectsGenerationRef.current) return;
      setProjects(list);
      // 現世代の成功でだけ失敗表示を消す（v2-410）。
      setProjectsError(null);
    } catch (err) {
      if (generation !== projectsGenerationRef.current) return;
      // 取得失敗時は旧一覧を残さない（世代一致＝現在の選択に対する応答の失敗のみクリア・instruction-board-backlog-0022）
      setProjects([]);
      // 失敗は領域内にも残す（toast だけにしない・正本 ui.ts:109。v2-410）。
      const message = apiErrorMessage(err, 'プロジェクトの取得に失敗しました');
      setProjectsError(message);
      toast.error(message);
    } finally {
      if (generation === projectsGenerationRef.current) setProjectsLoading(false);
    }
  }, [selectedOrgId, projectIncludeArchived]);

  // ── チャネル CRUD（選択 PJ 配下・admin 経路）──
  const [channels, setChannels] = useState<SpaceDto[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsBusy, setChannelsBusy] = useState(false);
  /** v2-410: 直近の取得成功で消える、現世代のチャネル一覧取得失敗（ペイン内 role="alert" へ接続）。 */
  const [channelsError, setChannelsError] = useState<string | null>(null);
  // 世代カウンタ: PJ 切替の後着応答が選択外のチャネル一覧を上書きしないようにする（set-0162）。
  const channelsGenerationRef = useRef(0);
  const loadChannels = useCallback(async () => {
    // null 遷移（選択解除・PJ 切替）でも世代を進め、進行中の旧フェッチを無効化する
    // （後着応答がクリア済み一覧を上書きしないように・set-0162）。
    const generation = ++channelsGenerationRef.current;
    if (!selectedProjectId) {
      setChannels([]);
      // 選択解除はこのペインの失敗表示も消す（v2-410）。
      setChannelsError(null);
      // v2-421: 対象が外れた時も読み込み中を下ろす（projects 側と同じ理由。進行中の旧取得が
      // 世代ガードで捨てられ finally でも下ろせないため、ここで下ろさないと表示が残る）。
      setChannelsLoading(false);
      return;
    }
    setChannelsLoading(true);
    try {
      // system ADMIN 経路（membership 非依存）。
      const list = await fetchChannelsByProjectAdmin(selectedProjectId, channelIncludeArchived);
      if (generation !== channelsGenerationRef.current) return;
      setChannels(list);
      // 現世代の成功でだけ失敗表示を消す（v2-410）。
      setChannelsError(null);
    } catch (err) {
      if (generation !== channelsGenerationRef.current) return;
      // 取得失敗時は旧一覧を残さない（世代一致＝現在の選択に対する応答の失敗のみクリア・instruction-board-backlog-0022）
      setChannels([]);
      // 失敗は領域内にも残す（toast だけにしない・正本 ui.ts:109。v2-410）。
      const message = apiErrorMessage(err, 'チャネルの取得に失敗しました');
      setChannelsError(message);
      toast.error(message);
    } finally {
      if (generation === channelsGenerationRef.current) setChannelsLoading(false);
    }
  }, [selectedProjectId, channelIncludeArchived]);

  // ── ドリルダウン連動 ──
  // 組織選択: PJ ペインを切り替え、チャネルは空白（指示どおりの非対称・criterion 2）。
  function handleSelectOrg(org: OrganizationDto) {
    setAutoSelectFirstProject(false); // ユーザー操作では PJ を自動選択しない（チャネル空白を維持）
    setSelectedOrgId(org.id);
    setSelectedProjectId(null);
    setChannels([]);
  }

  // PJ 選択: チャネルペインを切り替え。
  function handleSelectProject(project: ProjectDto) {
    setSelectedProjectId(project.id);
  }

  // 組織一覧ロード完了 → 先頭組織を自動選択（初期表示・criterion 1）。
  useEffect(() => {
    if (orgCrud.items.length === 0) {
      // 組織 0 件: 全ペイン空表示（criterion 1）。
      setSelectedOrgId(null);
      setSelectedProjectId(null);
      setChannels([]);
      return;
    }
    // 選択中組織が一覧に残っていれば維持（削除・アーカイブで消えたら先頭へフォールバック・criterion 5）。
    const current = orgCrud.items.find((o) => o.id === selectedOrgId);
    if (current) return;
    const first = orgCrud.items[0];
    setSelectedOrgId(first.id);
    setSelectedProjectId(null);
    setChannels([]);
    // 組織の自動フォールバック時は PJ も先頭まで自動選択して「選択が壊れない」ようにする。
    setAutoSelectFirstProject(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgCrud.items]);

  // PJ 一覧ロード完了 → 選択の維持・先頭 PJ 自動選択（初期表示のみ・criterion 1）。
  // 組織クリックで選択 PJ が null になった場合は自動選択しない（criterion 2 の非対称）。
  // 削除・アーカイブで選択 PJ が消えた場合のみ先頭へフォールバックする（criterion 5）。
  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId(null);
      setChannels([]);
      return;
    }
    const current = projects.find((p) => p.id === selectedProjectId);
    if (current) return;
    if (selectedProjectId === null) {
      // 未選択: 初期表示（初回ロード）だけ先頭 PJ を自動選択する。
      if (autoSelectFirstProject) {
        setSelectedProjectId(projects[0].id);
        setAutoSelectFirstProject(false);
      }
      return;
    }
    // 選択 PJ が消えた（削除・アーカイブ）→ 同ペインの先頭へフォールバック。
    setSelectedProjectId(projects[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // 選択の変化に PJ / チャネル一覧を追従。
  useEffect(() => {
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrgId, projectIncludeArchived]);

  useEffect(() => {
    void loadChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, channelIncludeArchived]);

  // ── 検索語の正規化と表示対象 ──
  const query = search.trim().toLowerCase();
  const projectQuery = projectSearch.trim().toLowerCase();
  const channelQuery = channelSearch.trim().toLowerCase();
  const visibleOrgs = useMemo(() => {
    if (!query) return orgCrud.items;
    return orgCrud.items.filter((org) => org.name.toLowerCase().includes(query));
  }, [orgCrud.items, query]);
  const visibleProjects = useMemo(() => {
    if (!projectQuery) return projects;
    return projects.filter((project) => project.name.toLowerCase().includes(projectQuery));
  }, [projects, projectQuery]);
  const visibleChannels = useMemo(() => {
    if (!channelQuery) return channels;
    return channels.filter((channel) => channel.name.toLowerCase().includes(channelQuery));
  }, [channels, channelQuery]);

  // ── ダイアログ確定処理 ──
  async function handleDialogSave(name: string) {
    if (!dialog || !name.trim()) return;
    await run(
      async () => {
        switch (dialog.kind) {
          case 'create-org': {
            await orgCrud.create(name);
            setSearch('');
            toast.success('組織を作成しました');
            break;
          }
          case 'rename-org': {
            await orgCrud.update(dialog.id, { name });
            toast.success('組織名を更新しました');
            break;
          }
          case 'create-project': {
            await createProjectAdmin({ organizationId: dialog.orgId, name });
            toast.success('プロジェクトを作成しました');
            await loadProjects();
            break;
          }
          case 'rename-project': {
            await adminUpdateProject(dialog.id, { name });
            toast.success('プロジェクト名を更新しました');
            await loadProjects();
            break;
          }
          case 'create-channel': {
            await createChannelAdmin({
              kind: SpaceKind.CHANNEL,
              projectId: dialog.projectId,
              name,
            });
            toast.success('チャネルを追加しました');
            await loadChannels();
            break;
          }
          case 'rename-channel': {
            await adminUpdateChannel(dialog.id, { name });
            toast.success('チャネル名を変更しました');
            await loadChannels();
            break;
          }
        }
        setDialog(null);
      },
      {
        onBusyChange: (busy) => {
          setSaving(busy);
          // PJ / チャネルの mutation 中は該当ペインの追加・操作ボタンを disabled にする。
          if (
            dialog?.kind === 'create-project' ||
            dialog?.kind === 'rename-project' ||
            dialog?.kind === 'create-channel' ||
            dialog?.kind === 'rename-channel'
          ) {
            setProjectsBusy(busy);
            setChannelsBusy(busy);
          }
        },
        onError: (err) => toast.error(apiErrorMessage(err, '保存に失敗しました')),
      },
    );
  }

  // ── archive / restore ──
  async function handleOrgRestore(org: OrganizationDto) {
    try {
      await orgCrud.update(org.id, { archived: false });
      orgCrud.reload();
      toast.success(`「${org.name}」を復元しました`);
    } catch (err) {
      toast.error(apiErrorMessage(err, '復元に失敗しました'));
    }
  }

  async function handleProjectRestore(proj: ProjectDto) {
    try {
      await adminUpdateProject(proj.id, { archived: false });
      toast.success(`「${proj.name}」を復元しました`);
      await loadProjects();
    } catch (err) {
      toast.error(apiErrorMessage(err, '復元に失敗しました'));
    }
  }

  async function handleChannelRestore(ch: SpaceDto) {
    try {
      await adminUpdateChannel(ch.id, { archived: false });
      toast.success(`「${ch.name}」を復元しました`);
      await loadChannels();
    } catch (err) {
      toast.error(apiErrorMessage(err, '復元に失敗しました'));
    }
  }

  // ── アーカイブ / 削除（確認ダイアログ 1 つで action を分岐）──
  const { deleteTarget, setDeleteTarget, handleDelete } = useDeleteConfirm<DeleteTarget>({
    remove: async (_id, target) => {
      try {
        if (target.action === 'archive') {
          if (target.kind === 'org') {
            await orgCrud.update(target.id, { archived: true });
            orgCrud.reload();
          } else if (target.kind === 'project') {
            await adminUpdateProject(target.id, { archived: true });
            await loadProjects();
          } else {
            await adminUpdateChannel(target.id, { archived: true });
            await loadChannels();
          }
        } else {
          // 物理削除（紐づきがあれば backend が 409 で拒否）。
          if (target.kind === 'org') {
            await deleteOrganization(target.id);
            orgCrud.reload();
          } else if (target.kind === 'project') {
            await deleteProject(target.id);
            await loadProjects();
          } else {
            await deleteChannel(target.id);
            await loadChannels();
          }
        }
        return true;
      } catch (err) {
        toast.error(apiErrorMessage(err, '削除に失敗しました'));
        return false;
      }
    },
    onSuccess: (_id, target) => {
      toast.success(
        target.action === 'archive'
          ? `「${target.name}」をアーカイブしました`
          : `「${target.name}」を削除しました`,
      );
    },
  });
  const selectedOrg = orgCrud.items.find((o) => o.id === selectedOrgId) ?? null;
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  return {
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
    // d659: 各ペインの取得失敗表示から再試行できるよう、取り直しを画面へ渡す。
    reloadOrgs: orgCrud.reload,
    reloadProjects: loadProjects,
    reloadChannels: loadChannels,
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
  };
}
