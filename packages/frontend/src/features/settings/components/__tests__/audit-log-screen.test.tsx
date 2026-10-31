import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { flush } from '@/test-utils/flush';
import { getListColumn, getListLayoutOrder } from '@/test-utils/list-layout';
import { AUDIT_PAGE_SIZE, type AuditLogDto, type PaginationMeta } from '@rete/shared';
import { AuditLogScreen } from '../audit-log-screen';

// ── API モック（audit-logs / tenant systems）─cmn-0142: vi.hoisted 化─
const { mockFetchAuditLogs, mockDownloadCsv, mockFetchTenantSystems, mockToastError } = vi.hoisted(
  () => ({
    mockFetchAuditLogs: vi.fn(),
    mockDownloadCsv: vi.fn(),
    mockFetchTenantSystems: vi.fn(),
    mockToastError: vi.fn(),
  }),
);
vi.mock('../../lib/audit-logs-api', () => ({
  fetchAuditLogs: (query: unknown) => mockFetchAuditLogs(query),
  downloadAuditLogsCsv: (query: unknown) => mockDownloadCsv(query),
}));

vi.mock('../../lib/api', () => ({
  fetchTenantSystems: () => mockFetchTenantSystems(),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: (m: string) => mockToastError(m) },
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

// ── フィクスチャ ──
const systems = [
  { id: 'SYS-001', name: '在庫管理', isRete: false, enabled: true },
  { id: 'SYS-002', name: '受発注', isRete: false, enabled: true },
];

const log = (over: Partial<AuditLogDto>): AuditLogDto => ({
  id: 'a1',
  actorName: '田中 太郎',
  actorEmail: 'tanaka@rete.local',
  systemName: '在庫管理',
  actionType: 'login',
  feature: 'ログイン',
  summary: 'ログインに成功しました',
  ipAddress: '192.0.2.1',
  createdAt: '2026-06-10T01:23:45.000Z',
  ...over,
});

const l1 = log({
  id: 'a1',
  actorName: '田中 太郎',
  actorEmail: 'tanaka@rete.local',
  actionType: 'login',
});
const l2 = log({
  id: 'a2',
  actorName: '山田 太郎',
  actorEmail: 'taro@rete.local',
  systemName: '受発注',
  actionType: 'update',
  feature: 'メンバー編集',
  summary: 'ロールを変更しました',
});

const meta = (over: Partial<PaginationMeta> = {}): PaginationMeta => ({
  total: 2,
  page: 1,
  limit: 20,
  totalPages: 1,
  ...over,
});

async function renderScreen() {
  render(<AuditLogScreen />);
  await flush();
}

describe('AuditLogScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchAuditLogs.mockResolvedValue({ data: [l1, l2], meta: meta() });
    mockFetchTenantSystems.mockResolvedValue(systems);
  });

  it('操作ログ一覧（ユーザー名・操作ラベル）を描画する', async () => {
    await renderScreen();
    expect(screen.getByText('田中 太郎')).toBeInTheDocument();
    expect(screen.getByText('山田 太郎')).toBeInTheDocument();
    // 操作ラベルは AUDIT_ACTION_LABELS 由来（login=ログイン / update=更新）。
    // 同ラベルは操作種別フィルタの option にも出るため、行バッジ分を含めて 1 件以上で検証する。
    expect(screen.getAllByText('ログイン').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('更新').length).toBeGreaterThanOrEqual(1);
  });

  it('メールアドレス列は無く、内容列にもメールを出さず summary のみ（set-0081）', async () => {
    const { container } = render(<AuditLogScreen />);
    await flush();
    // 独立した「メールアドレス」ヘッダは出さない。
    expect(screen.queryByRole('columnheader', { name: 'メールアドレス' })).not.toBeInTheDocument();
    // 内容列ヘッダは残る。
    expect(screen.getByRole('columnheader', { name: '内容' })).toBeInTheDocument();
    // 内容列にメールは出さない（summary のみ）。
    expect(screen.queryByText('tanaka@rete.local')).not.toBeInTheDocument();
    expect(screen.queryByText('taro@rete.local')).not.toBeInTheDocument();
    expect(screen.getByText('ログインに成功しました')).toBeInTheDocument();
    // ヘッダ列数 6（メール列削除後）。空行 colSpan は別 it で検証。
    const headers = container.querySelectorAll('thead th');
    expect(headers).toHaveLength(6);
  });

  it('初回ロードで limit=20・cursor/direction 無指定のクエリで fetchAuditLogs を呼ぶ', async () => {
    await renderScreen();
    expect(mockFetchAuditLogs).toHaveBeenCalledTimes(1);
    expect(mockFetchAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, direction: undefined, cursor: undefined }),
    );
  });

  // d756: 画面が問い合わせる件数はサーバーの既定と同じ共有定数を読む（画面側に写しを置かない）。
  it('問い合わせる limit は共有定数 AUDIT_PAGE_SIZE と一致する', async () => {
    await renderScreen();
    expect(mockFetchAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ limit: AUDIT_PAGE_SIZE }),
    );
  });

  it('操作種別フィルタを変えると actionType 付き・カーソルリセットで再フェッチする', async () => {
    await renderScreen();
    mockFetchAuditLogs.mockClear();
    // mdl-0026: 絞り込みは native select → FilterChipSelect（チップ→listbox）へ移行。
    fireEvent.click(screen.getByRole('button', { name: '操作種別で絞り込み' }));
    fireEvent.click(screen.getByRole('option', { name: '更新' }));
    await flush();
    expect(mockFetchAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'update', direction: undefined, cursor: undefined }),
    );
  });

  it('検索入力でユーザー名フィルタ付き・カーソルリセットで再フェッチをする', async () => {
    await renderScreen();
    mockFetchAuditLogs.mockClear();
    fireEvent.change(screen.getByPlaceholderText('ユーザー名 / メールで検索...'), {
      target: { value: '田中' },
    });
    await flush();
    expect(mockFetchAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ search: '田中', direction: undefined, cursor: undefined }),
    );
  });

  it('システムフィルタの選択肢に契約システム + 共通操作を出す', async () => {
    await renderScreen();
    // mdl-0026: チップを開いて listbox の候補を検証する。
    fireEvent.click(screen.getByRole('button', { name: 'システムで絞り込み' }));
    const listbox = screen.getByRole('listbox', { name: 'システム' });
    expect(within(listbox).getByRole('option', { name: '在庫管理' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: '受発注' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: '共通操作（認証等）' })).toBeInTheDocument();
  });

  it('CSV 出力パネルを開いて期間指定でダウンロードすると downloadAuditLogsCsv を呼ぶ（set-0082）', async () => {
    mockDownloadCsv.mockResolvedValue(new Blob(['﻿ユーザー名\r\n'], { type: 'text/csv' }));
    const createUrl = vi.fn(() => 'blob:mock');
    const revokeUrl = vi.fn();
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV 出力' }));
    // set-0082 再設計: OverlayDialog（role=dialog）＋内側 region を維持。
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /CSV 出力/ })).toBeInTheDocument();
    // パネル内で期間を入れる。
    fireEvent.change(screen.getByLabelText('出力開始日'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText('出力終了日'), { target: { value: '2026-06-10' } });
    fireEvent.click(screen.getByRole('button', { name: '出力する' }));
    await flush();

    expect(mockDownloadCsv).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-06-01', to: '2026-06-10' }),
    );
    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    // 成功後はパネルが閉じる。
    expect(screen.queryByRole('region', { name: /CSV 出力/ })).not.toBeInTheDocument();
    clickSpy.mockRestore();
  });

  it('CSV 出力失敗時は backend のエラーメッセージを toast 表示する', async () => {
    mockDownloadCsv.mockRejectedValue({
      // v2-234: 共有 apiErrorMessage（axios.isAxiosError ガード付き）を通るため、fixture は実体どおり
      // axios エラー形（isAxiosError: true）で渡す。backend 文言が toast に載ることは従来どおり検証する。
      isAxiosError: true,
      response: { data: { error: { message: '一時的に出力できません' } } },
    });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });

    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV 出力' }));
    // set-0092 以降は 92 日超過は UI 側で非活性のため、上限内期間で API 失敗経路を見る
    fireEvent.change(screen.getByLabelText('出力開始日'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText('出力終了日'), { target: { value: '2026-06-10' } });
    fireEvent.click(screen.getByRole('button', { name: '出力する' }));
    await flush();

    expect(mockToastError).toHaveBeenCalledWith('一時的に出力できません');
  });

  it('CSV パネルは✕を出さずキャンセルで閉じる・見出しは CSV 出力（操作ログ）（set-0085 / set-0086）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV 出力' }));
    expect(screen.queryByRole('button', { name: '閉じる' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'CSV 出力（操作ログ）' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('region', { name: /CSV/ })).not.toBeInTheDocument();
  });

  it('CSV パネルは旧段落説明を出さず、注意書きは3点の箇条書きで示す（set-0083 / set-0112 / set-0117）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV 出力' }));
    // set-0083: 旧段落は出さない
    expect(screen.queryByText(/出力対象の期間（最大/, { exact: false })).not.toBeInTheDocument();
    // set-0112: BOM の記載は出さない。set-0117 項目5: 保持期間（12ヶ月）の開示は戻す。
    const notes = document.querySelector('[data-csv-export-notes]');
    expect(notes).not.toBeNull();
    expect(notes?.textContent).toMatch(/最大\s*92\s*日/);
    expect(notes?.textContent).toMatch(/絞り込み条件/);
    expect(notes?.textContent).toMatch(/保持期間は\s*12\s*ヶ月/);
    expect(notes?.querySelectorAll('li')).toHaveLength(3);
    expect(notes?.textContent).not.toMatch(/UTF-8 BOM/);
  });

  it('PageTitle 説明と SummaryGrid 4枚は出さない（set-0088 / set-0089）', async () => {
    await renderScreen();
    expect(screen.getByRole('heading', { name: '操作ログ' })).toBeInTheDocument();
    expect(screen.queryByText(/テナント全体の監査ログ/, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText('該当ログ件数')).not.toBeInTheDocument();
    expect(screen.queryByText('表示ページ')).not.toBeInTheDocument();
    expect(screen.queryByText('CSV 出力上限')).not.toBeInTheDocument();
    expect(screen.queryByText('保存期間')).not.toBeInTheDocument();
  });

  it('件数表示は設定タブ共通の「全 N 件」語彙（set-0150）', async () => {
    await renderScreen();
    // 語彙だけを揃える変更で、件数の意味（絞り込み条件を適用した後の総件数）は変えていない。
    expect(screen.getByText('全 2 件')).toBeInTheDocument();
  });

  it('CSV 期間が92日超過だと出力日数表示とダウンロード非活性（set-0092）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV 出力' }));
    fireEvent.change(screen.getByLabelText('出力開始日'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('出力終了日'), { target: { value: '2026-06-10' } });
    const count = document.querySelector('[data-csv-export-day-count]');
    expect(count?.textContent).toMatch(/出力日数/);
    expect(count?.textContent).toMatch(/超過/);
    expect(screen.getByRole('button', { name: '出力する' })).toBeDisabled();
  });

  it('CSV 期間が上限内ならダウンロード可能・出力日数を表示（set-0092）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV 出力' }));
    fireEvent.change(screen.getByLabelText('出力開始日'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText('出力終了日'), { target: { value: '2026-06-10' } });
    const count = document.querySelector('[data-csv-export-day-count]');
    expect(count?.textContent).toMatch(/出力日数\s*10\s*日/);
    expect(screen.getByRole('button', { name: '出力する' })).not.toBeDisabled();
  });

  it('「CSV 出力」は絞り込み帯の外の独立行にあり、出力パネルはその直後に開く（set-0152）', async () => {
    const { container } = render(<AuditLogScreen />);
    await flush();
    const action = screen.getByRole('button', { name: 'CSV 出力' });
    expect(action.closest('.sp-filter-bar')).toBeNull();
    const row = action.closest('.sp-list-action-row');
    expect(row).not.toBeNull();
    // 検索窓は帯の中に残る（帯側のクラス名が変わって「常に null」で緑になる形を防ぐ対比）。
    expect(
      screen.getByPlaceholderText('ユーザー名 / メールで検索...').closest('.sp-filter-bar'),
    ).not.toBeNull();
    // 並び順は 帯 → アクション行 → 表（set-0150 で共通ヘルパへ抜き、メンバー / 招待にも適用）。
    expect(getListLayoutOrder(container)).toEqual(['sp-filter-bar', 'sp-list-action-row', 'table']);
    // 出力パネルは set-0082 で OverlayDialog（画面中央のオーバーレイ）へ再設計済みで、
    // ボタンの真下に開くインライン panel ではない。移設後もボタンから開けることだけを確かめる。
    fireEvent.click(action);
    expect(screen.getByRole('region', { name: /CSV 出力/ })).toBeInTheDocument();
    // パネルを開いてもアクション行は残る（オーバーレイ表示で行ごと差し替わらない）。
    // 開いている間はダイアログ外が aria-hidden になるため、role 経由ではなく DOM から取り直す。
    const rowAfterOpen = container.querySelector('.sp-list-action-row');
    expect(rowAfterOpen).not.toBeNull();
    expect(rowAfterOpen!.querySelector('button[aria-label="CSV 出力"]')).not.toBeNull();
  });

  it('CSV 出力の行と表が同じ幅の列に収まる（v2-180）', async () => {
    const { container } = render(<AuditLogScreen />);
    await flush();
    const column = getListColumn(container);
    // 表だけを絞ると右寄せの CSV 出力が表の右端から外れる（実測 253px ずれ）ため、行と表を同じ枠へ入れる。
    expect(column?.style.maxWidth).toBe('900px');
    expect(column?.contains(container.querySelector('table'))).toBe(true);
  });

  it('フィルタ帯は左寄せ既定で、中央寄せクラスを持たない（v2-184。set-0087 の中央寄せを撤回）', async () => {
    const { container } = render(<AuditLogScreen />);
    await flush();
    const bar = container.querySelector('.sp-filter-bar');
    expect(bar).not.toBeNull();
    // 中央寄せの分岐（align prop / .sp-filter-bar--center）は撤去済み。帯は既定の左寄せのみ。
    expect(bar?.classList.contains('sp-filter-bar--center')).toBe(false);
    // 帯は表の 900px 枠（v2-180 の列）の外にあり、左端はページ左端＝表カード左端と一致する。
    // 中央寄せだった時は帯の幅いっぱいの中央に子が並び、先頭コントロールが 204.7px 右へずれていた（実測）。
    expect(getListColumn(container)?.contains(bar as Node)).toBe(false);
  });

  it('検索キーワード指定時、一覧のユーザー名・メールセルの一致箇所を sp-search-hl でハイライトする（set-0055）', async () => {
    const { container } = render(<AuditLogScreen />);
    await flush();
    fireEvent.change(screen.getByPlaceholderText('ユーザー名 / メールで検索...'), {
      target: { value: '田中' },
    });
    await flush();
    const marks = container.querySelectorAll('mark.sp-search-hl');
    expect(marks.length).toBeGreaterThanOrEqual(1);
    expect(marks[0].textContent).toBe('田中');
  });

  it('検索キーワード未指定はハイライトしない（set-0055）', async () => {
    const { container } = render(<AuditLogScreen />);
    await flush();
    expect(container.querySelectorAll('mark.sp-search-hl').length).toBe(0);
  });

  it('該当ログ 0 件のとき空表示メッセージを出す', async () => {
    mockFetchAuditLogs.mockResolvedValue({ data: [], meta: meta({ total: 0, totalPages: 1 }) });
    const { container } = render(<AuditLogScreen />);
    await flush();
    expect(screen.getByText('操作ログがありません')).toBeInTheDocument();
    // set-0081: 列削除後 colSpan=6 で中央表示がずれないこと
    const emptyCell = container.querySelector('td[colspan="6"]');
    expect(emptyCell).not.toBeNull();
    expect(emptyCell?.textContent).toContain('操作ログがありません');
  });

  it('読み込み失敗時は、toast に加えて一覧の領域内に失敗を残す（d592）', async () => {
    mockFetchAuditLogs.mockRejectedValue(new Error('network'));
    await renderScreen();
    expect(mockToastError).toHaveBeenCalledWith('操作ログの読み込みに失敗しました');
    // 0 件の文言で失敗を隠さない（領域内の role="alert" に残す・正本 ui.ts:109）。
    expect(screen.getByRole('alert')).toHaveTextContent('操作ログの読み込みに失敗しました');
    expect(screen.queryByText('操作ログがありません')).not.toBeInTheDocument();
  });

  // d659: 取得失敗の表示から、失敗したページのカーソルに依存せず先頭から取り直す。
  it('取得失敗の表示に再試行を添え、押すと取り直して失敗の表示を消す（d659）', async () => {
    mockFetchAuditLogs.mockRejectedValueOnce(new Error('network'));
    mockFetchAuditLogs.mockResolvedValue({
      data: [],
      meta: { total: 0, hasNext: false, hasPrev: false },
      cursors: {},
    });
    await renderScreen();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('操作ログの読み込みに失敗しました');
    fireEvent.click(within(alert).getByRole('button', { name: '再試行' }));
    await flush();

    expect(mockFetchAuditLogs).toHaveBeenCalledTimes(2);
    // 先頭ページ・先頭カーソルで取り直す（失敗したページのカーソルを引き継がない）。
    expect(mockFetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: undefined }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('操作ログがありません')).toBeInTheDocument();
  });

  it('失敗の後に再取得が通れば、失敗の表示は消える（d592）', async () => {
    mockFetchAuditLogs.mockRejectedValueOnce(new Error('network'));
    mockFetchAuditLogs.mockResolvedValue({
      data: [],
      meta: { total: 0, hasNext: false, hasPrev: false },
      cursors: {},
    });
    await renderScreen();
    expect(screen.getByRole('alert')).toHaveTextContent('操作ログの読み込みに失敗しました');
    // 再取得（検索語の変更）で通ったら、失敗の表示は 0 件の表示へ戻る。
    fireEvent.change(screen.getByPlaceholderText('ユーザー名 / メールで検索...'), {
      target: { value: 'x' },
    });
    await flush();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('MEMBER ユーザーにはタイトルのみ示し一覧・フェッチを行わない（set-0057）', async () => {
    mockRole = 'MEMBER';
    await renderScreen();
    expect(screen.getByRole('heading', { name: '操作ログ' })).toBeInTheDocument();
    expect(screen.queryByText('田中 太郎')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'CSV 出力' })).not.toBeInTheDocument();
    expect(screen.queryByText(/このページはシステム管理者のみ/)).not.toBeInTheDocument();
    expect(mockFetchAuditLogs).not.toHaveBeenCalled();
    expect(mockFetchTenantSystems).not.toHaveBeenCalled();
  });

  it('実行日時ヘッダは inline 右寄せを持たず中央寄せを継承し、日時セルは右寄せ・nowrap・tabular-nums を維持する（set-0183）', async () => {
    const { container } = render(<AuditLogScreen />);
    await flush();

    // 実行日時ヘッダ: inline textAlign を持たない（globals.css の central 寄せを継承）。
    const header = Array.from(container.querySelectorAll('thead th')).find(
      (th) => th.textContent === '実行日時',
    );
    expect(header).toBeDefined();
    expect((header as HTMLElement).style.textAlign).toBe('');

    // 実行日時 data cell: 右寄せ・nowrap・tabular-nums を維持する。
    const dtCell = container.querySelector('tbody td:last-of-type');
    expect(dtCell).not.toBeNull();
    expect((dtCell as HTMLElement).style.textAlign).toBe('right');
    expect((dtCell as HTMLElement).style.whiteSpace).toBe('nowrap');
    expect((dtCell as HTMLElement).style.fontVariantNumeric).toBe('tabular-nums');
  });

  // ── v2-185: 期間は1つのピッカー（連続2ヶ月）で入力する（要求版2）──
  // 月は初期値（未設定なら実行時の当月）から決まるため、日を特定する検査は実行時の当月・翌月の
  // 日付ラベルを組み立てて指す（5日・10日はどの月にも存在する）。
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  const ymdOf = (d: Date, day: number) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(day)}`;
  const dayLabel = (d: Date, day: number) => `${d.getFullYear()}年${d.getMonth() + 1}月${day}日`;
  const monthGrids = () =>
    Array.from(
      screen
        .getByRole('group', { name: '期間のカレンダー' })
        .querySelectorAll('.sp-daterange-month'),
    ) as HTMLElement[];

  it('期間の欄はボタンになり、どちらの欄から開いても1つのピッカーに2ヶ月が出る（v2-185 要求版2）', async () => {
    await renderScreen();
    const fromTrigger = screen.getByRole('button', { name: '開始日' });
    expect(fromTrigger).toHaveAttribute('aria-haspopup', 'dialog');

    fireEvent.click(fromTrigger);
    expect(screen.getByRole('dialog', { name: '期間の範囲' })).toBeInTheDocument();
    expect(screen.getAllByRole('group', { name: '期間のカレンダー' })).toHaveLength(1);
    expect(monthGrids()).toHaveLength(2);
    expect(
      monthGrids().map((m) => m.querySelector('.sp-daterange-cal-title')?.textContent),
    ).toEqual([
      `${now.getFullYear()}年${now.getMonth() + 1}月`,
      `${next.getFullYear()}年${next.getMonth() + 1}月`,
    ]);

    // Esc で閉じ、終了日側から開き直しても同じ1つのピッカーが出る。
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '期間の範囲' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '終了日' }));
    expect(screen.getAllByRole('group', { name: '期間のカレンダー' })).toHaveLength(1);
  });

  it('1回目で開始日・2回目（翌月）で終了日が入り、from / to 付きで再取得する（v2-185 要求版2）', async () => {
    await renderScreen();
    mockFetchAuditLogs.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '開始日' }));
    fireEvent.click(within(monthGrids()[0]).getByRole('button', { name: dayLabel(now, 10) }));
    await flush();
    expect(screen.getByRole('button', { name: '開始日' })).toHaveTextContent(
      `${now.getFullYear()}/${pad(now.getMonth() + 1)}/10`,
    );
    expect(mockFetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: ymdOf(now, 10),
        to: undefined,
        direction: undefined,
        cursor: undefined,
      }),
    );

    fireEvent.click(within(monthGrids()[1]).getByRole('button', { name: dayLabel(next, 5) }));
    await flush();
    expect(screen.getByRole('button', { name: '終了日' })).toHaveTextContent(
      `${next.getFullYear()}/${pad(next.getMonth() + 1)}/05`,
    );
    expect(mockFetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: ymdOf(now, 10), to: ymdOf(next, 5) }),
    );
  });

  it('「上限を設定」で終了日が 9999/12/31 になり、開始日で再取得する（v2-185）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: '開始日' }));
    fireEvent.click(within(monthGrids()[0]).getByRole('button', { name: dayLabel(now, 10) }));
    await flush();
    mockFetchAuditLogs.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '上限を設定' }));
    await flush();

    expect(screen.getByRole('button', { name: '終了日' })).toHaveTextContent('9999/12/31');
    expect(screen.getByRole('button', { name: '開始日' })).toHaveTextContent(
      `${now.getFullYear()}/${pad(now.getMonth() + 1)}/10`,
    );
    expect(mockFetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: ymdOf(now, 10), to: '9999-12-31' }),
    );
  });

  it('「下限を設定」で開始日が 1900/01/01 になる（v2-185）', async () => {
    await renderScreen();
    mockFetchAuditLogs.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '開始日' }));
    fireEvent.click(screen.getByRole('button', { name: '下限を設定' }));
    await flush();

    expect(screen.getByRole('button', { name: '開始日' })).toHaveTextContent('1900/01/01');
    expect(mockFetchAuditLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '1900-01-01', to: undefined }),
    );
  });

  it('CSV 出力パネルの期間欄は native の日付入力のまま（v2-185 の対象外）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV 出力' }));
    const csvFrom = screen.getByLabelText('出力開始日');
    expect(csvFrom.tagName).toBe('INPUT');
    expect(csvFrom).toHaveAttribute('type', 'date');
    fireEvent.change(csvFrom, { target: { value: '2026-06-01' } });
    expect((csvFrom as HTMLInputElement).value).toBe('2026-06-01');
  });

  it('出力パネルの日付欄の見えるラベルも読み上げ名と同じ「出力開始日 / 出力終了日」（d536）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV 出力' }));
    // 絞り込み帯の期間欄（開始日 / 終了日）と同じ画面に出るため、見えるラベルも「出力」を冠して区別する。
    expect(screen.getByText('出力開始日', { selector: 'label' })).toBeInTheDocument();
    expect(screen.getByText('出力終了日', { selector: 'label' })).toBeInTheDocument();
    expect(screen.queryByText('開始日', { selector: 'label' })).not.toBeInTheDocument();
    expect(screen.queryByText('終了日', { selector: 'label' })).not.toBeInTheDocument();
  });

  it('出力中は「出力する」が載り、画面上の「CSV 出力」と読み上げ名が重ならない（d536）', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'CSV 出力' }));
    const apply = screen.getByRole('button', { name: '出力する' });
    expect(apply).toBeInTheDocument();
    // パネルを開いた状態で「ダウンロード」という名前のボタンは無い（何を押すかが一意になる）。
    expect(screen.queryByRole('button', { name: 'ダウンロード' })).not.toBeInTheDocument();
  });

  it('取得失敗のとき件数表示は「全 — 件」で、0 件の一覧と読めてしまわない（d536）', async () => {
    mockFetchAuditLogs.mockRejectedValue(new Error('network'));
    await renderScreen();
    expect(screen.getByRole('alert')).toHaveTextContent('操作ログの読み込みに失敗しました');
    // 失敗を「全 0 件」と出すと、本当に 0 件の一覧と読み分けられない。
    expect(screen.getByText('全 — 件')).toBeInTheDocument();
    expect(screen.queryByText('全 0 件')).not.toBeInTheDocument();
  });

  // ── d652: ページ取得中に続けて移動を押すと、同じカーソルで取り直して行が変わらないまま
  // ページ番号だけ進み、末尾の行へ届かなくなる（41 件 / 20 件表示のとき 3/3 が 21〜40 行目になる）──
  describe('取得中のページ移動は押し込めない（d652）', () => {
    type Page = {
      data: AuditLogDto[];
      meta: PaginationMeta;
      cursors: { next: string | null; prev: string | null };
    };
    const row = (id: number) => log({ id: `a${id}`, actorName: `利用者 ${id}` });
    const pages: Record<string, Page> = {
      first: {
        data: Array.from({ length: 20 }, (_, i) => row(i + 1)),
        meta: meta({ total: 41, page: 1, totalPages: 3 }),
        cursors: { next: 'C-NEXT-1', prev: null },
      },
      'C-NEXT-1': {
        data: Array.from({ length: 20 }, (_, i) => row(i + 21)),
        meta: meta({ total: 41, page: 2, totalPages: 3 }),
        cursors: { next: 'C-NEXT-2', prev: 'C-PREV-2' },
      },
      'C-NEXT-2': {
        data: [row(41)],
        meta: meta({ total: 41, page: 3, totalPages: 3 }),
        cursors: { next: null, prev: 'C-PREV-3' },
      },
      last: {
        data: [row(41)],
        meta: meta({ total: 41, page: 3, totalPages: 3 }),
        cursors: { next: null, prev: 'C-PREV-3' },
      },
    };
    /**
     * カーソルで該当ページを返す。defer を渡すと、渡したカーソルの問い合わせだけ手動で解決するまで
     * 待たせる（その前の 1 ページ目はすぐ返る＝画面が動いてから次の移動が押せる状況を作る）。
     * defer を渡さない時は待ちを外す。
     */
    function servePages(defer?: { key: string; resolve: () => void; promise: Promise<void> }) {
      mockFetchAuditLogs.mockImplementation(
        async (query: { cursor?: string; direction?: string }) => {
          // 先頭は 'first' で表す（カーソル無しの初回と、先頭へ戻す問い合わせを同じページにする）。
          const key = query.direction === 'last' ? 'last' : (query.cursor ?? 'first');
          const page = pages[key];
          if (defer && defer.key === key) await defer.promise;
          return page;
        },
      );
    }
    function deferResponse(key: string) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { key, resolve, promise };
    }
    const pageLabel = () => screen.getByText(/\d+ \/ 3 page/).textContent;
    const nextButton = () => screen.getByRole('button', { name: '次のページ' });
    const firstButton = () => screen.getByRole('button', { name: '先頭ページ' });

    it('取得中の「次のページ」は押せず、押しても同じ位置から取り直さない', async () => {
      servePages();
      await renderScreen();
      expect(pageLabel()).toBe('1 / 3 page');
      expect(nextButton()).toBeEnabled();

      // 2 ページ目の応答が遅れて届く状況を作る。
      const defer = deferResponse('C-NEXT-1');
      servePages(defer);
      fireEvent.click(nextButton());
      fireEvent.click(nextButton());

      // 取得中は続けて押せない（押し込みで同じカーソルから取り直さない）。
      expect(nextButton()).toBeDisabled();
      defer.resolve();
      await flush();

      expect(pageLabel()).toBe('2 / 3 page');
      expect(screen.getByText('利用者 21')).toBeInTheDocument();
      // 取り直しは 1 回だけ（next のカーソル指定で 1 件目 → 2 件目）。
      const nextCalls = mockFetchAuditLogs.mock.calls.filter(
        (call: unknown[]) => (call[0] as { cursor?: string }).cursor === 'C-NEXT-1',
      );
      expect(nextCalls).toHaveLength(1);
    });

    it('次で 2 ページ目・3 ページ目まで辿ると末尾の行（41 行目）へ届く', async () => {
      servePages();
      await renderScreen();

      fireEvent.click(nextButton());
      await flush();
      expect(pageLabel()).toBe('2 / 3 page');

      fireEvent.click(nextButton());
      await flush();
      expect(pageLabel()).toBe('3 / 3 page');
      expect(screen.getByText('利用者 41')).toBeInTheDocument();
      // 最終ページでは「次のページ」「最終ページ」とも押せない。
      expect(nextButton()).toBeDisabled();
      expect(screen.getByRole('button', { name: '最終ページ' })).toBeDisabled();
    });

    it('「最終ページ」は最後の応答の後に番号を合わせ、取得中は押せない', async () => {
      servePages();
      await renderScreen();
      const lastButton = () => screen.getByRole('button', { name: '最終ページ' });

      const defer = deferResponse('last');
      servePages(defer);
      fireEvent.click(lastButton());
      expect(lastButton()).toBeDisabled();
      defer.resolve();
      await flush();

      expect(pageLabel()).toBe('3 / 3 page');
      expect(screen.getByText('利用者 41')).toBeInTheDocument();
    });

    it('取得中は前のページ・先頭ページも押せない（戻し込みで位置をずらさない）', async () => {
      servePages();
      await renderScreen();
      fireEvent.click(nextButton());
      await flush();
      expect(pageLabel()).toBe('2 / 3 page');

      const defer = deferResponse('first');
      servePages(defer);
      fireEvent.click(screen.getByRole('button', { name: '前のページ' }));
      await act(async () => {});
      // 取得中は、前のページ・先頭ページとも押せない（待つ間に押しても位置をずらさない）。
      expect(screen.getByRole('button', { name: '前のページ' })).toBeDisabled();
      expect(firstButton()).toBeDisabled();
      // 投げた問い合わせは「初回」「2 ページ目」「1 ページ目へ戻る（2 ページ目が持つ戻りカーソル）」
      // の 3 回だけ。押し直しで同じカーソルの取り直しは起きていない。
      await flush();
      expect(
        mockFetchAuditLogs.mock.calls.map(
          (call: unknown[]) => (call[0] as { cursor?: string }).cursor,
        ),
      ).toEqual([undefined, 'C-NEXT-1', 'C-PREV-2']);
      // 応答を待つ間も、まだ問い合わせが返っていない（押し直しの取り直しは起きていない）。
      expect(mockFetchAuditLogs).toHaveBeenCalledTimes(3);
      defer.resolve();
      await flush();
      // 戻り先（1 ページ目）に辿り着き、そこで止まる（押し込みで別の位置を要求していない）。
      await act(async () => {});
      expect(mockFetchAuditLogs).toHaveBeenCalledTimes(3);
    });
  });

  it('成功時の件数表示は従来どおり「全 N 件」のまま（取得失敗の分岐が通常時へ漏れない）（d536）', async () => {
    await renderScreen();
    expect(screen.getByText('全 2 件')).toBeInTheDocument();
    expect(screen.queryByText('全 — 件')).not.toBeInTheDocument();
  });
});
