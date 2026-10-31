import { NO_HOME_GROUP_PERMISSIONS } from '@rete/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupEditScreen } from '../group-edit-screen';

const api = vi.hoisted(() => ({
  fetchUserGroups: vi.fn(),
  updateUserGroup: vi.fn(),
  fetchUserGroupMembers: vi.fn(),
  addUserGroupMember: vi.fn(),
  removeUserGroupMember: vi.fn(),
}));
vi.mock('../../lib/groups-api', () => api);

const membersApi = vi.hoisted(() => ({ fetchMembers: vi.fn() }));
vi.mock('../../lib/members-api', () => membersApi);

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

const group = {
  id: 'grp-1',
  name: '営業チーム',
  sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  memberCount: 1,
};

describe('GroupEditScreen（編集サブ画面・set-0188）', () => {
  it('取得した権限を表示し、他の許可を保ったまま権限だけ保存する', async () => {
    const user = userEvent.setup();
    api.fetchUserGroups.mockResolvedValue([
      {
        ...group,
        canEditHomeBoard: true,
        canEditHomeCalendar: false,
        canEditHomeFaq: true,
        canManageHomeTags: true,
      },
    ]);
    render(<GroupEditScreen groupId="grp-1" />);
    await waitFor(() => expect(screen.getByLabelText('掲示板')).toBeChecked());
    expect(screen.getByLabelText('FAQ')).toBeChecked();
    expect(screen.getByLabelText('タグ管理')).toBeChecked();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.click(screen.getByLabelText('カレンダー'));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(api.updateUserGroup).toHaveBeenCalledWith('grp-1', {
        name: group.name,
        canEditHomeBoard: true,
        canEditHomeCalendar: true,
        canEditHomeFaq: true,
        canManageHomeTags: true,
      }),
    );
  });

  it.each(['一覧へ戻る', '管理グループ一覧', 'Escape'])(
    '権限だけの変更を%sでも破棄確認し、元へ戻せばdirtyを解消する',
    async (label) => {
      const user = userEvent.setup();
      render(<GroupEditScreen groupId="grp-1" />);
      await user.click(await screen.findByLabelText('カレンダー'));
      if (label === 'Escape') await user.keyboard('{Escape}');
      else
        await user.click(
          screen.getByRole(label === '一覧へ戻る' ? 'button' : 'link', { name: label }),
        );
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(router.push).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'キャンセル' }));
      expect(screen.getByLabelText('カレンダー')).toBeChecked();
      await user.click(screen.getByLabelText('カレンダー'));
      expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: '一覧へ戻る' }));
      expect(router.push).toHaveBeenCalledWith('/settings/groups');
      expect(api.updateUserGroup).not.toHaveBeenCalled();
    },
  );

  it.each(['一覧へ戻る', '管理グループ一覧'])(
    '未保存名の%sは破棄確認を通す（空にした場合も含む）',
    async (label) => {
      const user = userEvent.setup();
      render(<GroupEditScreen groupId="grp-1" />);
      await waitFor(() => expect(screen.getByLabelText('グループ名')).toHaveValue('営業チーム'));
      await user.clear(screen.getByLabelText('グループ名'));
      await user.click(
        screen.getByRole(label === '一覧へ戻る' ? 'button' : 'link', { name: label }),
      );
      expect(router.push).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'キャンセル' }));
      expect(screen.getByLabelText('グループ名')).toHaveValue('');
      await user.click(
        screen.getByRole(label === '一覧へ戻る' ? 'button' : 'link', { name: label }),
      );
      await user.click(screen.getByRole('button', { name: 'OK' }));
      expect(router.push).toHaveBeenCalledWith('/settings/groups');
      expect(api.updateUserGroup).not.toHaveBeenCalled();
    },
  );
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchUserGroups.mockResolvedValue([group, { ...group, id: 'grp-2', name: '開発チーム' }]);
    api.fetchUserGroupMembers.mockResolvedValue([
      { id: 'm-1', groupId: 'grp-1', accountId: 'acc-1', accountName: '田中 太郎' },
    ]);
    membersApi.fetchMembers.mockResolvedValue([
      { id: 'acc-1', name: '田中 太郎' },
      { id: 'acc-2', name: '佐藤 花子' },
    ]);
    api.updateUserGroup.mockResolvedValue({ ...group, name: '営業本部' });
  });

  it('現在のグループ名と所属ユーザーを読み込み、改名（保存）と追加・除外ができる', async () => {
    const user = userEvent.setup();
    render(<GroupEditScreen groupId="grp-1" />);

    expect(
      await screen.findByRole('heading', { level: 2, name: '管理グループを編集' }),
    ).toBeInTheDocument();
    const nameInput = screen.getByLabelText('グループ名');
    expect(nameInput).toHaveValue('営業チーム');
    expect(screen.getByRole('cell', { name: '田中 太郎' })).toBeInTheDocument();

    // 所属ユーザーの追加（操作ごとに即時 API 反映）
    await user.selectOptions(screen.getByLabelText('追加するユーザー'), 'acc-2');
    await user.click(screen.getByRole('button', { name: 'ユーザーを追加' }));
    await waitFor(() =>
      expect(api.addUserGroupMember).toHaveBeenCalledWith({
        groupId: 'grp-1',
        accountId: 'acc-2',
      }),
    );
    expect(screen.getByRole('cell', { name: '佐藤 花子' })).toBeInTheDocument();

    // 所属ユーザーの除外
    await user.click(screen.getByRole('button', { name: '田中 太郎 を所属ユーザーから除外' }));
    await waitFor(() => expect(api.removeUserGroupMember).toHaveBeenCalledWith('grp-1', 'acc-1'));
    expect(screen.queryByRole('cell', { name: '田中 太郎' })).not.toBeInTheDocument();

    // グループ名の変更 → 保存で確定し一覧へ戻る
    await user.clear(nameInput);
    await user.type(nameInput, '営業本部');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(api.updateUserGroup).toHaveBeenCalledWith('grp-1', {
        ...NO_HOME_GROUP_PERMISSIONS,
        name: '営業本部',
      }),
    );
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/settings/groups'));
  });

  it('名前を変えていないうちは保存できない（空名も不可）', async () => {
    const user = userEvent.setup();
    render(<GroupEditScreen groupId="grp-1" />);
    await screen.findByRole('heading', { level: 2, name: '管理グループを編集' });

    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.clear(screen.getByLabelText('グループ名'));
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(api.updateUserGroup).not.toHaveBeenCalled();
  });

  // 作成画面（group-create-screen）と同じ待ち方に揃える（d594）。
  it('読み込み中は見出しだけを出し、入力と保存ボタンは出さない', async () => {
    let resolveGroups: (v: unknown[]) => void = () => {};
    api.fetchUserGroups.mockReturnValue(
      new Promise((resolve) => {
        resolveGroups = resolve;
      }),
    );

    render(<GroupEditScreen groupId="grp-1" />);

    expect(
      screen.getByRole('heading', { level: 2, name: '管理グループを編集' }),
    ).toBeInTheDocument();
    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
    expect(screen.queryByLabelText('グループ名')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();

    resolveGroups([group]);
    await waitFor(() => expect(screen.getByLabelText('グループ名')).toHaveValue('営業チーム'));
    expect(screen.queryByText('読み込み中…')).not.toBeInTheDocument();
  });

  it('存在しないグループ id は見つからない旨を表示する', async () => {
    api.fetchUserGroups.mockResolvedValue([]);
    render(<GroupEditScreen groupId="grp-x" />);

    expect(await screen.findByText('管理グループが見つかりません。')).toBeInTheDocument();
    expect(api.fetchUserGroupMembers).not.toHaveBeenCalled();
  });

  it('アーカイブの導線を持たない', async () => {
    render(<GroupEditScreen groupId="grp-1" />);
    await screen.findByRole('heading', { level: 2, name: '管理グループを編集' });

    expect(screen.queryByText(/アーカイブ/)).not.toBeInTheDocument();
  });
  it('Home権限だけの変更を保存できる', async () => {
    render(<GroupEditScreen groupId="grp-1" />);
    fireEvent.click(await screen.findByLabelText('カレンダー'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(api.updateUserGroup).toHaveBeenCalledWith('grp-1', {
        ...NO_HOME_GROUP_PERMISSIONS,
        name: group.name,
        canEditHomeCalendar: true,
      }),
    );
  });
});
