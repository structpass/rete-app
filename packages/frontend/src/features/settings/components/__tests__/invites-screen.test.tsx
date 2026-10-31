import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flush } from '@/test-utils/flush';
import { makeInviteDto } from '@/test-utils/fixtures';
import { getListColumn, getListLayoutOrder } from '@/test-utils/list-layout';
import { type InviteDto, type InviteImportResultDto, type SpaceDto, SpaceKind } from '@rete/shared';
import { InvitesScreen } from '../invites-screen';

// ── API モック ─cmn-0142: vi.hoisted 化─
const {
  mockFetchInvites,
  mockFetchMailStatus,
  mockCreateInvite,
  mockResendInvite,
  mockDeleteInvite,
  mockDownloadTemplate,
  mockImportCsv,
  mockFetchGroupSpaces,
  mockToastSuccess,
  mockToastError,
} = vi.hoisted(() => ({
  mockFetchInvites: vi.fn(),
  mockFetchMailStatus: vi.fn(),
  mockCreateInvite: vi.fn(),
  mockResendInvite: vi.fn(),
  mockDeleteInvite: vi.fn(),
  mockDownloadTemplate: vi.fn(),
  mockImportCsv: vi.fn(),
  mockFetchGroupSpaces: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('../../lib/invites-api', () => ({
  fetchInvites: () => mockFetchInvites(),
  fetchMailStatus: () => mockFetchMailStatus(),
  createInvite: (input: unknown) => mockCreateInvite(input),
  resendInvite: (id: string) => mockResendInvite(id),
  deleteInvite: (id: string) => mockDeleteInvite(id),
  downloadInviteTemplate: () => mockDownloadTemplate(),
  importInvitesCsv: (file: File, spaceId: string) => mockImportCsv(file, spaceId),
}));

vi.mock('../../lib/spaces-api', () => ({
  fetchGroupSpaces: () => mockFetchGroupSpaces(),
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

// ── フィクスチャ（d596: 招待の組み立ては test-utils/fixtures が正本）──
const invite = (over: Partial<InviteDto>): InviteDto =>
  makeInviteDto({
    invitedAt: '2026-04-28T09:00:00.000Z',
    expiresAt: '2026-05-05T09:00:00.000Z',
    ...over,
  });

const i1 = invite({ id: 'inv-1', email: 'tanaka@struct-pass.io', status: 'PENDING' });
const i2 = invite({ id: 'inv-2', email: 'suzuki@struct-pass.io', status: 'EXPIRED' });

const space1: SpaceDto = {
  id: 'space-1',
  kind: SpaceKind.GROUP,
  projectId: null,
  ownerId: null,
  peerAccountId: null,
  name: '営業部',
  sortOrder: 0,
  archived: false,
  canManageMembers: false,
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
};

async function renderScreen() {
  render(<InvitesScreen />);
  await flush();
}

/**
 * 発行・再送の失敗の理由（一覧の取得失敗とは別に、表の外へ出す role="alert"）。
 *
 * 理由の文字だけを見ると、一覧の取得失敗の表示（表の 0 件行に「招待一覧の読み込みに失敗しました」）と
 * 区別できないので、表の外に出ていることと、一覧の失敗の文が alert に混ざっていないことを確かめる。
 */
function expectListAlert(text: string) {
  const alerts = screen.queryAllByRole('alert');
  const found = alerts.find((el) => el.textContent?.includes(text));
  if (!found)
    throw new Error(
      `「${text}」の alert が無い: ${alerts.map((el) => el.textContent).join(' | ')}`,
    );
  expect(found.closest('tbody')).toBeNull();
  expect(found).not.toHaveTextContent('招待一覧の読み込みに失敗しました');
  return found;
}

/**
 * 発行フォーム（オーバーレイ）を開いたままの失敗理由。
 * オーバーレイ中は背面が inert + aria-hidden で隔離されるため、理由が背面にあると
 * 読み上げにも届かない。フォームの中に出ていることを確かめる（d535）。
 */
function expectInFormAlert(text: string) {
  const dialog = screen.getByRole('dialog');
  const found = within(dialog)
    .queryAllByRole('alert')
    .find((el) => el.textContent?.includes(text));
  if (!found)
    throw new Error(
      `フォーム内に「${text}」の alert が無い: ${within(dialog)
        .queryAllByRole('alert')
        .map((el) => el.textContent)
        .join(' | ')}`,
    );
  return found;
}

/** 共通 Select（button trigger）を開いて option を選ぶ（set-0142・task-create-overlay と同イディオム）。 */
async function pickOption(triggerLabel: string, optionName: string) {
  await userEvent.click(screen.getByLabelText(triggerLabel));
  await userEvent.click(screen.getByRole('option', { name: optionName }));
}

/** 発行フォームを開き、メール + 初期 Space を埋める。 */
async function fillIssueForm(email: string) {
  fireEvent.click(screen.getByRole('button', { name: '招待メールを発行' }));
  fireEvent.change(screen.getByLabelText('招待先メールアドレス'), { target: { value: email } });
  await pickOption('初期 Space（受諾時に参加）', '営業部');
}

describe('InvitesScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchInvites.mockResolvedValue([i1, i2]);
    mockFetchMailStatus.mockResolvedValue({ configured: true });
    mockFetchGroupSpaces.mockResolvedValue([space1]);
  });

  it('一覧の取得に失敗したら、空の一覧でなく領域内に失敗を残す（d592）', async () => {
    mockFetchInvites.mockRejectedValue(new Error('network'));
    await renderScreen();
    expect(mockToastError).toHaveBeenCalledWith('招待一覧の読み込みに失敗しました');
    // 0 件の「招待がありません」と読み分けられるよう、role="alert" の文言で残す（正本 ui.ts:109）。
    expect(screen.getByRole('alert')).toHaveTextContent('招待一覧の読み込みに失敗しました');
    expect(screen.queryByText('招待がありません')).not.toBeInTheDocument();
  });

  it('検索語を入れた状態で取得に失敗しても、0件の文言「見つかりませんでした」で失敗を隠さない（d655）', async () => {
    mockFetchInvites.mockRejectedValue(new Error('network'));
    await renderScreen();
    const search = screen.getByPlaceholderText(/で検索/);
    fireEvent.change(search, { target: { value: 'tanaka' } });
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('招待一覧の読み込みに失敗しました');
    expect(screen.queryByText('招待が見つかりませんでした')).not.toBeInTheDocument();
    // 件数も 0 件と読めない形にする（メンバー・操作ログと同じ扱い・d655）。
    expect(screen.queryByText(/全 0 件/)).not.toBeInTheDocument();
    expect(screen.getByText(/全 — 件/)).toBeInTheDocument();
    expect(screen.queryByText('招待がありません')).not.toBeInTheDocument();
  });

  // d659: 取得失敗は「もう一度取る手段」までを 1 つの領域として出し、押せば本当に取り直す。
  it('取得失敗の表示に再試行を添え、押すと取り直して失敗の表示を消す（d659）', async () => {
    mockFetchInvites.mockRejectedValueOnce(new Error('network'));
    mockFetchInvites.mockResolvedValue([i1]);

    await renderScreen();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('招待一覧の読み込みに失敗しました');
    fireEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    await flush();

    expect(mockFetchInvites).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('招待がありません')).not.toBeInTheDocument();
  });

  it('招待一覧（メール・状態バッジ）を描画する', async () => {
    await renderScreen();
    expect(screen.getByText('tanaka@struct-pass.io')).toBeInTheDocument();
    expect(screen.getByText('suzuki@struct-pass.io')).toBeInTheDocument();
    expect(screen.getAllByText('招待中').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('期限切れ').length).toBeGreaterThanOrEqual(1);
  });

  it('補助アクションと隠しファイル入力は絞り込み帯の外の独立行にある（set-0152）', async () => {
    const { container } = render(<InvitesScreen />);
    await flush();
    for (const name of ['CSV インポート', 'CSV テンプレートをダウンロード', '招待メールを発行']) {
      const action = screen.getByRole('button', { name });
      expect(action.closest('.sp-filter-bar')).toBeNull();
      expect(action.closest('.sp-list-action-row')).not.toBeNull();
    }
    // 隠し file input もアクションと同じ行へ移す（インポート操作の起点が離れないこと）。
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    expect(fileInput!.closest('.sp-list-action-row')).not.toBeNull();
    // 検索窓は帯の中に残る（帯側のクラス名が変わって「常に null」で緑になる形を防ぐ対比）。
    expect(
      screen.getByPlaceholderText('メールアドレスで検索...').closest('.sp-filter-bar'),
    ).not.toBeNull();
    // 帰属だけでは行が表より下へ動いても緑のままなので、並び順も検査する（set-0150）。
    expect(getListLayoutOrder(container)).toEqual(['sp-filter-bar', 'sp-list-action-row', 'table']);
  });

  it('アクション行と表が同じ幅の列に収まる（v2-180）', async () => {
    const { container } = render(<InvitesScreen />);
    await flush();
    const column = getListColumn(container);
    // 表だけを絞ると右寄せのアクションが表の右端から外れる（実測 393px ずれ）ため、行と表を同じ枠へ入れる。
    expect(column?.style.maxWidth).toBe('760px');
    expect(column?.contains(container.querySelector('table'))).toBe(true);
  });

  it('上部サマリーカードを表示しない（set-0115）', async () => {
    await renderScreen();
    expect(screen.queryByText('合計')).not.toBeInTheDocument();
    // ステータスバッジ（行内）は維持される
    expect(screen.getAllByText('招待中').length).toBeGreaterThanOrEqual(1);
  });

  it('メール検索で一致する行だけ残す', async () => {
    await renderScreen();
    fireEvent.change(screen.getByPlaceholderText('メールアドレスで検索...'), {
      target: { value: 'tanaka' },
    });
    // set-0055: 一致箇所が sp-search-hl でハイライトされ text が分割されるため、
    // 完全一致テキストを持つ SPAN を狙い撃ちで探す（getByText の単純完全一致は破綻する）。
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'SPAN' && el.textContent === 'tanaka@struct-pass.io',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('suzuki@struct-pass.io')).not.toBeInTheDocument();
  });

  it('検索キーワード指定時、一覧のメールセルの一致箇所を sp-search-hl でハイライトする（set-0055）', async () => {
    const { container } = render(<InvitesScreen />);
    await flush();
    fireEvent.change(screen.getByPlaceholderText('メールアドレスで検索...'), {
      target: { value: 'tanaka' },
    });
    const marks = container.querySelectorAll('mark.sp-search-hl');
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect(marks[0].textContent).toBe('tanaka');
  });

  it('招待一覧に丸アイコン（??）と操作オーバーレイ導線が無い（set-0121）', async () => {
    await renderScreen();
    expect(screen.queryByText('??')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /の操作$/ })).not.toBeInTheDocument();
    expect(screen.queryByText('招待の操作')).not.toBeInTheDocument();
  });

  it('検索キーワード未指定はハイライトしない（set-0055）', async () => {
    const { container } = render(<InvitesScreen />);
    await flush();
    expect(container.querySelectorAll('mark.sp-search-hl').length).toBe(0);
  });

  it('状態フィルタ「招待中」で PENDING のみ残す', async () => {
    await renderScreen();
    // mdl-0026: 絞り込みは native select → FilterChipSelect（チップ→listbox）へ移行。
    fireEvent.click(screen.getByRole('button', { name: '状態で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: '招待中' }));
    expect(screen.getByText('tanaka@struct-pass.io')).toBeInTheDocument();
    expect(screen.queryByText('suzuki@struct-pass.io')).not.toBeInTheDocument();
  });

  it('初期 Space 未選択では発行ボタンが無効', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '招待メールを発行' }));
    expect(screen.queryByLabelText('権限（受諾時に付与）')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('招待先メールアドレス'), {
      target: { value: 'x@example.com' },
    });
    // Space 未選択 → 送信ボタン無効
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    // Space 選択 → 有効
    await pickOption('初期 Space（受諾時に参加）', '営業部');
    expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled();
  });

  it('発行フォームで email + Space を入れて送信すると権限なしで createInvite を呼ぶ', async () => {
    const newInvite = invite({ id: 'inv-3', email: 'new@example.com', status: 'PENDING' });
    mockCreateInvite.mockResolvedValue(newInvite);

    await renderScreen();
    await fillIssueForm('new@example.com');
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(mockCreateInvite).toHaveBeenCalledWith({
      email: 'new@example.com',
      spaceId: 'space-1',
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('new@example.com'));
  });

  it('発行フォームは必須項目（招待先メール・初期 Space）を必須として出す（正本 comp-form-field）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '招待メールを発行' }));
    const email = await screen.findByLabelText('招待先メールアドレス');

    expect(email).toHaveAttribute('aria-required', 'true');
    // 初期 Space も受諾先なので必須（CreateInviteDto.spaceId）。
    expect(screen.getByLabelText('初期 Space（受諾時に参加）')).toBeInTheDocument();
    expect(document.querySelectorAll('.sp-required-mark')).toHaveLength(2);
  });

  it('mail-status が未設定なら「招待」「インポート」を無効化しバナーを出す（論点2）', async () => {
    mockFetchMailStatus.mockResolvedValue({ configured: false });
    await renderScreen();
    expect(screen.getByText(/メール送信が未設定/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '招待メールを発行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'CSV インポート' })).toBeDisabled();
  });

  it('createInvite が 503 を返すと SMTP バナーを表示し、理由を領域内にも残す（d535）', async () => {
    // 503 のうち「設定が無い」場合。バナーは、送信の失敗後に引き直した設定で決まる（d535）。
    mockFetchMailStatus
      .mockResolvedValueOnce({ configured: true })
      .mockResolvedValueOnce({ configured: false });
    mockCreateInvite.mockRejectedValue({
      response: {
        status: 503,
        data: {
          error: {
            message: 'メールが未設定のため招待を送信できません。SMTP 設定を確認してください',
          },
        },
      },
    });
    await renderScreen();
    await fillIssueForm('smtp@example.com');
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(screen.getByText(/メール送信が未設定/)).toBeInTheDocument();
    // 設定が無い時もフォームを閉じない。閉じると、バナーが出ない場合に理由が何も残らない（d535）。
    expect(screen.getByLabelText('招待先メールアドレス')).toBeInTheDocument();
    expectInFormAlert('メールが未設定のため招待を送信できません');
  });

  it('送信の一時障害（503・送信失敗の文言）では、設定不足のバナーに切り替えない（d535）', async () => {
    mockFetchMailStatus.mockResolvedValue({ configured: true });
    mockCreateInvite.mockRejectedValue({
      response: {
        status: 503,
        data: { error: { message: 'メール送信に失敗しました。しばらく後にお試しください' } },
      },
    });
    await renderScreen();
    await fillIssueForm('send-fail@example.com');
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(screen.queryByText(/メール送信が未設定/)).not.toBeInTheDocument();
    // 入力が残っているのでキャンセルは破棄確認を挟む。閉じて一覧に戻っても理由が残る。
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expectListAlert('メール送信に失敗しました。しばらく後にお試しください');
  });

  it('createInvite が 400 を返すと「既に招待中」トーストを表示する', async () => {
    mockCreateInvite.mockRejectedValue({ response: { status: 400 } });
    await renderScreen();
    await fillIssueForm('dup@example.com');
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(mockToastError).toHaveBeenCalledWith('このメールアドレスは既に招待中です');
  });

  it('発行が 503 以外の失敗をすると、通知が消えた後も領域内に理由を残す（d535）', async () => {
    // 通知（toast）は数秒で消える。残さないと、開き直した一覧と正常な状態が見分けられない。
    mockCreateInvite.mockRejectedValue({
      response: {
        status: 500,
        data: { error: { message: '招待の発行に失敗しました（検証）' } },
      },
    });
    await renderScreen();
    await fillIssueForm('fail@example.com');
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(mockToastError).toHaveBeenCalledWith('招待の発行に失敗しました（検証）');
    // 入力が残っているのでキャンセルは破棄確認を挟む。閉じて一覧に戻っても理由が残る。
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expectListAlert('招待の発行に失敗しました（検証）');
    expect(screen.queryByText('招待がありません')).not.toBeInTheDocument();
  });

  it('再送が 503 以外の失敗をすると、領域内に理由を残し、閉じた後も続けて押せる（d535）', async () => {
    mockResendInvite.mockRejectedValue({
      response: { status: 500, data: { error: { message: '再送に失敗しました（検証）' } } },
    });
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'tanaka@struct-pass.io をメール再送' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expectListAlert('再送に失敗しました（検証）');
    // 閉じた後に押せること（押せないと、理由が出ていても次を試せない）。
    const resend = screen.getByRole('button', { name: 'tanaka@struct-pass.io をメール再送' });
    expect(resend).not.toBeDisabled();
    fireEvent.click(resend);
    await flush();
    // 閉じた画面のままで、次の確認が出る（一覧の取得に戻ろうとして読み込み状態へ戻らない）。
    expect(screen.queryByLabelText('招待先メールアドレス')).toBeNull();
    expect(screen.getByText('tanaka@struct-pass.io')).toBeInTheDocument();
  });

  it('送信そのものの失敗（503・送信失敗の文言）は、設定が有るまま領域内に理由を残す（d535）', async () => {
    // 503 は「設定が無い」と「送信に失敗した」の 2 通り。後者はこれまで通知だけで消えていた。
    mockCreateInvite.mockRejectedValue({
      response: {
        status: 503,
        data: { error: { message: 'メール送信に失敗しました。しばらく後にお試しください' } },
      },
    });
    await renderScreen();
    await fillIssueForm('send-fail@example.com');
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    // 入力が残っているのでキャンセルは破棄確認を挟む。閉じて一覧に戻っても理由が残る。
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expectListAlert('メール送信に失敗しました。しばらく後にお試しください');
    // 設定は無いと誤って案内しない（設定を引き直しても「有る」）。
    expect(screen.queryByText(/メール送信が未設定/)).not.toBeInTheDocument();
  });

  it('再送の送信失敗（503・送信失敗の文言）も領域内に理由を残す（d535）', async () => {
    mockResendInvite.mockRejectedValue({
      response: {
        status: 503,
        data: { error: { message: 'メール送信に失敗しました。しばらく後にお試しください' } },
      },
    });
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'tanaka@struct-pass.io をメール再送' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expectListAlert('メール送信に失敗しました。しばらく後にお試しください');
  });

  it('設定が無い場合の 503 は、バナーに加えてフォームを閉じず領域内にも案内を残す（d535）', async () => {
    // 送信後に引き直した設定が「無い」なら、従来の案内（バナー）へ切り替える。
    mockFetchMailStatus
      .mockResolvedValueOnce({ configured: true })
      .mockResolvedValueOnce({ configured: false });
    mockCreateInvite.mockRejectedValue({
      response: {
        status: 503,
        data: {
          error: {
            message: 'メールが未設定のため招待を送信できません。SMTP 設定を確認してください',
          },
        },
      },
    });
    await renderScreen();
    await fillIssueForm('not-configured@example.com');
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(screen.getByText(/メール送信が未設定/)).toBeInTheDocument();
    // バナーはページ上部、理由は欄内。通知が消えた後に何も残らないと、送れたのか分からない（d535）。
    expectInFormAlert('メールが未設定のため招待を送信できません');
    // フォームは閉じない（閉じると理由の行き先が無い）。
    expect(screen.getByLabelText('招待先メールアドレス')).toBeInTheDocument();
  });

  it('設定は足りているのに 503（送信失敗）が返る時も、理由を領域内に残す（d535）', async () => {
    // 実環境では、設定はあるが送信に失敗する時にこの形で返る。前回はここでフォームだけ閉じ、
    // バナーは出さず理由も残さずに消えていた（サイレント失敗）。
    mockFetchMailStatus.mockResolvedValue({ configured: true });
    mockCreateInvite.mockRejectedValue({
      response: {
        status: 503,
        data: {
          error: {
            message: 'メールが未設定のため招待を送信できません。SMTP 設定を確認してください',
          },
        },
      },
    });
    await renderScreen();
    await fillIssueForm('configured-but-failed@example.com');
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await flush();

    expect(screen.queryByText(/メール送信が未設定/)).not.toBeInTheDocument();
    expectInFormAlert('メールが未設定のため招待を送信できません');
  });

  it('失敗の表示は、次の成功（再送が通る）で解ける（d535）', async () => {
    mockResendInvite.mockRejectedValueOnce({
      response: { status: 500, data: { error: { message: '再送に失敗しました（検証）' } } },
    });
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'tanaka@struct-pass.io をメール再送' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();
    expectListAlert('再送に失敗しました（検証）');

    mockResendInvite.mockResolvedValueOnce({ ...i1, invitedAt: '2026-05-10T09:00:00.000Z' });
    fireEvent.click(screen.getByRole('button', { name: 'tanaka@struct-pass.io をメール再送' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expect(screen.queryByText('再送に失敗しました（検証）')).not.toBeInTheDocument();
  });

  it('行のゴミ箱から削除確認→OK で deleteInvite を呼ぶ（set-0121）', async () => {
    mockDeleteInvite.mockResolvedValue(undefined);
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'tanaka@struct-pass.io を削除' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expect(mockDeleteInvite).toHaveBeenCalledWith('inv-1');
    expect(mockToastSuccess).toHaveBeenCalledWith('招待を削除しました');
  });

  it('削除確認をキャンセルすると deleteInvite を呼ばない（set-0121）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'tanaka@struct-pass.io を削除' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
    );
    await flush();
    expect(mockDeleteInvite).not.toHaveBeenCalled();
  });

  it('招待中の行の「メール再送」確認 OK で resendInvite を呼ぶ（set-0121）', async () => {
    const updated = { ...i1, invitedAt: '2026-05-10T09:00:00.000Z' };
    mockResendInvite.mockResolvedValue(updated);
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'tanaka@struct-pass.io をメール再送' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expect(mockResendInvite).toHaveBeenCalledWith('inv-1');
    expect(mockToastSuccess).toHaveBeenCalledWith('招待メールを再送しました');
  });

  it('期限切れの行にはメール再送ボタンが出ない（set-0121）', async () => {
    await renderScreen();
    expect(
      screen.queryByRole('button', { name: 'suzuki@struct-pass.io をメール再送' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'suzuki@struct-pass.io を削除' }),
    ).toBeInTheDocument();
  });

  it('resendInvite が 503 を返すと SMTP バナーを表示し「招待」ボタンを無効化する', async () => {
    // 送信後に引き直した設定が「無い」なら案内へ切り替える（フォームが無いので領域内にも残す・d535）。
    mockFetchMailStatus
      .mockResolvedValueOnce({ configured: true })
      .mockResolvedValueOnce({ configured: false });
    mockResendInvite.mockRejectedValue({
      response: {
        status: 503,
        data: {
          error: {
            message: 'メールが未設定のため招待を送信できません。SMTP 設定を確認してください',
          },
        },
      },
    });
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'tanaka@struct-pass.io をメール再送' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));
    await flush();

    expect(screen.getByText(/メール送信が未設定/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '招待メールを発行' })).toBeDisabled();
    // 再送はフォームが無いので、通知が消えた後に理由が残るのはこの欄だけ（d535）。
    expectListAlert('メールが未設定のため招待を送信できません');
  });

  it('「サンプル」ボタンで downloadInviteTemplate を呼びファイルをダウンロードする', async () => {
    mockDownloadTemplate.mockResolvedValue(new Blob(['email\r\n'], { type: 'text/csv' }));
    const createUrl = vi.fn(() => 'blob:mock');
    const revokeUrl = vi.fn();
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV テンプレートをダウンロード' }));
    await flush();

    expect(mockDownloadTemplate).toHaveBeenCalledTimes(1);
    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('CSV インポート設定で Space のみを選び、権限なしで importInvitesCsv を呼ぶ', async () => {
    const result: InviteImportResultDto = {
      issued: 3,
      skipped: 1,
      skippedDetails: [{ email: 'bad@x.io', reason: 'invalid_email', row: 2 }],
    };
    mockImportCsv.mockResolvedValue(result);

    await renderScreen();

    // インポート設定オーバーレイを開く。
    fireEvent.click(screen.getByRole('button', { name: 'CSV インポート' }));
    expect(screen.getByText('CSV 一括インポート')).toBeInTheDocument();
    expect(screen.queryByLabelText('権限（受諾時に付与）')).not.toBeInTheDocument();
    await pickOption('初期 Space（受諾時に参加）', '営業部');

    // 隠し file input への直接変更でインポートをトリガー。
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['email\r\ntest@x.io\r\n'], 'test.csv', { type: 'text/csv' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);
    await flush();

    expect(mockImportCsv).toHaveBeenCalledWith(file, 'space-1');
    expect(screen.getByText('CSV インポート結果')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // 行番号 + 日本語化理由（論点4）。
    expect(screen.getByText('形式不正')).toBeInTheDocument();
    expect(screen.getByText('bad@x.io')).toBeInTheDocument();
    // 行番号列（row=2）が描画される（サマリ件数の '2' とも重複するため件数で確認）。
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
    // 失敗行再投入導線。
    expect(screen.getByRole('button', { name: /失敗行を CSV でダウンロード/ })).toBeInTheDocument();
  });

  it('一覧が空の時「招待がありません」を表示する', async () => {
    mockFetchInvites.mockResolvedValue([]);
    await renderScreen();
    expect(screen.getByText('招待がありません')).toBeInTheDocument();
  });

  // 背面ボタンは OverlayDialog 表示中アクセシビリティツリーから外れる（aria-modal）ため、
  // role 検索では引けない。DOM から直接引いて disabled を確認する（set-0117 項目1）。
  const bgButton = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it('招待発行オーバーレイ表示中は背面の操作ボタンと行操作を無効化する（set-0117 / set-0121）', async () => {
    await renderScreen();

    fireEvent.click(screen.getByRole('button', { name: '招待メールを発行' }));
    expect(bgButton('CSV インポート')).toBeDisabled();
    expect(bgButton('CSV テンプレートをダウンロード')).toBeDisabled();
    // 行操作も aria-modal 背面で role 検索外 → DOM 直参照
    expect(bgButton('tanaka@struct-pass.io をメール再送')).toBeDisabled();
    expect(bgButton('tanaka@struct-pass.io を削除')).toBeDisabled();
  });

  it('MEMBER ユーザーにはタイトルのみ示し一覧・フェッチを行わない（set-0057）', async () => {
    mockRole = 'MEMBER';
    await renderScreen();
    expect(screen.getByRole('heading', { name: '招待管理' })).toBeInTheDocument();
    expect(screen.queryByText('tanaka@struct-pass.io')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '招待メールを発行' })).not.toBeInTheDocument();
    expect(screen.queryByText(/このページはシステム管理者のみ/)).not.toBeInTheDocument();
    expect(mockFetchInvites).not.toHaveBeenCalled();
    expect(mockFetchMailStatus).not.toHaveBeenCalled();
    expect(mockFetchGroupSpaces).not.toHaveBeenCalled();
  });
});
