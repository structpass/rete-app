import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Profiler } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ResolvedTab } from '../../lib/nav-config';
import { AppHeader } from '../app-header';

// set-0105: AppHeader は TenantInfoProvider 必須。単体 render 用に favorites と同型で stub。
// cmn-0142: vi.hoisted 化
const { fnSetTenantInfo, fnRefetchTenantInfo } = vi.hoisted(() => ({
  fnSetTenantInfo: vi.fn(),
  fnRefetchTenantInfo: vi.fn(),
}));

vi.mock('../../hooks/tenant-info-context', () => ({
  useTenantInfoContext: () => ({
    tenantInfo: { name: '開発法人', badgeColor: 'green' as const },
    loading: false,
    setTenantInfo: fnSetTenantInfo,
    refetch: fnRefetchTenantInfo,
  }),
}));

const tabs: ResolvedTab[] = [
  { key: 'home', label: 'Home', href: '/hub', active: true, disabled: false, external: false },
  { key: 'desk', label: 'デスク', href: '/desk', active: false, disabled: false, external: false },
  { key: 'mock', label: 'モック', href: null, active: false, disabled: true, external: false },
];

function renderHeader(
  overrides: { onSelectTab?: (tab: ResolvedTab) => void; onLogout?: () => void } = {},
) {
  return render(
    <AppHeader
      tabs={tabs}
      userName="開発統括"
      onSelectTab={overrides.onSelectTab ?? vi.fn()}
      onLogout={overrides.onLogout ?? vi.fn()}
    />,
  );
}

const tabButton = (label: string) => screen.getByRole('button', { name: label });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AppHeader テナントバッジ（set-0105 / set-0118）', () => {
  it('テナント名バッジのみを表示し「開発環境」バッジは出さない（set-0118）', () => {
    renderHeader();
    expect(screen.getByLabelText('テナント 開発法人')).toHaveTextContent('開発法人');
    expect(screen.queryByLabelText('開発環境')).not.toBeInTheDocument();
  });
});

describe('AppHeader タブナビ', () => {
  it('初期はアクティブタブがレンズ対象になる', () => {
    renderHeader();
    expect(tabButton('Home')).toHaveClass('tab-lensed');
    expect(tabButton('デスク')).not.toHaveClass('tab-lensed');
  });

  it('キーボードフォーカスでもホバーと同じくレンズ対象が移る', () => {
    renderHeader();
    fireEvent.focus(tabButton('デスク'));
    expect(tabButton('デスク')).toHaveClass('tab-lensed');
    expect(tabButton('Home')).not.toHaveClass('tab-lensed');
  });

  it('nav の外へフォーカスが抜けたらアクティブタブへ戻る', () => {
    renderHeader();
    fireEvent.focus(tabButton('デスク'));
    fireEvent.blur(tabButton('デスク'), { relatedTarget: document.body });
    expect(tabButton('Home')).toHaveClass('tab-lensed');
  });

  it('nav 内の別タブへフォーカスが移る間はレンズ対象を落とさない', () => {
    renderHeader();
    fireEvent.focus(tabButton('Home'));
    fireEvent.blur(tabButton('Home'), { relatedTarget: tabButton('デスク') });
    fireEvent.focus(tabButton('デスク'));
    expect(tabButton('デスク')).toHaveClass('tab-lensed');
  });

  it('disabled タブはフォーカスでもレンズ対象にならない', () => {
    renderHeader();
    fireEvent.focus(tabButton('モック'));
    expect(tabButton('モック')).not.toHaveClass('tab-lensed');
    expect(tabButton('Home')).toHaveClass('tab-lensed');
  });

  it('disabled タブへの mouseEnter はレンズ対象を変えない', () => {
    renderHeader();
    fireEvent.mouseEnter(tabButton('モック'));
    expect(tabButton('モック')).not.toHaveClass('tab-lensed');
    expect(tabButton('Home')).toHaveClass('tab-lensed');
  });

  it('nav 全体から mouseLeave するとレンズ対象がアクティブタブへ戻る', () => {
    const { container } = renderHeader();
    fireEvent.mouseEnter(tabButton('デスク'));
    expect(tabButton('デスク')).toHaveClass('tab-lensed');

    fireEvent.mouseLeave(container.querySelector('nav') as HTMLElement);
    expect(tabButton('Home')).toHaveClass('tab-lensed');
  });
});

