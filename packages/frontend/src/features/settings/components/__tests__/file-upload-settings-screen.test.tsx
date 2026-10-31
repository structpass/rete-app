import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// 画面が直接 import する hook（@/features/files/hooks/use-file-settings）をモックし、
// 描画・フォーム操作・保存呼び出しを検証する（tenant-settings-screen.test.tsx の
// 「直接依存する境界をモックする」方針に倣う。ここでの直接依存は API でなく hook）。
const useFileSettings = vi.hoisted(() => vi.fn());
vi.mock('@/features/files/hooks/use-file-settings', () => ({ useFileSettings }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
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
import { FileUploadSettingsScreen } from '../file-upload-settings-screen';

function makeHookResult(overrides: Partial<ReturnType<typeof useFileSettings>> = {}) {
  return {
    loading: false,
    saving: false,
    error: false,
    maxSizeMb: 20,
    allowedExtensions: ['.pdf', '.md'],
    fixedRejectedExtensions: ['.exe', '.dll', '.msi', '.scr', '.com'],
    rejectedExtensions: ['.ps1', '.sh'],
    loadErrorReason: '',
    setMaxSizeMb: vi.fn(),
    addAllowedExtension: vi.fn().mockReturnValue('added'),
    addRejectedExtension: vi.fn().mockReturnValue('added'),
    removeAllowedExtension: vi.fn(),
    removeRejectedExtension: vi.fn(),
    save: vi.fn().mockResolvedValue({ ok: true }),
    reset: vi.fn(),
    dirty: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useFileSettings.mockReturnValue(makeHookResult());
});

/** 見出しの欄（data-ext-group）の中だけを対象にする（同名ラベルが複数あるため）。 */
function groupOf(id: string) {
  const el = document.querySelector(`[data-ext-group="${id}"]`);
  if (!el) throw new Error(`group not found: ${id}`);
  return within(el as HTMLElement);
}

describe('FileUploadSettingsScreen 初回描画', () => {
  it('hook の値をフォームへ描画する', () => {
    render(<FileUploadSettingsScreen />);
    expect(screen.getByLabelText('最大ファイルサイズ（MB）')).toHaveValue(20);
  });

  it('拡張子は1本の入力欄ではなく、1件ずつのラベルとして描画する（v2-203）', () => {
    render(<FileUploadSettingsScreen />);
    // 許可する拡張子: 入力欄（下書き用）とは別に、追加済みの値がラベルとして並ぶ。
    const allowed = groupOf('upload-allowed-ext');
    expect(allowed.getByText('.pdf')).toBeInTheDocument();
    expect(allowed.getByText('.md')).toBeInTheDocument();
    // 旧方式の「カンマ区切りの値を入れた入力欄」は残っていない（入力欄は空の下書き）。
    expect(allowed.getByLabelText('許可する拡張子')).toHaveValue('');
    expect(screen.queryByDisplayValue('.pdf, .md')).not.toBeInTheDocument();

    const rejected = groupOf('upload-rejected-ext');
    expect(rejected.getByText('.ps1')).toBeInTheDocument();
    expect(rejected.getByText('.sh')).toBeInTheDocument();
  });

  it('各ラベルの右横に ✕（解除）ボタンを描画する（v2-203）', () => {
    render(<FileUploadSettingsScreen />);
    const allowed = groupOf('upload-allowed-ext');
    expect(allowed.getByRole('button', { name: '.pdf を解除' })).toBeInTheDocument();
    expect(allowed.getByRole('button', { name: '.md を解除' })).toBeInTheDocument();
  });

  it('常に拒否する拡張子は編集できず、追加・解除の対象にもならない（v2-197 要求版2）', () => {
    render(<FileUploadSettingsScreen />);
    const fixed = screen.getByLabelText('常に拒否する拡張子の一覧');
    expect(within(fixed).getByText('.exe')).toBeInTheDocument();
    expect(within(fixed).getByText('.com')).toBeInTheDocument();
    // 固定分には解除ボタンが無い（＝外せそうに見せない）。
    expect(screen.queryByRole('button', { name: '.exe を解除' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/この設定では変更できません/, { selector: 'strong' }),
    ).toBeInTheDocument();
  });

  it('フォームカードが内容に合う幅の枠に収まる（v2-180）', () => {
    render(<FileUploadSettingsScreen />);
    // 全幅(1153px)のままだと入力欄と本文が離れて間延びするため、表のある画面と同じ 680px の枠へ入れる。
    expect(getFormColumn(document.body)?.style.maxWidth).toBe('680px');
  });

  it('loading 中はフォームでなく共通 Spinner を描画する', () => {
    useFileSettings.mockReturnValue(makeHookResult({ loading: true }));
    render(<FileUploadSettingsScreen />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByLabelText('最大ファイルサイズ（MB）')).not.toBeInTheDocument();
  });

  it('error 時はエラーメッセージを描画する', () => {
    useFileSettings.mockReturnValue(makeHookResult({ error: true }));
    render(<FileUploadSettingsScreen />);
    expect(screen.getByText('設定の読み込みに失敗しました')).toBeInTheDocument();
  });

  it('error 時は読み込みに失敗した理由をそのまま描画する（d754）', () => {
    useFileSettings.mockReturnValue(
      makeHookResult({ error: true, loadErrorReason: '設定の参照権限がありません' }),
    );
    render(<FileUploadSettingsScreen />);
    expect(screen.getByText('設定の参照権限がありません')).toBeInTheDocument();
    expect(screen.queryByText('設定の読み込みに失敗しました')).not.toBeInTheDocument();
  });
});

describe('フォーム操作（v2-203: 1件ずつの追加・解除）', () => {
  it('最大サイズ入力で setMaxSizeMb を呼ぶ', async () => {
    const setMaxSizeMb = vi.fn();
    useFileSettings.mockReturnValue(makeHookResult({ setMaxSizeMb }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.clear(screen.getByLabelText('最大ファイルサイズ（MB）'));
    await user.type(screen.getByLabelText('最大ファイルサイズ（MB）'), '50');
    expect(setMaxSizeMb).toHaveBeenCalled();
  });

  it('許可する拡張子は入力＋追加ボタンで addAllowedExtension を呼ぶ', async () => {
    const addAllowedExtension = vi.fn().mockReturnValue('added');
    useFileSettings.mockReturnValue(makeHookResult({ addAllowedExtension }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    const allowed = groupOf('upload-allowed-ext');
    await user.type(allowed.getByLabelText('許可する拡張子'), 'csv');
    await user.click(allowed.getByRole('button', { name: '許可する拡張子を追加' }));
    expect(addAllowedExtension).toHaveBeenCalledWith('csv');
  });

  it('追加で拒否する拡張子は入力＋追加ボタンで addRejectedExtension を呼ぶ', async () => {
    const addRejectedExtension = vi.fn().mockReturnValue('added');
    useFileSettings.mockReturnValue(makeHookResult({ addRejectedExtension }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    const rejected = groupOf('upload-rejected-ext');
    await user.type(rejected.getByLabelText('追加で拒否する拡張子'), '.zip');
    await user.click(rejected.getByRole('button', { name: '追加で拒否する拡張子を追加' }));
    expect(addRejectedExtension).toHaveBeenCalledWith('.zip');
  });

  it('追加が入ると入力欄を空にして次の1件を受け付ける', async () => {
    const addAllowedExtension = vi.fn().mockReturnValue('added');
    useFileSettings.mockReturnValue(makeHookResult({ addAllowedExtension }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    const input = groupOf('upload-allowed-ext').getByLabelText('許可する拡張子');
    await user.type(input, 'csv');
    await user.click(
      groupOf('upload-allowed-ext').getByRole('button', { name: '許可する拡張子を追加' }),
    );
    expect(input).toHaveValue('');
  });

  it('重複は追加されず、理由を画面に出す（黙って消えない）', async () => {
    const addAllowedExtension = vi.fn().mockReturnValue('duplicate');
    useFileSettings.mockReturnValue(makeHookResult({ addAllowedExtension }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    const allowed = groupOf('upload-allowed-ext');
    await user.type(allowed.getByLabelText('許可する拡張子'), '.pdf');
    await user.click(allowed.getByRole('button', { name: '許可する拡張子を追加' }));
    expect(allowed.getByRole('status')).toHaveTextContent('.pdf は既に追加されています');
  });

  it('空のまま追加を押すと理由を出す', async () => {
    const addAllowedExtension = vi.fn().mockReturnValue('invalid');
    useFileSettings.mockReturnValue(makeHookResult({ addAllowedExtension }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.click(
      groupOf('upload-allowed-ext').getByRole('button', { name: '許可する拡張子を追加' }),
    );
    expect(groupOf('upload-allowed-ext').getByRole('status')).toHaveTextContent(
      '拡張子を入力してください',
    );
  });

  it('✕ ボタンでその1件だけを解除する（removeAllowedExtension）', async () => {
    const removeAllowedExtension = vi.fn();
    useFileSettings.mockReturnValue(makeHookResult({ removeAllowedExtension }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.click(groupOf('upload-allowed-ext').getByRole('button', { name: '.pdf を解除' }));
    expect(removeAllowedExtension).toHaveBeenCalledWith('.pdf');
  });

  it('✕ ボタンで拒否拡張子もその1件だけを解除する（removeRejectedExtension）', async () => {
    const removeRejectedExtension = vi.fn();
    useFileSettings.mockReturnValue(makeHookResult({ removeRejectedExtension }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.click(groupOf('upload-rejected-ext').getByRole('button', { name: '.sh を解除' }));
    expect(removeRejectedExtension).toHaveBeenCalledWith('.sh');
  });
});

describe('保存とキャンセル（v2-203）', () => {
  it('保存ボタン押下で save を呼び成功時は成功トーストを出す', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true });
    useFileSettings.mockReturnValue(makeHookResult({ save }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('アップロード設定を保存しました');
  });

  it('保存失敗時はサーバーが返した検証理由をそのままエラートーストに出す（v2-198）', async () => {
    const save = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: '拡張子は ".pdf" の形式で指定してください' });
    useFileSettings.mockReturnValue(makeHookResult({ save }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(toast.error).toHaveBeenCalledWith('拡張子は ".pdf" の形式で指定してください');
    // 理由を捨てた固定文言だけのトーストへ戻っていないこと（v2-198 の要求）。
    expect(toast.error).not.toHaveBeenCalledWith('設定の保存に失敗しました');
  });

  it('複数の検証理由が返った時は全部を並べて出す（v2-198）', async () => {
    const save = vi.fn().mockResolvedValue({
      ok: false,
      reason: '拡張子は 50 件までです / 拡張子は ".pdf" の形式で指定してください',
    });
    useFileSettings.mockReturnValue(makeHookResult({ save }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(toast.error).toHaveBeenCalledWith(
      '拡張子は 50 件までです / 拡張子は ".pdf" の形式で指定してください',
    );
  });

  it('キャンセルボタンがあり、押すと保存せず reset で途中入力を破棄する（要求の 4・5）', async () => {
    const reset = vi.fn();
    const save = vi.fn().mockResolvedValue({ ok: true });
    useFileSettings.mockReturnValue(makeHookResult({ reset, save }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(reset).toHaveBeenCalledTimes(1);
    // 破棄は保存を伴わない（保存ボタンを押すまで確定しない、という要求の 4）。
    expect(save).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('変更を破棄しました');
  });

  it('編集中のキャンセルは破棄確認を挟み、取り消すと破棄しない', async () => {
    const reset = vi.fn();
    useFileSettings.mockReturnValue(makeHookResult({ dirty: true, reset }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    // 確認ダイアログが開いた時点では破棄しない（規約②: 未編集の時だけ即実行）。
    expect(reset).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
    );
    expect(reset).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('未編集で Esc を押すと確認を挟まず取得値へ戻す', async () => {
    const reset = vi.fn();
    useFileSettings.mockReturnValue(makeHookResult({ dirty: false, reset }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('編集中に Esc を押すと破棄確認を挟み、閉じた Esc では破棄せず、OK で破棄する', async () => {
    const reset = vi.fn();
    useFileSettings.mockReturnValue(makeHookResult({ dirty: true, reset }));
    const user = userEvent.setup();
    render(<FileUploadSettingsScreen />);

    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();

    // 確認表示中の Esc はダイアログだけを閉じる（規約④。入力は破棄しない）。
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(reset).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('saving 中は保存ボタンを無効化する', () => {
    useFileSettings.mockReturnValue(makeHookResult({ saving: true }));
    render(<FileUploadSettingsScreen />);
    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled();
  });

  it('loading 中は保存ボタンを無効化する', () => {
    useFileSettings.mockReturnValue(makeHookResult({ loading: true }));
    render(<FileUploadSettingsScreen />);
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('error 時は保存ボタンを無効化する', () => {
    useFileSettings.mockReturnValue(makeHookResult({ error: true }));
    render(<FileUploadSettingsScreen />);
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
});

describe('MEMBER アクセス制御（set-0057）', () => {
  it('MEMBER ユーザーにはタイトルのみ示しフォーム・hook を実行しない', () => {
    mockRole = 'MEMBER';
    render(<FileUploadSettingsScreen />);
    expect(screen.getByRole('heading', { name: 'アップロード設定' })).toBeInTheDocument();
    expect(screen.queryByLabelText('最大ファイルサイズ（MB）')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('許可する拡張子')).not.toBeInTheDocument();
    expect(screen.queryByText(/このページはシステム管理者のみ/)).not.toBeInTheDocument();
    // Body（useFileSettings 実行元）を mount しない = 初期フェッチも起きない
    expect(useFileSettings).not.toHaveBeenCalled();
  });
});
