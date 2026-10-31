import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// 画面が直接 import する API モジュール（../lib/api）をモックし、画面の挙動を検証する:
// 初回ロード / テナント情報の保存。
const api = vi.hoisted(() => ({
  fetchTenantInfo: vi.fn(),
  updateTenantInfo: vi.fn(),
}));
// set-0105: TenantInfoProvider 外で描画するため context を stub
const tenantInfoCtx = vi.hoisted(() => ({ setTenantInfo: vi.fn() }));
// react-hot-toast は Toaster（layout 直下）へ portal するため単体 render では DOM に出ない。
// rete 既存規約に倣い default export をスパイ化し、呼び出しを検証する。
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../lib/api', () => api);
vi.mock('@/features/shell/hooks/tenant-info-context', () => ({
  useTenantInfoContext: () => tenantInfoCtx,
}));
vi.mock('react-hot-toast', () => ({ default: toast }));

// ── useSession モック（role を外部変数で切り替えられるようにする・set-0057）──
let mockRole = 'ADMIN';
vi.mock('@/features/auth/components/session-provider', () => ({
  useSessionContext: () => ({
    user: { id: 'u1', email: 'admin@rete.local', name: 'Admin', role: mockRole },
    loading: false,
    menuItems: [],
  }),
}));

// ロールをリセットする
beforeEach(() => {
  mockRole = 'ADMIN';
});

import { getFormColumn } from '@/test-utils/list-layout';
import { TenantSettingsScreen } from '../tenant-settings-screen';

const INFO = { name: '開発法人', badgeColor: 'green' };

// pointer-events:none な hidden radio もクリック対象にするため check を無効化。
const setupUser = () => userEvent.setup({ pointerEventsCheck: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchTenantInfo.mockResolvedValue({ ...INFO });
  api.updateTenantInfo.mockResolvedValue({ ...INFO });
  tenantInfoCtx.setTenantInfo.mockReset();
});

/** 画面を描画し、初回ロード完了まで待つ。 */
async function renderLoaded() {
  render(<TenantSettingsScreen />);
  await screen.findByLabelText('テナント名');
}

describe('TenantSettingsScreen 初回ロード', () => {
  it('テナント情報を取得して描画する', async () => {
    await renderLoaded();
    expect(api.fetchTenantInfo).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('テナント名')).toHaveValue('開発法人');
    expect(screen.getByRole('radio', { name: '緑' })).toBeChecked();
    expect(screen.queryByText('システム一覧')).not.toBeInTheDocument();
  });

  it('フォームカードが内容に合う幅の枠に収まる（v2-180）', async () => {
    await renderLoaded();
    // 全幅(1153px)のままだと入力欄と本文が離れて間延びするため、表のある画面と同じ 680px の枠へ入れる。
    expect(getFormColumn(document.body)?.style.maxWidth).toBe('680px');
  });

  it('ロード失敗時はエラートーストを出す', async () => {
    api.fetchTenantInfo.mockRejectedValueOnce(new Error('boom'));
    render(<TenantSettingsScreen />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('設定の読み込みに失敗しました'));
  });
});

describe('テナント情報の保存', () => {
  it('名称と表示色を編集して更新すると updateTenantInfo を呼ぶ', async () => {
    api.updateTenantInfo.mockResolvedValueOnce({ name: '新法人', badgeColor: 'red' });
    await renderLoaded();
    const user = setupUser();
    const nameInput = screen.getByLabelText('テナント名');
    await user.clear(nameInput);
    await user.type(nameInput, '新法人');
    await user.click(screen.getByRole('radio', { name: '赤' }));
    await user.click(screen.getAllByRole('button', { name: '保存' })[0]);
    expect(api.updateTenantInfo).toHaveBeenCalledWith({ name: '新法人', badgeColor: 'red' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('テナント情報を更新しました'));
    // set-0105: ヘッダバッジへ同一タブ即時反映
    expect(tenantInfoCtx.setTenantInfo).toHaveBeenCalledWith({ name: '新法人', badgeColor: 'red' });
  });

  it('更新失敗時はエラートーストを出す', async () => {
    api.updateTenantInfo.mockRejectedValueOnce(new Error('boom'));
    await renderLoaded();
    const user = setupUser();
    await user.click(screen.getAllByRole('button', { name: '保存' })[0]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('テナント情報の更新に失敗しました'),
    );
  });

  it('保存と対でキャンセルボタンを出す（v2-171。set-0107「キャンセルを出さない」を撤回）', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '保存' }).length).toBeGreaterThanOrEqual(1);
  });
});

