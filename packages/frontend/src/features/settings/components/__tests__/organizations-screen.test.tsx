import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { flush } from '@/test-utils/flush';
import { makeOrganizationDto, makeProjectDto, makeSpaceDto } from '@/test-utils/fixtures';
import type { OrganizationDto } from '@rete/shared';
import { OrganizationsScreen } from '../organizations-screen';

// ── API モック ──
const orgsApi = vi.hoisted(() => ({
  fetchOrganizationsAdmin: vi.fn(),
  createOrganization: vi.fn(),
  adminUpdateOrganization: vi.fn(),
  fetchProjectsAdmin: vi.fn(),
  adminUpdateProject: vi.fn(),
}));
vi.mock('../../lib/orgs-api', () => orgsApi);

const spacesApi = vi.hoisted(() => ({
  fetchChannelsByProjectAdmin: vi.fn(),
  createChannelAdmin: vi.fn(),
  adminUpdateChannel: vi.fn(),
  deleteChannel: vi.fn(),
}));
vi.mock('../../lib/spaces-api', () => spacesApi);

// ── useSession モック（role を外部変数で切り替えられるようにする）──
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

// ── OverlayDialog モック（ポータルを回避してインライン描画）──
// useOverlayClose は onClose 直結（dirty ガードは overlay-dialog 側の単体テストで検証済み）。
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

// ── フィクスチャ（d596: 組織の組み立ては test-utils/fixtures が正本）──
const org1 = makeOrganizationDto({ id: 'org-1', name: 'Acme' });
const org2 = makeOrganizationDto({ id: 'org-2', name: 'Beta', archived: true });

const project1 = makeProjectDto({
  id: 'project-1',
  name: 'Project One',
  canManageChannels: true,
});

const channel1 = makeSpaceDto({ id: 'channel-1', projectId: 'project-1', name: 'Channel One' });

/** 絞り込みチップ（状態）の選択肢を選ぶ。チップを開いてから option をクリックする。 */
function selectArchiveFilter(label: '有効のみ' | 'アーカイブ済も表示') {
  fireEvent.click(screen.getByLabelText('状態で絞り込み'));
  fireEvent.click(screen.getByRole('option', { name: label }));
}

async function renderScreen() {
  render(<OrganizationsScreen />);
  await flush();
}

// ロールをリセットする
beforeEach(() => {
  mockRole = 'ADMIN';
});

afterEach(() => cleanup());

