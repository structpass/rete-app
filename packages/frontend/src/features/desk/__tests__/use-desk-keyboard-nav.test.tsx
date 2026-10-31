import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, act } from '@testing-library/react';
import { useDeskKeyboardNav, type DeskKeyboardNavArgs } from '../hooks/use-desk-keyboard-nav';
import { applyQuietFocus } from '../utils/quiet-focus';

/**
 * Desk キーボードナビ フック（モック desk/index.html の ↑↓ ← → / Tab 移植）。
 *
 * jsdom は layout を持たず offsetParent が常に null・getBoundingClientRect が 0 のため、
 * - 可視判定は「!is-pending && 祖先 .desk-view が is-active」で行う（display:none の非アクティブ view を除外）
 * - ←→ の最近傍テストでは getBoundingClientRect を行ごとに差し替えて縦中心を与える
 */

type Harness = {
  leftView?: 'list' | 'detail' | 'promote';
  rightView?: 'tree' | 'thread';
  openThread: Mock<DeskKeyboardNavArgs['openThread']>;
  openTaskDetail: Mock<DeskKeyboardNavArgs['openTaskDetail']>;
  closeLeft: Mock<DeskKeyboardNavArgs['closeLeft']>;
  closeRight: Mock<DeskKeyboardNavArgs['closeRight']>;
  setActiveTheme: Mock<DeskKeyboardNavArgs['setActiveTheme']>;
  setActiveTask: Mock<DeskKeyboardNavArgs['setActiveTask']>;
};

function Fixture(props: DeskKeyboardNavArgs) {
  useDeskKeyboardNav(props);
  const leftActive = (props.leftView ?? 'list') === 'list';
  const treeActive = (props.rightView ?? 'tree') === 'tree';
  const threadActive = (props.rightView ?? 'tree') === 'thread';
  const detailActive = (props.leftView ?? 'list') === 'detail';
  return (
    <div>
      <div className={`desk-view${leftActive ? ' is-active' : ''}`} data-left-view="list">
        <button className="desk-chat-card" data-theme-id="t1">
          A
        </button>
        <button className="desk-chat-card" data-theme-id="t2">
          B
        </button>
        <button className="desk-chat-card" data-theme-id="t3">
          C
        </button>
      </div>
      <div className={`desk-view${detailActive ? ' is-active' : ''}`} data-left-view="detail" />
      <div className={`desk-view${treeActive ? ' is-active' : ''}`} data-right-view="tree">
        <button className="desk-task-row" data-task-id="11">
          X
        </button>
        <button className="desk-task-row" data-task-id="22">
          Y
        </button>
      </div>
      <div className={`desk-view${threadActive ? ' is-active' : ''}`} data-right-view="thread" />
    </div>
  );
}

function setup(h: Harness) {
  const args: DeskKeyboardNavArgs = {
    leftView: h.leftView ?? 'list',
    rightView: h.rightView ?? 'tree',
    openThread: h.openThread,
    openTaskDetail: h.openTaskDetail,
    closeLeft: h.closeLeft,
    closeRight: h.closeRight,
    setActiveTheme: h.setActiveTheme,
    setActiveTask: h.setActiveTask,
  };
  const utils = render(<Fixture {...args} />);
  const cards = Array.from(utils.container.querySelectorAll<HTMLButtonElement>('.desk-chat-card'));
  const rows = Array.from(utils.container.querySelectorAll<HTMLButtonElement>('.desk-task-row'));
  return { ...utils, cards, rows };
}

function mockRect(el: HTMLElement, top: number, height = 20) {
  el.getBoundingClientRect = () =>
    ({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function press(key: string, opts: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
    );
  });
}

function harness(): Harness {
  return {
    openThread: vi.fn<DeskKeyboardNavArgs['openThread']>(),
    openTaskDetail: vi.fn<DeskKeyboardNavArgs['openTaskDetail']>(),
    closeLeft: vi.fn<DeskKeyboardNavArgs['closeLeft']>(),
    closeRight: vi.fn<DeskKeyboardNavArgs['closeRight']>(),
    setActiveTheme: vi.fn<DeskKeyboardNavArgs['setActiveTheme']>(),
    setActiveTask: vi.fn<DeskKeyboardNavArgs['setActiveTask']>(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useDeskKeyboardNav — ↑↓ チャット明細移動（0012）', () => {
  it('ArrowDown で次のチャットカードへフォーカスが移る', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[0].focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(cards[1]);
  });

  it('ArrowUp で前のチャットカードへフォーカスが移る', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[2].focus();
    press('ArrowUp');
    expect(document.activeElement).toBe(cards[1]);
  });

  it('末尾で ArrowDown してもフォーカスは動かない（edge-stop）', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[2].focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(cards[2]);
  });
});

