import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { flush } from '@/test-utils/flush';
import { makeMemberDto } from '@/test-utils/fixtures';
import { getListColumn, getListLayoutOrder } from '@/test-utils/list-layout';
import type { MemberDto } from '@rete/shared';
import { MembersScreen } from '../members-screen';

// ── API モック（members / tenant systems / roles negative check）─cmn-0142: vi.hoisted 化─
const {
  mockFetchMembers,
  mockUpdateMember,
  mockUnlockMember,
  mockResetMemberMfa,
  mockDownloadCsv,
  mockToastSuccess,
  mockToastError,
} = vi.hoisted(() => ({
  mockFetchMembers: vi.fn(),
  mockUpdateMember: vi.fn(),
  mockUnlockMember: vi.fn(),
  mockResetMemberMfa: vi.fn(),
  mockDownloadCsv: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('../../lib/members-api', () => ({
  fetchMembers: () => mockFetchMembers(),
  updateMember: (id: string, input: unknown) => mockUpdateMember(id, input),
  unlockMember: (id: string) => mockUnlockMember(id),
  resetMemberMfa: (id: string) => mockResetMemberMfa(id),
  downloadMembersCsv: () => mockDownloadCsv(),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: (m: string) => mockToastSuccess(m), error: (m: string) => mockToastError(m) },
}));

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

// ── フィクスチャ（d596: メンバーの組み立ては test-utils/fixtures が正本）──
const member = (over: Partial<MemberDto>): MemberDto => makeMemberDto(over);

const m1 = member({
  id: 'm1',
  name: '山田 太郎',
  familyName: '山田',
  givenName: '太郎',
  email: 'taro@rete.local',
  isActive: true,
});
const m2 = member({
  id: 'm2',
  name: '佐藤 花子',
  familyName: '佐藤',
  givenName: '花子',
  email: 'hanako@rete.local',
  isActive: false,
});

// set-0155: render 結果（container 等）を返す。結果が要るテストが render + flush を手書きで
// 展開する重複（4 箇所あった）を無くし、描画の入口を本ヘルパへ一本化する。
async function renderScreen() {
  const utils = render(<MembersScreen />);
  await flush();
  return utils;
}

describe('MembersScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchMembers.mockResolvedValue([m1, m2]);
  });

  it('メンバー一覧（氏名・メール）を描画し、業務ロール値に依存しない', async () => {
    const { container } = await renderScreen();
    expect(screen.getByText('山田 太郎')).toBeInTheDocument();
    expect(screen.getByText('taro@rete.local')).toBeInTheDocument();
    expect(screen.getByText('佐藤 花子')).toBeInTheDocument();
    expect(screen.queryByText('事務管理者')).not.toBeInTheDocument();
    expect(screen.queryByText('権限')).not.toBeInTheDocument();
    expect(screen.getByText('山田 太郎').closest('span')).not.toHaveClass('font-semibold');
    expect(container.querySelectorAll('thead th')).toHaveLength(5);
  });

  it('空状態行の colSpan は権限列除去後の5列に揃う', async () => {
    mockFetchMembers.mockResolvedValue([]);
    const { container } = await renderScreen();
    expect(container.querySelector('tbody td')).toHaveAttribute('colspan', '5');
  });

  it('「CSV 出力」は絞り込み帯の中ではなく独立したアクション行にある（set-0152）', async () => {
    const { container } = await renderScreen();
    const action = screen.getByRole('button', { name: 'メンバーを CSV 出力' });
    expect(action.closest('.sp-filter-bar')).toBeNull();
    expect(action.closest('.sp-list-action-row')).not.toBeNull();
    // 検索窓は帯の中に残る（帯側のクラス名が変わって「常に null」で緑になる形を防ぐ対比）。
    expect(
      screen.getByPlaceholderText('氏名 / メールで検索...').closest('.sp-filter-bar'),
    ).not.toBeNull();
    // 帰属だけでは行が表より下へ動いても緑のままなので、並び順も検査する（set-0150）。
    expect(getListLayoutOrder(container)).toEqual(['sp-filter-bar', 'sp-list-action-row', 'table']);
  });

  it('CSV 出力の行と表が同じ幅の列に収まる（v2-180）', async () => {
    const { container } = await renderScreen();
    const column = getListColumn(container);
    // 表だけを絞ると右寄せの CSV 出力が表の右端から外れる（実測 473px ずれ）ため、行と表を同じ枠へ入れる。
    expect(column?.style.maxWidth).toBe('680px');
    expect(column?.contains(container.querySelector('table'))).toBe(true);
  });

  it('CSV 出力ボタンの可視ラベルは操作ログと同じ「CSV 出力」表記（set-0150）', async () => {
    await renderScreen();
    const action = screen.getByRole('button', { name: 'メンバーを CSV 出力' });
    expect(action.textContent).toContain('CSV 出力');
  });

  it('上部サマリーカード4枚は出さない（set-0065）', async () => {
    await renderScreen();
    expect(screen.queryByText('メンバー総数')).not.toBeInTheDocument();
    expect(screen.queryByText('有効アカウント')).not.toBeInTheDocument();
    expect(screen.queryByText('契約 system')).not.toBeInTheDocument();
    // 見出し・タブ・一覧は残る。
    expect(screen.getByText('メンバー')).toBeInTheDocument();
    expect(screen.getByText('山田 太郎')).toBeInTheDocument();
  });

  it('状態フィルタ「ロック中」でロックアカウントのみ残す', async () => {
    await renderScreen();
    // mdl-0026: 絞り込みは native select → FilterChipSelect（チップ→listbox）へ移行。
    fireEvent.click(screen.getByRole('button', { name: '状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: 'ロック中' }));
    expect(screen.queryByText('山田 太郎')).not.toBeInTheDocument();
    expect(screen.getByText('佐藤 花子')).toBeInTheDocument();
  });

  it('検索で氏名・メールを絞り込む', async () => {
    await renderScreen();
    fireEvent.change(screen.getByPlaceholderText('氏名 / メールで検索...'), {
      target: { value: 'hanako' },
    });
    expect(screen.queryByText('山田 太郎')).not.toBeInTheDocument();
    expect(screen.getByText('佐藤 花子')).toBeInTheDocument();
  });

  it('編集オーバーレイの初期描画: 姓・名・メール・ステータスの順で表示し、権限とシステムアクセスの UI は無い（set-0070/set-0096/set-0181）', async () => {
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    expect(screen.getByText('メンバーの編集')).toBeInTheDocument();

    // set-0096: 表示名は姓・名の2入力。set-0097 でメールは編集可能（<input>）。
    expect(screen.getByTestId('member-editor-family-name')).toHaveValue('山田');
    expect(screen.getByTestId('member-editor-given-name')).toHaveValue('太郎');
    expect(screen.getByTestId('member-editor-email')).toHaveValue('taro@rete.local');
    expect(screen.queryByLabelText('権限')).not.toBeInTheDocument();
    expect(screen.queryByText('権限')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'アカウントをロックする' })).toBeInTheDocument();

    // ステータス右側のラベル（set-0070: 有効/ロックを可読文字列で表示）。
    expect(screen.getByTestId('member-editor-status-label')).toHaveTextContent('有効');

    // システムアクセス UI は set-0070 で撤去（ロールベースのアクセス制御へ一本化）。
    expect(screen.queryByLabelText('受発注 へのアクセス')).not.toBeInTheDocument();
    expect(screen.queryByText('システムアクセス')).not.toBeInTheDocument();
  });

  it('ステータスをトグルスイッチで有効⇔ロック切替できる（set-0070）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));

    const toggle = screen.getByRole('switch', { name: 'アカウントをロックする' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('member-editor-status-label')).toHaveTextContent('有効');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'アカウントを有効にする' })).toBe(toggle);
    expect(screen.getByTestId('member-editor-status-label')).toHaveTextContent(
      'ロック（ログイン不可）',
    );

    // 保存すると isActive:false のみ送られる（systemAccess は UI 撤去で送らない）。
    mockUpdateMember.mockResolvedValue({ ...m1, isActive: false });
    mockFetchMembers.mockResolvedValueOnce([{ ...m1, isActive: false }, m2]);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(mockUpdateMember).toHaveBeenCalledWith('m1', { isActive: false });
    expect(mockUpdateMember.mock.calls[0][1]).not.toHaveProperty('businessRoleId');
    expect(mockFetchMembers).toHaveBeenCalledTimes(2);
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith('メンバーを更新しました');
    expect(screen.queryByText('メンバーの編集')).not.toBeInTheDocument();
  });

  it.each(['cancel', 'escape'])(
    'メンバーの未保存入力は%sで破棄確認し、取り消すと保持する',
    async (mode) => {
      await renderScreen();
      fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
      fireEvent.change(screen.getByTestId('member-editor-given-name'), {
        target: { value: '未保存' },
      });
      if (mode === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
      else fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
      );
      expect(screen.getByTestId('member-editor-given-name')).toHaveValue('未保存');
      fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      expect(screen.queryByTestId('member-editor-given-name')).not.toBeInTheDocument();
      expect(mockUpdateMember).not.toHaveBeenCalled();
    },
  );

  it('何も変更せず保存すると updateMember を呼ばずに閉じる（差分送信・rete-settings-0020）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '佐藤 花子 を編集' }));
    // 何も触らず保存 → close-only
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();
    expect(mockUpdateMember).not.toHaveBeenCalled();
  });

  it('email を変更すると保存前に確認ダイアログが表示され、確定で PATCH 送信される（set-0097）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));

    const emailInput = screen.getByTestId('member-editor-email');
    expect(emailInput).toHaveValue('taro@rete.local');

    // email を変更
    fireEvent.change(emailInput, { target: { value: 'taro-new@rete.local' } });
    // 保存ボタン押下 → 確認ダイアログが出る（PATCH はまだ走らない）。AlertDialogContent は mounted
    // フラグの useEffect 後まで描画されないため flush が必要。
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    const confirmDialog = screen.getByRole('alertdialog');
    expect(confirmDialog).toHaveTextContent('taro-new@rete.local');
    expect(mockUpdateMember).not.toHaveBeenCalled();

    // キャンセルなら PATCH しない（確認ダイアログ内のキャンセルボタン＝alertdialog 配下）
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'キャンセル' }));
    expect(mockUpdateMember).not.toHaveBeenCalled();

    // もう一度保存 → 「OK」確定で PATCH
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();
    mockUpdateMember.mockResolvedValue({ ...m1, email: 'taro-new@rete.local' });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expect(mockUpdateMember).toHaveBeenCalledWith('m1', { email: 'taro-new@rete.local' });
  });

  it('email を大文字で変更しても backend 正規化で照合が一致し、成功扱いする（set-0178 HIGH 修正）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));

    const emailInput = screen.getByTestId('member-editor-email');
    // 大文字を含む email を入力（backend は trim + 小文字化して保存する）。
    fireEvent.change(emailInput, { target: { value: 'TARO-NEW@RETE.LOCAL' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    // 確認ダイアログ -> OK で PATCH。送信値は小文字化後の値。
    mockUpdateMember.mockResolvedValue({ ...m1, email: 'taro-new@rete.local' });
    // 再取得結果は小文字化された email（backend の正規化後）。
    mockFetchMembers.mockResolvedValueOnce([{ ...m1, email: 'taro-new@rete.local' }, m2]);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expect(mockUpdateMember).toHaveBeenCalledWith('m1', { email: 'taro-new@rete.local' });
    // 照合一致 → success toast + モーダル閉じ（偽の SAVE_VERIFICATION_ERROR にならない）。
    expect(mockToastSuccess).toHaveBeenCalledWith('メンバーを更新しました');
    expect(screen.queryByText('メンバーの編集')).not.toBeInTheDocument();
  });

  it('email を大文字に変えただけ（case-only）で initial と等価なら PATCH しない（backend no-op と整合・set-0178 HIGH 修正）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));

    const emailInput = screen.getByTestId('member-editor-email');
    // initial.email = 'taro@rete.local'（小文字）。大文字にしても trim+toLowerCase で等価になる。
    fireEvent.change(emailInput, { target: { value: 'TARO@RETE.LOCAL' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    // 正規化後等価 → email は差分なし（input.email は送られない）。確認ダイアログも出ない。
    expect(mockUpdateMember).not.toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ email: expect.anything() }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('email 変更なしで保存すると確認ダイアログは出ずにそのまま PATCH される（差分ありの他の項目だけ送る・set-0097）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '佐藤 花子 を編集' }));

    // 何も触らず保存 → email は初期値と同じなので確認ダイアログは出ない
    mockUpdateMember.mockResolvedValue(m2);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // 差分なし＝close-only（updateMember 呼ばない）
    expect(mockUpdateMember).not.toHaveBeenCalled();
  });

  it('email 変更保存で backend から 409（既に使用）が返るとエラー toast が出る（set-0097）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    fireEvent.change(screen.getByTestId('member-editor-email'), {
      target: { value: 'taken@rete.local' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    const conflict = {
      isAxiosError: true,
      response: {
        data: { error: { message: 'メールアドレス「taken@rete.local」は既に使用されています' } },
      },
    };
    mockUpdateMember.mockRejectedValue(conflict);

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expect(mockUpdateMember).toHaveBeenCalledWith('m1', { email: 'taken@rete.local' });
    expect(mockToastError).toHaveBeenCalledWith(
      'メールアドレス「taken@rete.local」は既に使用されています',
    );
  });

  it('PATCH 自体が失敗（backend メッセージ無し）なら「更新に失敗」を表示し、検証失敗と誤ラベルしない（set-0178 MEDIUM 修正）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    fireEvent.change(screen.getByTestId('member-editor-given-name'), { target: { value: '次郎' } });

    // PATCH（updateMember）が backend メッセージなしで throw（validation 等）。click 前に設定する。
    mockUpdateMember.mockRejectedValue(new Error('network'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(mockUpdateMember).toHaveBeenCalledTimes(1);
    // 検証失敗（SaveVerificationError）ではないので「更新に失敗しました」を表示。
    expect(mockToastError).toHaveBeenCalledWith('更新に失敗しました');
    // モーダルは開いたまま（エディタ状態を維持）。
    expect(screen.getByText('メンバーの編集')).toBeInTheDocument();
  });

  it('email 確認ダイアログで ESC を押すと確認ダイアログのみ閉じ、OverlayDialog は残る（set-0097）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    fireEvent.change(screen.getByTestId('member-editor-email'), {
      target: { value: 'taro-new@rete.local' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    // 確認ダイアログが出ている
    expect(screen.getByRole('alertdialog')).toHaveTextContent('taro-new@rete.local');

    // ESC を発火（AlertDialog の document keydown リスナが stopPropagation する＝OverlayDialog には届かない）
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();

    // 確認ダイアログは閉じているが OverlayDialog（=「メンバーの編集」ヘッダ）は残っている
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('メンバーの編集')).toBeInTheDocument();
    // PATCH はまだ走っていない
    expect(mockUpdateMember).not.toHaveBeenCalled();
  });

  it('姓・名変更時は trim 済みで送信・照合し、一致すれば成功扱いする（set-0178 HIGH 修正）', async () => {
    // m1 は '山田'→'鈴木'・'太郎'→'次郎' へ変更。backend は trim して保存するので、送信・照合も trim 済み。
    mockUpdateMember.mockResolvedValue({
      ...m1,
      familyName: '鈴木',
      givenName: '次郎',
      name: '鈴木 次郎',
    });
    mockFetchMembers
      .mockResolvedValueOnce([m1, m2])
      .mockResolvedValueOnce([
        { ...m1, familyName: '鈴木', givenName: '次郎', name: '鈴木 次郎' },
        m2,
      ]);
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    fireEvent.change(screen.getByTestId('member-editor-family-name'), {
      target: { value: '鈴木' },
    });
    fireEvent.change(screen.getByTestId('member-editor-given-name'), { target: { value: '次郎' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(mockUpdateMember).toHaveBeenCalledWith('m1', {
      familyName: '鈴木',
      givenName: '次郎',
    });
    expect(mockFetchMembers).toHaveBeenCalledTimes(2);
    expect(mockToastSuccess).toHaveBeenCalledWith('メンバーを更新しました');
    expect(screen.queryByText('メンバーの編集')).not.toBeInTheDocument();
  });

  it('姓・名に前後空白を足すだけでは差分とみなさず no-op（backend trim と整合・set-0178 HIGH 修正）', async () => {
    // initial は backend 保存済み（trim 済み）なので、入力に前後空白を足しても正規化後等価 → PATCH しない。
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));

    fireEvent.change(screen.getByTestId('member-editor-family-name'), {
      target: { value: ' 山田 ' },
    });
    fireEvent.change(screen.getByTestId('member-editor-given-name'), {
      target: { value: ' 太郎 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(mockUpdateMember).not.toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        familyName: expect.anything(),
      }),
    );
  });

  it('姓・名変更時、保存後の再取得結果が送信値と不一致なら成功扱いしない（set-0178 HIGH 修正）', async () => {
    mockUpdateMember.mockResolvedValue({
      ...m1,
      familyName: '鈴木',
      givenName: '次郎',
      name: '鈴木 次郎',
    });
    // 再取得結果が old のまま（PATCH がストア未反映）→ 照合不一致。
    mockFetchMembers.mockResolvedValueOnce([m1, m2]).mockResolvedValueOnce([{ ...m1 }, m2]);
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    fireEvent.change(screen.getByTestId('member-editor-family-name'), {
      target: { value: '鈴木' },
    });
    fireEvent.change(screen.getByTestId('member-editor-given-name'), { target: { value: '次郎' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(mockUpdateMember).toHaveBeenCalledTimes(1);
    expect(mockFetchMembers).toHaveBeenCalledTimes(2);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(screen.getByText('メンバーの編集')).toBeInTheDocument();
  });

  it('「CSV 出力」ボタンで downloadMembersCsv を呼びダウンロードを発火する', async () => {
    mockDownloadCsv.mockResolvedValue(new Blob(['﻿表示名\r\n'], { type: 'text/csv' }));
    const createUrl = vi.fn(() => 'blob:mock');
    const revokeUrl = vi.fn();
    // jsdom は URL.createObjectURL を実装しないためスタブする。
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'メンバーを CSV 出力' }));
    await flush();

    expect(mockDownloadCsv).toHaveBeenCalledTimes(1);
    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('エクスポート進行中はボタンを無効化し二重発火を防ぐ', async () => {
    let resolve!: (b: Blob) => void;
    mockDownloadCsv.mockReturnValue(
      new Promise<Blob>((r) => {
        resolve = r;
      }),
    );
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await renderScreen();
    const btn = screen.getByRole('button', { name: 'メンバーを CSV 出力' });
    fireEvent.click(btn);
    await flush();
    // 進行中は disabled。disabled ボタンへの click は onClick を発火しない。
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(mockDownloadCsv).toHaveBeenCalledTimes(1);

    resolve(new Blob(['﻿'], { type: 'text/csv' }));
    await flush();
    expect(btn).not.toBeDisabled();
  });

  it('ロックアウト中のメンバーは一覧に「ロックアウト中」バッジを出し、編集で手動解除できる（set-0030）', async () => {
    const lockedMember = member({
      id: 'm3',
      name: '鈴木 一郎',
      email: 'ichiro@rete.local',
      isActive: true,
      lockedUntil: new Date(Date.now() + 12 * 60_000).toISOString(),
    });
    mockFetchMembers.mockResolvedValue([lockedMember]);
    mockUnlockMember.mockResolvedValue({ ...lockedMember, lockedUntil: null });

    await renderScreen();

    // 一覧でロックアウトを識別できる。
    expect(screen.getByText('ロックアウト中')).toBeInTheDocument();

    // 編集を開くと手動解除セクション（自動解除までの概算分）が出る。
    fireEvent.click(screen.getByRole('button', { name: '鈴木 一郎 を編集' }));
    expect(screen.getByText('ログイン試行ロックアウト')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '今すぐロックを解除' }));
    await flush();

    expect(mockUnlockMember).toHaveBeenCalledWith('m3');
    expect(mockToastSuccess).toHaveBeenCalledWith('ロックを解除しました');
    // 解除後はバッジが消える（lockedUntil クリア）。
    expect(screen.queryByText('ロックアウト中')).not.toBeInTheDocument();
  });

  it('MFA 有効なメンバーは編集でリセットセクションを出し、管理者リセットできる（set-0033）', async () => {
    const mfaMember = member({
      id: 'm4',
      name: '高橋 次郎',
      email: 'jiro@rete.local',
      isActive: true,
      mfaEnabled: true,
    });
    mockFetchMembers.mockResolvedValue([mfaMember]);
    mockResetMemberMfa.mockResolvedValue({ ...mfaMember, mfaEnabled: false });

    await renderScreen();

    // 編集を開くと MFA リセットセクション（リセットボタン）が出る。
    fireEvent.click(screen.getByRole('button', { name: '高橋 次郎 を編集' }));
    expect(screen.getByRole('button', { name: '二段階認証をリセット' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '二段階認証をリセット' }));
    // 即時リセットせず確認ダイアログを経る（set-0039）。確定するまで API は呼ばれない。
    expect(mockResetMemberMfa).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expect(mockResetMemberMfa).toHaveBeenCalledWith('m4');
    expect(mockToastSuccess).toHaveBeenCalledWith('二段階認証をリセットしました');
    // リセット後はリセットボタンが消え「設定されていません」表示へ変わる（mfaEnabled=false）。
    expect(screen.queryByRole('button', { name: '二段階認証をリセット' })).not.toBeInTheDocument();
    expect(screen.getByText('二段階認証は設定されていません')).toBeInTheDocument();
  });

  it('MFA リセットの確認ダイアログをキャンセルするとリセットされない（set-0039）', async () => {
    const mfaMember = member({
      id: 'm4b',
      name: '高橋 次郎',
      email: 'jiro2@rete.local',
      isActive: true,
      mfaEnabled: true,
    });
    mockFetchMembers.mockResolvedValue([mfaMember]);

    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: '高橋 次郎 を編集' }));
    fireEvent.click(screen.getByRole('button', { name: '二段階認証をリセット' }));
    // 確認ダイアログをキャンセル → API 未呼び出し・リセットボタンは残る（set-0039）。
    // MemberEditor フォームにも「キャンセル」があるため、ダイアログ内に限定して押す。
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
    );
    await flush();

    expect(mockResetMemberMfa).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '二段階認証をリセット' })).toBeInTheDocument();
  });

  it('MFA 未設定のメンバーは編集でリセットセクションを出さない（set-0033）', async () => {
    mockFetchMembers.mockResolvedValue([
      member({ id: 'm5', name: '田中 三郎', email: 'saburo@rete.local' }),
    ]);
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: '田中 三郎 を編集' }));
    expect(screen.queryByRole('button', { name: '二段階認証をリセット' })).not.toBeInTheDocument();
    expect(screen.getByText('二段階認証は設定されていません')).toBeInTheDocument();
  });

  it('検索キーワード指定時、一覧の氏名・メールセルの一致箇所を sp-search-hl でハイライトする（set-0055）', async () => {
    const { container } = await renderScreen();
    fireEvent.change(screen.getByPlaceholderText('氏名 / メールで検索...'), {
      target: { value: 'taro' },
    });
    // m1(山田 太郎/taro@rete.local) のみ残る。メールの一致箇所がハイライトされる。
    const emailMarks = container.querySelectorAll('td mark.sp-search-hl');
    expect(emailMarks.length).toBeGreaterThanOrEqual(1);
    expect(emailMarks[0].textContent).toBe('taro');
  });

  it('検索キーワード未指定はハイライトしない（set-0055）', async () => {
    const { container } = await renderScreen();
    expect(container.querySelectorAll('mark.sp-search-hl').length).toBe(0);
  });

  it('編集オーバーレイの FormCard description に氏名（姓+空白+名）がライブ表示・メールは出さない（set-0119 rework）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    const dialog = screen.getByText('メンバーの編集').closest('section')!;
    // set-0119 rework: description を復活（メール抜き・姓+空白+名）。mark.sp-search-hl は無し
    // （前回 commit で highlight 機構ごと撤去済み・本 rework でも復活対象外）。
    expect(within(dialog).queryByText('山田 太郎')).toBeInTheDocument();
    expect(within(dialog).queryByText(/taro@rete\.local/)).not.toBeInTheDocument();
    // オーバーレイ内に sp-search-hl は無い（一覧側のハイライトは別 it で担保）
    expect(within(dialog).queryAllByText('山田', { selector: 'mark.sp-search-hl' }).length).toBe(0);
    expect(screen.getByTestId('member-editor-email')).toHaveValue('taro@rete.local');
  });

  it('姓入力欄を書き換えると description の表示名がその場で追従する（set-0119 rework・editor.name 固定値の罠を避ける）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    const dialog = screen.getByText('メンバーの編集').closest('section')!;
    expect(within(dialog).queryByText('山田 太郎')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('member-editor-family-name'), {
      target: { value: '鈴木' },
    });
    // ライブ計算：保存前でも description が「鈴木 太郎」へ即時更新される（editor.name ではなく
    // familyName/givenName から都度算出するため・plan_notes grounding 参照）。
    expect(within(dialog).queryByText('鈴木 太郎')).toBeInTheDocument();
    expect(within(dialog).queryByText('山田 太郎')).not.toBeInTheDocument();
  });

  it('名入力欄を書き換えると description の表示名がその場で追従する（set-0135・givenName 対称）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    const dialog = screen.getByText('メンバーの編集').closest('section')!;
    expect(within(dialog).queryByText('山田 太郎')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('member-editor-given-name'), {
      target: { value: '次郎' },
    });
    expect(within(dialog).queryByText('山田 次郎')).toBeInTheDocument();
    expect(within(dialog).queryByText('山田 太郎')).not.toBeInTheDocument();
  });

  it('姓または名が空のとき description に余分な空白が残らない（set-0135）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    const dialog = screen.getByText('メンバーの編集').closest('section')!;

    fireEvent.change(screen.getByTestId('member-editor-given-name'), {
      target: { value: '' },
    });
    expect(within(dialog).queryByText('山田')).toBeInTheDocument();
    expect(within(dialog).queryByText(/山田\s+$/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('member-editor-family-name'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByTestId('member-editor-given-name'), {
      target: { value: '太郎' },
    });
    expect(within(dialog).queryByText('太郎')).toBeInTheDocument();
    expect(within(dialog).queryByText(/^\s+太郎/)).not.toBeInTheDocument();
  });

  it('姓・名の入力欄は横並びではなく縦 1 列に積まれる（set-0119 rework・auto-fit グリッドの撤回）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    const family = screen.getByTestId('member-editor-family-name').parentElement;
    const given = screen.getByTestId('member-editor-given-name').parentElement;
    // 同じ親を持たない＝grid の同一行ではない（前 commit の auto-fit grid 構造ではない）
    expect(family).not.toBe(given);
    expect(family!.style.gridTemplateColumns || '').not.toMatch(/auto-fit/);
    expect(given!.style.gridTemplateColumns || '').not.toMatch(/auto-fit/);
  });

  it('編集オーバーレイの項目順は 姓・名 → メール → ステータス → MFA（set-0119/set-0181）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    const dialog = screen.getByText('メンバーの編集').closest('section')!;
    const labels = within(dialog)
      .getAllByText(/^(姓|名|メールアドレス|ステータス|二段階認証（MFA）)$/)
      .map((el) => el.textContent);
    // FormLabel テキストの出現順（姓・名は grid 内で連続）
    expect(labels).toEqual(['姓', '名', 'メールアドレス', 'ステータス', '二段階認証（MFA）']);
  });

  it('保存失敗時は backend のエラーメッセージを toast 表示する（自己ロックアウト等）', async () => {
    mockUpdateMember.mockRejectedValue({
      // v2-234: 共有 apiErrorMessage（axios.isAxiosError ガード付き）を通るため、fixture は実体どおり
      // axios エラー形（isAxiosError: true）で渡す（:327 の既存 fixture と同形）。
      isAxiosError: true,
      response: { data: { error: { message: '自分自身をロックすることはできません' } } },
    });
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    fireEvent.click(screen.getByLabelText('アカウントをロックする')); // 有効 → ロックへ
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(mockToastError).toHaveBeenCalledWith('自分自身をロックすることはできません');
    expect(mockFetchMembers).toHaveBeenCalledTimes(1);
    expect(screen.getByText('メンバーの編集')).toBeInTheDocument();
  });

  it('保存後の確認 GET 失敗時は一覧を反映せず検証失敗を表示する', async () => {
    mockUpdateMember.mockResolvedValue({ ...m1, isActive: false });
    mockFetchMembers.mockResolvedValueOnce([m1, m2]).mockRejectedValueOnce(new Error('network'));

    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    fireEvent.click(screen.getByRole('switch', { name: 'アカウントをロックする' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(mockUpdateMember).toHaveBeenCalledWith('m1', { isActive: false });
    expect(mockFetchMembers).toHaveBeenCalledTimes(2);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      '保存後の状態確認に失敗しました。実状態が変更済みの可能性があります。メンバー一覧を再読み込みして再確認してください。',
    );
    expect(screen.getByText('メンバーの編集')).toBeInTheDocument();
  });

  it.each([
    ['対象IDが欠落', [m2]],
    ['対象の状態が不一致', [m1, m2]],
  ])('保存後の確認 GET が%sなら成功扱いしない', async (_caseName, refreshed) => {
    mockUpdateMember.mockResolvedValue({ ...m1, isActive: false });
    mockFetchMembers.mockResolvedValueOnce([m1, m2]).mockResolvedValueOnce(refreshed);

    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    fireEvent.click(screen.getByRole('switch', { name: 'アカウントをロックする' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    expect(mockUpdateMember).toHaveBeenCalledTimes(1);
    expect(mockFetchMembers).toHaveBeenCalledTimes(2);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(screen.getByText('メンバーの編集')).toBeInTheDocument();
  });

  it('保存中はボタンを無効化し、連打しても PATCH を重複させない', async () => {
    let resolveUpdate!: (value: MemberDto) => void;
    mockUpdateMember.mockReturnValue(
      new Promise<MemberDto>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    mockFetchMembers
      .mockResolvedValueOnce([m1, m2])
      .mockResolvedValueOnce([{ ...m1, isActive: false }, m2]);

    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '山田 太郎 を編集' }));
    fireEvent.click(screen.getByRole('switch', { name: 'アカウントをロックする' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flush();

    const save = screen.getByRole('button', { name: /保存$/ });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(mockUpdateMember).toHaveBeenCalledTimes(1);

    resolveUpdate({ ...m1, isActive: false });
    await flush();
    expect(mockToastSuccess).toHaveBeenCalledWith('メンバーを更新しました');
  });

  it('MEMBER ユーザーにはタイトルのみ示し一覧・フェッチを行わない（set-0057）', async () => {
    mockRole = 'MEMBER';
    await renderScreen();
    expect(screen.getByRole('heading', { name: 'メンバー' })).toBeInTheDocument();
    expect(screen.queryByText('山田 太郎')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'メンバーを CSV 出力' })).not.toBeInTheDocument();
    expect(screen.queryByText(/このページはシステム管理者のみ/)).not.toBeInTheDocument();
    expect(mockFetchMembers).not.toHaveBeenCalled();
  });

  it('一覧の取得に失敗したら領域内に role="alert" を出し、0件文言と区別する（v2-233）', async () => {
    mockFetchMembers.mockRejectedValue(new Error('network'));

    render(<MembersScreen />);
    await flush();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('メンバーの読み込みに失敗しました');
    // 真0件の空文言は描かない（失敗と0件を読み分けられる）
    expect(screen.queryByText('メンバーがいません')).not.toBeInTheDocument();
    // 取得失敗は toast へ逃がさない（正本 ui.ts:109-110 の二層: 取得失敗=領域内 / 操作失敗=toast）
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('検索語を入れた状態で取得に失敗しても、0件の文言「見つかりませんでした」で失敗を隠さない（d655）', async () => {
    mockFetchMembers.mockRejectedValue(new Error('network'));

    render(<MembersScreen />);
    await flush();
    fireEvent.change(screen.getByPlaceholderText('氏名 / メールで検索...'), {
      target: { value: '山田' },
    });
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('メンバーの読み込みに失敗しました');
    expect(screen.queryByText('メンバーが見つかりませんでした')).not.toBeInTheDocument();
    // 件数も 0 件と読めない形にする（操作ログと同じ扱い・d536）。
    expect(screen.queryByText(/全 0 件/)).not.toBeInTheDocument();
    expect(screen.getByText(/全 — 件/)).toBeInTheDocument();
  });

  // d659: 取得失敗は「もう一度取る手段」までを 1 つの領域として出し、押せば本当に取り直す。
  it('取得失敗の表示に再試行を添え、押すと取り直して失敗の表示を消す（d659）', async () => {
    mockFetchMembers.mockRejectedValueOnce(new Error('network'));
    mockFetchMembers.mockResolvedValue([makeMemberDto()]);

    render(<MembersScreen />);
    await flush();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('メンバーの読み込みに失敗しました');
    fireEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    await flush();

    expect(mockFetchMembers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('メンバーがいません')).not.toBeInTheDocument();
  });
});
