import { NO_HOME_GROUP_PERMISSIONS } from '@rete/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupCreateScreen } from '../group-create-screen';

const api = vi.hoisted(() => ({
  createUserGroup: vi.fn(),
  addUserGroupMember: vi.fn(),
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

describe('GroupCreateScreen（作成サブ画面・set-0188）', () => {
  it('Homeの4権限を選択して名前と一緒に作成する', async () => {
    const user = userEvent.setup();
    render(<GroupCreateScreen />);
    await user.type(await screen.findByLabelText('グループ名'), '新チーム');
    for (const label of ['掲示板', 'カレンダー', 'FAQ', 'タグ管理']) {
      expect(screen.getByLabelText(label)).not.toBeChecked();
      await user.click(screen.getByLabelText(label));
    }
    await user.click(screen.getByRole('button', { name: '作成' }));
    await waitFor(() =>
      expect(api.createUserGroup).toHaveBeenCalledWith({
        name: '新チーム',
        canEditHomeBoard: true,
        canEditHomeCalendar: true,
        canEditHomeFaq: true,
        canManageHomeTags: true,
      }),
    );
  });

  it('名前が空でも権限だけの未保存変更をEscで捨てない', async () => {
    const user = userEvent.setup();
    render(<GroupCreateScreen />);
    await user.click(await screen.findByLabelText('カレンダー'));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('button', { name: 'キャンセル' }).at(-1)!);
    expect(screen.getByLabelText('カレンダー')).toBeChecked();
    expect(api.createUserGroup).not.toHaveBeenCalled();
  });

  it.each(['キャンセル', '管理グループ一覧'])(
    '未保存名を%sで失わず、破棄確定後にだけ戻る',
    async (label) => {
      const user = userEvent.setup();
      render(<GroupCreateScreen />);
      await screen.findByLabelText('グループ名');
      await user.type(screen.getByLabelText('グループ名'), '未保存');
      await user.click(
        screen.getByRole(label === 'キャンセル' ? 'button' : 'link', { name: label }),
      );
      expect(router.push).not.toHaveBeenCalled();
      await user.click(screen.getAllByRole('button', { name: 'キャンセル' }).at(-1)!);
      expect(screen.getByLabelText('グループ名')).toHaveValue('未保存');
      await user.click(
        screen.getByRole(label === 'キャンセル' ? 'button' : 'link', { name: label }),
      );
      await user.click(screen.getByRole('button', { name: 'OK' }));
      expect(router.push).toHaveBeenCalledWith('/settings/groups');
      expect(api.createUserGroup).not.toHaveBeenCalled();
    },
  );
  beforeEach(() => {
    vi.clearAllMocks();
    membersApi.fetchMembers.mockResolvedValue([
      { id: 'acc-1', name: '田中 太郎' },
      { id: 'acc-2', name: '佐藤 花子' },
    ]);
    api.createUserGroup.mockResolvedValue({
      id: 'grp-9',
      name: '新チーム',
      sortOrder: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    api.addUserGroupMember.mockResolvedValue({ created: true });
  });

  it('グループ名と所属ユーザー（追加・除外）を決めて作成し、一覧へ戻る', async () => {
    const user = userEvent.setup();
    render(<GroupCreateScreen />);
    await screen.findByRole('heading', { level: 2, name: '管理グループを作成' });

    // グループ名が空のうちは作成できない
    expect(screen.getByRole('button', { name: '作成' })).toBeDisabled();

    await user.type(screen.getByLabelText('グループ名'), '新チーム');

    // 追加 → 除外（作成前は画面内で取り消せる）
    await user.selectOptions(screen.getByLabelText('追加するユーザー'), 'acc-1');
    await user.click(screen.getByRole('button', { name: 'ユーザーを追加' }));
    expect(screen.getByRole('cell', { name: '田中 太郎' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '田中 太郎 を所属ユーザーから除外' }));
    expect(screen.queryByRole('cell', { name: '田中 太郎' })).not.toBeInTheDocument();

    // 追加し直してから作成
    await user.selectOptions(screen.getByLabelText('追加するユーザー'), 'acc-1');
    await user.click(screen.getByRole('button', { name: 'ユーザーを追加' }));
    await user.click(screen.getByRole('button', { name: '作成' }));

    await waitFor(() =>
      expect(api.createUserGroup).toHaveBeenCalledWith({
        ...NO_HOME_GROUP_PERMISSIONS,
        name: '新チーム',
      }),
    );
    await waitFor(() =>
      expect(api.addUserGroupMember).toHaveBeenCalledWith({ groupId: 'grp-9', accountId: 'acc-1' }),
    );
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/settings/groups'));
  });

  it('所属ユーザーが空でも名前だけで作成できる', async () => {
    const user = userEvent.setup();
    render(<GroupCreateScreen />);
    await screen.findByRole('heading', { level: 2, name: '管理グループを作成' });

    await user.type(screen.getByLabelText('グループ名'), '新チーム');
    await user.click(screen.getByRole('button', { name: '作成' }));

    await waitFor(() =>
      expect(api.createUserGroup).toHaveBeenCalledWith({
        ...NO_HOME_GROUP_PERMISSIONS,
        name: '新チーム',
      }),
    );
    expect(api.addUserGroupMember).not.toHaveBeenCalled();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/settings/groups'));
  });

  it('キャンセルは一覧へ戻るだけ（作成しない）', async () => {
    const user = userEvent.setup();
    render(<GroupCreateScreen />);
    await screen.findByRole('heading', { level: 2, name: '管理グループを作成' });

    await user.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(router.push).toHaveBeenCalledWith('/settings/groups');
    expect(api.createUserGroup).not.toHaveBeenCalled();
  });

  // 編集画面（group-edit-screen）と同じ待ち方に揃える（d594）。
  it('読み込み中は見出しだけを出し、入力と作成ボタンは出さない', async () => {
    let resolveMembers: (v: { id: string; name: string }[]) => void = () => {};
    membersApi.fetchMembers.mockReturnValue(
      new Promise((resolve) => {
        resolveMembers = resolve;
      }),
    );

    render(<GroupCreateScreen />);

    expect(
      screen.getByRole('heading', { level: 2, name: '管理グループを作成' }),
    ).toBeInTheDocument();
    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
    expect(screen.queryByLabelText('グループ名')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '作成' })).not.toBeInTheDocument();

    resolveMembers([{ id: 'acc-1', name: '田中 太郎' }]);
    await screen.findByLabelText('グループ名');
    expect(screen.queryByText('読み込み中…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '作成' })).toBeInTheDocument();
  });

  it('アーカイブの導線を持たない', async () => {
    render(<GroupCreateScreen />);
    await screen.findByRole('heading', { level: 2, name: '管理グループを作成' });

    expect(screen.queryByText(/アーカイブ/)).not.toBeInTheDocument();
  });

  it('グループ名はサーバが空を拒否するため必須として出すこと（正本 comp-form-field）', async () => {
    render(<GroupCreateScreen />);
    const input = await screen.findByLabelText('グループ名');

    // マークは label の外に置き、アクセシブル名は「グループ名」のまま（FormLabel required）。
    expect(input).toHaveAttribute('aria-required', 'true');
    const marks = document.querySelectorAll('.sp-required-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent?.replace(/\s+/g, '')).toBe('*必須');
  });
});
