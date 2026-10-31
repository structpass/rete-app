/**
 * 途中でも済ませる後始末（全ユーザー共通の設定を作り変えるシナリオ用）。
 *
 * ファイル設定（`PATCH /files/settings`）のような全ユーザー共通の単一行を手順の途中で書き換える
 * シナリオは、途中で落ちると設定が元に戻らず、後続のシナリオや手元の操作を壊す。
 *
 * そこで feature の該当行の末尾へ
 *
 *     When PATCH "/api/v1/files/settings" を body "…" で叩く => システムADMIN "admin@rete.local"
 *
 * と書く。手順そのものは `=> …` を除いた部分で、叩く人は末尾で名乗った人。この行は「後始末でも
 * 流し直す手順」として登録される。
 *
 * 二重に戻さない規則:
 *   手順どおり最後まで進むと、その行は「戻し終えた」として印が付く（`resolveQuiet` が末尾の印を
 *   持ち帰る）。シナリオが最後まで進んだ時は最後の戻し行だけが印つきで記録されるため、
 *   後始末で流すものは無くなる。途中で落ちた時は、まだ戻していない行が後始末で 1 度だけ流れる。
 *
 * 実行の配線は steps/extended.steps.ts、後始末の呼び出しは support/fixtures.ts が持つ。
 * この file は依存を持たない（fixtures と steps の相互 import を避けるため）。
 */

export type DeferredStep = {
  /** 変数を解決する前の path（例: `/api/v1/files/settings`） */
  path: string;
  /** 変数を解決する前の body（JSON 文字列） */
  body: string;
  /** 叩く人（seed 済みのメール） */
  email: string;
  /** 手順どおり実行して戻し終えた行（後始末では流さない） */
  settled: boolean;
};

/** 末尾の `=> システムADMIN "<メール>"` を切り出す。無い時は email が null。 */
export function splitActorSuffix(text: string): { text: string; email: string | null } {
  const m = /\s*=>\s*システムADMIN\s+"([^"]+)"\s*$/.exec(text);
  if (!m) return { text, email: null };
  return { text: text.slice(0, m.index), email: m[1] };
}

/**
 * 後始末で流し直す手順を決める。
 * 戻し終えた行（settled）は除き、流す順は登録の逆順（後から変えた設定ほど先に戻す）。
 */
export function pendingTeardownSteps(registered: readonly DeferredStep[]): DeferredStep[] {
  return registered.filter((s) => !s.settled).reverse();
}

/**
 * 後始末で流す手順の値（`{{変数}}`）を、後始末の時点の変数で解決する。
 * `resolve` は steps 側の解決関数（差し込む値に引用符が入っても壊れないよう、値には触らない）。
 */
export function deferredTeardownValues(
  registered: readonly DeferredStep[],
  vars: Record<string, string>,
  resolve: (text: string, vars: Record<string, string>) => string,
): DeferredStep[] {
  return pendingTeardownSteps(registered).map((s) => ({
    ...s,
    path: resolve(s.path, vars),
    body: resolve(s.body, vars),
  }));
}
