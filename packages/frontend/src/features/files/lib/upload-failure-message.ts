import { extractErrorMessage } from '@/lib/error-utils';

/** サーバー側の想定外エラー（5xx）に出す日本語。英語の汎用文（An unexpected error occurred）の代わり。 */
const SERVER_ERROR_MESSAGE = 'サーバー側でエラーが発生しました。時間をおいてもう一度お試しください';

/** axios エラーの HTTP status（応答が読めない時は undefined）。 */
function errorStatus(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * サーバーの応答からアップロード失敗の理由を取り出す（v2-191）。
 *
 * 日本語化されていない内部寄りの文言がそのまま画面へ出るのを防ぐ。置き換えるのは 5xx（サーバー側の想定外
 * エラー）だけで、そこは英語の汎用文しか入っておらず利用者に意味が無い。4xx はサーバーが訳した案内文
 * （実行形式・サイズ・拡張子・multipart 上限・回数制限）なのでそのまま出す。
 *
 * 判定は HTTP status で行う。413（multipart の 100 MB ハードキャップ）の code は BAD_REQUEST。
 * 旧サーバーから INTERNAL_ERROR が返る場合も、4xx の直せば通る理由を汎用文へ潰さない。
 */
export function uploadFailureReason(err: unknown, fallback = '原因を特定できませんでした'): string {
  const status = errorStatus(err);
  if (status !== undefined && status >= 500) return SERVER_ERROR_MESSAGE;
  return extractErrorMessage(err, fallback);
}

/**
 * 失敗したアップロードをトースト 1 通の文言へまとめる（v2-191）。
 *
 * 以前はファイル名だけを並べ、サーバーが返した拒否理由を捨てていたため、利用者は何を直せば通るのか
 * 分からなかった。理由まで出すことで、拡張子・サイズ・実行形式のどれで弾かれたかがその場で分かる。
 *
 * 名前は出さず、理由だけを出す（開発統括の修正依頼・2026-09-23）。「「xx.png」のアップロードに失敗しました
 * （許可されていない拡張子です（.png / 許可: .jpg））」は 1 通が長く、複数件では同じ理由が並ぶだけで、
 * どのファイルが失敗したかを読み取る役にも立たなかった。理由は種類で畳み、多くても 2 種類まで出して
 * 残りは種類数へ畳む（トーストが画面を覆わない）。理由を返さない失敗（階層・項目数の上限など）は
 * 件数だけを出す（total は打ち切りで理由を出せなかった分も含む失敗総数）。
 */
export function formatUploadFailures(reasons: string[], total = reasons.length): string {
  if (total === 0) return '';
  const unique = [...new Set(reasons.filter((reason) => reason.length > 0))];
  if (total === 1) {
    return unique.length > 0
      ? `アップロードに失敗しました（${unique[0]}）`
      : 'アップロードに失敗しました';
  }
  const head = `${total} 件のアップロードに失敗しました`;
  if (unique.length === 0) return head;
  const shown = unique.slice(0, 2).join(' / ');
  const rest = unique.length - 2;
  return `${head}（${shown}${rest > 0 ? ` / ほか ${rest} 種類` : ''}）`;
}
