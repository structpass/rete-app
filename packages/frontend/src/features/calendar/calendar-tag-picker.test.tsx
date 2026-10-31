import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TagPickerOverlay } from '@/components/tags/tag-picker-overlay';
vi.mock('@/components/ui/overlay-dialog', () => ({
  OverlayDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  OverlayCloseButton: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock('@/components/ui/overlay-header', () => ({ OverlayHeader: () => null }));
const tags = [
  { id: 'a', name: '赤', color: 'red' },
  { id: 'b', name: '青', color: 'blue' },
];
describe('calendar single tag picker without changing shared defaults', () => {
  it('replaces the existing selection and allows removing the selected tag', () => {
    const confirm = vi.fn();
    render(
      <TagPickerOverlay
        tags={tags}
        initialSelected={['a']}
        selectionMode="single"
        onConfirm={confirm}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: '青' }));
    expect(screen.getByRole('checkbox', { name: '赤' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(confirm).toHaveBeenLastCalledWith(['b']);
    fireEvent.click(screen.getByRole('checkbox', { name: '青' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(confirm).toHaveBeenLastCalledWith([]);
  });
  it('keeps multiple selection for existing consumers that do not specify a mode', () => {
    const confirm = vi.fn();
    render(
      <TagPickerOverlay
        tags={tags}
        initialSelected={['a']}
        onConfirm={confirm}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: '青' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(confirm).toHaveBeenCalledWith(['a', 'b']);
  });
});
