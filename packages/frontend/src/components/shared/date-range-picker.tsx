'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn, formatDate, toLocalYmd } from '@/lib/utils';
import { useOutsideClose } from '@/hooks/use-outside-close';

/** 期間（From/To）の値。'YYYY-MM-DD' または空文字。 */
export interface DateRangeValue {
  from: string;
  to: string;
}

/** 曜日ラベル（日曜始まり）。 */
const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 「下限を設定」が開始日に入れる最小日。v2-185。 */
export const MIN_DATE = '1900-01-01';

/** 「上限を設定」が終了日に入れる最大日。v2-185。 */
export const MAX_DATE = '9999-12-31';

/** Date → 'YYYY-MM-DD'（ローカル時刻の年月日）。組み立ては @/lib/utils の 1 箇所に寄せる。 */
const ymd = toLocalYmd;

/**
 * 'YYYY-MM-DD' → Date（形式違い・実在しない日付・空は null）。
 *
 * `new Date(y, m-1, d)` は実在しない日付（2026-02-31 など）を繰り上げて別の日にしてしまうため、
 * 組み立てた日付を書き戻して一致する時だけ採用する（外部から来た値を月の決定に使っても
 * 勝手に別の月へずれない）。
 */
function parseYmd(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(date.getTime())) return null;
  return ymd(date) === value ? date : null;
}

/** その月の初日（0 時）。 */
function firstDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * ピッカーの表示月を決める日付（下限/上限の番兵値は使わない）。v2-185。
 *
 * 下限（1900-01-01）や上限（9999-12-31）を入れた後に開き直すと、その月（1900年1月・9999年12月）を
 * 出してしまい選び直しができない。番兵値は無視し、もう一方の値か当月を使う。
 */
function monthAnchor(from: string, to: string): Date | null {
  const f = parseYmd(from);
  if (f && from !== MIN_DATE) return f;
  const t = parseYmd(to);
  if (t && to !== MAX_DATE) return t;
  return null;
}

/** 翌月の初日。 */
function addMonths(month: Date, delta: number): Date {
  return new Date(month.getFullYear(), month.getMonth() + delta, 1);
}

/** 月の見出し（'2026年9月'）。 */
function monthLabel(month: Date): string {
  return `${month.getFullYear()}年${month.getMonth() + 1}月`;
}

/** popover を収めるための水平の表示領域（viewport 座標）。 */
interface PopoverBounds {
  left: number;
  right: number;
}

/**
 * popover の左端（viewport 座標）を決める。v2-187。
 *
 * 既定は右端基準（期間欄グループの右端に合わせて左へ広げる）。帯が折り返す幅では期間欄がペインの
 * 左寄りへ来るため、右端基準のままだと popover（幅 514px）がペインの左外へ出て、overflow を持つ
 * 祖先（.sp-page・overflow-x: auto）にクリップされ左の月が見えなくなる（実測: 800x600 で 210px
 * はみ出し、9月の日付はサイドバーがクリックを奪って押せない）。そこで、右端基準で収まらなければ
 * 左端基準（グループの左端から右へ広げる）へ切り替え、それでも収まらなければ表示領域内へ寄せる。
 */
export function computePopoverLeft(
  anchor: { left: number; right: number },
  width: number,
  bounds: PopoverBounds,
): number {
  const maxLeft = Math.max(bounds.left, bounds.right - width);
  const rightAnchored = anchor.right - width;
  if (rightAnchored >= bounds.left) return Math.min(rightAnchored, maxLeft);
  const leftAnchored = anchor.left;
  if (leftAnchored + width <= bounds.right) return leftAnchored;
  return maxLeft;
}

/**
 * popover をクリップし得る祖先（overflow が visible でない）と viewport の重なり。
 *
 * 帯そのものではなく、overflow を持つ祖先の可視範囲を基準にする（祖先の外へ出た分は
 * スクロールでは見られず、クリックも下の要素に奪われるため）。
 */
