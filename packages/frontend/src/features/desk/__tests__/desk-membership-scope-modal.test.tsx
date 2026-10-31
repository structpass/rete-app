import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flush } from '@/test-utils/flush';
import { MembershipScopeType } from '@rete/shared';
import type { MembershipDto } from '@rete/shared';
import type { Account } from '@/features/tasks/lib/api';
import { DeskMembershipScopeModal } from '../components/desk-membership-scope-modal';

/** axios.isAxiosError が true になる backend error shape 付きエラー（desk-group-manage-modal.test.tsx と同方針）。 */
const axiosError = (message: string) =>
  Object.assign(new Error(message), {
    isAxiosError: true,
    response: { data: { success: false, error: { message } } },
  });

const membershipsApi = vi.hoisted(() => ({
  fetchMemberships: vi.fn(),
  addMembership: vi.fn(),
  updateMembershipRole: vi.fn(),
  removeMembership: vi.fn(),
}));
vi.mock('@/features/settings/lib/memberships-api', () => membershipsApi);

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));

const accountA: Account = { id: 'acc-a', name: '田中 太郎' };
const accountB: Account = { id: 'acc-b', name: '鈴木 花子' };

const ms1: MembershipDto = {
  id: 'ms-1',
  accountId: 'acc-a',
  scopeType: MembershipScopeType.GROUP,
  scopeId: 'g1',
  role: 'MEMBER',
  accountName: '田中 太郎',
};

async function renderModal(
  overrides: Partial<React.ComponentProps<typeof DeskMembershipScopeModal>> = {},
) {
  const onClose = vi.fn();
  render(
    <DeskMembershipScopeModal
      open
      onClose={onClose}
      scopeType={MembershipScopeType.GROUP}
      scopeId="g1"
      scopeLabel="メンバー"
      scopeEntityName="グループ1"
      accounts={[accountA, accountB]}
      {...overrides}
    />,
  );
  await flush();
  return { onClose };
}

