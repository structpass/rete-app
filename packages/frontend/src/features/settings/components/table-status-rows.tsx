import type { ReactNode } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';

/**
 * テーブル末尾の状態行 3 種（読み込み中 / 取得失敗 / 0 件）の共通部品（set-0147・v2-233）。
 * settings の 4 画面（audit-log / members / invites / permissions）に複製されていた定型を集約する。
 * 列数と 0 件文言は画面固有のまま受け取り、見た目・挙動は不変（読み込み中行は全幅 colSpan・
 * Spinner＋「読み込み中…」、0 件行は同一のセンタリングと warm-mute 表示）。
 * v2-233: 取得失敗行（errorLabel）を追加。渡すと 0 件行の代わりに role="alert" の赤系文言を出す
 * （正本 ui.ts:109「取得失敗は領域内に残す・toast だけにしない」＝消えたあと 0 件と区別できないため）。
 * d659: 取得失敗行に再試行の導線を添える（onRetry）。障害は一時的なことが多く、押して取り直せないと
 * 画面を開き直すまで失敗表示のまま残る。
 */
export function TableStatusRows({
  colSpan,
  isLoading,
  empty,
  emptyLabel,
  emptyDescription,
  errorLabel,
  onRetry,
}: {
  colSpan: number;
  isLoading: boolean;
  /** 0 件判定（画面側の rows.length === 0 など）。isLoading の時は 0 件行は出ない。 */
  empty: boolean;
  /** 0 件時の画面固有文言。 */
  emptyLabel: string;
  /** 検索・絞り込みなど、0 件の理由を補足する表示。 */
  emptyDescription?: ReactNode;
  /** 取得失敗の画面固有文言。null / undefined / 空文字は「失敗なし」として 0 件行を出す。 */
  errorLabel?: string | null;
  /** 取得失敗行の「再試行」。渡さない画面は従来どおり文言だけを出す。 */
  onRetry?: () => void;
}) {
  return (
    <>
      {isLoading && (
        <tr>
          <td
            colSpan={colSpan}
            className="text-[var(--sp-text-warm-mute)]"
            style={{ textAlign: 'center', padding: '1.25rem' }}
          >
            <span className="inline-flex items-center justify-center gap-2">
              <Spinner className="h-6 w-6" />
              読み込み中…
            </span>
          </td>
        </tr>
      )}
      {!isLoading && errorLabel && (
        <tr>
          <td colSpan={colSpan} style={{ textAlign: 'center', padding: '1.25rem' }}>
            {/*
              取得失敗は toast で消さず領域内に残す（失敗と真0件を読み分けられるようにする）。
              d659: 再試行を添える時は文言とボタンを同じ role="alert" の中に置く（失敗の報せと、
              そこから戻る唯一の導線を 1 つの領域として読ませる）。
            */}
            <span role="alert" className="text-[var(--sp-accent-red)]">
              {errorLabel}
              {onRetry && (
                // 再試行中は呼び出し側が isLoading=true にするため、この失敗行ごと読み込み中の行
                // へ入れ替わる（二重押下で取得が重ならない）。
                <Button
                  type="button"
                  variant="outline"
                  size="sp-compact"
                  onClick={onRetry}
                  className="ml-2"
                >
                  再試行
                </Button>
              )}
            </span>
          </td>
        </tr>
      )}
      {!isLoading && !errorLabel && empty && (
        <tr>
          <td
            colSpan={colSpan}
            className="text-[var(--sp-text-warm-mute)]"
            style={{ textAlign: 'center', padding: '1.25rem' }}
          >
            {emptyLabel}
            {emptyDescription && (
              <span style={{ display: 'block', marginTop: '0.25rem' }}>{emptyDescription}</span>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
