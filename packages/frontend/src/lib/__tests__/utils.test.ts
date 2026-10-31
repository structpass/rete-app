import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, formatDateTimeWithSeconds, toLocalYmd } from '../utils';

describe('formatDate', () => {
  it('日付のみ YYYY/MM/DD に整形する', () => {
    expect(formatDate('2026-06-19T01:23:45.000Z')).toBe('2026/06/19');
  });
  it('null / 不正値は "—" で縮退（cmn-0278）', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
    expect(formatDate('')).toBe('—');
  });
});

describe('toLocalYmd (d755)', () => {
  /** 時刻帯を切り替えて検査し、必ず元の設定へ戻す（TZ=UTC 固定の試験環境を汚さない）。 */
  function withTz<T>(tz: string, run: () => T): T {
    const original = process.env.TZ;
    process.env.TZ = tz;
    try {
      return run();
    } finally {
      process.env.TZ = original;
    }
  }

  it('ローカルの年月日を 0 埋めで組む（UTC 実行下）', () => {
    expect(new Date().getTimezoneOffset()).toBe(0);
    expect(toLocalYmd(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toLocalYmd(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('時刻帯を JST へ変えても、ローカルの日付で組む（UTC 変換なら前日になる瞬間を固定）', () => {
    // UTC より東の時刻帯では、ローカルの 0 時は UTC の前日 15 時。UTC の年月日で組む式
    // （toISOString().slice(0,10)）へ差し替えると、この検査が 2026-01-04 で赤くなる（d755 の目的）。
    const midnight = withTz('Asia/Tokyo', () => {
      expect(new Date().getTimezoneOffset()).toBeLessThan(0);
      return new Date(2026, 0, 5, 0, 0, 0);
    });
    expect(midnight.toISOString().slice(0, 10)).toBe('2026-01-04');
    expect(withTz('Asia/Tokyo', () => toLocalYmd(new Date(2026, 0, 5)))).toBe('2026-01-05');
    expect(withTz('Asia/Tokyo', () => toLocalYmd(new Date(2026, 0, 5, 23, 30)))).toBe('2026-01-05');
  });

  it('時刻帯を西へ変えても、ローカルの日付で組む（UTC 変換なら翌日になる側）', () => {
    expect(withTz('America/New_York', () => toLocalYmd(new Date(2026, 0, 5, 20, 0)))).toBe(
      '2026-01-05',
    );
  });
});

describe('テスト実行時のタイムゾーン固定 (cmn-0253)', () => {
  it('vitest.config.ts の test.env で TZ=UTC が実際に効いている', () => {
    // 代入しただけで Date に反映されない環境（Node が TZ の変更を拾わない等）を、
    // 緑のまま見逃さないための検査。ここが赤い＝以下の日時 spec の前提が崩れている。
    expect(process.env.TZ).toBe('UTC');
    expect(new Date('2026-06-19T01:23:45.000Z').getHours()).toBe(1);
  });
  it('JST へ固定されていない（ローカル表示と JST 固定表示の取り違えを検出できる状態を保つ）', () => {
    // JST 実行下では「閲覧者ローカル」と「Asia/Tokyo 固定」が完全に一致してしまい、
    // 画面実装がどちらへ差し替わっても spec が緑のままになる（fil-0111 の原因）。
    expect(new Date('2026-06-19T01:23:45.000Z').getTimezoneOffset()).toBe(0);
  });
});

describe('formatDateTime (dsk-0220)', () => {
  it('YYYY/MM/DD HH:mm 形式（分まで）で返す', () => {
    // ローカルタイムゾーン依存を避け、フォーマット形状で検証する。
    expect(formatDateTime('2026-06-19T01:23:45.000Z')).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
  it('閲覧者ローカル時刻へ変換する（TZ=UTC 実行下では UTC の壁時計そのもの・cmn-0253）', () => {
    // 「入力 ISO → 閲覧者ローカル文字列」を固定する spec。JST 固定実装へ差し替わると
    // 期待値が 10:23 になって落ちる＝取り違えがここで止まる。
    expect(formatDateTime('2026-06-19T01:23:45.000Z')).toBe('2026/06/19 01:23');
    // 日付境界（UTC 実行下では日付は繰り上がらない。JST 固定なら 2026/06/20 09:00 になる）。
    expect(formatDateTime('2026-06-19T23:59:00.000Z')).toBe('2026/06/19 23:59');
  });
  it("null / 不正値は '—'（formatDate と同じ縮退・cmn-0296）", () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});

describe('formatDateTimeWithSeconds (set-0146)', () => {
  it('YYYY/MM/DD HH:mm:ss 形式（秒まで）で返す', () => {
    // ローカルタイムゾーン依存を避け、フォーマット形状で検証する（分までの formatDateTime と対）。
    expect(formatDateTimeWithSeconds('2026-06-19T01:23:45.000Z')).toMatch(
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });

  it('秒の値がゼロ埋めで保持される（監査ログの秒精度を落とさない）', () => {
    // 入力もローカル時刻で作り、期待値と同じ時間軸へ揃える（TZ 非依存）。
    const local = new Date(2026, 5, 19, 1, 23, 5);
    expect(formatDateTimeWithSeconds(local.toISOString())).toBe('2026/06/19 01:23:05');
  });

  it("null / 不正値は '—'（formatDateTime と同じ縮退・cmn-0296）", () => {
    expect(formatDateTimeWithSeconds(null)).toBe('—');
    expect(formatDateTimeWithSeconds(undefined)).toBe('—');
    expect(formatDateTimeWithSeconds('not-a-date')).toBe('—');
  });
});