describe('OrganizationsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([org1, org2]);
    orgsApi.fetchProjectsAdmin.mockResolvedValue([]);
    spacesApi.fetchChannelsByProjectAdmin.mockResolvedValue([]);
  });

  it('組織一覧を描画する', async () => {
    await renderScreen();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('組織・プロジェクト・チャネルの各表にページネーションと件数表示を出さない', async () => {
    orgsApi.fetchProjectsAdmin.mockResolvedValue([project1]);
    spacesApi.fetchChannelsByProjectAdmin.mockResolvedValue([channel1]);
    await renderScreen();

    await waitFor(() => expect(screen.getByText('Channel One')).toBeInTheDocument());
    for (const name of ['組織一覧', 'プロジェクト一覧', 'チャネル一覧']) {
      const region = screen.getByRole('region', { name });
      expect(region.querySelector('.sp-pagination')).toBeNull();
      expect(within(region).queryByText(/^全\s*\d+\s*件/)).not.toBeInTheDocument();
    }
  });

  it('アーカイブ済組織に「済」バッジを表示する', async () => {
    await renderScreen();
    expect(screen.getByLabelText('Beta を復元')).toBeInTheDocument();
  });

  it('組織作成ダイアログで組織を作成できる', async () => {
    const created = makeOrganizationDto({ id: 'org-new', name: 'New Org' });
    orgsApi.createOrganization.mockResolvedValue(created);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('組織を追加'));
    await flush();
    const input = screen.getByLabelText('名前');
    fireEvent.change(input, { target: { value: 'New Org' } });
    fireEvent.click(screen.getByText(/^(保存|追加)$/));
    await flush();
    expect(orgsApi.createOrganization).toHaveBeenCalledWith({ name: 'New Org' });
    expect(toast.success).toHaveBeenCalledWith('組織を作成しました');
  });

  it('改名ダイアログで組織名を変更できる', async () => {
    const updated = makeOrganizationDto({ id: 'org-1', name: 'Acme Renamed' });
    orgsApi.adminUpdateOrganization.mockResolvedValue(updated);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('Acme を改名'));
    await flush();
    const input = screen.getByLabelText('名前');
    expect(input).toHaveValue('Acme');
    fireEvent.change(input, { target: { value: 'Acme Renamed' } });
    fireEvent.click(screen.getByText(/^(保存|追加)$/));
    await flush();
    expect(orgsApi.adminUpdateOrganization).toHaveBeenCalledWith('org-1', { name: 'Acme Renamed' });
    expect(toast.success).toHaveBeenCalledWith('組織名を更新しました');
  });

  it('組織をアーカイブできる（確認ダイアログ経由・set-0058）', async () => {
    orgsApi.adminUpdateOrganization.mockResolvedValue({ ...org1, archived: true });
    // set-0120: update 後 reload。includeArchived=false 想定で Acme を返さない
    orgsApi.fetchOrganizationsAdmin
      .mockResolvedValueOnce([org1, org2])
      .mockResolvedValueOnce([org2]);
    await renderScreen();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Acme をアーカイブ'));
    await flush();
    // 即時実行されず確認ダイアログが開く
    expect(orgsApi.adminUpdateOrganization).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        '組織「Acme」をアーカイブしますか？配下のプロジェクトも連鎖してアーカイブされます。',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expect(orgsApi.adminUpdateOrganization).toHaveBeenCalledWith('org-1', { archived: true });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('アーカイブ'));
    // reload で再取得され、フィルタ外の行は一覧から消える
    expect(orgsApi.fetchOrganizationsAdmin.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
  });

  it('アーカイブ済組織を復元できる', async () => {
    orgsApi.adminUpdateOrganization.mockResolvedValue({ ...org2, archived: false });
    const restored = makeOrganizationDto({ id: 'org-2', name: 'Beta', archived: false });
    orgsApi.fetchOrganizationsAdmin
      .mockResolvedValueOnce([org1, org2])
      .mockResolvedValueOnce([org1, restored]);
    await renderScreen();
    fireEvent.click(screen.getByLabelText('Beta を復元'));
    await flush();
    expect(orgsApi.adminUpdateOrganization).toHaveBeenCalledWith('org-2', { archived: false });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('復元'));
    expect(orgsApi.fetchOrganizationsAdmin.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('アーカイブ確認をキャンセルすると実行されない（set-0058）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByLabelText('Acme をアーカイブ'));
    await flush();
    expect(
      screen.getByText(
        '組織「Acme」をアーカイブしますか？配下のプロジェクトも連鎖してアーカイブされます。',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await flush();
    expect(orgsApi.adminUpdateOrganization).not.toHaveBeenCalled();
    // ダイアログが閉じる
    expect(
      screen.queryByText(
        '組織「Acme」をアーカイブしますか？配下のプロジェクトも連鎖してアーカイブされます。',
      ),
    ).not.toBeInTheDocument();
  });

  // ── set-0149: reference マスタ系一覧への再構成（フィルタ帯 + 右上の追加ボタン）──

  it('絞り込みチップ「アーカイブ済も表示」で includeArchived=true を渡して再取得する', async () => {
    await renderScreen();
    expect(orgsApi.fetchOrganizationsAdmin).toHaveBeenCalledWith(false);
    selectArchiveFilter('アーカイブ済も表示');
    await flush();
    expect(orgsApi.fetchOrganizationsAdmin).toHaveBeenCalledWith(true);
  });

  it('絞り込みチップを既定（有効のみ）へ戻すと includeArchived=false で再取得する', async () => {
    await renderScreen();
    selectArchiveFilter('アーカイブ済も表示');
    await flush();
    orgsApi.fetchOrganizationsAdmin.mockClear();
    selectArchiveFilter('有効のみ');
    await flush();
    expect(orgsApi.fetchOrganizationsAdmin).toHaveBeenCalledWith(false);
  });

  it('旧アーカイブ済チェックボックスは撤去されている', async () => {
    await renderScreen();
    expect(screen.queryByLabelText('アーカイブ済を表示')).not.toBeInTheDocument();
  });

  it('検索窓で組織名の部分一致に絞り込め、クリアで全件へ戻る', async () => {
    await renderScreen();
    const input = screen.getByLabelText('組織名で検索...');
    fireEvent.change(input, { target: { value: 'bet' } });
    await flush();
    // 大文字小文字を無視した部分一致（Beta だけ残る）
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    // ページネーションと件数表示は行わない
    expect(screen.queryByText('全 1 件')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '' } });
    await flush();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByText('全 2 件')).not.toBeInTheDocument();
  });

  it('検索は画面内で完結し、サーバーを再取得しない（backend 無変更）', async () => {
    await renderScreen();
    orgsApi.fetchOrganizationsAdmin.mockClear();
    fireEvent.change(screen.getByLabelText('組織名で検索...'), { target: { value: 'Acme' } });
    await flush();
    expect(orgsApi.fetchOrganizationsAdmin).not.toHaveBeenCalled();
  });

  it('検索語とチップ選択は独立に保持される', async () => {
    await renderScreen();
    fireEvent.change(screen.getByLabelText('組織名で検索...'), { target: { value: 'Acme' } });
    await flush();
    selectArchiveFilter('アーカイブ済も表示');
    await flush();
    // チップを変えても検索語は消えない
    expect(screen.getByLabelText('組織名で検索...')).toHaveValue('Acme');
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('クリアで検索語と絞り込みチップの両方が既定へ戻る', async () => {
    await renderScreen();
    fireEvent.change(screen.getByLabelText('組織名で検索...'), { target: { value: 'Acme' } });
    selectArchiveFilter('アーカイブ済も表示');
    await flush();
    fireEvent.click(screen.getAllByLabelText('フィルタをクリア')[0]);
    await flush();
    expect(screen.getByLabelText('組織名で検索...')).toHaveValue('');
    expect(orgsApi.fetchOrganizationsAdmin).toHaveBeenLastCalledWith(false);
  });

  it('検索で 0 件の時は「見つかりませんでした」を出す（未登録と言い切らない）', async () => {
    await renderScreen();
    fireEvent.change(screen.getByLabelText('組織名で検索...'), { target: { value: 'zzz' } });
    await flush();
    expect(screen.getByText('組織が見つかりませんでした')).toBeInTheDocument();
    expect(screen.queryByText('組織がまだ登録されていません')).not.toBeInTheDocument();
    // アーカイブの注記は絞り込み0件のときだけ出す（v2-169）
    expect(screen.getByText('アーカイブ済みは表示していません')).toBeInTheDocument();
  });

  it('有効のみで 0 件の時は「組織がありません」を出す（v2-169。アーカイブ注記は絞り込み0件のときだけ）', async () => {
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([]);
    await renderScreen();
    const orgPane = within(screen.getByRole('region', { name: '組織一覧' }));
    expect(orgPane.getByText('組織がありません')).toBeInTheDocument();
    expect(orgPane.queryByText('組織がまだ登録されていません')).not.toBeInTheDocument();
    expect(orgPane.queryByText('アーカイブ済みは表示していません')).not.toBeInTheDocument();
  });

  it('「組織を追加」ボタンは ListActionRow（表の直上・右寄せ独立行）にあり、フィルタ帯の外にある（set-0162 → set-0184 改修）', async () => {
    await renderScreen();
    const addButton = screen.getByLabelText('組織を追加');
    // set-0184 改修後: 追加ボタンは ListActionRow（表の直上・右寄せ独立行）に置く。
    // 帯の子孫であってはならない（set-0149 の「帯の外」を維持）。
    expect(addButton.closest('.sp-filter-bar')).toBeNull();
    // 検索窓は帯の中（配置の対比が崩れたら気づけるようにする）
    expect(screen.getByLabelText('組織名で検索...').closest('.sp-filter-bar')).not.toBeNull();
    // 追加ボタンは ListActionRow（sp-list-action-row）内にある。
    expect(addButton.closest('.sp-list-action-row')).not.toBeNull();
    // ペインのセクション内にある。
    expect(addButton.closest('section[aria-label="組織一覧"]')).not.toBeNull();
  });

  it('帯の「組織一覧」ラベルは撤去されている', async () => {
    await renderScreen();
    expect(screen.queryByText('組織一覧')).not.toBeInTheDocument();
  });

  it('検索中に組織を追加すると検索語が解除され、追加した組織が一覧に見える', async () => {
    const created = makeOrganizationDto({ id: 'org-new', name: 'New Org' });
    orgsApi.createOrganization.mockResolvedValue(created);
    await renderScreen();
    fireEvent.change(screen.getByLabelText('組織名で検索...'), { target: { value: 'Acme' } });
    await flush();
    fireEvent.click(screen.getByLabelText('組織を追加'));
    await flush();
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'New Org' } });
    fireEvent.click(screen.getByText(/^(保存|追加)$/));
    await flush();
    expect(screen.getByLabelText('組織名で検索...')).toHaveValue('');
    expect(screen.getByText('New Org')).toBeInTheDocument();
  });

  it('一覧は DTO の全フィールドを実データとして描画へ通す（shape 検証）', async () => {
    // API が返す OrganizationDto の各フィールドが画面まで届いているかを、フィクスチャの自己検算では
    // なく描画結果で確かめる（name → 行の見出し / archived → 状態列 / id → 操作の aria-label）。
    const dto: OrganizationDto = {
      id: 'org-shape',
      name: 'Shape Org',
      sortOrder: 3,
      archived: false,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    };
    orgsApi.fetchOrganizationsAdmin.mockResolvedValue([dto]);
    await renderScreen();
    expect(orgsApi.fetchOrganizationsAdmin).toHaveBeenCalledWith(false);
    expect(screen.getByText('Shape Org')).toBeInTheDocument();
    expect(screen.getByLabelText('Shape Org を改名')).toBeInTheDocument();
    expect(screen.getByLabelText('Shape Org をアーカイブ')).toBeInTheDocument();
    expect(screen.queryByText('全 1 件')).not.toBeInTheDocument();
  });

  it('MEMBER ユーザーにはタイトルのみ示し説明ラベルは出さない（set-0103）', async () => {
    mockRole = 'MEMBER';
    render(<OrganizationsScreen />);
    await flush();
    expect(screen.getByRole('heading', { name: '組織管理' })).toBeInTheDocument();
    expect(screen.queryByText(/このページはシステム管理者のみ/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('組織を追加')).not.toBeInTheDocument();
  });

  it('API エラー時に toast.error を表示する', async () => {
    orgsApi.createOrganization.mockRejectedValue(new Error('Server Error'));
    await renderScreen();
    fireEvent.click(screen.getByLabelText('組織を追加'));
    await flush();
    const input = screen.getByLabelText('名前');
    fireEvent.change(input, { target: { value: 'Fail Org' } });
    fireEvent.click(screen.getByText(/^(保存|追加)$/));
    await flush();
    expect(toast.error).toHaveBeenCalled();
  });

  it('組織一覧の取得失敗は領域内 role="alert" に残し、0件文言と区別する（v2-410）', async () => {
    orgsApi.fetchOrganizationsAdmin.mockRejectedValue(new Error('Server Error'));
    await renderScreen();

    const orgPane = within(screen.getByRole('region', { name: '組織一覧' }));
    await waitFor(() => expect(orgPane.getByRole('alert')).toBeInTheDocument());
    expect(orgPane.getByText('組織の取得に失敗しました')).toBeInTheDocument();
    // 取得失敗（toast だけにしない・正本 ui.ts:109）
    expect(orgPane.queryByText('組織がありません')).not.toBeInTheDocument();
  });
});