function popoverBounds(root: HTMLElement): PopoverBounds {
  const bounds: PopoverBounds = { left: 0, right: window.innerWidth };
  for (let el = root.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowX === 'visible') continue;
    const rect = el.getBoundingClientRect();
    bounds.left = Math.max(bounds.left, rect.left);
    bounds.right = Math.min(bounds.right, rect.right);
  }
  return bounds;
}

/** 月のマス目（日曜始まり・先頭の空白 + 1〜末日・末尾を7の倍数まで埋める）。 */
function monthCells(year: number, month: number): (string | null)[] {
  const lead = new Date(year, month, 1).getDay();
  const last = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= last; day += 1) cells.push(ymd(new Date(year, month, day)));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

interface MonthGridProps {
  /** 表示月（その月の1日）。 */
  month: Date;
  /** 選択中の開始日・終了日（'YYYY-MM-DD' か空）。 */
  from: string;
  to: string;
  /** 日付を選ぶと 'YYYY-MM-DD' を渡す（範囲の決め方は呼び出し元が持つ）。 */
  onSelect: (value: string) => void;
}

/**
 * 1か月分の日付グリッド（月見出し + 曜日行 + 日ボタンの格子）。v2-185。
 *
 * 月送りは呼び出し元（ピッカー全体で1組）が持つため、この部品は月の描画と選択の通知だけを行う。
 */
