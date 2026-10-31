'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { FOCUSABLE_SELECTOR } from '@/lib/focus-utils';
import { useDiscardConfirm } from '@/hooks/use-discard-confirm';
import { DiscardConfirmDialog } from '@/components/ui/discard-confirm-dialog';

// ─────────────────────────────────────────────────────────────────────────────
// 背景隔離マネージャ（モジュールスコープ）
//
// 複数の OverlayDialog が同時に開く（例: フォームを開いたまま非同期完了で結果オーバーレイが
// 重なる）と、各インスタンスが独立に inert を save/restore すると「後勝ちの復元」で元状態が
// 取り違えられ、全部閉じても背景の inert が永続的に true で残る。これを防ぐため、開いている
// オーバーレイ root を集合管理し、元状態は要素ごとに最初の1回だけ保存・最後の1つが閉じた
// 時だけ一括復元する。
// ─────────────────────────────────────────────────────────────────────────────

const activeRoots = new Set<HTMLElement>();
const savedBgState = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();

/** body 直下の非オーバーレイ要素を inert + aria-hidden で隔離する（元状態は初回のみ保存）。 */
function lockBackground() {
  for (const el of Array.from(document.body.children) as HTMLElement[]) {
    if (activeRoots.has(el)) continue;
    if (!savedBgState.has(el)) {
      savedBgState.set(el, { inert: el.inert, ariaHidden: el.getAttribute('aria-hidden') });
    }
    el.inert = true;
    el.setAttribute('aria-hidden', 'true');
  }
}

