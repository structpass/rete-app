import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { flush } from '@/test-utils/flush';
import { makeOrganizationDto, makeProjectDto, makeSpaceDto } from '@/test-utils/fixtures';
import { OrganizationsScreen } from '../organizations-screen';

// ── API モック ──
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

// ── useSession モック ──
let mockRole = 'ADMIN';
vi.mock('@/features/auth/components/session-provider', () => ({
  useSessionContext: () => ({
    user: { id: 'u1', email: 'admin@rete.local', name: 'Admin', role: mockRole },
    loading: false,
    menuItems: [],
  }),
}));

// ── toast モック ──
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));

// ── OverlayDialog モック ──
vi.mock('@/components/ui/overlay-dialog', () => {
  let currentOnClose: () => void = () => {};
  return {
    OverlayDialog: ({
      open,
      onClose,
      children,
    }: {
      open: boolean;
      onClose: () => void;
      children: React.ReactNode;
    }) => {
      currentOnClose = onClose;
      return open ? <div data-testid="overlay">{children}</div> : null;
    },
    useOverlayClose: () => () => currentOnClose(),
  };
});

// ── フィクスチャ（d596: 組織・プロジェクト・チャネルの組み立ては test-utils/fixtures が正本）──
const org1 = makeOrganizationDto({ id: 'org-1', name: 'Acme' });
const org2 = makeOrganizationDto({ id: 'org-2', name: 'Beta' });
const proj1 = makeProjectDto({ id: 'proj-1', name: 'PJ-A', canManageChannels: true });
const proj2 = makeProjectDto({
  id: 'proj-2',
  organizationId: 'org-1',
  name: 'PJ-B',
  canManageChannels: true,
});
const ch1 = makeSpaceDto({ id: 'ch-1', name: '雑談' });
const ch2 = makeSpaceDto({ id: 'ch-2', name: '連絡' });

async function renderScreen() {
  render(<OrganizationsScreen />);
  await flush();
}

beforeEach(() => {
  mockRole = 'ADMIN';
  vi.clearAllMocks();
  orgsApi.fetchOrganizationsAdmin.mockResolvedValue([org1, org2]);
  orgsApi.fetchProjectsAdmin.mockResolvedValue([proj1, proj2]);
  spacesApi.fetchChannelsByProjectAdmin.mockResolvedValue([ch1, ch2]);
});