describe('useDeskKeyboardNav — ↑↓ タスク明細移動（0013）', () => {
  it('ArrowDown で次のタスク行へフォーカスが移る', () => {
    const h = harness();
    const { rows } = setup(h);
    rows[0].focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
  });
});

describe('useDeskKeyboardNav — オーバーレイ追従（0033 / 0034）', () => {
  it('チャット詳細表示中の ArrowDown で openThread(次テーマ) を呼ぶ', () => {
    const h = harness();
    const { cards } = setup({ ...h, rightView: 'thread' });
    cards[0].focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(cards[1]);
    expect(h.openThread).toHaveBeenCalledWith('t2');
  });

  it('タスク詳細表示中の ArrowDown で openTaskDetail(次タスク) を呼ぶ', () => {
    const h = harness();
    const { rows } = setup({ ...h, leftView: 'detail' });
    rows[0].focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    expect(h.openTaskDetail).toHaveBeenCalledWith(22);
  });

  it('チャット詳細を開いていない時の ArrowDown では openThread を呼ばない', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[0].focus();
    press('ArrowDown');
    expect(h.openThread).not.toHaveBeenCalled();
  });
});

describe('useDeskKeyboardNav — Tab パネル移動パリティ', () => {
  it('チャット詳細表示中に Tab でチャット明細を次へ送り openThread も切替', () => {
    const h = harness();
    const { cards } = setup({ ...h, rightView: 'thread' });
    cards[0].focus();
    press('Tab');
    expect(document.activeElement).toBe(cards[1]);
    expect(h.openThread).toHaveBeenCalledWith('t2');
  });

  it('Shift+Tab で前へ送る', () => {
    const h = harness();
    const { cards } = setup({ ...h, rightView: 'thread' });
    cards[1].focus();
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(cards[0]);
    expect(h.openThread).toHaveBeenCalledWith('t1');
  });

  it('オーバーレイ非表示時の Tab は素通し（フォーカスを奪わない）', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[0].focus();
    press('Tab');
    expect(document.activeElement).toBe(cards[0]);
    expect(h.openThread).not.toHaveBeenCalled();
  });
});

describe('useDeskKeyboardNav — → タスク明細へ最近傍（0014・同期: 詳細未表示）', () => {
  it('チャットカードの縦中心に最も近いタスク行へフォーカス', () => {
    const h = harness();
    const { cards, rows } = setup(h);
    mockRect(cards[0], 100);
    mockRect(rows[0], 300);
    mockRect(rows[1], 110); // card中心110に近い → rows[1]
    cards[0].focus();
    press('ArrowRight');
    expect(document.activeElement).toBe(rows[1]);
    expect(h.closeRight).not.toHaveBeenCalled();
  });
});

describe('useDeskKeyboardNav — ← チャット明細へ最近傍（0015・同期: 詳細未表示）', () => {
  it('タスク行の縦中心に最も近いチャットカードへフォーカス', () => {
    const h = harness();
    const { cards, rows } = setup(h);
    mockRect(rows[0], 200);
    mockRect(cards[0], 500);
    mockRect(cards[1], 210);
    mockRect(cards[2], 800);
    rows[0].focus();
    press('ArrowLeft');
    expect(document.activeElement).toBe(cards[1]);
    expect(h.closeLeft).not.toHaveBeenCalled();
  });
});

