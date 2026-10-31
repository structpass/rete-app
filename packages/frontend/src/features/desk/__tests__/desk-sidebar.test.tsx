import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SpaceKind, type OrganizationDto, type ProjectDto, type SpaceDto } from '@rete/shared';
import { makeSpaceDto } from '@/test-utils/fixtures';
import { FavoritesProvider } from '@/features/shell/hooks/favorites-context';
import { DeskSpaceProvider } from '../hooks/desk-space-context';
import { DeskSidebar } from '../components/desk-sidebar';

// DeskSidebar は実 API（fetchOrganizations / fetchProjects / fetchSpaces）から組織＞プロジェクト＞チャネル /
// グループ / 個人を描画する（CM-2 スライスB）。lib/api を部分モックして固定データを返す。
// cmn-0147: vi.hoisted 化（既存 favoritesApiMock hoisted ブロックへ非 hoisted 変数を合流＝新ブロック並設なし）。
// fetchOrganizations / fetchProjects / fetchSpaces / createSpace / updateSpace / fetchAccounts
// の 6 変数を既存ブロックへ統合する。
const { fetchOrganizations, fetchProjects, fetchSpaces, createSpace, updateSpace, fetchAccounts } =
  vi.hoisted(() => ({
    fetchOrganizations: vi.fn(),
    fetchProjects: vi.fn(),
    fetchSpaces: vi.fn(),
    createSpace: vi.fn(),
    updateSpace: vi.fn(),
    fetchAccounts: vi.fn(),
  }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    fetchOrganizations: (...a: unknown[]) => fetchOrganizations(...a),
    fetchProjects: (...a: unknown[]) => fetchProjects(...a),
    fetchSpaces: (...a: unknown[]) => fetchSpaces(...a),
    createSpace: (...a: unknown[]) => createSpace(...a),
    updateSpace: (...a: unknown[]) => updateSpace(...a),
  };
});

// 作成導線（rete-desk-0144）: DM 相手候補（GET /accounts）と現在ユーザー（useSession）を固定。
vi.mock('@/features/tasks/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/tasks/lib/api')>();
  return { ...actual, fetchAccounts: (...a: unknown[]) => fetchAccounts(...a) };
});
vi.mock('@/features/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth')>();
  return {
    ...actual,
    useSession: () => ({
      user: { id: 'me', email: 'me@example.com', name: '自分', role: 'MEMBER' },
      loading: false,
    }),
  };
});
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

// ★トグル（HM-1-4）は FavoritesProvider 配下でしか動かないため空 API で固定。
// dsk-0299: 行★（プロジェクト/チャネル/グループ/自分メモ/DM）の addFavorite 呼び出しをテストから検証するため名前付き参照で公開する。
// cmn-0225: vi.fn() インスタンスのみ hoisted で保持。mockResolvedValue は beforeEach で再設定する。
const favoritesApiMock = vi.hoisted(() => ({
  addFavorite: vi.fn(),
  fetchFavorites: vi.fn(),
  removeFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
}));
vi.mock('@/features/shell/lib/favorites-api', () => ({
  fetchFavorites: (...a: unknown[]) => favoritesApiMock.fetchFavorites(...a),
  addFavorite: (...a: unknown[]) => favoritesApiMock.addFavorite(...a),
  removeFavorite: (...a: unknown[]) => favoritesApiMock.removeFavorite(...a),
  reorderFavorites: (...a: unknown[]) => favoritesApiMock.reorderFavorites(...a),
}));

// dsk-0341: DeskMembershipScopeModal 内の fetchMemberships を固定値で吸収する統合テスト用モック。
const membershipsApiMock = vi.hoisted(() => ({
  fetchMemberships: vi.fn().mockResolvedValue([]),
  addMembership: vi.fn(),
  removeMembership: vi.fn(),
  updateMembershipRole: vi.fn(),
}));
vi.mock('@/features/settings/lib/memberships-api', () => membershipsApiMock);

