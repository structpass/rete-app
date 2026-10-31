import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import toast from 'react-hot-toast';
import { useTagMaster, type UseTagMasterOptions } from '@/hooks/use-tag-master';
import { TagMasterOverlay } from '../tag-master-overlay';

describe('タグ保存失敗の表示 — 実際の hook と画面の接続', () => {
  it.each(['create', 'update'] as const)(
    '%s の初回と再試行で、今回の理由を表示する',
    async (operation) => {
      const errorToast = vi.spyOn(toast, 'error');
      const save = vi
        .fn()
        .mockRejectedValueOnce({
          response: { data: { error: { message: '同名のタグがあります' } } },
        })
        .mockRejectedValueOnce({
          response: { data: { error: { message: 'タグの上限に達しました' } } },
        })
        .mockRejectedValueOnce(new Error('network'));
      const api: UseTagMasterOptions = {
        fetch: vi.fn().mockResolvedValue([{ id: 't1', name: '既存', icon: 'Tag', color: 'blue' }]),
        create: save,
        update: save,
        remove: vi.fn(),
      };
      function Harness() {
        return <TagMasterOverlay master={useTagMaster(api)} onClose={vi.fn()} />;
      }
      await act(async () => {
        render(<Harness />);
      });
      fireEvent.click(
        screen.getByRole('button', { name: operation === 'create' ? '新規登録' : '既存 を編集' }),
      );
      fireEvent.change(screen.getByPlaceholderText('タグ名'), {
        target: { value: '入力したタグ' },
      });

      const expected = [
        '同名のタグがあります',
        'タグの上限に達しました',
        operation === 'create'
          ? 'タグの追加に失敗しました（同名重複など）'
          : 'タグの更新に失敗しました（同名重複など）',
      ];
      for (const [index, message] of expected.entries()) {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: '保存' }));
        });
        expect(errorToast).toHaveBeenCalledTimes(index + 1);
        expect(errorToast).toHaveBeenLastCalledWith(message);
        expect(screen.getByPlaceholderText('タグ名')).toHaveValue('入力したタグ');
        expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
      }
    },
  );
});
