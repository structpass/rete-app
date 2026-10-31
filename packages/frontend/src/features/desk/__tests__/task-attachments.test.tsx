import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// hook と File ピッカーをモックし、TaskAttachments の表示状態と解除/追加導線を検証する。
// cmn-0146: vi.hoisted 化（factory クロージャ参照を構造的に hoist）
const { useDeskAttachments, downloadAttachment, toastError } = vi.hoisted(() => ({
  useDeskAttachments: vi.fn(),
  downloadAttachment: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../hooks/use-desk-attachments', () => ({
  useDeskAttachments: (...a: unknown[]) => useDeskAttachments(...a),
}));
vi.mock('../components/file-picker-overlay', () => ({
  FilePickerOverlay: ({
    onPick,
    isDuplicateName,
  }: {
    onPick: (id: string, name: string) => void;
    isDuplicateName?: (name: string) => boolean;
  }) => (
    <div data-testid="file-picker">
      <button type="button" onClick={() => onPick('file-x', 'x.pdf')}>
        pick-file
      </button>
      {/* isDuplicateName の配線を dsk-0290 で検証するためのプローブ（実際のローカルタブ事前チェックの代替）。 */}
      <span data-testid="is-duplicate-x">{String(isDuplicateName?.('x.pdf') ?? 'undefined')}</span>
    </div>
  ),
}));
// 確定済添付ダウンロード（dsk-0251）をモックし、ファイル名押下で起動されることを検証する。
vi.mock('../lib/download-attachment', () => ({
  downloadAttachment: (...a: unknown[]) => downloadAttachment(...a),
}));
// ダウンロード失敗時の toast 通知（dsk-0261）を検証する。
vi.mock('react-hot-toast', () => ({ default: { error: (...a: unknown[]) => toastError(...a) } }));

import { TaskAttachments, AttachmentAddButton } from '../components/task-attachments';
import type { Attachment } from '../lib/api';
import type { UseDeskAttachmentsResult } from '../hooks/use-desk-attachments';

const att = (id: string, name: string): Attachment => ({
  id,
  fileId: `f-${id}`,
  fileName: name,
  versionNo: 1,
  byteSize: 10,
  mimeType: 'application/pdf',
  attachedBy: '山田',
  createdAt: '2026-06-01T00:00:00.000Z',
});

function setup(over: Partial<ReturnType<typeof baseHook>> = {}) {
  useDeskAttachments.mockReturnValue({ ...baseHook(), ...over });
  return render(<TaskAttachments targetType="task" targetId={1} />);
}

function baseHook(): {
  attachments: Attachment[];
  loading: boolean;
  error: string | null;
  mutating: boolean;
  add: Mock<UseDeskAttachmentsResult['add']>;
  remove: Mock<UseDeskAttachmentsResult['remove']>;
  reload: Mock<UseDeskAttachmentsResult['reload']>;
} {
  return {
    attachments: [],
    loading: false,
    error: null,
    mutating: false,
    add: vi.fn<UseDeskAttachmentsResult['add']>(),
    remove: vi.fn<UseDeskAttachmentsResult['remove']>(),
    reload: vi.fn<UseDeskAttachmentsResult['reload']>(),
  };
}

beforeEach(() => {
  useDeskAttachments.mockReset();
  downloadAttachment.mockReset();
  downloadAttachment.mockResolvedValue(undefined);
  toastError.mockReset();
});