function MonthGrid({ month, from, to, onSelect }: MonthGridProps) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const cells = monthCells(year, monthIndex);
  const today = ymd(new Date());
  // 逆転期間（from > to）では範囲を塗らない（絞り込みは従来どおり両端をそのまま送る）。
  // 両端が下限/上限の番兵値（1900/01/01・9999/12/31）の時は「端を開いた＝範囲の指定なし」なので塗らない
  // （片方だけ番兵の時は、決めた側から端までを塗って「〜以前」「〜以降」を示す）。
  const hasRange = Boolean(from && to && from <= to) && !(from === MIN_DATE && to === MAX_DATE);
  const inRange = (value: string) => hasRange && value > from && value < to;
  const isSelected = (value: string) => value === from || value === to;

  return (
    <div className="sp-daterange-month">
      <div className="sp-daterange-cal-title">{monthLabel(month)}</div>
      <div className="sp-daterange-dow-row" aria-hidden="true">
        {DOW_LABELS.map((dow) => (
          <span key={dow} className="sp-daterange-dow">
            {dow}
          </span>
        ))}
      </div>
      <div className="sp-daterange-grid">
        {cells.map((value, index) =>
          value === null ? (
            <span key={`empty-${index}`} className="sp-daterange-day is-empty" aria-hidden="true" />
          ) : (
            <button
              key={value}
              type="button"
              className={cn(
                'sp-daterange-day',
                isSelected(value) && 'is-selected',
                !isSelected(value) && inRange(value) && 'is-in-range',
                value === today && 'is-today',
              )}
              aria-label={`${Number(value.slice(0, 4))}年${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`}
              aria-pressed={isSelected(value)}
              onClick={() => onSelect(value)}
            >
              {Number(value.slice(8, 10))}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

interface FilterDateRangeProps {
  from: string;
  to: string;
  /** 日付を選ぶたびに呼ぶ（From/To の両方を渡す。呼び出し元が即時反映する）。 */
  onChange: (next: DateRangeValue) => void;
  /** 項目名。呼び出し元画面の語彙に合わせる（既定は 開始日 / 終了日）。 */
  startLabel?: string;
  endLabel?: string;
  /** popover（role=dialog）の読み上げ名。 */
  ariaLabel?: string;
  /** trigger の id 接頭辞。省略時は useId。 */
  idPrefix?: string;
}

/**
 * 期間（From/To）を1つのピッカーで選ぶ絞り込み部品。v2-185。
 *
 * 背景: 絞り込み帯の期間は native `<input type="date">` が2本並び、どちらを押しても
 * **片方の月カレンダーしか出ない**（ネイティブのピッカーは差し替えられない）。同じ期間を入れるのに
 * 2回開く必要があり、開始と終了を見比べながら選べなかった。
 *
 * 形（要求版2）: trigger（値の表示だけを行うボタン）を押すと **1つのピッカー**が開き、
 * **連続する2ヶ月**の日付が同時に並ぶ。月跨ぎの期間を、月送りを挟まずに1画面で選べるようにするため。
 * どちらの trigger から開いても同じピッカーが出る。選択はクリック順で決める:
 * 1回目が開始日、2回目が終了日（2回目が開始日より前なら開始日をその日へ移す）、
 * 両方入った後のクリックは新しい開始日に戻す。月送りはピッカー全体で1ヶ月ずつ動く。
 *
 * 下部のボタン: 中央の **「下限を設定」は開始日に 1900/01/01、「上限を設定」は終了日に 9999/12/31** を
 * 入れる（もう一方の値は残すので、「〜以前」は上限だけ、「〜以降」は下限だけを押して作れる）。
 * 右の「クリア」は両方を空白にする。
 *
 * 位置: popover は trigger 行の直下・右端基準（`right: 0`）で開く。帯の右寄りにある期間欄から
 * 左方向へ広げることで、2面カレンダーの幅（実測 514px）でも表示領域からはみ出さない（横スクロールを
 * 作らない。1440x900 / 1024x768 で実測）。帯が折り返す幅（800x600 で実測）では期間欄がペインの
 * 左寄りへ来るため、右端基準のままだと左の月がペインの外へ出て見えず押せない。そこで開く時に
 * 実測して表示領域内へ収め、収まらなければ左端基準へ切り替える（computePopoverLeft・v2-187）。
 * 外側クリックと Esc で閉じる（共通フック useOutsideClose・document 段）。
 */
export function FilterDateRange({
  from,
  to,
  onChange,
  startLabel = '開始日',
  endLabel = '終了日',
  ariaLabel = '期間の範囲',
  idPrefix,
}: FilterDateRangeProps) {
  const uid = useId();
  const prefix = idPrefix ?? uid;
  /** どちらの trigger から開いたか（同じ trigger の再クリックで閉じる）。 */
  const [openSide, setOpenSide] = useState<'from' | 'to' | null>(null);
  /** ピッカーの左側に出す月（その月の1日）。右側はその翌月。 */
  const [baseMonth, setBaseMonth] = useState<Date>(() =>
    firstDayOfMonth(monthAnchor(from, to) ?? new Date()),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  /** popover の左端（.sp-daterange 基準の px）。null は CSS の既定（右端基準）。 */
  const [popoverLeft, setPopoverLeft] = useState<number | null>(null);
  const open = openSide !== null;

  useOutsideClose({ active: open, refs: [rootRef], onClose: () => setOpenSide(null) });

  // popover を表示領域内へ収める（v2-187）。開いた時と、スクロール・リサイズで測り直す
  // （ペインが横スクロールすると可視範囲が動くため）。計測できない環境では CSS の既定のまま。
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const root = rootRef.current;
      const popover = popoverRef.current;
      if (!root || !popover) return;
      const width = popover.offsetWidth;
      if (!width) return;
      const rootRect = root.getBoundingClientRect();
      const left = computePopoverLeft(
        { left: rootRect.left, right: rootRect.right },
        width,
        popoverBounds(root),
      );
      setPopoverLeft(left - rootRect.left);
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const toggle = (side: 'from' | 'to') => () => {
    if (openSide === side) {
      setOpenSide(null);
      return;
    }
    // 閉じた状態から開く時は選択済みの月へ戻す（前回の月送りのまま別の月を開かない）。
    // 開いている間にもう一方の欄を押した時は開いたまま選択状態を保つ（見比べながら直せる）。
    if (openSide === null) {
      const anchor = monthAnchor(from, to);
      if (anchor) setBaseMonth(firstDayOfMonth(anchor));
    }
    setOpenSide(side);
  };

  const nextMonth = addMonths(baseMonth, 1);

  /**
   * 日付を押した時の行き先を決める。v2-185。
   *
   * - 未選択、または範囲が確定済み → 新しい開始日（終了日は空へ戻す）
   * - 開始日のみ設定済み → 2回目は終了日（開始日より前なら開始日を移す）
   * - **終了日のみ設定済み** → 押した日を開始日に入れ、終了日は残す
   *   （「〜以前」を絞る時に、開始日を選び直しても終了日が消えないようにする）
   */
  const selectDate = (value: string) => {
    if (from && !to) {
      onChange(value < from ? { from: value, to: '' } : { from, to: value });
      return;
    }
    if (!from && to) {
      onChange({ from: value, to });
      return;
    }
    onChange({ from: value, to: '' });
  };

  /** 下限（1900/01/01）を開始日に入れる（もう一方の値は残す）。「〜以前」を絞る時に使う。 */
  const setLowerBound = () => onChange({ from: MIN_DATE, to });

  /** 上限（9999/12/31）を終了日に入れる（もう一方の値は残す）。「〜以降」を絞る時に使う。 */
  const setUpperBound = () => onChange({ from, to: MAX_DATE });

  // 次に何を選ぶかを面上に出す（値が入ると trigger は日付表示になり、欄の名前が画面から消えるため）。
  const hint = !from
    ? `${startLabel}を選んでください`
    : !to
      ? `${endLabel}を選んでください`
      : `${formatDate(from)} 〜 ${formatDate(to)}`;

  return (
    <div className="sp-daterange" ref={rootRef}>
      <button
        type="button"
        id={`${prefix}-from`}
        className={cn('sp-input sp-input--filter sp-daterange-trigger', !from && 'is-empty')}
        aria-label={startLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle('from')}
      >
        {from ? formatDate(from) : startLabel}
      </button>
      <span className="text-xs text-[var(--sp-text-warm-mute)]">〜</span>
      <button
        type="button"
        id={`${prefix}-to`}
        className={cn('sp-input sp-input--filter sp-daterange-trigger', !to && 'is-empty')}
        aria-label={endLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle('to')}
      >
        {to ? formatDate(to) : endLabel}
      </button>

      {open && (
        <div
          className="sp-daterange-popover"
          role="dialog"
          aria-label={ariaLabel}
          ref={popoverRef}
          style={popoverLeft === null ? undefined : { left: popoverLeft, right: 'auto' }}
        >
          <div className="sp-daterange-picker" role="group" aria-label="期間のカレンダー">
            <div className="sp-daterange-picker-head">
              <button
                type="button"
                className="sp-daterange-nav"
                aria-label="前の月"
                onClick={() => setBaseMonth(addMonths(baseMonth, -1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span className="sp-daterange-hint" aria-live="polite">
                {hint}
              </span>
              <button
                type="button"
                className="sp-daterange-nav"
                aria-label="次の月"
                onClick={() => setBaseMonth(nextMonth)}
              >
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div className="sp-daterange-months">
              <MonthGrid month={baseMonth} from={from} to={to} onSelect={selectDate} />
              <MonthGrid month={nextMonth} from={from} to={to} onSelect={selectDate} />
            </div>
          </div>
          <div className="sp-daterange-actions">
            {/* 下部中央: 端を開くための固定値。開始日に下限（1900/01/01）、終了日に上限（9999/12/31）を
                入れる（もう一方の値は残すので「〜以前」「〜以降」を1操作で作れる）。 */}
            <div className="sp-daterange-actions-bounds">
              <button
                type="button"
                className="sp-daterange-action-btn"
                title={`${startLabel}に ${formatDate(MIN_DATE)} を入れる`}
                onClick={setLowerBound}
              >
                下限を設定
              </button>
              <button
                type="button"
                className="sp-daterange-action-btn"
                title={`${endLabel}に ${formatDate(MAX_DATE)} を入れる`}
                onClick={setUpperBound}
              >
                上限を設定
              </button>
            </div>
            <div className="sp-daterange-actions-end">
              <button
                type="button"
                className="sp-daterange-action-btn"
                onClick={() => onChange({ from: '', to: '' })}
              >
                クリア
              </button>
              <button
                type="button"
                className="sp-daterange-action-btn"
                onClick={() => setOpenSide(null)}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
