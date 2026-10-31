import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupsAdminScreen } from '../groups-admin-screen';

const api = vi.hoisted(() => ({
  fetchUserGroups: vi.fn(),
  deleteUserGroup: vi.fn(),
}));
vi.mock('../../lib/groups-api', () => api);

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));

vi.mock('@/features/auth/components/session-provider', () => ({
  useSessionContext: () => ({
    user: { id: 'u1', email: 'admin@rete.local', name: 'Admin', role: 'ADMIN' },
    loading: false,
    menuItems: [],
  }),
}));

const group = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'grp-1',
  name: '営業チーム',
  sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  memberCount: 1,
  ...over,
});

async function renderScreen() {
  render(<GroupsAdminScreen />);
  await screen.findByText('営業チーム');
}

describe('GroupsAdminScreen（一覧のみ・set-0188）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchUserGroups.mockResolvedValue([
      group(),
      group({ id: 'grp-2', name: '開発チーム', memberCount: 2 }),
    ]);
  });

  it('一覧・行操作だけを出し、作成欄/改名欄/メンバー編集欄とアーカイブ導線を置かない', async () => {
    await renderScreen();

    expect(screen.getByRole('heading', { level: 2, name: '管理グループ' })).toBeInTheDocument();
    // 説明段落と所属管理への導線は置かない（説明文の撤去）
    expect(screen.queryByText(/ユーザーを束ねるための管理グループです/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '所属管理' })).not.toBeInTheDocument();
    expect(screen.getByText('1人')).toBeInTheDocument();
    expect(screen.getByText('2人')).toBeInTheDocument();

    // 各行の操作は「編集」「削除」だけ
    expect(screen.getByRole('button', { name: '営業チーム を編集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '営業チーム を削除' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '開発チーム を編集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '開発チーム を削除' })).toBeInTheDocument();

    // 一覧そのものに作成欄・改名欄・メンバー編集欄は無い
    expect(screen.queryByLabelText('新しい管理グループ名')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('管理グループ名')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('追加するユーザー')).not.toBeInTheDocument();

    // アーカイブ/復元の導線は無い
    expect(screen.queryByText(/アーカイブ/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /アーカイブ|復元/ })).not.toBeInTheDocument();

    // includeArchived を送らない（API クライアントの撤去固定）
    expect(api.fetchUserGroups).toHaveBeenCalledWith();
    expect(screen.getByText('全 2 件')).toBeInTheDocument();
    expect(screen.getByText('1 / 1 page')).toBeInTheDocument();
    expect(screen.queryByLabelText('ページ切り替え')).not.toBeInTheDocument();
  });

  it('「新規作成」は作成サブ画面へ遷移する', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.click(screen.getByRole('button', { name: '管理グループを新規作成' }));

    expect(router.push).toHaveBeenCalledWith('/settings/groups/new');
  });

  it('「編集」はそのグループの編集サブ画面へ遷移する', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.click(screen.getByRole('button', { name: '開発チーム を編集' }));

    expect(router.push).toHaveBeenCalledWith('/settings/groups/grp-2');
  });

  it('削除は確認ダイアログを挟んで DELETE を呼び、成功したら一覧から消える', async () => {
    const user = userEvent.setup();
    api.deleteUserGroup.mockResolvedValue(undefined);
    await renderScreen();

    await user.click(screen.getByRole('button', { name: '営業チーム を削除' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('管理グループ「営業チーム」を削除しますか？');
    expect(dialog).toHaveTextContent('所属設定');

    await user.click(within(dialog).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(api.deleteUserGroup).toHaveBeenCalledWith('grp-1'));
    await waitFor(() => expect(screen.queryByText('営業チーム')).not.toBeInTheDocument());
    // 削除していないグループは残る
    expect(screen.getByText('開発チーム')).toBeInTheDocument();
    expect(screen.getByText('全 1 件')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });

  it('キャンセルしたら DELETE を呼ばず、行も残す', async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.click(screen.getByRole('button', { name: '営業チーム を削除' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(api.deleteUserGroup).not.toHaveBeenCalled();
    expect(screen.getByText('営業チーム')).toBeInTheDocument();
  });

  it('削除に失敗したら行を残し、エラーを表示する（成功扱いにしない）', async () => {
    const user = userEvent.setup();
    api.deleteUserGroup.mockRejectedValue(new Error('boom'));
    await renderScreen();

    await user.click(screen.getByRole('button', { name: '営業チーム を削除' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByText('営業チーム')).toBeInTheDocument();
  });

  it('一覧ブロックを lg 幅で40%に絞り、左寄せにする（v2-167）', async () => {
    await renderScreen();

    const table = screen.getByRole('table');
    const card = table.closest('section');
    const layout = card?.parentElement ?? null;

    expect(layout).not.toBeNull();
    // 表と新規作成の行を同じ幅の列に入れ、lg 幅で4割へ絞る（v2-167・組織管理と同型）
    expect(layout).toHaveClass('lg:w-[40%]');
    expect(layout).toContainElement(screen.getByRole('button', { name: '管理グループを新規作成' }));
    // 中央寄せ・半幅の旧配置へ戻さない（set-0187 の撤去を維持）
    expect(layout).not.toHaveClass('lg:justify-center');
    expect(layout).not.toHaveClass('lg:grid-cols-[minmax(0,50%)]');
  });

  it('一覧の取得に失敗したら領域内に role="alert" を出し、0件文言と区別する（v2-233）', async () => {
    api.fetchUserGroups.mockRejectedValue(new Error('boom'));

    render(<GroupsAdminScreen />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('管理グループの読み込みに失敗しました');
    // 真0件の空文言は描かない（失敗と0件を読み分けられる）
    expect(screen.queryByText('管理グループがありません')).not.toBeInTheDocument();
    // 取得失敗は toast へ逃がさない（正本 ui.ts:109-110 の二層: 取得失敗=領域内 / 操作失敗=toast）
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByText('全 — 件')).toBeInTheDocument();
    expect(screen.queryByText('全 0 件')).not.toBeInTheDocument();
    expect(screen.queryByText('1 / 1 page')).not.toBeInTheDocument();
  });

  it('取得中は件数不明、取得成功の空配列は全0件と表示する（d595）', async () => {
    let resolveGroups!: (groups: unknown[]) => void;
    api.fetchUserGroups.mockReturnValue(
      new Promise((resolve) => {
        resolveGroups = resolve;
      }),
    );
    render(<GroupsAdminScreen />);
    expect(screen.getByText('全 — 件')).toBeInTheDocument();
    expect(screen.queryByText('全 0 件')).not.toBeInTheDocument();
    expect(screen.queryByText('1 / 1 page')).not.toBeInTheDocument();
    resolveGroups([]);
    expect(await screen.findByText('全 0 件')).toBeInTheDocument();
    expect(screen.getByText('管理グループがありません')).toBeInTheDocument();
    expect(screen.queryByText('全 — 件')).not.toBeInTheDocument();
  });

  // d659: 取得失敗は「もう一度取る手段」までを 1 つの領域として出す。押せば本当に取り直す。
  it('取得失敗の表示に再試行を添え、押すと取り直して失敗の表示を消す（d659）', async () => {
    const user = userEvent.setup();
    api.fetchUserGroups.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([group()]);

    render(<GroupsAdminScreen />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('管理グループの読み込みに失敗しました');
    const retry = within(alert).getByRole('button', { name: '再試行' });

    await user.click(retry);

    expect(await screen.findByText('営業チーム')).toBeInTheDocument();
    // 取れたのに失敗の文言が残らない（成功と失敗が同時に出ない）
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.fetchUserGroups).toHaveBeenCalledTimes(2);
    expect(screen.getByText('全 1 件')).toBeInTheDocument();
  });
});