describe('TaskAttachments — 表示状態', () => {
  it('読み込み中はスピナーを出すこと', () => {
    setup({ loading: true });
    expect(document.querySelector('.desk-ticket-file-state')).toBeInTheDocument();
  });

  it('エラー時は alert でメッセージを出すこと', () => {
    setup({ error: '添付の取得に失敗しました' });
    expect(screen.getByRole('alert')).toHaveTextContent('添付の取得に失敗しました');
  });

  it('空のとき空文言「添付ファイルはありません」は出さない（rete-desk-0084）', () => {
    setup({ attachments: [] });
    expect(screen.queryByText('添付ファイルはありません')).toBeNull();
    // 追加導線（ファイル添付ボタン）は空でも残る。
    expect(screen.getByRole('button', { name: /ファイル添付/ })).toBeInTheDocument();
  });

  it('添付一覧を描画し、各行に解除ボタンを置くこと', () => {
    setup({ attachments: [att('a', '仕様.pdf'), att('b', '図面.png')] });
    expect(screen.getByText('仕様.pdf')).toBeInTheDocument();
    expect(screen.getByText('図面.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '仕様.pdf を解除' })).toBeInTheDocument();
  });

  it('各添付のファイル名がダウンロードボタンとして描画されること（dsk-0251）', () => {
    setup({ attachments: [att('a', '仕様.pdf')] });
    expect(screen.getByRole('button', { name: '仕様.pdf をダウンロード' })).toBeInTheDocument();
  });
});

describe('TaskAttachments — 操作', () => {
  it('解除ボタン押下で remove(id) を呼ぶこと', () => {
    const remove = vi.fn();
    setup({ attachments: [att('a', '仕様.pdf')], remove });
    fireEvent.click(screen.getByRole('button', { name: '仕様.pdf を解除' }));
    expect(remove).toHaveBeenCalledWith('a');
  });

  it('ファイル名押下で downloadAttachment(該当添付) を呼ぶこと（dsk-0251）', async () => {
    setup({ attachments: [att('a', '仕様.pdf')] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '仕様.pdf をダウンロード' }));
    });
    expect(downloadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'f-a', fileName: '仕様.pdf' }),
    );
  });

  it('ダウンロード実行中は対象ボタンが disabled になり、連打で並列取得しないこと（dsk-0261）', async () => {
    let resolveDownload: () => void = () => undefined;
    downloadAttachment.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDownload = resolve;
      }),
    );
    setup({ attachments: [att('a', '仕様.pdf')] });
    const button = screen.getByRole('button', { name: '仕様.pdf をダウンロード' });

    fireEvent.click(button);
    fireEvent.click(button); // 連打
    await Promise.resolve();

    expect(downloadAttachment).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    await act(async () => {
      resolveDownload();
      await Promise.resolve();
    });
    expect(button).not.toBeDisabled();
  });

  it('ダウンロード失敗時は toast.error でエラー通知すること（dsk-0261）', async () => {
    downloadAttachment.mockRejectedValue(new Error('network error'));
    setup({ attachments: [att('a', '仕様.pdf')] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '仕様.pdf をダウンロード' }));
      await Promise.resolve();
    });
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('ダウンロードに失敗しました'));
  });

  it('保留チップ（versionNo:0・pending- id）はダウンロード導線を出さず「保存時に確定」ツールチップを出す（dsk-0265）', () => {
    // useDeferredAttachments が合成する未確定チップ。確定前のため版・添付者が無く、DL も不可にする
    // （コンポーザの PendingChipsRow と同方針）。
    const pending: Attachment = {
      ...att('x', '保留分.pdf'),
      id: 'pending-f-x',
      versionNo: 0,
      byteSize: 0,
      mimeType: '',
      attachedBy: '',
      createdAt: '',
    };
    setup({ attachments: [pending] });
    expect(screen.queryByRole('button', { name: '保留分.pdf をダウンロード' })).toBeNull();
    expect(screen.getByText('保留分.pdf')).toHaveAttribute('title', '保存時に確定');
  });

  it('「ファイル添付」押下でピッカーを開き、ファイル選択で add(fileId, fileName) を呼ぶこと（rete-desk-0086 / dsk-0265）', async () => {
    const add = vi.fn().mockResolvedValue(true);
    setup({ add });
    fireEvent.click(screen.getByRole('button', { name: /ファイル添付/ }));
    expect(screen.getByTestId('file-picker')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('pick-file'));
    });
    // fileName は保留（deferred）実装が確定前チップの表示名に使う（dsk-0265 で add へ追加）。
    expect(add).toHaveBeenCalledWith('file-x', 'x.pdf');
  });
});

describe('同名添付のブロック（dsk-0273）', () => {
  it('AttachmentPanel: 同名の確定済み添付があるファイルを選ぶと、ピッカーを閉じてトースト表示し add を呼ばないこと', async () => {
    const add = vi.fn();
    // FilePickerOverlay モックは常に x.pdf を選ぶ → 既存確定添付に同名を置く。
    setup({ attachments: [att('a', 'x.pdf')], add });
    fireEvent.click(screen.getByRole('button', { name: /ファイル添付/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('pick-file'));
    });
    expect(add).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('同名のファイルは既に添付されています');
    expect(screen.queryByTestId('file-picker')).toBeNull();
  });

  it('AttachmentPanel: 同名が保留チップ（未確定）のみの場合はブロックせず add を呼ぶこと（確定済み限定・スコープ外）', async () => {
    const pending: Attachment = {
      ...att('x', 'x.pdf'),
      id: 'pending-f-x',
      versionNo: 0,
    };
    const add = vi.fn().mockResolvedValue(true);
    setup({ attachments: [pending], add });
    fireEvent.click(screen.getByRole('button', { name: /ファイル添付/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('pick-file'));
    });
    expect(add).toHaveBeenCalledWith('file-x', 'x.pdf');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('AttachmentAddButton（チャット詳細メッセージ添付経路）: 同名の確定済み添付があると同じチェックが働くこと', async () => {
    const add = vi.fn();
    const controller = { ...baseHook(), attachments: [att('a', 'x.pdf')], add };
    render(<AttachmentAddButton controller={controller} />);
    fireEvent.click(screen.getByRole('button', { name: /ファイル添付/ }));
    await act(async () => {
      fireEvent.click(screen.getByText('pick-file'));
    });
    expect(add).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('同名のファイルは既に添付されています');
    expect(screen.queryByTestId('file-picker')).toBeNull();
  });

  it('AttachmentPanel: FilePickerOverlay へ isDuplicateName を配線し確定済み添付名で true を返すこと（dsk-0290・ローカルタブ事前チェックの孤児防止）', () => {
    setup({ attachments: [att('a', 'x.pdf')] });
    fireEvent.click(screen.getByRole('button', { name: /ファイル添付/ }));
    expect(screen.getByTestId('is-duplicate-x')).toHaveTextContent('true');
  });

  it('AttachmentAddButton: FilePickerOverlay へ isDuplicateName を配線し未確定なら false を返すこと（dsk-0290）', () => {
    const controller = { ...baseHook(), attachments: [] };
    render(<AttachmentAddButton controller={controller} />);
    fireEvent.click(screen.getByRole('button', { name: /ファイル添付/ }));
    expect(screen.getByTestId('is-duplicate-x')).toHaveTextContent('false');
  });
});