describe('AppHeader タブ選択/ログアウト', () => {
  it('有効タブをクリックすると onSelectTab がそのタブで呼ばれる', () => {
    const onSelectTab = vi.fn();
    renderHeader({ onSelectTab });
    fireEvent.click(tabButton('デスク'));
    expect(onSelectTab).toHaveBeenCalledWith(tabs[1]);
  });

  it('disabled タブをクリックしても onSelectTab は呼ばれない', () => {
    const onSelectTab = vi.fn();
    renderHeader({ onSelectTab });
    fireEvent.click(tabButton('モック'));
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it('ログアウトボタンをクリックすると onLogout が呼ばれる', () => {
    const onLogout = vi.fn();
    renderHeader({ onLogout });
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe('AppHeader ピルの駆動', () => {
  it('位置は translate3d(x, y) で駆動し left/top は使わない（縦は offsetTop 計測）', () => {
    const { container } = renderHeader();
    const pill = container.querySelector('.nav-pill') as HTMLElement;

    expect(pill.style.transform).toBe('translate3d(0px, 0px, 0)');
    expect(pill.style.left).toBe('');
    expect(pill.style.top).toBe('');
  });

  // 開発統括指示 2026-07-18（brd-0190）: 白ピルはホバー先へ追従せず、選択中（active）タブに固定される。
  // ホバーの表現は別要素（.nav-hoverband）が担うため、ピルの追従条件は「対象タブ（active）が
  // 変わること」に変わった（旧: mouseEnter で hoverIdx が変わると追従）。
  it('active タブが変わると translate3d の X/Y が計測値へ追従する', () => {
    const { container, rerender } = renderHeader();
    const pill = container.querySelector('.nav-pill') as HTMLElement;

    // jsdom は offsetLeft/offsetTop を常に 0 で返すので、active 切替前に新しい対象タブの計測値を作る
    // （key が同じなので DOM ノードは rerender をまたいで同一参照のまま残る）。
    Object.defineProperty(tabButton('デスク'), 'offsetLeft', { value: 84, configurable: true });
    Object.defineProperty(tabButton('デスク'), 'offsetTop', { value: 2, configurable: true });

    const deskActiveTabs: ResolvedTab[] = tabs.map((t) => ({ ...t, active: t.key === 'desk' }));
    rerender(
      <AppHeader
        tabs={deskActiveTabs}
        userName="開発統括"
        onSelectTab={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    expect(pill.style.transform).toBe('translate3d(84px, 2px, 0)');
  });

  // AppShell は各 page が持つのでタブ遷移のたび AppHeader ごと再マウントされる。
  // 初回は left:0/width:0 で一度描かれるため、transition を殺しておかないと
  // ピルが「左からスライドしてくる」誤アニメになる（hom-0114 の差し戻し）。
  it('初回の位置決めが済むまで transition を殺すクラスが付く', () => {
    // 計測が成立する幅（offsetWidth）を与えたうえで rAF を発火させず、
    // 「計測済みだが次フレームがまだ来ていない」マウント直後の一瞬を再現する。
    const proto = Object.getPrototypeOf(document.createElement('button'));
    const offsetWidth = vi.spyOn(proto, 'offsetWidth', 'get').mockReturnValue(60 as never);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1 as never);

    const { container } = renderHeader();

    expect(container.querySelector('.nav-pill')).toHaveClass('nav-pill-init');
    expect(raf).toHaveBeenCalled();
    raf.mockRestore();
    offsetWidth.mockRestore();
  });

  it('計測が済んだ次のフレームで transition が復帰する', () => {
    const { container, rerender } = renderHeader();

    // jsdom は offsetWidth を 0 で返すので、次に active になるタブへ計測が成立する幅を作る。
    Object.defineProperty(tabButton('デスク'), 'offsetWidth', { value: 60, configurable: true });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });

    const deskActiveTabs: ResolvedTab[] = tabs.map((t) => ({ ...t, active: t.key === 'desk' }));
    act(() => {
      rerender(
        <AppHeader
          tabs={deskActiveTabs}
          userName="開発統括"
          onSelectTab={vi.fn()}
          onLogout={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('.nav-pill')).not.toHaveClass('nav-pill-init');
  });
});

describe('AppHeader ピル計測', () => {
  const resizeCalls = (spy: { mock: { calls: ReadonlyArray<readonly unknown[]> } }) =>
    spy.mock.calls.filter(([type]) => type === 'resize').length;

  it('resize 監視はマウント時 1 回だけで、ホバーしても張り直さない', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    renderHeader();

    expect(resizeCalls(add)).toBe(1);

    fireEvent.mouseEnter(tabButton('デスク'));
    fireEvent.mouseEnter(tabButton('Home'));

    expect(resizeCalls(add)).toBe(1);
    expect(resizeCalls(remove)).toBe(0);
  });

  // rete-top-0003: document.fonts.ready 解決後の再計測を jsdom でも検証する（MEDIUM 退避分）。
  it('document.fonts.ready が解決すると remeasure（再計測）が走る', async () => {
    // Object.defineProperty は vi.spyOn 経由でないため afterEach(vi.restoreAllMocks) では
    // 復元されない。放置すると後続テストが leak した document.fonts.ready を拾い、順序依存の
    // flaky を招く（quality-review rete-top-0003 MEDIUM）ので try/finally で明示的に戻す。
    const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready },
    });

    try {
      const { container } = renderHeader();
      const pill = container.querySelector('.nav-pill') as HTMLElement;

      Object.defineProperty(tabButton('Home'), 'offsetLeft', { value: 0, configurable: true });
      Object.defineProperty(tabButton('Home'), 'offsetWidth', { value: 96, configurable: true });

      await act(async () => {
        resolveReady();
        await ready;
        // .then(remeasure) の microtask を消化
        await Promise.resolve();
      });

      expect(pill.style.width).toBe('96px');
    } finally {
      if (originalFonts) {
        Object.defineProperty(document, 'fonts', originalFonts);
      } else {
        delete (document as unknown as { fonts?: unknown }).fonts;
      }
    }
  });

  // rete-top-0003: unmount 時に resize 監視を外すこと（LOW 退避分）。
  it('アンマウント時に window.removeEventListener(resize) が 1 回呼ばれる', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHeader();

    const resizeHandler = add.mock.calls.find(([type]) => type === 'resize')?.[1];
    expect(resizeHandler).toBeTypeOf('function');

    unmount();

    expect(resizeCalls(remove)).toBe(1);
    expect(remove).toHaveBeenCalledWith('resize', resizeHandler);
  });

  // cmn-0103: テナントバッジ後着などヘッダ内レイアウトシフトへの追従。
  // jsdom に ResizeObserver が無いので stub し、observe 対象と snap 挙動を検証する。
  describe('レイアウトシフト追従（cmn-0103）', () => {
    class ResizeObserverStub {
      static instances: ResizeObserverStub[] = [];
      callback: ResizeObserverCallback;
      observed: Element[] = [];
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        ResizeObserverStub.instances.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnected = false;
      disconnect() {
        this.disconnected = true;
        this.observed = [];
      }
    }

    beforeEach(() => {
      ResizeObserverStub.instances = [];
      vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    });

    it('nav と全タブを ResizeObserver で監視する', () => {
      const { container } = renderHeader();
      const observer = ResizeObserverStub.instances.at(-1)!;
      const nav = container.querySelector('nav') as HTMLElement;

      expect(observer.observed).toContain(nav);
      for (const el of Array.from(container.querySelectorAll('.tab-link'))) {
        expect(observer.observed).toContain(el);
      }
    });

    // cmn-0104: resize リスナと対をなす後片付けの検証（RO 側が欠けていた）。
    it('アンマウント時に ResizeObserver を disconnect する', () => {
      const { unmount } = renderHeader();
      const observer = ResizeObserverStub.instances.at(-1)!;
      expect(observer.disconnected).toBe(false);

      unmount();

      expect(observer.disconnected).toBe(true);
    });

    // cmn-0104: tabs の中身が変わるとタブ DOM が入れ替わるので observer を張り直す（deps=[tabs]）。
    it('tabs が変わると observer を張り直し、新しいタブも監視対象に入る', () => {
      const { container, rerender } = render(
        <AppHeader tabs={tabs} userName="開発統括" onSelectTab={vi.fn()} onLogout={vi.fn()} />,
      );
      const first = ResizeObserverStub.instances.at(-1)!;
      const beforeCount = ResizeObserverStub.instances.length;

      const nextTabs: ResolvedTab[] = [
        ...tabs,
        {
          key: 'files',
          label: 'ファイル',
          href: '/files',
          active: false,
          disabled: false,
          external: false,
        },
      ];
      rerender(
        <AppHeader tabs={nextTabs} userName="開発統括" onSelectTab={vi.fn()} onLogout={vi.fn()} />,
      );

      expect(first.disconnected).toBe(true);
      expect(ResizeObserverStub.instances.length).toBe(beforeCount + 1);

      const next = ResizeObserverStub.instances.at(-1)!;
      const links = Array.from(container.querySelectorAll('.tab-link'));
      expect(links).toHaveLength(nextTabs.length);
      for (const el of links) expect(next.observed).toContain(el);
    });

    // cmn-0104: 同一参照の tabs（AppShell 側で useMemo 済み）なら張り直さない＝過剰再生成の再発防止。
    it('tabs の参照が同じ再レンダーでは observer を張り直さない', () => {
      const { rerender } = render(
        <AppHeader tabs={tabs} userName="開発統括" onSelectTab={vi.fn()} onLogout={vi.fn()} />,
      );
      const beforeCount = ResizeObserverStub.instances.length;

      rerender(<AppHeader tabs={tabs} userName="別名" onSelectTab={vi.fn()} onLogout={vi.fn()} />);

      expect(ResizeObserverStub.instances.length).toBe(beforeCount);
    });

    it('レイアウト変化の再計測は snap（transition 抑止）で瞬時適用し、次フレームで復帰する', () => {
      // rAF を手動フラッシュ制にして「snap 適用中の 1 フレーム」を観測する。
      let rafQueue: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
      const flushRaf = () => {
        const queue = rafQueue;
        rafQueue = [];
        act(() => queue.forEach((cb) => cb(0)));
      };
      // 初回計測を成立させて settled を立てる（nav-pill-init の初期分を先に消化）。
      const proto = Object.getPrototypeOf(document.createElement('button'));
      vi.spyOn(proto, 'offsetWidth', 'get').mockReturnValue(60 as never);

      const { container } = renderHeader();
      flushRaf();
      const pill = container.querySelector('.nav-pill') as HTMLElement;
      expect(pill).not.toHaveClass('nav-pill-init');

      // バッジ後着相当: アクティブタブ（Home）の位置がシフトした状態で RO が発火する。
      Object.defineProperty(tabButton('Home'), 'offsetLeft', { value: 40, configurable: true });
      const observer = ResizeObserverStub.instances.at(-1)!;
      act(() => observer.callback([], observer as unknown as ResizeObserver));

      // 新位置へ瞬時追従（transition 抑止クラスが付いている）
      expect(pill.style.transform).toBe('translate3d(40px, 0px, 0)');
      expect(pill).toHaveClass('nav-pill-init');

      // 次フレームで transition 復帰（以降の hover 移動はアニメする）
      flushRaf();
      expect(pill).not.toHaveClass('nav-pill-init');
    });

    it('計測値が変わらない RO 発火では snap しない（nav-pill-init が付かない）', () => {
      // rAF は手動フラッシュ制（即時実行にすると snap→復帰が一瞬で終わり検証が空振りする）。
      let rafQueue: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
      const flushRaf = () => {
        const queue = rafQueue;
        rafQueue = [];
        act(() => queue.forEach((cb) => cb(0)));
      };
      const proto = Object.getPrototypeOf(document.createElement('button'));
      vi.spyOn(proto, 'offsetWidth', 'get').mockReturnValue(60 as never);

      const { container } = renderHeader();
      flushRaf();
      const pill = container.querySelector('.nav-pill') as HTMLElement;
      expect(pill).not.toHaveClass('nav-pill-init');

      // 計測値が変わらないまま RO が発火（rAF は流さない＝snap したら class が残るはず）
      const observer = ResizeObserverStub.instances.at(-1)!;
      act(() => observer.callback([], observer as unknown as ResizeObserver));

      expect(pill).not.toHaveClass('nav-pill-init');
    });
  });

  it('計測値が変わらない resize では再レンダーしない／変わった時だけ再レンダーする', () => {
    let commits = 0;
    render(
      <Profiler id="header" onRender={() => (commits += 1)}>
        <AppHeader tabs={tabs} userName="開発統括" onSelectTab={vi.fn()} onLogout={vi.fn()} />
      </Profiler>,
    );

    commits = 0;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(commits).toBe(0);

    // jsdom は offsetLeft/offsetWidth を常に 0 で返すので、計測値の変化を明示的に作る。
    Object.defineProperty(tabButton('Home'), 'offsetWidth', { value: 120, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(commits).toBe(1);
  });
});