describe('テナント情報のキャンセル（v2-171）', () => {
  it('名称と表示色の編集を保存済みの値へ戻す（API は呼ばない）', async () => {
    await renderLoaded();
    const user = setupUser();
    const nameInput = screen.getByLabelText('テナント名');
    await user.clear(nameInput);
    await user.type(nameInput, '編集中の名前');
    await user.click(screen.getByRole('radio', { name: '赤' }));

    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    // 編集中は破棄確認を挟む（規約②③）。取り消すと入力は残る。
    await user.click(screen.getAllByRole('button', { name: 'キャンセル' }).at(-1)!);
    expect(screen.getByLabelText('テナント名')).toHaveValue('編集中の名前');

    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    await user.click(screen.getByRole('button', { name: 'OK' }));

    expect(screen.getByLabelText('テナント名')).toHaveValue('開発法人');
    expect(screen.getByRole('radio', { name: '緑' })).toBeChecked();
    expect(api.updateTenantInfo).not.toHaveBeenCalled();
    expect(tenantInfoCtx.setTenantInfo).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('変更をキャンセルしました');
  });

  it('未編集のキャンセルは確認を挟まず、入力も変えない', async () => {
    await renderLoaded();
    const user = setupUser();
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('テナント名')).toHaveValue('開発法人');
  });

  it('更新後に編集してキャンセルすると直前の保存値へ戻す', async () => {
    api.updateTenantInfo.mockResolvedValueOnce({ name: '新法人', badgeColor: 'red' });
    await renderLoaded();
    const user = setupUser();
    const nameInput = screen.getByLabelText('テナント名');
    await user.clear(nameInput);
    await user.type(nameInput, '新法人');
    await user.click(screen.getByRole('radio', { name: '赤' }));
    await user.click(screen.getAllByRole('button', { name: '保存' })[0]);
    await waitFor(() => expect(api.updateTenantInfo).toHaveBeenCalledTimes(1));

    await user.clear(screen.getByLabelText('テナント名'));
    await user.type(screen.getByLabelText('テナント名'), 'また編集中');
    await user.click(screen.getByRole('radio', { name: '青' }));
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    await user.click(screen.getByRole('button', { name: 'OK' }));

    expect(screen.getByLabelText('テナント名')).toHaveValue('新法人');
    expect(screen.getByRole('radio', { name: '赤' })).toBeChecked();
    expect(api.updateTenantInfo).toHaveBeenCalledTimes(1);
  });

  it('未編集で Esc を押すと確認を挟まず、入力へ影響しない', async () => {
    await renderLoaded();
    const user = setupUser();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('テナント名')).toHaveValue('開発法人');
  });

  it('編集中に Esc を押すと破棄確認を挟み、閉じた Esc では破棄せず、OK で保存済みの値へ戻す', async () => {
    await renderLoaded();
    const user = setupUser();
    const nameInput = screen.getByLabelText('テナント名');
    await user.clear(nameInput);
    await user.type(nameInput, '編集中の名前');
    await user.click(screen.getByRole('radio', { name: '赤' }));

    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByLabelText('テナント名')).toHaveValue('編集中の名前');

    // 確認表示中の Esc はダイアログだけを閉じる（規約④。編集は続く）。
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByLabelText('テナント名')).toHaveValue('編集中の名前');

    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    expect(screen.getByLabelText('テナント名')).toHaveValue('開発法人');
    expect(screen.getByRole('radio', { name: '緑' })).toBeChecked();
  });
});

describe('MEMBER アクセス制御（set-0057）', () => {
  it('MEMBER ユーザーにはタイトルのみ示しフェッチを行わない', async () => {
    mockRole = 'MEMBER';
    render(<TenantSettingsScreen />);
    expect(screen.getByRole('heading', { name: 'テナント設定' })).toBeInTheDocument();
    expect(screen.queryByLabelText('テナント名')).not.toBeInTheDocument();
    expect(screen.queryByText(/このページはシステム管理者のみ/)).not.toBeInTheDocument();
    expect(api.fetchTenantInfo).not.toHaveBeenCalled();
  });
});
