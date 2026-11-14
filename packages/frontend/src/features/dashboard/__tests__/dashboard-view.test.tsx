import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { flush } from '@/test-utils/flush';
import { Role } from '@rete/shared';
import { DashboardView } from '../components/dashboard-view';
import type { UseTagMasterResult } from '@/hooks/use-tag-master';
import type { AnnouncementSummary, AnnouncementDetail } from '../lib/api';

// cmn-0142: vi.hoisted 化
const {
  mockUser,
  mockCreate,
  mockUpdate,
  mockRemove,
  mockReorder,
  mockMarkReadLocal,
  mockDecrement,
  mockFetchDetail,
} = vi.hoisted(() => ({
  mockUser: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockRemove: vi.fn(),
  mockReorder: vi.fn(),
  mockMarkReadLocal: vi.fn(),
  mockDecrement: vi.fn(),
  mockFetchDetail: vi.fn(),
}));
// totalPages はテストごとに差し替え可能にする（D&D グリップは単一ページ時のみ出る gating の検証用・let 維持）
let mockTotalPages = 1;

// RichTextEditor は Tiptap（jsdom 非対応の measure 系）を含むため、編集オーバーレイのテスト用に
// テキストエリアの最小スタブへ差し替える（onChange だけ通せれば作成/保存は検証可能）。
vi.mock('@/features/desk/components/rich-text-editor', () => ({
  RichTextEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (html: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('@/features/auth/hooks/use-session', () => ({
  useSession: () => ({ user: mockUser(), loading: false }),
}));

vi.mock('../hooks/home-permissions-context', () => ({
  useHomePermissions: () => ({
    boardEdit: mockUser()?.role === Role.ADMIN,
    faqEdit: mockUser()?.role === Role.ADMIN,
    calendarEdit: false,
    tagManage: false,
    refresh: vi.fn(),
  }),
}));

// hom-0062 回帰: 複数タグが一覧行で全て描画されることを固定する fixture（2つ目以降が落ちないことの保証）。
const twoTags = [
  { id: 't1', name: '全体周知', icon: 'megaphone', color: '#3b82f6', archived: false },
  { id: 't2', name: '最新情報', icon: 'sparkles', color: '#ec4899', archived: false },
];

// rete-home-0043: tags フィールドを追加（AnnouncementSummary の必須フィールド）。hom-0054: important/isNew 廃止。
const items: AnnouncementSummary[] = [
  {
    id: 'a1',
    title: '重要なお知らせ',
    publishedAt: '2026-06-01T09:30:00.000Z',
    author: '田中 太郎',
    excerpt: '重要なお知らせの概要テキスト',
    unread: true,
    tags: [],
  },
  // hom-0062 回帰: a2 に複数タグを付与し、一覧行で 2 チップが全て出ることを検証する（2つ目の欠落防止）。
  {
    id: 'a2',
    title: '通常のお知らせ',
    publishedAt: '2026-05-20T08:00:00.000Z',
    author: '田中 太郎',
    excerpt: '通常のお知らせの概要テキスト',
    unread: false,
    tags: twoTags,
  },
];

// totalPages はテストごとに差し替え可能にする（D&D グリップは単一ページ時のみ出る gating の検証用・let 維持）
vi.mock('../hooks/use-announcements', () => ({
  useAnnouncements: () => ({
    items,
    total: 2,
    page: 1,
    totalPages: mockTotalPages,
    limit: 20,
    setPage: vi.fn(),
    loading: false,
    error: null,
    refetch: vi.fn(),
    create: mockCreate,
    update: mockUpdate,
    remove: mockRemove,
    reorder: mockReorder,
    markReadLocal: mockMarkReadLocal,
  }),
}));

vi.mock('../hooks/announcement-unread-context', () => ({
  useAnnouncementUnread: () => ({
    unreadCount: 1,
    loading: false,
    decrement: mockDecrement,
    refresh: vi.fn(),
  }),
}));

// rete-home-0043: tags フィールドを追加（AnnouncementDetail の必須フィールド）。hom-0054: important/isNew 廃止。
const detail: AnnouncementDetail = {
  id: 'a1',
  title: '重要なお知らせ',
  publishedAt: '2026-06-01T09:30:00.000Z',
  author: '田中 太郎',
  body: '<p>本文です</p>',
  attachments: [],
  // hom-0062 回帰: 詳細ペインでも複数タグが全て描画されることを固定する。
  tags: twoTags,
};
vi.mock('../hooks/use-announcement-detail', () => ({
  useAnnouncementDetail: () => ({ detail, loading: false, error: null, refetch: vi.fn() }),
}));

// hom-0073: タグマスタは AnnouncementTagMasterProvider（Context）から取得するよう変更。
// DashboardView は props ではなく useAnnouncementTagMasterContext() を直接呼ぶため、hook をモックする。
const stubTagMaster: UseTagMasterResult = {
  tags: [],
  loading: false,
  error: false,
  mutating: false,
  lastError: null,
  reload: async () => {},
  create: async () => true,
  update: async () => true,
  remove: async () => true,
};
vi.mock('../hooks/announcement-tag-master-context', () => ({
  useAnnouncementTagMasterContext: () => ({ board: stubTagMaster, faq: stubTagMaster }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    fetchAnnouncementDetail: (id: string) => mockFetchDetail(id),
    // rete-home-0043: setAnnouncementTags のネットワーク呼び出しを抑止する。
    setAnnouncementTags: vi.fn().mockResolvedValue(undefined),
  };
});

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTotalPages = 1;
    mockUser.mockReturnValue({ id: 'u1', email: 'x@y.z', name: '田中 太郎', role: Role.ADMIN });
    mockFetchDetail.mockResolvedValue(detail);
  });

  it('一覧の通知タイトル・詳細本文を描画する', () => {
    render(<DashboardView />);
    // a1 は一覧 + 選択中の詳細ヘッダの 2 箇所に出る。a2 は一覧のみ。
    expect(screen.getAllByText('重要なお知らせ').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('通常のお知らせ')).toBeInTheDocument();
    // 詳細ペインに本文 HTML が描画される。
    expect(screen.getByText('本文です')).toBeInTheDocument();
  });

  it('複数タグを持つ通知は一覧行・詳細ペインの双方で全タグを描画する（2つ目以降が落ちない / hom-0062 回帰）', () => {
    render(<DashboardView />);
    // 一覧行（a2「通常のお知らせ」）に 2 タグが両方描画される（2つ目「最新情報」の欠落を防ぐ）。
    const listed = screen.getByRole('list', { name: '通知一覧' });
    expect(within(listed).getByText('全体周知')).toBeInTheDocument();
    expect(within(listed).getByText('最新情報')).toBeInTheDocument();
    // 詳細ペイン（自動選択された a1）にも 2 タグが両方描画される。
    // タグ名は一覧（a2）と詳細（a1）の両方に出るため、全体で各タグ名が 2 箇所以上に現れることを確認する。
    expect(screen.getAllByText('全体周知').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('最新情報').length).toBeGreaterThanOrEqual(2);
  });

  it('詳細ペイン最上部に作成者アバター・氏名・日時(HH:mm込み)を表示する（hom-0090）', () => {
    render(<DashboardView />);
    // detail.author='田中 太郎'。Avatar は頭文字（アバター配色は id ハッシュ由来で成立・aria-hidden）。
    // publishedAt が一覧側（a1）と同値のため、日付テキストは詳細ペイン（article）内に絞って確認する。
    const detailPane = document.querySelector('article')!;
    expect(within(detailPane).getAllByText('田中 太郎').length).toBeGreaterThanOrEqual(1);
    expect(within(detailPane).getByTestId('dashboard-detail-avatar')).toBeInTheDocument();
    // HH:mm はタイムゾーン依存のため年月日部分のみ固定して確認。
    expect(within(detailPane).getByText(/2026\/06\/01/)).toBeInTheDocument();
  });

  it('添付がある時は見出しを「ファイル」で表示する（hom-0090: 「添付ファイル」から変更）', () => {
    detail.attachments = [
      {
        id: 'att1',
        fileId: 'f1',
        fileName: 'sample.pdf',
        versionNo: 1,
        byteSize: 100,
        mimeType: 'application/pdf',
        attachedBy: '田中 太郎',
        createdAt: '2026-06-01T09:30:00.000Z',
      },
    ];
    try {
      render(<DashboardView />);
      expect(screen.getByText('ファイル')).toBeInTheDocument();
      expect(screen.queryByText('添付ファイル')).not.toBeInTheDocument();
    } finally {
      detail.attachments = [];
    }
  });

  it('0件へ絞り込んでも通知一覧を保持し、検索解除で行が戻る', async () => {
    render(<DashboardView kind="board" />);
    const list = screen.getByRole('list', { name: '通知一覧' });
    fireEvent.change(screen.getByLabelText('通知を検索'), {
      target: { value: '一致しない検索語' },
    });
    await flush();
    expect(screen.getByRole('list', { name: '通知一覧' })).toBe(list);
    expect(within(list).getByText('該当する通知はありません')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('通知を検索'), { target: { value: '' } });
    await flush();
    expect(screen.getByRole('list', { name: '通知一覧' })).toBe(list);
    expect(within(list).getByText('重要なお知らせ')).toBeInTheDocument();
  });

  it('検索でタイトル・概要に一致する通知だけを一覧に残す（クライアントフィルタ）', async () => {
    render(<DashboardView />);
    await flush();
    fireEvent.change(screen.getByPlaceholderText('タイトル・内容で検索...'), {
      target: { value: '通常' },
    });
    // a2 は一覧に残り、a1 は一覧から消える（詳細ヘッダの a1 は別ペインなので queryAllByText で一覧側のみ判定）。
    // hom-0110 以降、一致語がハイライトで別ノードに割れるため textContent 全体で判定する（getByText の
    // 文字列/正規表現一致は単一テキストノード前提で分割ノードにマッチしない）。
    const listed = screen.getByRole('list', { name: '通知一覧' });
    expect(
      within(listed).getByText(
        (_, el) =>
          el?.tagName === 'SPAN' &&
          el.className.includes('truncate') &&
          el.textContent === '通常のお知らせ',
      ),
    ).toBeInTheDocument();
    expect(within(listed).queryByText('重要なお知らせ')).not.toBeInTheDocument();
  });

  it('未読通知に未読インジケータを表示し、開く（選択）と既読化（decrement）を呼ぶ（HM-3・ADR 0029）', async () => {
    render(<DashboardView />);
    await flush();
    // a1（unread:true）は未読マークで未読を示す（d539: 文字の太さで未読/既読を分けず、行の太さは
    // 明細行の正本に従う。旧 rete-home-0036 の「太字へ一本化」は撤回し、行内の未読マークで示す）。
    const listed = screen.getByRole('list', { name: '通知一覧' });
    expect(within(listed).getAllByTestId('home-unread-dot')).toHaveLength(1);
    // 先頭 a1 が自動選択され「表示された = 既読」で decrement が走る。
    expect(mockMarkReadLocal).toHaveBeenCalledWith('a1');
    expect(mockDecrement).toHaveBeenCalled();
  });

  it('未読・既読ともタイトルの文字の太さは同じで、未読だけ印を付ける（d539・旧 rete-home-0011 の太字区別は撤回）', () => {
    render(<DashboardView />);
    const listed = screen.getByRole('list', { name: '通知一覧' });
    const unreadTitle = within(listed).getByText('重要なお知らせ');
    const readTitle = within(listed).getByText('通常のお知らせ');
    // タイトルは 0.8125rem のみで、太さは明細行の正本（.sp-row-title=500）に委ねる
    // （旧 font-semibold / font-normal は付かない・font-bold の持ち込みも許さない）。
    for (const title of [unreadTitle, readTitle]) {
      expect(title).toHaveClass('text-[0.8125rem]');
      expect(title).not.toHaveClass('font-semibold');
      expect(title).not.toHaveClass('font-normal');
      expect(title).not.toHaveClass('font-bold');
    }
    expect(within(listed).getAllByTestId('home-unread-dot')).toHaveLength(1);
  });

  it('既読（unread:false）の通知を開いても decrement を呼ばない', async () => {
    render(<DashboardView />);
    await flush();
    mockDecrement.mockClear();
    mockMarkReadLocal.mockClear();
    // a2 は unread:false。クリックしても既読化は走らない。
    // タイトル文言で行を選ぶ（並び替えグリップも title を aria-label に含むため、行選択ボタン本体＝
    // タイトルテキストノードをクリックして曖昧一致を避ける）。
    const listed = screen.getByRole('list', { name: '通知一覧' });
    fireEvent.click(within(listed).getByText('通常のお知らせ'));
    await flush();
    expect(mockMarkReadLocal).not.toHaveBeenCalled();
    expect(mockDecrement).not.toHaveBeenCalled();
  });

  it('ADMIN は登録・編集・削除の導線が出る', () => {
    render(<DashboardView />);
    expect(screen.getByRole('button', { name: '新規登録' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '編集' }).length).toBeGreaterThan(0);
    // 削除は詳細ペイン上部に出る（rete-home-0039: 行内アイコンから詳細ヘッダへ移設）。
    expect(screen.getAllByRole('button', { name: '削除' }).length).toBeGreaterThan(0);
  });

  it('非 ADMIN（MEMBER）は編集導線を一切出さない', () => {
    mockUser.mockReturnValue({ id: 'u2', email: 'm@y.z', name: '一般', role: Role.MEMBER });
    render(<DashboardView />);
    expect(screen.queryByRole('button', { name: '新規登録' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '編集' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument();
  });

  it('ADMIN・未フィルタ・単一ページでは各行に並び替えグリップを出す（H0021）', () => {
    render(<DashboardView />);
    // 行数分の「… を並び替え」グリップが出る（dndEnabled）。
    expect(screen.getByRole('button', { name: '重要なお知らせ を並び替え' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '通常のお知らせ を並び替え' })).toBeInTheDocument();
  });

  it('検索フィルタ中はグリップを出さない（部分集合の reorder を避ける / H0021）', async () => {
    render(<DashboardView />);
    await flush();
    fireEvent.change(screen.getByPlaceholderText('タイトル・内容で検索...'), {
      target: { value: '通常' },
    });
    expect(screen.queryByRole('button', { name: /を並び替え/ })).not.toBeInTheDocument();
  });

  it('並びは「検索フィルタ行 → 表直上のアクション行 → 表」で、Desk・設定一覧と同じ配置（d1273）', () => {
    const { container } = render(<DashboardView />);
    const children = Array.from(
      screen.getByLabelText('通知を検索').closest('.dashboard-shell')!.children,
    );
    const filterIndex = children.findIndex((el) => el.querySelector('.desk-filter-keyword'));
    const actionIndex = children.findIndex((el) => el.classList.contains('sp-list-action-row'));
    const tableIndex = children.findIndex((el) => el.classList.contains('grid'));
    // 3 段がこの順で並ぶ（ボタンは絞り込み帯に混ざらず、表の直上の独立行に居る）。
    expect(filterIndex).toBeGreaterThanOrEqual(0);
    expect(filterIndex).toBeLessThan(actionIndex);
    expect(actionIndex).toBeLessThan(tableIndex);
    // 行と表の間隔は 4px（cmn-0145）。フィルタエリア側に 12px を足して表から離す形にはしない。
    const actionRow = children[actionIndex] as HTMLElement;
    expect(actionRow.className).toContain('sp-list-action-row');
    expect(actionRow.querySelector('.sp-list-action-row-actions')).not.toBeNull();
    expect(container.querySelector('.desk-filter-bar')).toBeNull(); // 帯は箱で囲まない
  });

  it('権限でボタンが無くてもアクション行は残し、表の開始位置を動かさない（d1273）', () => {
    mockUser.mockReturnValue({ id: 'u2', email: 'm@y.z', name: '一般', role: Role.MEMBER });
    render(<DashboardView />);
    // 閲覧のみの人は新規登録ボタンが出ない。
    expect(screen.queryByRole('button', { name: '新規登録' })).not.toBeInTheDocument();
    // それでも行は描画される（行ごと消すと表の上端がずれる）。高さは CSS の min-height が保証する。
    const shell = screen.getByLabelText('通知を検索').closest('.dashboard-shell')!;
    const row = shell.querySelector('.sp-list-action-row');
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll('button')).toHaveLength(0);
  });

  it('段間トークンは 1 箇所でだけ定義する（src 配下の CSS を全部見て、値の写し・重複を作らない）', () => {
    // globals.css だけを見ると、別 CSS に複製された時に緑のままになる（独立レビュー指摘）。
    const srcRoot = join(__dirname, '../../..');
    const cssFiles = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.css'))
      .map((f) => join(srcRoot, f));
    expect(cssFiles.length).toBeGreaterThan(0);
    const definitions: string[] = [];
    for (const file of cssFiles) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/--sp-section-gap:\s*([^;]+);/g)) {
        definitions.push(`${relative(srcRoot, file).replaceAll('\\', '/')}:${m[1].trim()}`);
      }
    }
    // 定義は 1 件だけ・値は 0.75rem（12px）。増えたら写しが生まれている。
    expect(definitions).toEqual(['app/globals.css:0.75rem']);
    // 0.75rem が 12px であることも固定する（単位の取り違えを値の一致だけで通さない）。
    const globals = readFileSync(join(srcRoot, 'app/globals.css'), 'utf8');
    expect(globals).toContain('--sp-section-gap: 0.75rem;');
  });

  it('非 ADMIN（MEMBER）はグリップを出さない（reorder は ADMIN 限定 / H0021）', () => {
    mockUser.mockReturnValue({ id: 'u2', email: 'm@y.z', name: '一般', role: Role.MEMBER });
    render(<DashboardView />);
    expect(screen.queryByRole('button', { name: /を並び替え/ })).not.toBeInTheDocument();
  });

  it('複数ページある時はグリップを出さない（部分集合の reorder を避ける / H0021）', () => {
    // ページングで現在ページが全件の部分集合になるため、backend の「全件 id」契約を満たせず D&D を無効化する。
    mockTotalPages = 2;
    render(<DashboardView />);
    expect(screen.queryByRole('button', { name: /を並び替え/ })).not.toBeInTheDocument();
  });

  it('登録 → 右ペイン inline フォームで title 入力 → 保存 で create を呼ぶ', async () => {
    mockCreate.mockResolvedValue('new-1');
    render(<DashboardView />);

    fireEvent.click(screen.getByRole('button', { name: '新規登録' }));
    const form = screen.getByRole('form', { name: '通知の新規作成' });
    fireEvent.change(screen.getByPlaceholderText('通知のタイトル'), {
      target: { value: '新しい通知' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await flush();

    // rete-home-0043: tagIds は handleSubmit で取り出され、create には含まれない。
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ title: '新しい通知' }));
  });

  it('タイトル未入力では作成 API を呼ばない（必須バリデーション）', async () => {
    render(<DashboardView />);
    fireEvent.click(screen.getByRole('button', { name: '新規登録' }));
    const form = screen.getByRole('form', { name: '通知の新規作成' });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('検索キーワード指定時、一覧行タイトルの一致箇所を sp-search-hl でハイライトする（hom-0110）', async () => {
    render(<DashboardView />);
    await flush();
    fireEvent.change(screen.getByPlaceholderText('タイトル・内容で検索...'), {
      target: { value: '通常' },
    });
    const listed = screen.getByRole('list', { name: '通知一覧' });
    const marks = within(listed).getAllByText('通常', { selector: 'mark.sp-search-hl' });
    expect(marks.length).toBe(1);
  });

  it('検索キーワード未指定（空）は一覧行タイトルをハイライトしない（hom-0110）', () => {
    render(<DashboardView />);
    const listed = screen.getByRole('list', { name: '通知一覧' });
    expect(within(listed).queryByText('通常', { selector: 'mark' })).not.toBeInTheDocument();
  });

  it('検索キーワード指定時、詳細ペインのタイトル・本文の一致箇所をハイライトする（hom-0110）', async () => {
    detail.title = '通常タイトル';
    detail.body = '<p>通常の本文です</p>';
    try {
      render(<DashboardView />);
      await flush();
      fireEvent.change(screen.getByPlaceholderText('タイトル・内容で検索...'), {
        target: { value: '通常' },
      });
      await flush();
      const detailPane = document.querySelector('article')!;
      const marks = within(detailPane).getAllByText('通常', { selector: 'mark.sp-search-hl' });
      // タイトル(h3)+本文(RichTextView) の両方に 1 箇所ずつ現れる。
      expect(marks.length).toBe(2);
    } finally {
      detail.title = '重要なお知らせ';
      detail.body = '<p>本文です</p>';
    }
  });

  // hom-0124: ↑↓キーで選択行（hom-0133 以降は teal 内枠線=li.sp-row-ring）を移動する window keydown ナビ。
  // 詳細 hook はモック固定のため、選択の実体は li の sp-row-ring クラスで検証する。
  describe('キーボード↑↓ナビゲーション（hom-0124）', () => {
    const selectedTitle = () => document.querySelector('li.sp-row-ring')?.textContent ?? '';

    beforeEach(() => {
      // jsdom は scrollIntoView 未実装（選択追従スクロールで呼ばれる）。
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    });

    it('↓で選択が1行下へ移動し、末尾で↓は動かない（edge-stop・wrap しない）', async () => {
      render(<DashboardView />);
      await flush();
      expect(selectedTitle()).toContain('重要なお知らせ');
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(selectedTitle()).toContain('通常のお知らせ');
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(selectedTitle()).toContain('通常のお知らせ');
    });

    it('↑で選択が1行上へ戻り、先頭で↑は動かない（edge-stop）', async () => {
      render(<DashboardView />);
      await flush();
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(selectedTitle()).toContain('通常のお知らせ');
      fireEvent.keyDown(window, { key: 'ArrowUp' });
      expect(selectedTitle()).toContain('重要なお知らせ');
      fireEvent.keyDown(window, { key: 'ArrowUp' });
      expect(selectedTitle()).toContain('重要なお知らせ');
    });

    it('検索欄フォーカス中・ボタンフォーカス中は↑↓で選択が動かない', async () => {
      render(<DashboardView />);
      await flush();
      screen.getByLabelText('通知を検索').focus();
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(selectedTitle()).toContain('重要なお知らせ');
      screen.getByRole('button', { name: /新規登録/ }).focus();
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(selectedTitle()).toContain('重要なお知らせ');
    });

    // hom-0125: 絞り込みで選択行（selectedId）が visibleItems から外れた（currentIdx===-1）時の
    // edge-snap 救済。既存 fixture（a1/a2）だけでは先頭/末尾の区別が付かないため a3 を一時追加する。
    const a3: AnnouncementSummary = {
      id: 'a3',
      title: '通常の続報',
      publishedAt: '2026-05-25T08:00:00.000Z',
      author: '田中 太郎',
      excerpt: '通常の続報の概要テキスト',
      unread: false,
      tags: [],
    };

    it('絞り込みで選択行が非表示（currentIdx=-1）の時、↓で先頭の表示行が選択される（hom-0125）', async () => {
      items.push(a3);
      try {
        render(<DashboardView />);
        await flush();
        expect(selectedTitle()).toContain('重要なお知らせ');
        // 「通常」は a2/a3 にのみ一致し、選択中の a1（重要なお知らせ）は非表示になる＝currentIdx=-1。
        fireEvent.change(screen.getByPlaceholderText('タイトル・内容で検索...'), {
          target: { value: '通常' },
        });
        await flush();
        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(selectedTitle()).toContain('通常のお知らせ'); // visibleItems[0]
      } finally {
        items.pop();
      }
    });

    it('絞り込みで選択行が非表示（currentIdx=-1）の時、↑で末尾の表示行が選択される（hom-0125）', async () => {
      items.push(a3);
      try {
        render(<DashboardView />);
        await flush();
        fireEvent.change(screen.getByPlaceholderText('タイトル・内容で検索...'), {
          target: { value: '通常' },
        });
        await flush();
        fireEvent.keyDown(window, { key: 'ArrowUp' });
        expect(selectedTitle()).toContain('通常の続報'); // visibleItems[length-1]
      } finally {
        items.pop();
      }
    });

    it('明細行の button をクリックして直後にフォーカスが残っていても↑↓で選択が動く（hom-0126）', async () => {
      render(<DashboardView />);
      await flush();
      // 明細行自体が <button data-home-row-select> のため、クリック直後はこの button に
      // フォーカスが乗る（ブラウザ既定挙動。fireEvent.click は focus を発生させないため明示 focus
      // で再現する）。従来は BUTTON 除外条件に誤って一致し↑↓が無効化されていた。
      const rowButton = within(screen.getByRole('list', { name: '通知一覧' }))
        .getByText('重要なお知らせ')
        .closest('button')!;
      fireEvent.click(rowButton);
      rowButton.focus();
      expect(document.activeElement).toBe(rowButton);
      expect(selectedTitle()).toContain('重要なお知らせ');
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(selectedTitle()).toContain('通常のお知らせ');
    });
  });
});
