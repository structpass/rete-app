import type { Request } from 'express';

/**
 * セッションの「認証の出自」を書く唯一の入口（d1022）。
 *
 * `authOrigin` はログイン後の強制（MFA・パスワード変更）を効かせるかの判断に読まれる値で、
 * 素通しは `'external-idp'` と明示された時だけ。**その値を書く場所をここに 1 つだけ置く。**
 * 書き手が散ると、書き忘れは強制を開いたまま（fail-open）になり、書き損じは強制を閉じたまま
 * （安全側だが利用者が詰まる）になる。書き手と読み手を 1 か所に寄せて、片方だけを直せない形にする。
 *
 * 今は `'local'`（Rete 自身の資格情報でログインした）だけを書く。`'external-idp'` は外部 IdP の
 * 受け口を作る時に、その経路から（この関数を通して）書く。それまでは読む側も素通しが起きない。
 */
export function setLocalAuthOrigin(req: Request): void {
  setAuthOrigin(req, 'local');
  // 互換のための旧欄（d955・@deprecated）。判定には使わないが、旧セッションと一覧が読むため併記する。
  req.session.authMethod = 'local';
}

/** 出自の値を、既に持っている値のまま戻す（セッションの張り直し・パスワード変更の後）。 */
export function setAuthOrigin(req: Request, origin: 'local' | 'external-idp'): void {
  req.session.authOrigin = origin;
}
