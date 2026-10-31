import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CategorySettingsDialog } from '../components/category-settings-dialog';
import type { Category } from '@/features/tasks/lib/api';

// cmn-0142: vi.hoisted 化（テスト本文が使う mockXxx と衝突しないよう fn プレフィックス）
const {
  fnFetchCategories,
  fnCreateCategory,
  fnUpdateCategory,
  fnDeleteCategory,
  fnReorderCategories,
} = vi.hoisted(() => ({
  fnFetchCategories: vi.fn(),
  fnCreateCategory: vi.fn(),
  fnUpdateCategory: vi.fn(),
  fnDeleteCategory: vi.fn(),
  fnReorderCategories: vi.fn(),
}));

vi.mock('@/features/tasks/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/tasks/lib/api')>();
  return {
    ...actual,
    fetchCategories: fnFetchCategories,
    createCategory: fnCreateCategory,
    updateCategory: fnUpdateCategory,
    deleteCategory: fnDeleteCategory,
    reorderCategories: fnReorderCategories,
  };
});

import {
  fetchCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from '@/features/tasks/lib/api';

const mockFetchCategories = vi.mocked(fetchCategories);
const mockCreateCategory = vi.mocked(createCategory);
const mockUpdateCategory = vi.mocked(updateCategory);
const mockDeleteCategory = vi.mocked(deleteCategory);
// reorderCategories は mock したままにする（本ファイルは実 API を呼ばせない）が、呼び出しの検査は
// category-settings-dialog.dragend.test.tsx が担うためここでは参照しない（cmn-0357）。

const SPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const cat = (id: number, name: string, archived = false): Category => ({
  id,
  name,
  sortOrder: id,
  archived,
  spaceId: SPACE_ID,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
});

/** axios.isAxiosError が true になる 409 風エラー（backend error shape 付き）。 */
const axios409 = (message: string) =>
  Object.assign(new Error(message), {
    isAxiosError: true,
    response: { data: { success: false, error: { code: 'CONFLICT', message } } },
  });

describe('CategorySettingsDialog（rete-desk-0140）', () => {
  const onClose = vi.fn();
  const onChanged = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchCategories.mockResolvedValue([cat(1, '入荷'), cat(2, '出荷'), cat(3, '旧分類', true)]);
  });

  const renderDialog = (open = true, spaceId: string | null = SPACE_ID) =>
    render(
      <CategorySettingsDialog
        open={open}
        spaceId={spaceId}
        onClose={onClose}
        onChanged={onChanged}
      />,
    );

  it('open=false の間は何も描画しないこと', () => {
    renderDialog(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockFetchCategories).not.toHaveBeenCalled();
  });

  it('spaceId=null（チャネル未選択）では一覧を取得せず案内を出すこと（rete-desk-0158）', () => {
    renderDialog(true, null);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockFetchCategories).not.toHaveBeenCalled();
    expect(
      screen.getByText('チャネルを選択すると、そのチャネルの分類を管理できます。'),
    ).toBeInTheDocument();
    // 追加入力も出さない。
    expect(screen.queryByLabelText('新しい分類名')).not.toBeInTheDocument();
  });

  it('開くと includeArchived=true で取得し、有効タブに非アーカイブのみ表示すること（rete-desk-0200・0201）', async () => {
    renderDialog();
    expect(await screen.findByText('入荷')).toBeInTheDocument();
    expect(mockFetchCategories).toHaveBeenCalledWith(SPACE_ID, true);
    // 有効タブが既定。表形式（rete-desk-0201）で非アーカイブのみ表示、アーカイブ済は別タブ。
    const activeTable = screen.getByRole('table', { name: '有効な分類' });
    expect(within(activeTable).getByText('入荷')).toBeInTheDocument();
    expect(within(activeTable).queryByText('旧分類')).not.toBeInTheDocument();
  });

  it('アーカイブタブへ切替でアーカイブ済のみ表示し、解除ボタンを出すこと（rete-desk-0200）', async () => {
    renderDialog();
    await screen.findByText('入荷');

    fireEvent.click(screen.getByRole('tab', { name: 'アーカイブ' }));
    const archivedTable = screen.getByRole('table', { name: 'アーカイブ済みの分類' });
    expect(within(archivedTable).getByText('旧分類')).toBeInTheDocument();
    expect(within(archivedTable).queryByText('入荷')).not.toBeInTheDocument();
    expect(
      within(archivedTable).getByRole('button', { name: '旧分類 をアーカイブ解除' }),
    ).toBeInTheDocument();
  });

  it('並び替え: 並び順列が行の表示位置で 1 始まりに描画されること（rete-desk-0199）', async () => {
    renderDialog();
    await screen.findByText('入荷');

    // ドロップ確定（handleDragEnd）そのものの検査は category-settings-dialog.dragend.test.tsx が
    // DndContext モック方式で担う（cmn-0357）。ここは描画のみ＝テスト名を実体へ合わせて是正した
    // （旧名は reorderCategories 呼び出しを謳っていたが、本体は捕捉も呼び出しもしていなかった）。
    const activeTable = screen.getByRole('table', { name: '有効な分類' });
    const cells = within(activeTable).getAllByText(/^[12]$/);
    expect(cells.map((c) => c.textContent)).toEqual(['1', '2']);
  });

  it('追加: 入力 + 追加ボタンで createCategory → 再取得 + onChanged + 入力クリア', async () => {
    mockCreateCategory.mockResolvedValue(cat(4, '検品'));
    renderDialog();
    await screen.findByText('入荷');

    const input = screen.getByLabelText('新しい分類名');
    fireEvent.change(input, { target: { value: ' 検品 ' } });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    await waitFor(() => expect(mockCreateCategory).toHaveBeenCalledWith(SPACE_ID, '検品'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockFetchCategories).toHaveBeenCalledTimes(2);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('名称変更: 鉛筆 → インライン編集 → 保存で updateCategory({ name }) を呼ぶこと', async () => {
    mockUpdateCategory.mockResolvedValue(cat(1, '入荷管理'));
    renderDialog();
    await screen.findByText('入荷');

    fireEvent.click(screen.getByRole('button', { name: '入荷 の名称変更' }));
    const input = screen.getByLabelText('分類名');
    fireEvent.change(input, { target: { value: '入荷管理' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockUpdateCategory).toHaveBeenCalledWith(1, { name: '入荷管理' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('アーカイブ切替: 有効タブは archived:true / アーカイブタブは archived:false を送ること', async () => {
    mockUpdateCategory.mockResolvedValue(cat(1, '入荷', true));
    renderDialog();
    await screen.findByText('入荷');

    // 有効タブ: アーカイブ。
    fireEvent.click(screen.getByRole('button', { name: '入荷 をアーカイブ' }));
    await waitFor(() => expect(mockUpdateCategory).toHaveBeenCalledWith(1, { archived: true }));

    // アーカイブタブへ切替して解除。
    fireEvent.click(screen.getByRole('tab', { name: 'アーカイブ' }));
    fireEvent.click(screen.getByRole('button', { name: '旧分類 をアーカイブ解除' }));
    await waitFor(() => expect(mockUpdateCategory).toHaveBeenCalledWith(3, { archived: false }));
  });

  it('アーカイブタブの分類には名称変更ボタンを出さないこと（解除・削除のみ）', async () => {
    renderDialog();
    await screen.findByText('入荷');
    fireEvent.click(screen.getByRole('tab', { name: 'アーカイブ' }));
    await screen.findByText('旧分類');
    expect(screen.queryByRole('button', { name: '旧分類 の名称変更' })).not.toBeInTheDocument();
  });

  it('削除: 確認ダイアログ「OK」で deleteCategory を呼ぶこと', async () => {
    mockDeleteCategory.mockResolvedValue(undefined);
    renderDialog();
    await screen.findByText('入荷');

    fireEvent.click(screen.getByRole('button', { name: '出荷 を削除' }));
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('分類「出荷」を削除しますか？');
    fireEvent.click(within(confirm).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(mockDeleteCategory).toHaveBeenCalledWith(2));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('削除: 確認ダイアログをキャンセルすると deleteCategory を呼ばないこと', async () => {
    renderDialog();
    await screen.findByText('入荷');

    fireEvent.click(screen.getByRole('button', { name: '出荷 を削除' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }),
    );

    expect(mockDeleteCategory).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('削除 409: backend の error.message（アーカイブ案内）をそのまま表示すること', async () => {
    mockDeleteCategory.mockRejectedValue(
      axios409('紐づくタスクが存在するため削除できません。アーカイブをご利用ください。'),
    );
    renderDialog();
    await screen.findByText('入荷');

    fireEvent.click(screen.getByRole('button', { name: '入荷 を削除' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'OK' }));

    expect(
      await screen.findByText(
        '紐づくタスクが存在するため削除できません。アーカイブをご利用ください。',
      ),
    ).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('一覧取得失敗時はエラーメッセージを表示すること', async () => {
    mockFetchCategories.mockRejectedValue(new Error('network'));
    renderDialog();
    expect(
      await screen.findByText('分類の取得に失敗しました。閉じて再度お試しください。'),
    ).toBeInTheDocument();
  });

  it('backdrop クリックで onClose を呼び、カード内クリックでは呼ばないこと', async () => {
    renderDialog();
    await screen.findByText('入荷');

    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    // 重ね表示は共通 OverlayDialog（正本 comp-overlay-dialog）が持ち、backdrop は primitive 側の要素。
    fireEvent.click(screen.getByTestId('overlay-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('カード面は OverlayDialog の内側に描き、手組みの全画面 backdrop を持たないこと', async () => {
    renderDialog();
    await screen.findByText('入荷');

    const card = screen.getByTestId('catset-card');
    expect(card).toHaveClass('desk-catset-card');
    expect(screen.getByRole('dialog')).toContainElement(card);
    // 手組みの全画面 backdrop（.desk-catset-backdrop）は残っていない＝重ね表示は共通 primitive 1 枚。
    expect(document.querySelector('.desk-catset-backdrop')).toBeNull();
    expect(screen.getAllByTestId('overlay-backdrop')).toHaveLength(1);
  });

  it('未編集のまま Esc で閉じたら破棄確認を出さずに閉じること', async () => {
    renderDialog();
    await screen.findByText('入荷');

    // Esc の持ち主は共通 OverlayDialog（パネルの onKeyDown）。未編集なら破棄確認なしで即閉じる。
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('名称変更モードに入っただけ（未編集）では Esc で破棄確認を出さないこと', async () => {
    renderDialog();
    await screen.findByText('入荷');

    fireEvent.click(screen.getByRole('button', { name: '入荷 の名称変更' }));
    // 名称変更モードが開いた（入力欄が出た）ことを確かめてから Esc を押す。
    expect(screen.getByLabelText('分類名')).toHaveValue('入荷');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('名称を実際に変えた後は Esc で破棄確認を出すこと', async () => {
    renderDialog();
    await screen.findByText('入荷');

    fireEvent.click(screen.getByRole('button', { name: '入荷 の名称変更' }));
    fireEvent.change(screen.getByLabelText('分類名'), { target: { value: '入荷（改）' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    // 未保存の変更があるので閉じずに破棄確認を出す（mdl-0034 規約②）。
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('新しい分類名を打ち始めただけでも Esc で破棄確認を出すこと', async () => {
    renderDialog();
    await screen.findByText('入荷');

    fireEvent.change(screen.getByLabelText('新しい分類名'), { target: { value: '発送' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ESC で onClose を呼ぶこと（確認ダイアログ表示中はそちら優先で閉じない）', async () => {
    renderDialog();
    await screen.findByText('入荷');

    // 確認ダイアログ表示中の ESC はダイアログのキャンセル扱いで消費され、モーダルは閉じない。
    fireEvent.click(screen.getByRole('button', { name: '入荷 を削除' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