describe('useDeskKeyboardNav — ← / → 遅延最近傍（オーバーレイを閉じて再描画後）', () => {
  function Stateful({
    openThread,
    openTaskDetail,
    setActiveTask = () => {},
  }: {
    openThread: () => void;
    openTaskDetail: () => void;
    setActiveTask?: (id: number) => void;
  }) {
    const [rightView, setRightView] = React.useState<'tree' | 'thread'>('thread');
    useDeskKeyboardNav({
      leftView: 'list',
      rightView,
      openThread,
      openTaskDetail,
      closeLeft: () => {},
      closeRight: () => setRightView('tree'),
      setActiveTheme: () => {},
      setActiveTask,
    });
    const treeActive = rightView === 'tree';
    const threadActive = rightView === 'thread';
    return (
      <div>
        <div className="desk-view is-active" data-left-view="list">
          <button className="desk-chat-card" data-theme-id="t1">
            A
          </button>
        </div>
        <div className={`desk-view${treeActive ? ' is-active' : ''}`} data-right-view="tree">
          <button className="desk-task-row" data-task-id="11">
            X
          </button>
          <button className="desk-task-row" data-task-id="22">
            Y
          </button>
        </div>
        <div className={`desk-view${threadActive ? ' is-active' : ''}`} data-right-view="thread" />
      </div>
    );
  }

  it('チャット詳細表示中の → で closeRight 後にタスク明細の最近傍へフォーカス', () => {
    const utils = render(<Stateful openThread={() => {}} openTaskDetail={() => {}} />);
    const card = utils.container.querySelector<HTMLButtonElement>('.desk-chat-card')!;
    const rows = Array.from(utils.container.querySelectorAll<HTMLButtonElement>('.desk-task-row'));
    mockRect(card, 100);
    mockRect(rows[0], 400);
    mockRect(rows[1], 105); // card中心105付近 → rows[1]
    card.focus();
    press('ArrowRight');
    // closeRight→再描画→effectで最近傍フォーカスが解決している
    expect(document.activeElement).toBe(rows[1]);
  });
});

describe('useDeskKeyboardNav — アクティブ枠のカーソル追従（dsk-0410）', () => {
  it('詳細を閉じた状態の ↑↓ でも setActiveTheme(移動先) を呼ぶ（枠だけ追従・開かない）', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[0].focus();
    press('ArrowDown');
    expect(h.setActiveTheme).toHaveBeenCalledWith('t2');
    expect(h.openThread).not.toHaveBeenCalled();
  });

  it('詳細を閉じた状態のタスク ↑↓ でも setActiveTask(移動先) を呼ぶ', () => {
    const h = harness();
    const { rows } = setup(h);
    rows[0].focus();
    press('ArrowDown');
    expect(h.setActiveTask).toHaveBeenCalledWith(22);
    expect(h.openTaskDetail).not.toHaveBeenCalled();
  });

  it('→（同期経路）で移動先タスク行に setActiveTask を呼ぶ（移動元枠は view-state 側の相互排他で消える）', () => {
    const h = harness();
    const { cards, rows } = setup(h);
    mockRect(cards[0], 100);
    mockRect(rows[0], 300);
    mockRect(rows[1], 110);
    cards[0].focus();
    press('ArrowRight');
    expect(document.activeElement).toBe(rows[1]);
    expect(h.setActiveTask).toHaveBeenCalledWith(22);
  });

  it('←（同期経路）で移動先チャットカードに setActiveTheme を呼ぶ', () => {
    const h = harness();
    const { cards, rows } = setup(h);
    mockRect(rows[0], 200);
    mockRect(cards[0], 500);
    mockRect(cards[1], 210);
    mockRect(cards[2], 800);
    rows[0].focus();
    press('ArrowLeft');
    expect(document.activeElement).toBe(cards[1]);
    expect(h.setActiveTheme).toHaveBeenCalledWith('t2');
  });

  it('移動先が無い ←→ では setActive* を呼ばない（カーソル不動＝枠も不動）', () => {
    const h = harness();
    // タスク行なしの DOM を作る（tree は空）
    const utils = render(
      <FixtureEmptyTree
        {...({
          leftView: 'list',
          rightView: 'tree',
          openThread: h.openThread,
          openTaskDetail: h.openTaskDetail,
          closeLeft: h.closeLeft,
          closeRight: h.closeRight,
          setActiveTheme: h.setActiveTheme,
          setActiveTask: h.setActiveTask,
        } satisfies DeskKeyboardNavArgs)}
      />,
    );
    const card = utils.container.querySelector<HTMLButtonElement>('.desk-chat-card')!;
    card.focus();
    press('ArrowRight');
    expect(h.setActiveTask).not.toHaveBeenCalled();
  });

  it('チャット詳細表示中の ↑↓ は openThread に加えて setActiveTheme も呼ぶ（枠と詳細が一体で追従）', () => {
    const h = harness();
    const { cards } = setup({ ...h, rightView: 'thread' });
    cards[0].focus();
    press('ArrowDown');
    expect(h.openThread).toHaveBeenCalledWith('t2');
    expect(h.setActiveTheme).toHaveBeenCalledWith('t2');
  });
});

