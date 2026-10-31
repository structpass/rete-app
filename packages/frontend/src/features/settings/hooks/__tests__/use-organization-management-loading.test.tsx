import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { makeOrganizationDto, makeProjectDto } from '@/test-utils/fixtures';

import { useOrganizationManagement } from '../use-organization-management';

// ── API モック（既存の 3pane テストと同じ形）──
const orgsApi = vi.hoisted(() => ({
  fetchOrganizationsAdmin: vi.fn(),
  createOrganization: vi.fn(),
  adminUpdateOrganization: vi.fn(),
  deleteOrganization: vi.fn(),
  fetchProjectsAdmin: vi.fn(),
  createProjectAdmin: vi.fn(),
  adminUpdateProject: vi.fn(),
  deleteProject: vi.fn(),
}));
vi.mock('../../lib/orgs-api', () => orgsApi);

const spacesApi = vi.hoisted(() => ({
  fetchChannelsByProjectAdmin: vi.fn(),
  createChannelAdmin: vi.fn(),
  adminUpdateChannel: vi.fn(),
  deleteChannel: vi.fn(),
}));
vi.mock('../../lib/spaces-api', () => spacesApi);

vi.mock('@/features/auth/components/session-provider', () => ({
  useSessionContext: () => ({
    user: { id: 'u1', email: 'admin@rete.local', name: 'Admin', role: 'ADMIN' },
    loading: false,
    menuItems: [],
  }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));

/** 解決タイミングを外から制御できる Promise（後着順を固定するため）。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

// d596: 組織・プロジェクトの組み立ては test-utils/fixtures が正本（元は型無しの手書き）
const org = (id = 'org-1') => makeOrganizationDto({ id, name: `Org ${id}` });

const project = (id = 'proj-1', organizationId = 'org-1') =>
  makeProjectDto({ id, organizationId, name: `PJ ${id}`, canManageChannels: true });

describe('useOrganizationManagement — 読み込み中の取り下げ（v2-421）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([org()]);
    orgsApi.fetchProjectsAdmin.mockResolvedValue([project()]);
    spacesApi.fetchChannelsByProjectAdmin.mockResolvedValue([]);
  });

  it('組織一覧が空になり選択が外れた時、プロジェクトペインの読み込み中を下ろす', async () => {
    // プロジェクト取得を未解決のまま止めておき、その間に組織一覧が空になる状況を作る。
    const pending = deferred<unknown[]>();
    orgsApi.fetchProjectsAdmin.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useOrganizationManagement());

    // 初期表示で組織が選択され、プロジェクト取得が走って読み込み中になる。
    await waitFor(() => expect(result.current.selectedOrgId).toBe('org-1'));
    await waitFor(() => expect(result.current.projectsLoading).toBe(true));

    // 組織一覧が空になる（全件削除・アーカイブ等）→ 選択が null へ落ちる。
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([]);
    await act(async () => {
      result.current.orgCrud.reload();
    });

    await waitFor(() => expect(result.current.selectedOrgId).toBeNull());

    // 対象が外れたペインは読み込み中を残さない（本票の要求）。
    await waitFor(() => expect(result.current.projectsLoading).toBe(false));

    // 後着した古い取得が解決しても、読み込み中が再点灯しない。
    await act(async () => {
      pending.resolve([project()]);
      await pending.promise;
    });
    expect(result.current.projectsLoading).toBe(false);
  });

  it('選択プロジェクトが外れた時、チャネルペインの読み込み中を下ろす', async () => {
    const pendingChannels = deferred<unknown[]>();
    spacesApi.fetchChannelsByProjectAdmin.mockReturnValue(pendingChannels.promise);

    const { result } = renderHook(() => useOrganizationManagement());

    // 組織 → プロジェクトが自動選択され、チャネル取得が走って読み込み中になる。
    await waitFor(() => expect(result.current.selectedProjectId).toBe('proj-1'));
    await waitFor(() => expect(result.current.channelsLoading).toBe(true));

    // 組織一覧が空になり、選択プロジェクトも外れる。
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([]);
    await act(async () => {
      result.current.orgCrud.reload();
    });

    await waitFor(() => expect(result.current.selectedProjectId).toBeNull());
    await waitFor(() => expect(result.current.channelsLoading).toBe(false));

    await act(async () => {
      pendingChannels.resolve([]);
      await pendingChannels.promise;
    });
    expect(result.current.channelsLoading).toBe(false);
  });

  it('取得中に選択組織が切り替わった時も、読み込み中が残らない（世代不一致で捨てられる場合）', async () => {
    const first = deferred<unknown[]>();
    orgsApi.fetchProjectsAdmin.mockReturnValueOnce(first.promise);
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([org('org-1'), org('org-2')]);

    const { result } = renderHook(() => useOrganizationManagement());
    await waitFor(() => expect(result.current.selectedOrgId).toBe('org-1'));
    await waitFor(() => expect(result.current.projectsLoading).toBe(true));

    // 2 件目の組織へ切り替え、2 回目の取得は即座に解決させる。
    orgsApi.fetchProjectsAdmin.mockResolvedValue([project('proj-2', 'org-2')]);
    await act(async () => {
      result.current.handleSelectOrg(org('org-2') as never);
    });

    // 新しい取得が成功した後、古い取得が後着しても読み込み中は下がったまま。
    await waitFor(() => expect(result.current.projectsLoading).toBe(false));
    await act(async () => {
      first.resolve([project('proj-1', 'org-1')]);
      await first.promise;
    });
    expect(result.current.projectsLoading).toBe(false);
  });
});
