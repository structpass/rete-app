import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CalendarTagField } from './calendar-tag-field';
const tag = { id: 'tag', name: '定期イベント', icon: 'Calendar', color: 'red' };
describe('calendar tag field aligned with announcement tag chips', () => {
  it('renders a separate label, edit action and the shared outlined icon badge', () => {
    const edit = vi.fn();
    const { container } = render(<CalendarTagField tags={[tag]} disabled={false} onEdit={edit} />);
    expect(screen.getByText('タグ').closest('.calendar-tag-heading')).not.toBeNull();
    const name = screen.getByText('定期イベント');
    const badge = name.parentElement!;
    expect(badge).toHaveClass('border-input', 'rounded-full');
    expect(badge.querySelector('svg')).toHaveStyle({ color: '#dc2626' });
    expect(container.querySelector('.calendar-tags')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'タグを編集' }));
    expect(edit).toHaveBeenCalledTimes(1);
  });
  it('prevents tag edits while disabled and keeps the empty tag field available', () => {
    const edit = vi.fn();
    render(<CalendarTagField tags={[]} disabled={true} onEdit={edit} />);
    expect(screen.getByText('タグ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'タグを編集' }));
    expect(edit).not.toHaveBeenCalled();
  });
});