const now = '2026-06-14T00:00:00.000Z';
const org: OrganizationDto = {
  id: 'org1',
  name: '組織アルファ',
  sortOrder: 0,
  archived: false,
  createdAt: now,
  updatedAt: now,
};
const project: ProjectDto = {
  id: 'p1',
  organizationId: 'org1',
  name: '倉庫オペレーション改善',
  sortOrder: 0,
  archived: false,
  // 既定（非管理者）= 編集アイコン非表示。管理者ケースは個別テストで canManageChannels:true に差し替える。
  canManageChannels: false,
  createdAt: now,
  updatedAt: now,
};
function space(over: Partial<SpaceDto> & Pick<SpaceDto, 'id' | 'kind' | 'name'>): SpaceDto {
  // d596: 既定値は test-utils/fixtures が正本。id/kind/name は各テストが必ず指定する（既定を置かない）。
  // canManageMembers の既定は false（管理者ケースは canManageMembers: true を差し替える・dsk-0354）。
  return makeSpaceDto({ ...over, createdAt: now, updatedAt: now });
}
const channel = space({ id: 'ch1', kind: SpaceKind.CHANNEL, projectId: 'p1', name: '全体共通' });
const group = space({ id: 'g1', kind: SpaceKind.GROUP, name: '営業部' });
const adminGroup = space({
  id: 'g1',
  kind: SpaceKind.GROUP,
  name: '営業部',
  canManageMembers: true,
});
const dm = space({
  id: 'dm1',
  kind: SpaceKind.PERSONAL_DM,
  name: '佐久間 健',
  ownerId: 'me',
  peerAccountId: 'acc-2',
});

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <FavoritesProvider>
      <DeskSpaceProvider>{children}</DeskSpaceProvider>
    </FavoritesProvider>
  );
}