describe('useDeskKeyboardNav — 遅延経路（オーバーレイを閉じて→）のアクティブ枠追従（dsk-0410）', () => {
  it('チャット詳細表示中の → は閉じた後の最近傍タスク行に setActiveTask を呼ぶ', () => {
    const setActiveTask = vi.fn();
    const utils = render(<StatefulDeferred setActiveTask={setActiveTask} />);
    const card = utils.container.querySelector<HTMLButtonElement>('.desk-chat-card')!;
    const rows = Array.from(utils.container.querySelectorAll<HTMLButtonElement>('.desk-task-row'));
    mockRect(card, 100);
    mockRect(rows[0], 400);
    mockRect(rows[1], 105);
    card.focus();
    press('ArrowRight');
    expect(document.activeElement).toBe(rows[1]);
    expect(setActiveTask).toHaveBeenCalledWith(22);
  });
});

function FixtureEmptyTree(props: DeskKeyboardNavArgs) {
  useDeskKeyboardNav(props);
  return (
    <div>
      <div className="desk-view is-active" data-left-view="list">
        <button className="desk-chat-card" data-theme-id="t1">
          A
        </button>
      </div>
      <div className="desk-view is-active" data-right-view="tree" />
      <div className="desk-view" data-right-view="thread" />
    </div>
  );
}

function StatefulDeferred({ setActiveTask }: { setActiveTask: (id: number) => void }) {
  const [rightView, setRightView] = React.useState<'tree' | 'thread'>('thread');
  useDeskKeyboardNav({
    leftView: 'list',
    rightView,
    openThread: () => {},
    openTaskDetail: () => {},
    closeLeft: () => {},
    closeRight: () => setRightView('tree'),
    setActiveTheme: () => {},
    setActiveTask,
  });
  const treeActive = rightView === 'tree';
  return (
    <div>
      <div className="desk-view is-active" data-left-view="list">
        <button className="desk-chat-card" data-theme-id="t1">
          A
        </button>
      </div>
      <div className={`desk-view${treeActive ? ' is-active' : ''}`} data-right-view="tree">
        <button className="desk-task-row" data-task-id="11">
          X
        </button>
        <button className="desk-task-row" data-task-id="22">
          Y
        </button>
      </div>
      <div className={`desk-view${treeActive ? '' : ' is-active'}`} data-right-view="thread" />
    </div>
  );
}

describe('useDeskKeyboardNav — 閉じ直後の枠抑止引き継ぎ（dsk-0392）', () => {
  it('data-quiet-focus 保持行からの ArrowDown は移動先へ目印を引き継ぐ', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[0].focus();
    act(() => applyQuietFocus(cards[0])); // Esc/トグル閉じ直後の状態を再現
    press('ArrowDown');
    expect(document.activeElement).toBe(cards[1]);
    expect(cards[1].hasAttribute('data-quiet-focus')).toBe(true);
    // 移動元の目印は focusout で外れる（残留させない）
    expect(cards[0].hasAttribute('data-quiet-focus')).toBe(false);
  });

  it('連続する ↑↓ 移動では目印を引き継ぎ続ける（閉じ起点の一連の移動で枠を出さない仕様）', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[0].focus();
    act(() => applyQuietFocus(cards[0]));
    press('ArrowDown');
    press('ArrowDown');
    expect(document.activeElement).toBe(cards[2]);
    expect(cards[2].hasAttribute('data-quiet-focus')).toBe(true);
    expect(cards[0].hasAttribute('data-quiet-focus')).toBe(false);
    expect(cards[1].hasAttribute('data-quiet-focus')).toBe(false);
  });

  it('目印なし行からの ArrowDown では移動先に目印を付けない（Tab 到達時の枠維持）', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[0].focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(cards[1]);
    expect(cards[1].hasAttribute('data-quiet-focus')).toBe(false);
  });
});

describe('useDeskKeyboardNav — 素通し条件', () => {
  it('input にフォーカス中の ArrowDown は無視（IME/入力を尊重）', () => {
    const h = harness();
    const { container } = setup(h);
    const input = document.createElement('input');
    container.querySelector('[data-left-view="list"]')!.appendChild(input);
    input.focus();
    const before = document.activeElement;
    press('ArrowDown');
    expect(document.activeElement).toBe(before);
    expect(h.openThread).not.toHaveBeenCalled();
  });

  it('IME 変換中（isComposing）の ArrowDown は素通し', () => {
    const h = harness();
    const { cards } = setup(h);
    cards[0].focus();
    // isComposing は KeyboardEvent では明示できないため getModifierState 経由ではなく
    // dispatch オプションで模す（フック側は e.isComposing を見る）。
    act(() => {
      const ev = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(ev, 'isComposing', { value: true });
      window.dispatchEvent(ev);
    });
    expect(document.activeElement).toBe(cards[0]);
  });
});
