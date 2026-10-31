import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MembershipScopeType, type PermissionMatrixDto } from '@rete/shared';
import { flush } from '@/test-utils/flush';
import { MembershipsAdminScreen } from '../memberships-admin-screen';

const membershipsApi = vi.hoisted(() => ({ fetchPermissionMatrix: vi.fn() }));
vi.mock('../../lib/memberships-api', () => membershipsApi);

const groupsApi = vi.hoisted(() => ({
  addUserGroupGrant: vi.fn(),
  removeUserGroupGrant: vi.fn(),
}));
vi.mock('../../lib/groups-api', () => groupsApi);

vi.mock('@/features/auth/components/session-provider', () => ({
  useSessionContext: () => ({
    user: { id: 'admin-1', email: 'admin@rete.local', name: 'Admin', role: 'ADMIN' },
    loading: false,
  }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));

const matrix: PermissionMatrixDto = {
  scopes: [
    {
      id: 'org-1',
      scopeType: MembershipScopeType.ORGANIZATION,
      name: 'Acme',
      parentId: null,
      depth: 0,
    },
    {
      id: 'project-1',
      scopeType: MembershipScopeType.PROJECT,
      name: '新製品',
      parentId: 'org-1',
      depth: 1,
    },
    {
      id: 'channel-1',
      scopeType: MembershipScopeType.CHANNEL,
      name: '企画',
      parentId: 'project-1',
      depth: 2,
    },
  ],
  groups: [
    {
      id: 'group-1',
      name: '開発チーム',
      sortOrder: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      memberCount: 2,
    },
    {
      id: 'group-2',
      name: '運用チーム',
      sortOrder: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      memberCount: 1,
    },
  ],
  grants: [
    {
      id: 'grant-1',
      groupId: 'group-1',
      scopeType: MembershipScopeType.ORGANIZATION,
      scopeId: 'org-1',
      role: 'ADMIN',
      createdAt: '2026-08-01T00:00:00.000Z',
    },
  ],
};

async function renderScreen() {
  render(<MembershipsAdminScreen />);
  await waitFor(() => expect(membershipsApi.fetchPermissionMatrix).toHaveBeenCalledTimes(1));
  await flush();
}

function editButton(groupName: string) {
  return screen.getByRole('button', { name: `管理グループ ${groupName} を編集` });
}

/** 編集モードのラジオグループ内で「一般/管理者/なし」をクリックする。 */
async function selectRole(scopeName: string, groupName: string, optionName: string) {
  const radioGroup = screen.getByRole('radiogroup', {
    name: `${scopeName} × 管理グループ ${groupName} の所属ロール`,
  });
  await userEvent.click(
    screen.getByRole('radio', {
      name: `${scopeName} × 管理グループ ${groupName} の所属ロール を ${optionName} に設定`,
    }),
  );
  return radioGroup;
}

describe('MembershipsAdminScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    membershipsApi.fetchPermissionMatrix.mockResolvedValue(matrix);
    groupsApi.addUserGroupGrant.mockResolvedValue({ created: true });
    groupsApi.removeUserGroupGrant.mockResolvedValue(undefined);
  });

  it('参照モードで開き、セルは設定済みの役割をテキスト表示する（ドロップダウンが無い）', async () => {
    await renderScreen();

    expect(screen.getByRole('heading', { name: '所属管理' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();

    // 組織行（Acme）のセルは設定済み値をテキスト表示する
    const acmeRow = screen.getByRole('row', { name: /Acme/ });
    expect(acmeRow).toHaveTextContent('管理者');
    expect(acmeRow).toHaveTextContent('（なし）');

    // プロジェクト/チャネル行も未設定は「（なし）」と読める（v2-188: 旧「所属なし」から変更）
    const projectRow = screen.getByRole('row', { name: /新製品/ });
    expect(projectRow).toHaveTextContent('（なし）');
    expect(screen.queryByText('所属なし')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /開発チーム/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /運用チーム/ })).toBeInTheDocument();

    // v2-179: ヘッダの管理グループ所属ユーザー数ラベル（例「2名」）は表示しない
    expect(screen.queryByText('2名')).not.toBeInTheDocument();
    expect(screen.queryByText('1名')).not.toBeInTheDocument();
  });

  it('明細は列区切りの縦線を出さず、ロールラベルを中央寄せにする（v2-188）', async () => {
    await renderScreen();

    const bodyRows = screen.getAllByRole('row').slice(1);

    // 行ヘッダ・明細セルとも列区切りの縦線（border-r）を持たない（行区切りの border-b は残る）
    const rowHeader = bodyRows[0].querySelector('th') as HTMLElement;
    expect(rowHeader.className).toContain('border-b');
    expect(rowHeader.className).not.toContain('border-r');
    for (const cell of Array.from(bodyRows[0].querySelectorAll('td'))) {
      expect((cell as HTMLElement).className).toContain('border-b');
      expect((cell as HTMLElement).className).not.toContain('border-r');
    }

    // v2-188 要求版2: 固定列（行ヘッダ）の右端にも線を出さない（shadow による全高の縦線を外す）
    expect(rowHeader.className).not.toContain('shadow-[');

    // 明細ラベル（一般・管理者・（なし））は中央寄せの共通spanで描画する
    const labels = Array.from(document.querySelectorAll('tbody td span'));
    expect(labels).toHaveLength(6);
    for (const label of labels) {
      expect((label as HTMLElement).className).toContain('text-center');
    }
  });

  it('外枠は表の行・列の寸法に追従して縮み、上限を超えた分だけ内側でスクロールする（v2-186）', async () => {
    await renderScreen();

    const frame = screen.getByTestId('permission-matrix-scroll');
    // 領域いっぱいに伸ばす flex-1 を外し、表の幅に縮む w-fit ＋ 上限（横 max-w-full / 縦 max-h）を持つ
    expect(frame.className).toContain('w-fit');
    expect(frame.className).toContain('max-w-full');
    expect(frame.className).toContain('max-h-[calc(100vh-12.5rem)]');
    expect(frame.className).not.toContain('flex-1');
    expect(frame.className).toContain('overflow-auto');

    // 操作行は残り高さを吸ってページ下端に残る（枠を伸ばして埋めない）
    const actionRow = document.querySelector('main.sp-page > div:last-child') as HTMLElement;
    expect(actionRow.className).toContain('mt-auto');
  });

  it('偶数行に縞（var(--sp-row-stripe)）を敷き、固定列も不透明のまま縞を重ねる（v2-180）', async () => {
    await renderScreen();

    const bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(3);

    // 1行目（奇数）は無地、2行目（偶数）は縞＝共通 .sp-table tbody tr:nth-child(even) と同じ扱い
    expect((bodyRows[0].querySelector('td') as HTMLElement).style.background).toBe('white');
    expect((bodyRows[1].querySelector('td') as HTMLElement).style.background).toBe(
      'var(--sp-row-stripe)',
    );

    // 固定列（行ヘッダ th）は横スクロールで下が透けないよう白を下地にし、縞は重ねて塗る
    const sticky = bodyRows[1].querySelector('th') as HTMLElement;
    expect(sticky.style.backgroundColor).toBe('white');
    expect(sticky.style.backgroundImage).toContain('var(--sp-row-stripe)');
  });

  it('ヘッダの列区切りは上下端に接しない短い線で、行ヘッダ列と末尾列には出さない（v2-180・v2-188 で行ヘッダ列を除外）', async () => {
    await renderScreen();

    // 末尾以外のグループ列 = 1本（管理グループは2件・行ヘッダ列には出さない）
    const dividers = document.querySelectorAll('[data-testid="matrix-header-divider"]');
    expect(dividers).toHaveLength(1);
    expect(
      (screen.getByRole('columnheader', { name: /運用チーム/ }) as HTMLElement).querySelector(
        '[data-testid="matrix-header-divider"]',
      ),
    ).toBeNull();
    expect(
      (
        screen.getByRole('columnheader', {
          name: /組織 \/ プロジェクト \/ チャネル/,
        }) as HTMLElement
      ).querySelector('[data-testid="matrix-header-divider"]'),
    ).toBeNull();

    // 共通 .sp-table thead th::after と同じ「1px × 0.875rem・中央」の短い線（セルの border-r ではない）
    expect((dividers[0] as HTMLElement).classList.contains('h-3.5')).toBe(true);
    expect((dividers[0] as HTMLElement).classList.contains('w-px')).toBe(true);
    expect(
      (screen.getByRole('columnheader', { name: /開発チーム/ }) as HTMLElement).className,
    ).not.toContain('border-r');
  });

  it('各グループのヘッダに編集アイコンがあり、クリックで編集モードへ入る（対象グループの列のみ表示）', async () => {
    await renderScreen();

    expect(editButton('開発チーム')).toBeInTheDocument();
    expect(editButton('運用チーム')).toBeInTheDocument();

    await userEvent.click(editButton('開発チーム'));

    // 編集対象グループの列だけが残り、他グループの列は非表示になる
    expect(screen.getByRole('columnheader', { name: /開発チーム/ })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /運用チーム/ })).not.toBeInTheDocument();

    // 各行に3値スイッチ（ラジオグループ）が表示され、現在値 管理者 が選択状態
    const acmeGroup = screen.getByRole('radiogroup', {
      name: 'Acme × 管理グループ 開発チーム の所属ロール',
    });
    expect(acmeGroup).toBeInTheDocument();
    expect(
      screen.getByRole('radio', {
        name: 'Acme × 管理グループ 開発チーム の所属ロール を 管理者 に設定',
      }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('radio', {
        name: 'Acme × 管理グループ 開発チーム の所属ロール を 一般 に設定',
      }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('3値スイッチは排他で、選択中だけがチェックされる（他はOFF）', async () => {
    await renderScreen();
    await userEvent.click(editButton('開発チーム'));

    const radioFor = (name: string) =>
      screen.getByRole('radio', {
        name: `Acme × 管理グループ 開発チーム の所属ロール を ${name} に設定`,
      });

    await userEvent.click(radioFor('一般'));
    expect(radioFor('一般')).toHaveAttribute('aria-checked', 'true');
    expect(radioFor('管理者')).toHaveAttribute('aria-checked', 'false');
    expect(radioFor('なし')).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(radioFor('なし'));
    expect(radioFor('なし')).toHaveAttribute('aria-checked', 'true');
    expect(radioFor('一般')).toHaveAttribute('aria-checked', 'false');
    expect(radioFor('管理者')).toHaveAttribute('aria-checked', 'false');
  });

  it('チャネルを管理者/一般にした時、上位プロジェクトが未設定ならエラーメッセージを表示し選択を拒否する', async () => {
    await renderScreen();
    await userEvent.click(editButton('開発チーム'));

    // 企画（チャネル）の上位 新製品（プロジェクト）は未設定（org は管理者のみ設定済）
    await selectRole('企画', '開発チーム', '管理者');

    expect(toast.error).toHaveBeenCalledWith(
      '上位のプロジェクト、または組織に対する所属が未設定です',
    );
    expect(
      screen.getByRole('radio', {
        name: '企画 × 管理グループ 開発チーム の所属ロール を 管理者 に設定',
      }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(groupsApi.addUserGroupGrant).not.toHaveBeenCalled();
  });

  it('プロジェクトを管理者/一般にした時、上位組織が未設定ならエラーメッセージを表示し選択を拒否する', async () => {
    await renderScreen();
    // 運用チーム（group-2）には grant が無いため Acme（組織）が未設定の状態になる
    await userEvent.click(editButton('運用チーム'));

    await selectRole('新製品', '運用チーム', '管理者');

    expect(toast.error).toHaveBeenCalledWith('上位の組織に対する所属が未設定です');
    expect(
      screen.getByRole('radio', {
        name: '新製品 × 管理グループ 運用チーム の所属ロール を 管理者 に設定',
      }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('上位を先に設定すればチャネルにも選択でき、更新で既存APIへ反映する', async () => {
    await renderScreen();
    await userEvent.click(editButton('開発チーム'));

    // 親（新製品）を一般に設定 → 親が設定済みになったため子（企画）にも一般を設定できる
    await selectRole('新製品', '開発チーム', '一般');
    await selectRole('企画', '開発チーム', '一般');

    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => expect(groupsApi.addUserGroupGrant).toHaveBeenCalledTimes(2));
    expect(groupsApi.addUserGroupGrant.mock.calls[0][0]).toEqual({
      groupId: 'group-1',
      scopeType: MembershipScopeType.PROJECT,
      scopeId: 'project-1',
      role: 'MEMBER',
    });
    expect(groupsApi.addUserGroupGrant.mock.calls[1][0]).toEqual({
      groupId: 'group-1',
      scopeType: MembershipScopeType.CHANNEL,
      scopeId: 'channel-1',
      role: 'MEMBER',
    });
  });

  it('編集アイコンを再クリックで参照モードへ戻り、キャンセルでsnapshotへ戻す', async () => {
    await renderScreen();
    await userEvent.click(editButton('開発チーム'));
    await selectRole('新製品', '開発チーム', '一般');

    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled();

    // 参照モードへ戻っても変更は保留されたまま（更新ボタンは有効）
    await userEvent.click(editButton('開発チーム'));
    expect(screen.getByRole('columnheader', { name: /運用チーム/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled();
    expect(groupsApi.addUserGroupGrant).not.toHaveBeenCalled();

    // キャンセルで snapshot へ戻る
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('button', { name: '更新' })).toBeDisabled();
  });

  it('更新途中の失敗で停止し、一括再読込して部分反映数を通知する', async () => {
    groupsApi.addUserGroupGrant
      .mockResolvedValueOnce({ created: true })
      .mockRejectedValueOnce(new Error('last admin'));
    await renderScreen();
    await userEvent.click(editButton('開発チーム'));

    await selectRole('新製品', '開発チーム', '一般');
    await selectRole('企画', '開発チーム', '一般');
    fireEvent.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('1件は反映済みです'));
    expect(membershipsApi.fetchPermissionMatrix).toHaveBeenCalledTimes(2);
  });

  it('matrix の取得に失敗したら領域内に role="alert" を出し、0件文言と区別する（v2-233）', async () => {
    membershipsApi.fetchPermissionMatrix.mockRejectedValue(new Error('network'));

    render(<MembershipsAdminScreen />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('所属設定の読み込みに失敗しました');
    // 真0件の空文言は描かない（失敗と0件を読み分けられる）
    expect(screen.queryByText('条件に一致するスコープがありません')).not.toBeInTheDocument();
    // 取得失敗は toast へ逃がさない（正本 ui.ts:109-110 の二層: 取得失敗=領域内 / 操作失敗=toast）
    expect(toast.error).not.toHaveBeenCalled();
  });

  // d659: 取得失敗の表示から、画面を開き直さずに取り直せる。
  it('取得失敗の表示に再試行を添え、押すと取り直して失敗の表示を消す（d659）', async () => {
    membershipsApi.fetchPermissionMatrix.mockRejectedValueOnce(new Error('network'));
    membershipsApi.fetchPermissionMatrix.mockResolvedValue(matrix);

    render(<MembershipsAdminScreen />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('所属設定の読み込みに失敗しました');
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(membershipsApi.fetchPermissionMatrix).toHaveBeenCalledTimes(2);
    // 失敗の文言が残ったまま表が出る、を防ぐ（取れたら失敗の表示は消える）
    expect(screen.queryByText('所属設定の読み込みに失敗しました')).not.toBeInTheDocument();
  });
});