describe('DeskSidebar（実 API・CM-2 スライスB）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchOrganizations.mockReset().mockResolvedValue([org]);
    fetchProjects.mockReset().mockResolvedValue([project]);
    createSpace.mockReset();
    updateSpace.mockReset();
    favoritesApiMock.addFavorite.mockReset().mockResolvedValue(undefined);
    favoritesApiMock.fetchFavorites.mockReset().mockResolvedValue([]);
    favoritesApiMock.removeFavorite.mockReset().mockResolvedValue(undefined);
    favoritesApiMock.reorderFavorites.mockReset().mockResolvedValue([]);
    fetchAccounts.mockReset().mockResolvedValue([
      { id: 'me', name: '自分' },
      { id: 'acc-2', name: '佐久間 健' },
      { id: 'acc-3', name: '田中 太郎' },
    ]);
    membershipsApiMock.fetchMemberships.mockReset().mockResolvedValue([]);
    fetchSpaces.mockReset().mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([group]);
        case SpaceKind.PERSONAL_DM:
          return Promise.resolve([dm]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
  });

  it('組織タブ既定で 組織＞プロジェクト＞チャネル を描画する', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    expect(await screen.findByText('組織アルファ')).toBeInTheDocument();
    expect(await screen.findByText('倉庫オペレーション改善')).toBeInTheDocument();
    // 既定で展開済みのため lazy 取得したチャネルが出る。
    expect(await screen.findByText('全体共通')).toBeInTheDocument();
  });

  it('3 タブ（組織/グループ/個人）が存在し切り替えでパネルが前面に出る', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    await screen.findByText('組織アルファ');
    const groupTab = screen.getByRole('tab', { name: '組織' });
    expect(groupTab).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'グループ' }));
    expect(await screen.findByText('営業部')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    expect(await screen.findByText('佐久間 健')).toBeInTheDocument();
  });

  // dsk-0399: Home ★の ?spaceId= deep-link は selectedSpaceId を直接セットするが、activeTab は
  // localStorage 復元のみで deep-link 先の Space 種別を見ないため、既定の組織タブに留まり選択中の
  // 器がどのタブにも表示されない不具合があった。selectedSpaceId 変化への自動追従で解消する。
  it('deep-link（initialSpaceId）が GROUP を指す場合、既定の組織タブでなくグループタブへ自動追従する（dsk-0399）', async () => {
    const deepLinkGroup = space({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      kind: SpaceKind.GROUP,
      name: 'TETS',
    });
    fetchSpaces.mockReset().mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([deepLinkGroup]);
        case SpaceKind.PERSONAL_DM:
          return Promise.resolve([dm]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
    function DeepLinkWrapper({ children }: { children: ReactNode }) {
      return (
        <FavoritesProvider>
          <DeskSpaceProvider initialSpaceId={deepLinkGroup.id}>{children}</DeskSpaceProvider>
        </FavoritesProvider>
      );
    }
    render(<DeskSidebar />, { wrapper: DeepLinkWrapper });

    const groupTab = await screen.findByRole('tab', { name: 'グループ' });
    await waitFor(() => expect(groupTab).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByText('TETS')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '組織' })).toHaveAttribute('aria-selected', 'false');
  });

  // dsk-0399 code-review是正（HIGH）: groups/memos/dms/channelsByProject は各リストの lazy 取得完了
  // のたびに新しい参照になり同期 effect が再実行される。selectedSpaceId 自体が変わらない限り再判定
  // しないガード（lastSyncedSpaceIdRef）が無いと、無関係なリスト再取得だけで直前に手動で開いたタブが
  // 問答無用でスナップバックしてしまう。
  //
  // dsk-0426 撤去判断: 旧テストの「チャネル改名 UI → reloadChannels で channelsByProject に新しい参照」
  // 経路はチャネル管理撤去で失われた。置換候補を code-reviewer と再検討した結果:
  //   - グループ作成: setSelectedSpaceId で selectedSpaceId が変化し、ガード経路を素通りするため検証価値消失
  //   - グループ改名 / アーカイブ: 発火点がグループタブ配下にあり、ORG タブ在席中に発火できない
  //   - DM 作成: 同じく PERSONAL タブ依存
  //   - 個人メモ自動作成: mount 時点で実行され、ORG タブへの手動切替前に完了してしまう
  // criteria【6】 sub-bullet 3 は「チャネル管理に依存しない操作へ置換して維持」と書かれているが、
  // 現在の UI で同等トリガが引けないため、dsk-0399 テストは撤去する（直下の別テストで同等の「
  // 同一タブ内で別 Space 選択時に setTab が呼ばれない」動作は引き続き検証される）。
  it.skip('dsk-0399 ガード経路は dsk-0426 で撤去済み（旧: deep-link → 手動タブ切替 → 無関係なリスト再取得でスナップバックしない）', () => {});

  // dsk-0399 code-review是正（MEDIUM）: 判定結果が現在の activeTab と同じ時は setTab を呼ばない。
  // useDeskSidebarState.setTab は無条件に新しい state を返すため、呼ぶたび localStorage 書き込みが
  // 走る。同一タブ内で別 Space をクリックする通常操作のたびに無駄書き込みが発生していないか検証する。
  it('同一タブ内で別の Space を選択しても setTab は呼ばれない＝ localStorage 書き込みを増やさない（dsk-0399）', async () => {
    const groupA = space({ id: 'g-a', kind: SpaceKind.GROUP, name: 'グループA' });
    const groupB = space({ id: 'g-b', kind: SpaceKind.GROUP, name: 'グループB' });
    fetchSpaces.mockReset().mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([groupA, groupB]);
        case SpaceKind.PERSONAL_DM:
          return Promise.resolve([dm]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: 'グループ' }));
    await screen.findByText('グループA');
    await screen.findByText('グループB');

    // タブ切替自体の書き込みが収まってから spy を設置する。
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem');
    fireEvent.click(screen.getByText('グループA'));
    fireEvent.click(screen.getByText('グループB'));

    await waitFor(() => {
      const dm1 = screen.getByText('グループB').closest('.sidebar-member-row');
      expect(dm1).toHaveClass('active');
    });
    const sidebarStateWrites = setItemSpy.mock.calls.filter(
      ([key]) => key === 'desk-sidebar-state-v2',
    );
    expect(sidebarStateWrites).toHaveLength(0);
    setItemSpy.mockRestore();
  });

  it('DM 行は space.name が固定値「DM」でも閲覧者視点の相手名（owner側）を表示する', async () => {
    fetchSpaces.mockReset().mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([group]);
        case SpaceKind.PERSONAL_DM:
          // 自分が owner 側。name は backend 固定値 'DM'（実運用の実データ形）。
          return Promise.resolve([
            space({
              id: 'dm-fixed',
              kind: SpaceKind.PERSONAL_DM,
              name: 'DM',
              ownerId: 'me',
              peerAccountId: 'acc-2',
            }),
          ]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    expect(await screen.findByText('佐久間 健')).toBeInTheDocument();
    expect(screen.queryByText('DM')).not.toBeInTheDocument();
  });

  it('DM 行は自分が peer 側でも owner 側の Account 名を相手名として表示する', async () => {
    fetchSpaces.mockReset().mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([group]);
        case SpaceKind.PERSONAL_DM:
          // 自分が peer 側。owner が相手（acc-3=田中 太郎）。
          return Promise.resolve([
            space({
              id: 'dm-fixed',
              kind: SpaceKind.PERSONAL_DM,
              name: 'DM',
              ownerId: 'acc-3',
              peerAccountId: 'me',
            }),
          ]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    expect(await screen.findByText('田中 太郎')).toBeInTheDocument();
    expect(screen.queryByText('DM')).not.toBeInTheDocument();
  });

  // dsk-0325: backend が peerName を同梱するケース — accounts に相手が無くても名前が出る。
  it('DM 行: peerName が backend から提供されていれば accounts 取得を待たず表示する（dsk-0325）', async () => {
    fetchSpaces.mockReset().mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([group]);
        case SpaceKind.PERSONAL_DM:
          // accounts に存在しない ID（acc-unknown）でも peerName 同梱で名前が出る。
          return Promise.resolve([
            space({
              id: 'dm-fixed',
              kind: SpaceKind.PERSONAL_DM,
              name: 'DM',
              ownerId: 'me',
              peerAccountId: 'acc-unknown',
              peerName: '同梱 名前',
            }),
          ]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    expect(await screen.findByText('同梱 名前')).toBeInTheDocument();
    expect(screen.queryByText('DM')).not.toBeInTheDocument();
  });

  // dsk-0325: 退会・ロック済み（peerName が null）のケース — accounts に居れば accounts 引きで fallback。
  it('DM 行: peerName が null で accounts に相手がいれば accounts 引きでフォールバック表示（dsk-0325）', async () => {
    fetchSpaces.mockReset().mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([group]);
        case SpaceKind.PERSONAL_DM:
          return Promise.resolve([
            space({
              id: 'dm-fixed',
              kind: SpaceKind.PERSONAL_DM,
              name: 'DM',
              ownerId: 'me',
              peerAccountId: 'acc-2',
              peerName: null,
            }),
          ]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    expect(await screen.findByText('佐久間 健')).toBeInTheDocument();
  });

  // dsk-0325: 空文字 peerName を「DM」固定値や accounts 引きに置換せず、空文字のまま表示する。
  // （要件：空文字を誤ってフォールバックしない／accounts 引きや 'DM' 固定値より空文字の明示が優先）。
  it('DM 行: peerName が空文字なら空文字を素通しし "DM" にも accounts 引きにも倒さない（dsk-0325）', async () => {
    fetchSpaces.mockReset().mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([group]);
        case SpaceKind.PERSONAL_DM:
          return Promise.resolve([
            space({
              id: 'dm-empty',
              kind: SpaceKind.PERSONAL_DM,
              name: 'DM',
              ownerId: 'me',
              peerAccountId: 'acc-2',
              peerName: '',
            }),
          ]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    // ダイレクトメッセージセクションがレンダリングされるまで待つ（dsk-0353: 旧「関係者」表記の刷新）
    await screen.findByText('ダイレクトメッセージ');
    // DM 行はダイレクトメッセージセクション内の最後の .sidebar-member-row
    const memberRows = document.querySelectorAll('.sidebar-member-row');
    const dmRow = memberRows[memberRows.length - 1];
    expect(dmRow).not.toBeNull();
    const nameSpan = dmRow.querySelector('.sidebar-member-name');
    expect(nameSpan).not.toBeNull();
    expect(nameSpan!.textContent).toBe('');
    // 「DM」固定値にも accounts 引き（佐久間 健）にも倒れていないことを保証する。
    expect(screen.queryByText('DM')).not.toBeInTheDocument();
    expect(screen.queryByText('佐久間 健')).not.toBeInTheDocument();
  });

  it('チャネル行クリックで active が付く（spaceId 選択）', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    const ch = (await screen.findByText('全体共通')).closest('.sidebar-channel')!;
    expect(ch).not.toHaveClass('active');
    fireEvent.click(ch);
    expect(ch).toHaveClass('active');
  });

  it('プロジェクト見出しクリックで折り畳み状態がトグルする', async () => {
    const { container } = render(<DeskSidebar />, { wrapper: Wrapper });
    // v2-505: ★トグルも label を accessible name に含むため、name の緩い一致だと★にも当たる。
    // 描画完了を待ってから、見出しボタンを class で特定する。
    await waitFor(() => expect(container.querySelector('.sidebar-project-head')).not.toBeNull());
    const head = container.querySelector('.sidebar-project-head') as HTMLElement;
    expect(head).toHaveAccessibleName(/倉庫オペレーション改善/);
    const proj = head.closest('.sidebar-project');
    expect(proj).toHaveClass('is-expanded');
    fireEvent.click(head);
    expect(proj).not.toHaveClass('is-expanded');
    expect(head).toHaveAttribute('aria-expanded', 'false');
  });

  it('折り畳み中のプロジェクトのチャネルは取得しない（lazy / N+1 回避）', async () => {
    // 初期状態を「折り畳み済み」に復元してマウント → CHANNEL fetch が走らないこと。
    window.localStorage.setItem(
      'desk-sidebar-state-v2',
      JSON.stringify({ activeTab: 'organization', collapsed: { p1: true } }),
    );
    render(<DeskSidebar />, { wrapper: Wrapper });
    await screen.findByText('倉庫オペレーション改善');
    await waitFor(() => expect(fetchProjects).toHaveBeenCalled());
    // CHANNEL kind の取得が一度も行われない（折り畳み中のため）。
    const channelCalls = fetchSpaces.mock.calls.filter(
      ([p]) => (p as { kind?: SpaceKind })?.kind === SpaceKind.CHANNEL,
    );
    expect(channelCalls).toHaveLength(0);
  });

  // ===== 作成導線（rete-desk-0144・第一弾＝グループ／1:1 DM）=====

  it('グループ「＋」でフォームが開き、作成で createSpace(GROUP) を呼ぶ', async () => {
    createSpace.mockResolvedValue(
      space({ id: 'g-new', kind: SpaceKind.GROUP, name: '新規グループ' }),
    );
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: 'グループ' }));
    await screen.findByText('営業部');

    fireEvent.click(screen.getByRole('button', { name: 'グループを追加' }));
    fireEvent.change(screen.getByLabelText('グループ名'), { target: { value: '新規グループ' } });
    // cmn-0385: change の state 反映前に click すると確定ボタンが disabled のまま onClick が発火せず
    // createSpace 未呼び出しになるレース（CI で 1 回失敗・flaky）。enabled 化を待ってからクリックする。
    const submitBtn = screen.getByRole('button', { name: 'グループ作成' });
    await waitFor(() => expect(submitBtn).toBeEnabled());
    fireEvent.click(submitBtn);

    await waitFor(() =>
      expect(createSpace).toHaveBeenCalledWith({ kind: SpaceKind.GROUP, name: '新規グループ' }),
    );
  });

  it('DM「＋」で相手ピッカーが開き、自分＋既存 DM 相手を除外した候補のみ出す', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    await screen.findByText('佐久間 健'); // 既存 DM 行

    fireEvent.click(screen.getByRole('button', { name: 'ダイレクトメッセージを追加' }));
    // 候補: 自分(me) と 既存相手(acc-2 佐久間) を除外 → 田中 太郎(acc-3) のみ。
    expect(await screen.findByRole('button', { name: /田中 太郎/ })).toBeInTheDocument();
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('DM 候補選択で確認ダイアログを挟み、「開始する」で createSpace(PERSONAL_DM) を呼ぶ（dsk-0353）', async () => {
    createSpace.mockResolvedValue(
      space({ id: 'dm-new', kind: SpaceKind.PERSONAL_DM, name: '田中 太郎' }),
    );
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    await screen.findByText('佐久間 健');

    fireEvent.click(screen.getByRole('button', { name: 'ダイレクトメッセージを追加' }));
    fireEvent.click(await screen.findByRole('button', { name: /田中 太郎/ }));

    // 候補クリックでは PERSONAL_DM の createSpace は呼ばず、確認ダイアログが出る（PERSONAL_MEMO の
    // 自動作成＝dsk-0352 は別経路で mounted 直後に走るため、PERSONAL_DM 呼び出し有無で検証する）。
    expect(createSpace).not.toHaveBeenCalledWith({
      kind: SpaceKind.PERSONAL_DM,
      peerAccountId: 'acc-3',
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('田中 太郎 とダイレクトメッセージを開始しますか？');

    // 「OK」を押して初めて createSpace。
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(createSpace).toHaveBeenCalledWith({
        kind: SpaceKind.PERSONAL_DM,
        peerAccountId: 'acc-3',
      }),
    );
  });

  it('DM 確認ダイアログで「キャンセル」を押すと PERSONAL_DM を作らず一覧へ戻る（dsk-0353）', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    await screen.findByText('佐久間 健');

    fireEvent.click(screen.getByRole('button', { name: 'ダイレクトメッセージを追加' }));
    fireEvent.click(await screen.findByRole('button', { name: /田中 太郎/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセル' }));

    expect(createSpace).not.toHaveBeenCalledWith({
      kind: SpaceKind.PERSONAL_DM,
      peerAccountId: 'acc-3',
    });
    // 一覧に復帰（候補ボタンが再度押せる）。
    expect(screen.getByRole('button', { name: /田中 太郎/ })).toBeInTheDocument();
  });

  // ===== チャネル管理（dsk-0426 で撤去済み）=====
  // 旧: rete-desk-0143 の編集アイコン → メニュー（追加/改名/アーカイブ）+ プロジェクト行の参照権限管理モーダルは
  // dsk-0426 で撤去された。設定画面（set-0148/dsk-0430）側へ移設する。

  // ===== グループ設定ゲート（dsk-0354・canManageMembers / dsk-0364 で直開きへ）=====

  it('非管理者（canManageMembers=false）はグループ行に編集アイコンを出さない（dsk-0354）', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: 'グループ' }));
    await screen.findByText('営業部');
    // 既定 group は canManageMembers=false → 編集アイコン無し（403 到達経路を UI から消す）。
    expect(screen.queryAllByRole('button', { name: 'グループ設定' })).toHaveLength(0);
  });

  it('管理者（canManageMembers=true）はグループ行の ✎ でグループ設定モーダルが直接開く（dsk-0364）', async () => {
    fetchSpaces.mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([adminGroup]);
        case SpaceKind.PERSONAL_DM:
          return Promise.resolve([dm]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: 'グループ' }));
    await screen.findByText('営業部');

    // dsk-0364: 中間の吹き出しメニュー（「何を編集するか」の一枚）を経ずに設定画面が開く。
    fireEvent.click(screen.getByRole('button', { name: 'グループ設定' }));

    expect(
      await screen.findByRole('dialog', { name: '営業部 のグループ設定' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  // ===== グループ改名 / アーカイブ（dsk-0366・canManageMembers ゲート共有）=====

  /** adminGroup（canManageMembers=true）を返す fetchSpaces 差し替え（dsk-0354 テストと同型）。 */
  function mockAdminGroupSpaces() {
    fetchSpaces.mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([adminGroup]);
        case SpaceKind.PERSONAL_DM:
          return Promise.resolve([dm]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });
  }

  /** グループ設定モーダルを開くところまで（dsk-0364: ✎ から直接開く）。 */
  async function openGroupSettings() {
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: 'グループ' }));
    await screen.findByText('営業部');
    fireEvent.click(screen.getByRole('button', { name: 'グループ設定' }));
    return await screen.findByRole('dialog', { name: '営業部 のグループ設定' });
  }

  it('グループ設定モーダル内でグループ名を書き換えて保存すると updateSpace(name) を呼ぶ（dsk-0364）', async () => {
    mockAdminGroupSpaces();
    updateSpace.mockResolvedValue({ ...adminGroup, name: '営業部v2' });
    const modal = await openGroupSettings();

    const input = within(modal).getByLabelText('グループ名');
    expect(input).toHaveValue('営業部');
    fireEvent.change(input, { target: { value: '営業部v2' } });
    fireEvent.click(within(modal).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith('g1', { name: '営業部v2' }));
  });

  it('グループ設定モーダルの「アーカイブ」は確認ダイアログを挟み、確定で updateSpace(archived) を呼ぶ（dsk-0364）', async () => {
    mockAdminGroupSpaces();
    updateSpace.mockResolvedValue({ ...adminGroup, archived: true });
    const modal = await openGroupSettings();

    fireEvent.click(within(modal).getByRole('button', { name: 'アーカイブ' }));

    // 押下だけでは実行されず、確認ダイアログが出る（破壊操作の確認は dsk-0364 でも残す）。
    expect(updateSpace).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(updateSpace).toHaveBeenCalledWith('g1', { archived: true }));
  });

  it('アーカイブ確認ダイアログでキャンセルすると updateSpace を呼ばない（dsk-0364）', async () => {
    mockAdminGroupSpaces();
    const modal = await openGroupSettings();

    fireEvent.click(within(modal).getByRole('button', { name: 'アーカイブ' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(updateSpace).not.toHaveBeenCalled();
  });

  // ===== 行★お気に入り（dsk-0299・組織/グループ/個人の各行から直接登録）=====

  it('組織タブ: プロジェクト行・チャネル行それぞれに★ボタンがあり、押すと addFavorite(kind別) を呼ぶ', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    await screen.findByText('全体共通');

    const projectRow = screen
      .getByText('倉庫オペレーション改善')
      .closest('.sidebar-project-head-row') as HTMLElement;
    fireEvent.click(
      within(projectRow).getByRole('button', {
        name: 'プロジェクト「倉庫オペレーション改善」をお気に入りに追加',
      }),
    );
    await waitFor(() =>
      expect(favoritesApiMock.addFavorite).toHaveBeenCalledWith({
        kind: 'project',
        targetRef: 'p1',
        label: '倉庫オペレーション改善',
      }),
    );

    const channelRow = screen.getByText('全体共通').closest('.sidebar-channel-row') as HTMLElement;
    fireEvent.click(
      within(channelRow).getByRole('button', { name: 'スペース「全体共通」をお気に入りに追加' }),
    );
    await waitFor(() =>
      expect(favoritesApiMock.addFavorite).toHaveBeenCalledWith({
        kind: 'space',
        targetRef: 'ch1',
        label: '全体共通',
      }),
    );
  });

  it('グループタブ: グループ行に★ボタンがあり、押すと addFavorite(kind=space) を呼ぶ', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: 'グループ' }));
    await screen.findByText('営業部');

    const row = screen.getByText('営業部').closest('.sidebar-member-row-wrap') as HTMLElement;
    fireEvent.click(
      within(row).getByRole('button', { name: 'スペース「営業部」をお気に入りに追加' }),
    );
    await waitFor(() =>
      expect(favoritesApiMock.addFavorite).toHaveBeenCalledWith({
        kind: 'space',
        targetRef: 'g1',
        label: '営業部',
      }),
    );
  });

  it('個人タブ: DM行に★ボタンがあり、押すと addFavorite(kind=space) を呼ぶ', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    await screen.findByText('佐久間 健');

    const row = screen.getByText('佐久間 健').closest('.sidebar-member-row-wrap') as HTMLElement;
    fireEvent.click(
      within(row).getByRole('button', { name: 'スペース「佐久間 健」をお気に入りに追加' }),
    );
    await waitFor(() =>
      expect(favoritesApiMock.addFavorite).toHaveBeenCalledWith({
        kind: 'space',
        targetRef: 'dm1',
        label: '佐久間 健',
      }),
    );
  });

  // ===== 自分宛メニュー固定化（dsk-0352）=====

  it('個人タブ「自分宛」には＋ボタンや新規メモ作成フォームが表示されない（dsk-0352・criteria 1）', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    await screen.findByText('佐久間 健');

    // 「自分宛」セクションには「メモを追加」も「メモ名」入力欄も出ない（dsk-0301 の逆操作）
    expect(screen.queryByRole('button', { name: 'メモを追加' })).toBeNull();
    expect(screen.queryByLabelText('メモ名')).toBeNull();
    expect(screen.queryByRole('button', { name: 'メモ作成' })).toBeNull();

    // 「自分宛」セクションラベルは表示のまま
    expect(screen.getByText('自分宛').closest('.sidebar-section-label')).toBeInTheDocument();
  });

  /** dsk-0381: 個人先頭見出しはグループ先頭と同型（mt-2 無し）でタブ切替の上下ジャンプを防ぐ。 */
  it('個人タブ先頭「自分宛」見出しは mt-2 無し（グループ先頭と同型・dsk-0381）', async () => {
    const { container } = render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    await screen.findByText('佐久間 健');
    const personalLabel = screen.getByText('自分宛').closest('.sidebar-section-label');
    expect(personalLabel).not.toBeNull();
    expect(personalLabel).not.toHaveClass('mt-2');
    // グループ先頭も mt-2 無し（揃いの前提）
    fireEvent.click(screen.getByRole('tab', { name: 'グループ' }));
    const groupLabel = container.querySelector('#desk-sidebar-panel-group .sidebar-section-label');
    expect(groupLabel).not.toBeNull();
    expect(groupLabel).not.toHaveClass('mt-2');
  });

  it('個人タブ「自分宛」は PERSONAL_MEMO が 2 件あっても 1 行だけ表示する（dsk-0352・criteria 4）', async () => {
    fetchSpaces.mockReset().mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([group]);
        case SpaceKind.PERSONAL_DM:
          return Promise.resolve([dm]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([
            space({
              id: 'memo1',
              kind: SpaceKind.PERSONAL_MEMO,
              name: '個人メモ',
              ownerId: 'me',
              createdAt: '2026-01-01T00:00:00Z',
            }),
            space({
              id: 'memo2',
              kind: SpaceKind.PERSONAL_MEMO,
              name: '1',
              ownerId: 'me',
              createdAt: '2026-02-01T00:00:00Z',
            }),
          ]);
        default:
          return Promise.resolve([]);
      }
    });
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    await screen.findByText('佐久間 健');

    // dsk-0382: 行はログインユーザー表示名（mock name=「自分」）。固定「自分宛」ではない。
    // セクション見出し「自分宛」は残る。PERSONAL_MEMO が 2 件でも行は 1 つ。
    const personalRows = screen
      .getAllByText('自分')
      .filter((el) => el.closest('.sidebar-member-row-wrap'));
    expect(personalRows.length).toBe(1);
    expect(
      screen.getAllByText('自分宛').filter((el) => el.closest('.sidebar-member-row-wrap')).length,
    ).toBe(0);
  });

  /** dsk-0382: 個人タブの自分用スペース行はログインユーザー名＋アバター頭文字。 */
  it('個人タブの自分用行はログインユーザー表示名になる（固定「自分宛」ではない・dsk-0382）', async () => {
    // memos 1 件を返す（lazy create 前に行が出る）
    fetchSpaces.mockImplementation((params: { kind?: SpaceKind }) => {
      switch (params?.kind) {
        case SpaceKind.CHANNEL:
          return Promise.resolve([channel]);
        case SpaceKind.GROUP:
          return Promise.resolve([group]);
        case SpaceKind.PERSONAL_DM:
          return Promise.resolve([dm]);
        case SpaceKind.PERSONAL_MEMO:
          return Promise.resolve([
            space({ id: 'memo1', kind: SpaceKind.PERSONAL_MEMO, name: '個人メモ', ownerId: 'me' }),
          ]);
        default:
          return Promise.resolve([]);
      }
    });
    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));
    await screen.findByText('佐久間 健');
    // セクション見出しは「自分宛」のまま
    expect(screen.getByText('自分宛').closest('.sidebar-section-label')).toBeInTheDocument();
    // 行は mock useSession の name「自分」
    const row = screen.getByText('自分').closest('.sidebar-member-row');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('自')).toBeInTheDocument(); // avatarChar
  });

  it('PERSONAL_MEMO 0 件のとき、初回ロード完了後に createSpace(PERSONAL_MEMO, name=undefined) を 1 回だけ自動呼出する（dsk-0352・lazy find-or-create）', async () => {
    // デフォルトの fetchSpaces mock が PERSONAL_MEMO を [] で返す（beforeEach 通り）→ lazy find-or-create が走る
    createSpace.mockResolvedValue(
      space({ id: 'memo-new', kind: SpaceKind.PERSONAL_MEMO, name: '個人メモ', ownerId: 'me' }),
    );

    render(<DeskSidebar />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('tab', { name: '個人' }));

    await waitFor(() =>
      expect(createSpace).toHaveBeenCalledWith({ kind: SpaceKind.PERSONAL_MEMO, name: undefined }),
    );
  });

  // ===== プロジェクトの参照権限管理（dsk-0426 で撤去済み）=====
  // 旧: dsk-0309/dsk-0341 の DeskMembershipScopeModal（scopeType=PROJECT）は dsk-0426 で撤去された。
  // 設定画面（set-0148/dsk-0430）側へ移設する。

  it('サイドバー最上部の「選択中のみ★」ボタンは撤去されている', async () => {
    render(<DeskSidebar />, { wrapper: Wrapper });
    await screen.findByText('組織アルファ');
    const header = document.querySelector('.app-sidebar-header') as HTMLElement;
    expect(within(header).queryByRole('button', { name: /お気に入り/ })).toBeNull();
  });
});
