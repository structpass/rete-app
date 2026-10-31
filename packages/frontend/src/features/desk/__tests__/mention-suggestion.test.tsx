import { describe, expect, it, vi } from 'vitest';
import { createMentionSuggestion } from '../components/mention-suggestion';

vi.mock('@tiptap/react', () => ({
  ReactRenderer: class {
    element = document.createElement('div');
    ref = { onKeyDown: () => false };
    updateProps() {}
    destroy() {}
  },
}));

describe('メンション候補の位置追従', () => {
  it('入れ子のscrollとresizeで最新のキャレット位置に追従し、終了後は解除する', () => {
    const render = createMentionSuggestion(() => []).render!();
    let left = 40;
    const props = {
      clientRect: () => new DOMRect(left, 500, 1, 20),
      editor: {},
      items: [],
      command: vi.fn(),
    } as never;
    render.onStart!(props);
    const anchor = document.querySelector<HTMLElement>('.desk-mention-popup-anchor')!;
    expect(anchor.style.left).toBe('40px');
    left = 80;
    const scroller = document.createElement('div');
    document.body.append(scroller);
    scroller.dispatchEvent(new Event('scroll'));
    expect(anchor.style.left).toBe('80px');
    left = 120;
    window.dispatchEvent(new Event('resize'));
    expect(anchor.style.left).toBe('120px');
    render.onExit!(props);
    expect(anchor.isConnected).toBe(false);
    left = 160;
    window.dispatchEvent(new Event('resize'));
    expect(anchor.style.left).toBe('120px');
    scroller.remove();
  });
});
