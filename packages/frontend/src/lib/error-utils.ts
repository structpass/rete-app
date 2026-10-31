/**
 * API レスポンスからエラーメッセージを抽出する。
 * backend の AllExceptionsFilter は `{ success: false, error: { code, message } }` を返す。
 */
export function extractErrorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: { message?: unknown } } } })?.response
    ?.data?.error?.message;
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

/**
 * バリデーション詳細（`details.validationErrors`）を優先してエラーメッセージを抽出する。
 * backend は class-validator 由来の失敗で error.message を generic な 'Validation failed' にし、
 * どの項目がどう悪いかは details.validationErrors[] にしか入れない（AllExceptionsFilter）。
 * 理由を捨てて固定文言だけを出すと、利用者はどの入力を直せば通るのか分からなくなる（v2-198）。
 */
export function extractValidationErrorMessage(err: unknown, fallback: string): string {
  const error = (
    err as {
      response?: {
        data?: { error?: { message?: string; details?: { validationErrors?: unknown } } };
      };
    }
  )?.response?.data?.error;
  const validation = error?.details?.validationErrors;
  if (Array.isArray(validation)) {
    const messages = validation.filter(
      (message): message is string => typeof message === 'string' && message.length > 0,
    );
    if (messages.length > 0) return messages.join(' / ');
  }
  // 詳細が無い時の message は英語の generic 文言（'Validation failed'）になり得るため、それは fallback へ倒す。
  return error?.message && error.message !== 'Validation failed' ? error.message : fallback;
}

/**
 * API エラーの HTTP status を取り出す。取得できなければ undefined。
 * 画面側が axios を直 import して e.response.status を読む代わりにこれを使う
 * （status 判定の入口を 1 つに保ち、API クライアントの実装差し替えに画面を巻き込まない）。
 */
export function extractErrorStatus(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * API エラーの code（'TOO_MANY_REQUESTS' / 'UNAUTHORIZED' 等）を取り出す。
 * code で分岐したい場面（ログイン画面のロックアウト文言の出し分け等）で使う。未取得は undefined。
 */
export function extractErrorCode(err: unknown): string | undefined {
  const resp = (err as { response?: { data?: { error?: { code?: string } } } })?.response;
  return resp?.data?.error?.code;
}