/** 開いているオーバーレイが全て閉じたら元状態へ一括復元、残っていれば再ロックのみ。 */
function releaseBackground() {
  if (activeRoots.size > 0) {
    lockBackground();
    return;
  }
  for (const [el, prev] of savedBgState) {
    el.inert = prev.inert;
    if (prev.ariaHidden === null) el.removeAttribute('aria-hidden');
    else el.setAttribute('aria-hidden', prev.ariaHidden);
  }
  savedBgState.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// dirty ガード付き閉じ要求（mdl-0034 Esc 規約②: 入力・変更ありの閉じ操作は破棄確認を挟む）
//
// Esc / 背景クリックは OverlayDialog 自身が、キャンセル・× ボタンは children が閉じ経路を持つ。
// 全経路を同じガードに通すため、閉じ要求を context で配布する。children のキャンセル/×は
// 親から渡された onClose を直接呼ばず useOverlayClose() を使う（dirty 時に確認が挟まる）。
// ─────────────────────────────────────────────────────────────────────────────

const OverlayCloseContext = createContext<(() => void) | null>(null);

/**
 * OverlayDialog 配下のキャンセル / × ボタンが使う閉じ要求。
 * dirty prop が true の間は破棄確認を挟み、確認 OK で初めて onClose が呼ばれる。
 */
export function useOverlayClose(): () => void {
  const requestClose = useContext(OverlayCloseContext);
  if (!requestClose) throw new Error('useOverlayClose must be used within OverlayDialog');
  return requestClose;
}

/**
 * dirty ガードを通る閉じボタン（キャンセル / ×）。onClick 以外の button 属性はそのまま透過する。
 * OverlayDialog の children 内でのみ使える（useOverlayClose と同条件）。
 */
export function OverlayCloseButton(
  props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>,
) {
  const requestClose = useOverlayClose();
  return <button type="button" {...props} onClick={requestClose} />;
}

// 利用側は Props 型を取り込まず components だけを使う（公開面の使われない型は出さない・d611）。
interface OverlayDialogProps {
  /** 表示状態。false で何も描画しない。 */
  open: boolean;
  /** 背景クリック・ESC・閉じる操作で呼ばれる。 */
  onClose: () => void;
  /**
   * 入力途中（変更あり）か。true の間、Esc / 背景クリック / useOverlayClose 経由の閉じ要求は
   * 破棄確認ダイアログを挟む（mdl-0034 規約②）。未指定は従来どおり即クローズ。
   */
  dirty?: boolean;
  /** 破棄確認の本文（既定「変更を破棄しますか？」）。 */
  discardMessage?: string;
  /** 見出し要素の id（aria-labelledby）。 */
  labelledBy?: string;
  /** ラベル文字列（aria-label）。labelledBy が無い時のフォールバック。 */
  ariaLabel?: string;
  /** パネルへ付与する追加クラス。 */
  className?: string;
  /** パネル幅（既定 'min(420px, 90vw)'）。 */
  width?: number | string;
  /** 背景クリックで閉じるか（既定 true）。 */
  closeOnBackdrop?: boolean;
  children: ReactNode;
}

/**
 * settings 配下のオーバーレイ（招待操作 / 削除確認 / CSV 出力）が共有する a11y 内蔵の primitive。
 * - focus trap（Tab/Shift+Tab で内部巡回）・ESC クローズ・開く前のフォーカス復帰
 * - 背景（body 直下の非オーバーレイ要素）を inert + aria-hidden で隔離
 * - role=dialog / aria-modal / aria-label(or labelledby)
 *
 * パネルは位置決め（センタリング + 最大幅）のみを担い、カード面（sp-card / FormCard / CSV chrome）は
 * children 側が持つ。意匠は AlertDialog に揃える（backdrop = 薄いグレーの曇りガラス・--sp-overlay-scrim + blur・cmn-0115）。
 */
export function OverlayDialog({
  open,
  onClose,
  labelledBy,
  ariaLabel,
  className,
  width = 'min(420px, 90vw)',
  closeOnBackdrop = true,
  dirty = false,
  discardMessage,
  children,
}: OverlayDialogProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const [mounted, setMounted] = useState(false);

  // 閉じ要求のガード。dirty / onClose は ref 経由で最新値を参照する
  // （requestClose の identity を安定させ、context 消費側の再レンダを抑える）。
  const { open: discardOpen, request, onConfirm, onCancel } = useDiscardConfirm();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    request(dirtyRef.current, () => onCloseRef.current());
  }, [request]);

  // SSR ガード: createPortal 先（document.body）が存在するクライアントでのみ描画。
  useEffect(() => {
    setMounted(true);
  }, []);

  // 開いている間: 背景を隔離 + 初期フォーカス + 閉じる時にフォーカス復帰。
  useEffect(() => {
    if (!open || !mounted) return;

    previouslyFocused.current = document.activeElement;

    const root = rootRef.current;
    if (root) activeRoots.add(root);
    lockBackground();

    // パネルへ初期フォーカス → 次フレームで data-autofocus か最初の focusable へ。
    panelRef.current?.focus();
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const auto = panel.querySelector<HTMLElement>('[data-autofocus]');
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (auto ?? first)?.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      if (root) activeRoots.delete(root);
      releaseBackground();
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
  }, [open, mounted]);

  if (!open || !mounted) return null;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const firstEl = focusables[0];
    const lastEl = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      if (active === firstEl || active === panel) {
        e.preventDefault();
        lastEl.focus();
      }
    } else if (active === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  const handleBackdrop = (_e: ReactMouseEvent<HTMLDivElement>) => {
    if (closeOnBackdrop) requestClose();
  };

  return createPortal(
    <div ref={rootRef} data-overlay-root>
      <div
        data-testid="overlay-backdrop"
        onClick={handleBackdrop}
        className="fixed inset-0 z-[10050] bg-[var(--sp-overlay-scrim)] backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`fixed left-1/2 top-1/2 z-[10050] -translate-x-1/2 -translate-y-1/2 outline-none ${className ?? ''}`}
        style={{ width }}
      >
        <OverlayCloseContext.Provider value={requestClose}>{children}</OverlayCloseContext.Provider>
      </div>
      {/* 破棄確認（AlertDialog は body へ portal し z-[10050] 後着で最前面）。Esc は AlertDialog 側が
          stopPropagation 込みで消費するため、確認表示中の Esc がパネルへ二重伝播しない。 */}
      <DiscardConfirmDialog
        open={discardOpen}
        onConfirm={onConfirm}
        onCancel={onCancel}
        message={discardMessage}
      />
    </div>,
    document.body,
  );
}