describe('DeskMembershipScopeModal（dsk-0309・共通メンバー管理モーダル）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    membershipsApi.fetchMemberships.mockResolvedValue([]);
  });

  it('open=false の間は何も描画しないこと', () => {
    render(
      <DeskMembershipScopeModal
        open={false}
        onClose={vi.fn()}
        scopeType={MembershipScopeType.GROUP}
        scopeId="g1"
        scopeLabel="メンバー"
        scopeEntityName="グループ1"
        accounts={[accountA]}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('open=true で fetchMemberships を呼び、一覧を表示すること', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    await renderModal();

    expect(membershipsApi.fetchMemberships).toHaveBeenCalledWith(MembershipScopeType.GROUP, 'g1');
    expect(screen.getByRole('dialog', { name: 'グループ1 の メンバー' })).toBeInTheDocument();
    expect(screen.getByText('田中 太郎')).toBeInTheDocument();
    // 既存メンバー（acc-a）はピッカー候補から除外され、未加入の acc-b のみ表示される。
    expect(screen.getByText('鈴木 花子')).toBeInTheDocument();
    expect(
      screen.queryByText('田中 太郎', { selector: '.sidebar-member-picker-option span' }),
    ).not.toBeInTheDocument();
  });

  it('メンバーがゼロ件なら空状態メッセージを出すこと', async () => {
    await renderModal();
    expect(screen.getByText('メンバーはまだいません')).toBeInTheDocument();
  });

  it('一覧取得失敗時、inline エラーと toast.error の両方を出すこと（dsk-0329 項目4）', async () => {
    membershipsApi.fetchMemberships.mockRejectedValue(axiosError('取得失敗しました'));
    await renderModal();

    expect(screen.getByRole('alert')).toHaveTextContent('取得失敗しました');
    expect(toast.error).toHaveBeenCalledWith('取得失敗しました');
  });

  it('候補をクリックすると addMembership を呼び、成功トーストを出して再取得すること', async () => {
    membershipsApi.addMembership.mockResolvedValue(ms1);
    await renderModal();
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);

    await act(async () => {
      fireEvent.click(screen.getByText('鈴木 花子'));
    });

    expect(membershipsApi.addMembership).toHaveBeenCalledWith({
      accountId: 'acc-b',
      scopeType: MembershipScopeType.GROUP,
      scopeId: 'g1',
      role: 'MEMBER',
    });
    expect(toast.success).toHaveBeenCalledWith('メンバーを追加しました');
    expect(membershipsApi.fetchMemberships).toHaveBeenCalledTimes(2);
  });

  it('追加失敗時、inline エラーと toast.error の両方を出すこと', async () => {
    membershipsApi.addMembership.mockRejectedValue(axiosError('追加できません'));
    await renderModal();

    await act(async () => {
      fireEvent.click(screen.getByText('鈴木 花子'));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('追加できません');
    expect(toast.error).toHaveBeenCalledWith('追加できません');
  });

  it('削除アイコン押下で即削除せず ConfirmDialog を挟むこと（dsk-0329 項目2）', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    await renderModal();

    fireEvent.click(screen.getByRole('button', { name: '田中 太郎 を削除' }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(membershipsApi.removeMembership).not.toHaveBeenCalled();
  });

  it('削除確認ダイアログでキャンセルすると removeMembership を呼ばないこと', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    await renderModal();

    fireEvent.click(screen.getByRole('button', { name: '田中 太郎 を削除' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(membershipsApi.removeMembership).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Escape でモーダル本体が閉じること（Esc の持ち主は共通 OverlayDialog 1つ）', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    const { onClose } = await renderModal();

    // Esc は共通 OverlayDialog（パネルの onKeyDown）が受け、desk-shell の一括クローズへは伝播しない。
    // 局所の document capture リスナーを併設すると、ここで二重に閉じて後ろのペインまで閉じる。
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('削除確認ダイアログ表示中は Escape でモーダル本体が閉じないこと（dsk-0329 項目3）', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    const { onClose } = await renderModal();

    // 削除アイコン → ConfirmDialog を開く。
    fireEvent.click(screen.getByRole('button', { name: '田中 太郎 を削除' }));
    await screen.findByRole('alertdialog');

    // Escape 押下は ConfirmDialog（AlertDialog）が受理して閉じる。本モーダルへは届かない（onClose は呼ばれない）。
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('削除確認ダイアログで確定すると removeMembership を呼び、成功トーストを出して再取得すること', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    membershipsApi.removeMembership.mockResolvedValue(undefined);
    await renderModal();

    fireEvent.click(screen.getByRole('button', { name: '田中 太郎 を削除' }));
    const dialog = screen.getByRole('alertdialog');
    membershipsApi.fetchMemberships.mockResolvedValue([]);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    });

    expect(membershipsApi.removeMembership).toHaveBeenCalledWith('ms-1');
    expect(toast.success).toHaveBeenCalledWith('「田中 太郎」を削除しました');
    expect(membershipsApi.fetchMemberships).toHaveBeenCalledTimes(2);
  });

  it('削除失敗時、inline エラーと toast.error の両方を出すこと', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    membershipsApi.removeMembership.mockRejectedValue(axiosError('削除できません'));
    await renderModal();

    fireEvent.click(screen.getByRole('button', { name: '田中 太郎 を削除' }));
    const dialog = screen.getByRole('alertdialog');

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('削除できません');
    expect(toast.error).toHaveBeenCalledWith('削除できません');
  });

  it('canEditRole=false（既定）ではロールをテキスト表示し select を出さないこと', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    await renderModal();

    expect(screen.getByText('MEMBER')).toBeInTheDocument();
    // set-0142: 共通 Select 化で trigger は button（combobox ではない）。ラベルで不在を検証する。
    expect(screen.queryByLabelText('田中 太郎 のロール')).not.toBeInTheDocument();
  });

  it('canEditRole=true でロール select を変更すると updateMembershipRole を呼び、成功トーストと再取得を行うこと（dsk-0366）', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    membershipsApi.updateMembershipRole.mockResolvedValue({ ...ms1, role: 'ADMIN' });
    await renderModal({ canEditRole: true });

    const select = screen.getByRole('button', { name: '田中 太郎 のロール' });
    membershipsApi.fetchMemberships.mockResolvedValue([{ ...ms1, role: 'ADMIN' }]);

    // set-0142: 共通 Select（button trigger）→ option クリックのイディオム。
    await userEvent.click(select);
    await userEvent.click(screen.getByRole('option', { name: 'ADMIN' }));
    await flush();

    expect(membershipsApi.updateMembershipRole).toHaveBeenCalledWith('ms-1', 'ADMIN');
    expect(toast.success).toHaveBeenCalledWith('ロールを変更しました');
    expect(membershipsApi.fetchMemberships).toHaveBeenCalledTimes(2);
  });

  it('ロール変更失敗時、inline エラーと toast.error の両方を出すこと', async () => {
    membershipsApi.fetchMemberships.mockResolvedValue([ms1]);
    membershipsApi.updateMembershipRole.mockRejectedValue(axiosError('権限がありません'));
    await renderModal({ canEditRole: true });

    await userEvent.click(screen.getByRole('button', { name: '田中 太郎 のロール' }));
    await userEvent.click(screen.getByRole('option', { name: 'ADMIN' }));
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('権限がありません');
    expect(toast.error).toHaveBeenCalledWith('権限がありません');
  });

  it('閉じるボタン押下で onClose を呼ぶこと', async () => {
    const { onClose } = await renderModal();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