describe('OrganizationsScreen 3 ペイン（set-0162）', () => {
  it('3表を左寄せで配置し、lg 幅では40%の幅にする（v2-161。set-0187 の半幅中央配置を撤回）', async () => {
    await renderScreen();

    const sections = ['組織一覧', 'プロジェクト一覧', 'チャネル一覧'].map((name) =>
      screen.getByRole('region', { name }),
    );
    const layout = sections[0].parentElement;

    expect(layout).not.toBeNull();
    expect(layout).toHaveClass('grid', 'grid-cols-1', 'items-start', 'gap-4');
    // 表の横幅は画面いっぱいにせず、lg 幅で40%に絞る（v2-161）
    expect(layout).toHaveClass('lg:w-[40%]');
    // 検索帯（共通 FilterBar）と同じ左端に揃える。lg 幅でも中央寄せ・半幅にしない（v2-161）
    expect(layout).not.toHaveClass('lg:justify-center');
    expect(layout).not.toHaveClass('lg:grid-cols-[minmax(0,50%)]');
    for (const section of sections) {
      expect(section.parentElement).toBe(layout);
    }
  });

  it('3セクションとも ラベル→検索→登録ボタン→一覧 の順に並ぶ（v2-161）', async () => {
    await renderScreen();

    const cases = [
      { name: '組織一覧', label: '組織', add: '組織を追加' },
      { name: 'プロジェクト一覧', label: 'プロジェクト', add: 'プロジェクトを追加' },
      { name: 'チャネル一覧', label: 'チャネル', add: 'チャネルを追加' },
    ];

    for (const item of cases) {
      const scope = within(screen.getByRole('region', { name: item.name }));
      const nodes = [
        scope.getByText(item.label),
        scope.getByRole('searchbox'),
        scope.getByRole('button', { name: item.add }),
        scope.getByRole('table'),
      ];
      for (let i = 1; i < nodes.length; i += 1) {
        expect(
          nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    }
  });
  it('3表の「操作」ヘッダを中央寄せにし、列幅を維持する（set-0186）', async () => {
    await renderScreen();

    const actionHeaders = screen.getAllByRole('columnheader', { name: '操作' });
    expect(actionHeaders).toHaveLength(3);
    for (const header of actionHeaders) {
      expect(header).toHaveStyle({ width: '96px', textAlign: 'center' });
    }
  });

  it('初期表示: 先頭組織 + 先頭 PJ が選択され、チャネルまで表示される（criterion 1）', async () => {
    await renderScreen();
    // PJ ペインに選択 PJ（sp-row-ring）が付く
    const row = screen.getByText('PJ-A').closest('tr');
    expect(row?.className).toContain('sp-row-ring');
    // チャネルまで表示される
    expect(screen.getByText('雑談')).toBeInTheDocument();
    expect(screen.getByText('連絡')).toBeInTheDocument();
  });

  it('組織行クリックで PJ ペインが切り替わり、チャネルは空白になる（criterion 2 の非対称）', async () => {
    orgsApi.fetchProjectsAdmin
      .mockResolvedValueOnce([proj1, proj2]) // 初期ロード
      .mockResolvedValue([]); // org-2 クリック後（PJ なし）
    await renderScreen();
    expect(screen.getByText('雑談')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Beta'));
    await flush();

    // org-2 配下 PJ で再取得され、チャネルは空白
    expect(orgsApi.fetchProjectsAdmin).toHaveBeenLastCalledWith('org-2', false);
    // org-2 配下に PJ がない → PJ 未選択・チャネル空白
    await waitFor(() => {
      expect(screen.queryByText('雑談')).not.toBeInTheDocument();
    });
    // 未登録の真0件ではプレースホルダ文言を出さない（v2-166）
    expect(screen.queryByText('プロジェクトがまだ登録されていません')).not.toBeInTheDocument();
    expect(screen.queryByText('アーカイブ済みは表示していません')).not.toBeInTheDocument();
  });

  it('組織切替直後に PJ 取得が失敗したら旧一覧が残らない（fetch 失敗時クリア・criteria 1）', async () => {
    orgsApi.fetchProjectsAdmin
      .mockResolvedValueOnce([proj1, proj2]) // 初期ロード
      .mockRejectedValueOnce(new Error('network')); // org-2 クリック後の取得が失敗
    await renderScreen();
    expect(screen.getByText('PJ-A')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Beta'));
    await flush();

    // 前の組織の PJ 一覧が残らず、空状態になる
    await waitFor(() => {
      expect(screen.queryByText('PJ-A')).not.toBeInTheDocument();
    });
    // 未登録の真0件ではプレースホルダ文言を出さない（v2-166）
    expect(screen.queryByText('プロジェクトがまだ登録されていません')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
  });

  it('PJ 切替直後にチャネル取得が失敗したら旧一覧が残らない（fetch 失敗時クリア・criteria 2）', async () => {
    spacesApi.fetchChannelsByProjectAdmin
      .mockResolvedValueOnce([ch1, ch2]) // 初期ロード
      .mockRejectedValueOnce(new Error('network')); // PJ-B クリック後の取得が失敗
    await renderScreen();
    expect(screen.getByText('雑談')).toBeInTheDocument();

    fireEvent.click(screen.getByText('PJ-B'));
    await flush();

    // 前の PJ のチャネル一覧が残らず、空状態になる
    await waitFor(() => {
      expect(screen.queryByText('雑談')).not.toBeInTheDocument();
    });
    // 未登録の真0件ではプレースホルダ文言を出さない（v2-166）
    expect(screen.queryByText('チャネルがまだ登録されていません')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
  });

  it('組織配下にプロジェクトが 0 件でも未登録のプレースホルダ文言を出さない（v2-166）', async () => {
    orgsApi.fetchProjectsAdmin.mockResolvedValue([]);
    await renderScreen();

    const pane = within(screen.getByRole('region', { name: 'プロジェクト一覧' }));
    expect(pane.queryByText('プロジェクトがまだ登録されていません')).not.toBeInTheDocument();
    expect(pane.queryByText('アーカイブ済みは表示していません')).not.toBeInTheDocument();
    // 表の骨格（ヘッダ）は残す
    expect(pane.getByRole('columnheader', { name: 'プロジェクト名' })).toBeInTheDocument();
  });

  it('プロジェクト配下にチャネルが 0 件でも未登録のプレースホルダ文言を出さない（v2-166）', async () => {
    spacesApi.fetchChannelsByProjectAdmin.mockResolvedValue([]);
    await renderScreen();

    const pane = within(screen.getByRole('region', { name: 'チャネル一覧' }));
    expect(pane.queryByText('チャネルがまだ登録されていません')).not.toBeInTheDocument();
    expect(pane.queryByText('アーカイブ済みは表示していません')).not.toBeInTheDocument();
    expect(pane.getByRole('columnheader', { name: 'チャネル名' })).toBeInTheDocument();
  });

  it('絞り込みで 0 件のときは「見つかりませんでした」を出す（v2-166 でも維持）', async () => {
    await renderScreen();

    fireEvent.change(screen.getByLabelText('プロジェクト名で検索...'), {
      target: { value: 'zzz' },
    });
    fireEvent.change(screen.getByLabelText('チャネル名で検索...'), { target: { value: 'zzz' } });
    await flush();

    expect(screen.getByText('プロジェクトが見つかりませんでした')).toBeInTheDocument();
    expect(screen.getByText('チャネルが見つかりませんでした')).toBeInTheDocument();
  });

  it('組織ペインが 0 件のときは「組織がありません」を出す（v2-169 で3一覧の言い方を揃える）', async () => {
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([]);
    await renderScreen();

    const pane = within(screen.getByRole('region', { name: '組織一覧' }));
    expect(pane.getByText('組織がありません')).toBeInTheDocument();
    // 旧文言と、真0件でのアーカイブ注記は出さない
    expect(pane.queryByText('組織がまだ登録されていません')).not.toBeInTheDocument();
    expect(pane.queryByText('アーカイブ済みは表示していません')).not.toBeInTheDocument();
  });

  it('PJ 行クリックでチャネルがその PJ 配下に切り替わる（criterion 2）', async () => {
    await renderScreen();
    spacesApi.fetchChannelsByProjectAdmin.mockClear();
    spacesApi.fetchChannelsByProjectAdmin.mockResolvedValue([
      makeSpaceDto({ id: 'ch-x', name: 'PJ-B用' }),
    ]);

    fireEvent.click(screen.getByText('PJ-B'));
    await flush();

    await waitFor(() => {
      expect(spacesApi.fetchChannelsByProjectAdmin).toHaveBeenLastCalledWith('proj-2', false);
      expect(screen.getByText('PJ-B用')).toBeInTheDocument();
    });
  });

  it('プロジェクトとチャネルの検索で名前を絞り込める', async () => {
    await renderScreen();

    fireEvent.change(screen.getByLabelText('プロジェクト名で検索...'), {
      target: { value: 'PJ-A' },
    });
    expect(screen.getByText('PJ-A')).toBeInTheDocument();
    expect(screen.queryByText('PJ-B')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('チャネル名で検索...'), {
      target: { value: '雑談' },
    });
    expect(screen.getByText('雑談')).toBeInTheDocument();
    expect(screen.queryByText('連絡')).not.toBeInTheDocument();
  });

  it('プロジェクトとチャネルの状態フィルタが各 API に反映される', async () => {
    await renderScreen();
    orgsApi.fetchProjectsAdmin.mockClear();
    spacesApi.fetchChannelsByProjectAdmin.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'プロジェクトの状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: 'アーカイブ済も表示' }));
    fireEvent.click(screen.getByRole('button', { name: 'チャネルの状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: 'アーカイブ済も表示' }));
    await flush();

    expect(orgsApi.fetchProjectsAdmin).toHaveBeenLastCalledWith('org-1', true);
    expect(spacesApi.fetchChannelsByProjectAdmin).toHaveBeenLastCalledWith('proj-1', true);
  });

  it('プロジェクトとチャネルのクリアで検索語と状態を初期値へ戻す', async () => {
    await renderScreen();

    fireEvent.change(screen.getByLabelText('プロジェクト名で検索...'), {
      target: { value: 'PJ-A' },
    });
    fireEvent.change(screen.getByLabelText('チャネル名で検索...'), {
      target: { value: '雑談' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクトの状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: 'アーカイブ済も表示' }));
    fireEvent.click(screen.getByRole('button', { name: 'チャネルの状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: 'アーカイブ済も表示' }));

    fireEvent.click(screen.getAllByRole('button', { name: 'フィルタをクリア' })[1]);
    fireEvent.click(screen.getAllByRole('button', { name: 'フィルタをクリア' })[2]);
    await flush();

    expect(screen.getByLabelText('プロジェクト名で検索...')).toHaveValue('');
    expect(screen.getByLabelText('チャネル名で検索...')).toHaveValue('');
  });

  it('組織が 0 件の場合は全ペイン空表示でクラッシュしない（criterion 1）', async () => {
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([]);
    await renderScreen();
    expect(screen.getByText('組織がありません')).toBeInTheDocument();
    expect(orgsApi.fetchProjectsAdmin).not.toHaveBeenCalled();
  });

  it('組織を追加すると選択が新組織へは移らず、一覧に追加される', async () => {
    const created = makeOrganizationDto({ id: 'org-new', name: 'New Org' });
    orgsApi.createOrganization.mockResolvedValue(created);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('組織を追加'));
    await flush();
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'New Org' } });
    fireEvent.click(screen.getByText(/^(保存|追加)$/));
    await flush();
    expect(orgsApi.createOrganization).toHaveBeenCalledWith({ name: 'New Org' });
    expect(screen.getByText('New Org')).toBeInTheDocument();
  });

  it('PJ を追加すると選択 PJ 配下に反映される（admin 経路・membership 非依存）', async () => {
    const created = makeProjectDto({ id: 'proj-new', name: 'PJ-New' });
    orgsApi.createProjectAdmin.mockResolvedValue(created);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('プロジェクトを追加'));
    await flush();
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'PJ-New' } });
    fireEvent.click(screen.getByText(/^(保存|追加)$/));
    await flush();
    expect(orgsApi.createProjectAdmin).toHaveBeenCalledWith({
      organizationId: 'org-1',
      name: 'PJ-New',
    });
    // reload が走る（新 PJ が一覧へ反映される）
    expect(orgsApi.fetchProjectsAdmin.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('チャネルを追加すると admin 経路で作成される', async () => {
    const created = makeSpaceDto({ id: 'ch-new', name: '新チャネル' });
    spacesApi.createChannelAdmin.mockResolvedValue(created);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('チャネルを追加'));
    await flush();
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '新チャネル' } });
    fireEvent.click(screen.getByText(/^(保存|追加)$/));
    await flush();
    expect(spacesApi.createChannelAdmin).toHaveBeenCalledWith({
      kind: 'CHANNEL',
      projectId: 'proj-1',
      name: '新チャネル',
    });
    expect(spacesApi.fetchChannelsByProjectAdmin.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('組織の物理削除: 確認ダイアログ経由で deleteOrganization を呼ぶ', async () => {
    orgsApi.deleteOrganization.mockResolvedValue(undefined);
    orgsApi.fetchOrganizationsAdmin
      .mockResolvedValueOnce([org1, org2])
      .mockResolvedValueOnce([org2]); // 削除後の reload
    await renderScreen();
    fireEvent.click(screen.getByLabelText('Acme を削除'));
    await flush();
    expect(
      screen.getByText(
        '組織「Acme」を削除しますか？削除すると元に戻せません。配下のデータがある場合は削除できません（アーカイブしてください）。',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expect(orgsApi.deleteOrganization).toHaveBeenCalledWith('org-1');
  });

  it('PJ の物理削除: 確認ダイアログ経由で deleteProject を呼ぶ', async () => {
    orgsApi.deleteProject.mockResolvedValue(undefined);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('PJ-A を削除'));
    await flush();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expect(orgsApi.deleteProject).toHaveBeenCalledWith('proj-1');
    expect(orgsApi.fetchProjectsAdmin.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('チャネルの物理削除: 確認ダイアログ経由で deleteChannel を呼ぶ', async () => {
    spacesApi.deleteChannel.mockResolvedValue(undefined);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('雑談 を削除'));
    await flush();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expect(spacesApi.deleteChannel).toHaveBeenCalledWith('ch-1');
    expect(spacesApi.fetchChannelsByProjectAdmin.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('削除 409（紐づきあり）はエラートーストを表示し、確認ダイアログは閉じる', async () => {
    const err = Object.assign(
      new Error('配下のデータが存在するため削除できません。アーカイブしてください'),
      {
        response: {
          status: 409,
          data: { message: '配下のデータが存在するため削除できません。アーカイブしてください' },
        },
      },
    );
    orgsApi.deleteOrganization.mockRejectedValue(err);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('Acme を削除'));
    await flush();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expect(toast.error).toHaveBeenCalled();
  });

  it('組織のアーカイブは削除ではなく adminUpdateOrganization の archived=true を呼ぶ', async () => {
    orgsApi.adminUpdateOrganization.mockResolvedValue({ ...org1, archived: true });
    orgsApi.fetchOrganizationsAdmin
      .mockResolvedValueOnce([org1, org2])
      .mockResolvedValueOnce([org2]);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('Acme をアーカイブ'));
    await flush();
    expect(
      screen.getByText(
        '組織「Acme」をアーカイブしますか？配下のプロジェクトも連鎖してアーカイブされます。',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expect(orgsApi.adminUpdateOrganization).toHaveBeenCalledWith('org-1', { archived: true });
    expect(orgsApi.deleteOrganization).not.toHaveBeenCalled();
  });

  it('チャネルのアーカイブは adminUpdateChannel の archived=true を呼ぶ（削除でない）', async () => {
    spacesApi.adminUpdateChannel.mockResolvedValue({ ...ch1, archived: true });
    await renderScreen();
    fireEvent.click(screen.getByLabelText('雑談 をアーカイブ'));
    await flush();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expect(spacesApi.adminUpdateChannel).toHaveBeenCalledWith('ch-1', { archived: true });
    expect(spacesApi.deleteChannel).not.toHaveBeenCalled();
  });

  it('選択組織がアーカイブ・削除で消えたら先頭組織へフォールバックする（criterion 5）', async () => {
    orgsApi.fetchOrganizationsAdmin
      .mockResolvedValueOnce([org1, org2])
      .mockResolvedValueOnce([org2]); // org-1 が消える
    await renderScreen();
    // 最初は org-1（Acme）が選択
    expect(screen.getByText('PJ-A')).toBeInTheDocument();
    // org-1 をアーカイブ → reload → 一覧から消える
    orgsApi.adminUpdateOrganization.mockResolvedValue({ ...org1, archived: true });
    fireEvent.click(screen.getByLabelText('Acme をアーカイブ'));
    await flush();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    // 選択が org-2（Beta）へフォールバックし、org-2 配下 PJ が再取得される
    await waitFor(() => {
      expect(orgsApi.fetchProjectsAdmin).toHaveBeenLastCalledWith('org-2', false);
    });
  });

  it('チャネル行は選択対象外（行クリックで何も起きない・操作は stopPropagation 済み）', async () => {
    await renderScreen();
    // チャネル行クリック後も選択 PJ が変わらない（チャネルは末端）
    fireEvent.click(screen.getByText('雑談'));
    await flush();
    const row = screen.getByText('PJ-A').closest('tr');
    expect(row?.className).toContain('sp-row-ring');
  });

  it('MEMBER ユーザーにはタイトルのみ表示（system ADMIN ガード維持・criterion 7）', async () => {
    mockRole = 'MEMBER';
    render(<OrganizationsScreen />);
    await flush();
    expect(screen.getByRole('heading', { name: '組織管理' })).toBeInTheDocument();
    expect(screen.queryByLabelText('組織を追加')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('プロジェクトを追加')).not.toBeInTheDocument();
  });

  // ── v2-410: 一覧取得失敗を領域内 role="alert" で残し、0件表示と区別する ──

  const paneOf = (name: '組織一覧' | 'プロジェクト一覧' | 'チャネル一覧') =>
    within(screen.getByRole('region', { name }));

  it('組織一覧の取得に失敗したら組織ペインに role="alert" を出し、0件文言と区別する（v2-410）', async () => {
    orgsApi.fetchOrganizationsAdmin.mockRejectedValue(new Error('network'));
    await renderScreen();

    const pane = paneOf('組織一覧');
    await waitFor(() => expect(pane.getByRole('alert')).toBeInTheDocument());
    expect(pane.getByText('組織の取得に失敗しました')).toBeInTheDocument();
    // 失敗を「組織がありません」と読み違えさせない
    expect(pane.queryByText('組織がありません')).not.toBeInTheDocument();
    expect(pane.queryByText('組織が見つかりませんでした')).not.toBeInTheDocument();
  });

  // d659: 取得失敗は「もう一度取る手段」までを 1 つの領域として出し、押せば本当に取り直す。
  it('組織ペインの取得失敗の再試行を押すと取り直して失敗の表示を消す（d659）', async () => {
    orgsApi.fetchOrganizationsAdmin.mockRejectedValueOnce(new Error('network'));
    await renderScreen();

    const pane = paneOf('組織一覧');
    await waitFor(() => expect(pane.getByRole('alert')).toBeInTheDocument());
    fireEvent.click(pane.getByRole('button', { name: '再試行' }));

    await waitFor(() => expect(pane.queryByRole('alert')).not.toBeInTheDocument());
    expect(orgsApi.fetchOrganizationsAdmin).toHaveBeenCalledTimes(2);
    expect(pane.queryByText('組織の取得に失敗しました')).not.toBeInTheDocument();
  });

  it('プロジェクト一覧の取得に失敗したらプロジェクトペインに role="alert" を出し、0件文言と区別する（v2-410）', async () => {
    orgsApi.fetchProjectsAdmin.mockRejectedValue(new Error('network'));
    await renderScreen();

    const pane = paneOf('プロジェクト一覧');
    await waitFor(() => expect(pane.getByRole('alert')).toBeInTheDocument());
    expect(pane.getByText('プロジェクトの取得に失敗しました')).toBeInTheDocument();
    expect(pane.queryByText('プロジェクトがありません')).not.toBeInTheDocument();
    // 取得失敗を操作失敗の toast だけにしない（正本 ui.ts:109）。一覧取得失敗の toast は
    // 正本 ui.ts:118 が「現状実値・是正は rete-cross-0001 管轄」として残している既存挙動なので
    // 本票では消さない（消す時はこの assertion も一緒に見直す）。
    expect(toast.error).toHaveBeenCalled();
  });

  it('チャネル一覧の取得に失敗したらチャネルペインに role="alert" を出し、0件文言と区別する（v2-410）', async () => {
    spacesApi.fetchChannelsByProjectAdmin.mockRejectedValue(new Error('network'));
    await renderScreen();

    const pane = paneOf('チャネル一覧');
    await waitFor(() => expect(pane.getByRole('alert')).toBeInTheDocument());
    expect(pane.getByText('チャネルの取得に失敗しました')).toBeInTheDocument();
    expect(pane.queryByText('チャネルがありません')).not.toBeInTheDocument();
  });

  it('再取得に成功すると失敗表示が消える（v2-410）', async () => {
    orgsApi.fetchOrganizationsAdmin
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue([org1, org2]);
    await renderScreen();

    const pane = paneOf('組織一覧');
    await waitFor(() => expect(pane.getByRole('alert')).toBeInTheDocument());

    // 現在の filter のまま既存の再取得（絞り込みチップの切替）で再試行する
    fireEvent.click(screen.getByRole('button', { name: '状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: 'アーカイブ済も表示' }));
    await flush();

    await waitFor(() => expect(pane.queryByRole('alert')).not.toBeInTheDocument());
    expect(pane.getByText('Acme')).toBeInTheDocument();
  });

  it('再取得に失敗しても旧一覧を残したまま失敗表示を出す（v2-410）', async () => {
    orgsApi.fetchOrganizationsAdmin
      .mockResolvedValueOnce([org1, org2])
      .mockRejectedValueOnce(new Error('network'));
    await renderScreen();
    expect(screen.getByText('Acme')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: 'アーカイブ済も表示' }));
    await flush();

    const pane = paneOf('組織一覧');
    await waitFor(() => expect(pane.getByRole('alert')).toBeInTheDocument());
    // 旧一覧は最新情報のように見せない（失敗表示を隠さない）
    expect(pane.getByText('Acme')).toBeInTheDocument();
    expect(pane.queryByText('組織がありません')).not.toBeInTheDocument();
  });

  it('選択が外れるとそのペインの失敗表示も消える（v2-410）', async () => {
    spacesApi.fetchChannelsByProjectAdmin
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue([]);
    await renderScreen();

    const pane = paneOf('チャネル一覧');
    await waitFor(() => expect(pane.getByRole('alert')).toBeInTheDocument());

    // 組織を切り替える＝PJ 選択が外れる（チャネルペインの対象が消える）
    fireEvent.click(screen.getByText('Beta'));
    await flush();

    await waitFor(() => expect(pane.queryByRole('alert')).not.toBeInTheDocument());
    expect(pane.getByText('チャネルがありません')).toBeInTheDocument();
  });

  it('正常な0件は空文言のままで失敗表示を出さない（v2-410）', async () => {
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([]);
    orgsApi.fetchProjectsAdmin.mockResolvedValue([]);
    spacesApi.fetchChannelsByProjectAdmin.mockResolvedValue([]);
    await renderScreen();

    for (const name of ['組織一覧', 'プロジェクト一覧', 'チャネル一覧'] as const) {
      expect(paneOf(name).queryByRole('alert')).not.toBeInTheDocument();
    }
    expect(screen.getByText('組織がありません')).toBeInTheDocument();
    expect(screen.getByText('プロジェクトがありません')).toBeInTheDocument();
    expect(screen.getByText('チャネルがありません')).toBeInTheDocument();
  });
});

describe('組織管理の一覧状態（d597）', () => {
  for (const [region, fetchList, emptyLabel] of [
    ['組織一覧', orgsApi.fetchOrganizationsAdmin, '組織がありません'],
    ['プロジェクト一覧', orgsApi.fetchProjectsAdmin, 'プロジェクトがありません'],
    ['チャネル一覧', spacesApi.fetchChannelsByProjectAdmin, 'チャネルがありません'],
  ] as const) {
    it(region + 'の取得中も表見出しを残し、0件と区別する', async () => {
      let resolve!: (rows: never[]) => void;
      fetchList.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      await renderScreen();
      const pane = within(screen.getByRole('region', { name: region }));
      expect(pane.getByRole('status')).toBeInTheDocument();
      expect(pane.getAllByRole('columnheader')).toHaveLength(2);
      expect(pane.queryByText(emptyLabel)).not.toBeInTheDocument();
      expect(pane.queryByText('アーカイブ済みは表示していません')).not.toBeInTheDocument();
      resolve([]);
      await flush();
      expect(pane.queryByRole('status')).not.toBeInTheDocument();
      expect(pane.getByText(emptyLabel)).toBeInTheDocument();
    });
  }

  it('3一覧の検索0件は補足を維持し、アーカイブを含めると補足を消す', async () => {
    await renderScreen();
    for (const [region, placeholder, label, filter] of [
      ['組織一覧', '組織名で検索...', '組織', '状態で絞り込み'],
      [
        'プロジェクト一覧',
        'プロジェクト名で検索...',
        'プロジェクト',
        'プロジェクトの状態で絞り込み',
      ],
      ['チャネル一覧', 'チャネル名で検索...', 'チャネル', 'チャネルの状態で絞り込み'],
    ]) {
      const pane = within(screen.getByRole('region', { name: region }));
      fireEvent.change(pane.getByPlaceholderText(placeholder), {
        target: { value: 'not-found-d597' },
      });
      await flush();
      expect(pane.getByText(label + 'が見つかりませんでした')).toBeInTheDocument();
      expect(pane.getByText('アーカイブ済みは表示していません')).toBeInTheDocument();
      fireEvent.click(pane.getByRole('button', { name: filter }));
      fireEvent.click(screen.getByRole('option', { name: 'アーカイブ済も表示' }));
      await flush();
      expect(pane.queryByText('アーカイブ済みは表示していません')).not.toBeInTheDocument();
    }
  });
});

// 一覧の読み直し中に既存行を消さないこと（d687）。
describe('組織管理のペインの読み直し（d687）', () => {
  it('取得し直している間も、プロジェクトの既存行を消さない', async () => {
    await renderScreen();

    // 読み直し（PJ の状態フィルタ切り替え）を、応答前の状態で止める。
    let resolveProjects!: (rows: never[]) => void;
    orgsApi.fetchProjectsAdmin.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveProjects = r;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'プロジェクトの状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: 'アーカイブ済も表示' }));
    await flush();

    const projectPane = within(screen.getByRole('region', { name: 'プロジェクト一覧' }));
    // 取得中でも、既に持っている行は消さない（旧行を消して空にしない）。
    expect(projectPane.getByText('PJ-A')).toBeInTheDocument();
    expect(projectPane.getByRole('status')).toBeInTheDocument();
    resolveProjects([]);
    await flush();
    expect(projectPane.queryByText('PJ-A')).not.toBeInTheDocument();
  });

  it('チャネルの取得し直し中も、既存行を消さない', async () => {
    await renderScreen();

    spacesApi.fetchChannelsByProjectAdmin.mockClear();
    let resolveChannels!: (rows: never[]) => void;
    spacesApi.fetchChannelsByProjectAdmin.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveChannels = r;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'チャネルの状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: 'アーカイブ済も表示' }));
    await flush();

    const channelPane = within(screen.getByRole('region', { name: 'チャネル一覧' }));
    expect(channelPane.getByText('雑談')).toBeInTheDocument();
    expect(channelPane.getByRole('status')).toBeInTheDocument();
    resolveChannels([]);
    await flush();
    expect(channelPane.queryByText('雑談')).not.toBeInTheDocument();
  });
});
