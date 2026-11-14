import { Injectable, Logger } from '@nestjs/common';
import { InjectOidcProvider } from 'nest-oidc-provider';
import type { Provider } from 'oidc-provider';
import type { Request } from 'express';
import { OIDC_SESSION_COOKIE, readSignedCookieValue } from './oidc-session-cookie';

/**
 * Rete のログアウトで、oidc-provider の SSO セッション（`_session` cookie + Session payload）を
 * サーバー側で終わらせる（d1269）。
 *
 * なぜ必要か: `POST /auth/logout` が express-session だけを破棄していたため、`_session` が 14 日残り、
 * Reference / 報告管理を開き直すと authorize が interaction（ログイン画面）を省いて素通りしていた。
 * 「ログアウトしたのにログイン画面が出ない」の原因はここ。
 *
 * 設計上の線引き:
 * - **署名検証を省かない**。cookie の値をそのまま session id として消すと、他人の session id を
 *   投げるだけで他人の SSO セッションを消せる経路になる。`OIDC_COOKIE_KEYS`（provider が実際に
 *   使っている `provider.keys`）で HMAC を検証し、通った値だけを id として扱う。
 * - セッションに紐づく grant / トークンも失効させる（provider の end_session と同じ意味にする）。
 *   これをしないと RP が保持する access token が 1 時間生き続け、ログアウトが「画面だけ」になる。
 * - cookie の後始末（`_session` / `_session.sig` を Max-Age=0）は呼び出し側（controller）が行う。
 *   ここはサーバー側の状態だけを消す（HTTP の関心を持ち込まない）。
 */
@Injectable()
export class OidcSessionLogoutService {
  private readonly logger = new Logger(OidcSessionLogoutService.name);

  constructor(@InjectOidcProvider() private readonly provider: Provider) {}

  /**
   * リクエストの `_session` cookie が指す SSO セッションを破棄する。
   *
   * best-effort: 破棄に失敗しても throw しない（ログだけ残す）。呼び出し側は成否に関わらず
   * cookie を落とすので、ブラウザからは SSO セッションに到達できなくなる。ここで throw して
   * ログアウト全体を失敗させると「アプリにログインしたまま、SSO も生きている」状態が残り、
   * 利用者にとって一番困る形になる（消し残しの行は OidcPurgeService が期限で掃除する）。
   *
   * @returns 破棄したセッション id（cookie が無い・署名不正・期限切れ・既に消えている場合は undefined）
   */
  async endSession(req: Request): Promise<string | undefined> {
    const sessionId = readSignedCookieValue(
      req.headers?.cookie,
      OIDC_SESSION_COOKIE,
      this.cookieKeys(),
    );
    // 署名が無い／合わない cookie は「セッションを指定していない」と同じに扱う（他人の id を消さない）。
    if (!sessionId) return undefined;

    try {
      const session = await this.provider.Session.find(sessionId);
      if (!session) return undefined;

      // grant 失効 → セッション破棄の順。grant を先に消すのは、セッションが消えた後に
      // トークンだけが残る一瞬を作らないため。
      for (const grantId of this.grantIds(session.authorizations)) {
        try {
          // provider の end_session と同じ効果にする。AccessToken の revokeByGrantId は
          // adapter の実装が「grantId 列を持つ payload」を一括削除する（Grant / AccessToken /
          // RefreshToken / AuthorizationCode 等・oidc-prisma.adapter）。Grant 行自体は
          // 期限切れ行の日次 purge に任せる（レビュー指摘: 何を消すのかを実装に合わせて書く）。
          await this.provider.AccessToken.revokeByGrantId(grantId);
        } catch (err) {
          // grant 失効の失敗でセッション破棄を止めない（セッションが消えれば session 紐づきの
          // トークンは provider 側の checkSessionBinding で弾かれる）。痕跡だけ残す。
          this.logWarn('OIDC grant revocation failed on logout', err);
        }
      }
      await session.destroy();
      return sessionId;
    } catch (err) {
      this.logWarn('OIDC session destroy failed on logout', err);
      return undefined;
    }
  }

  /** 失敗の痕跡を残す（token / cookie の値は出さない・operational-policy §2）。 */
  private logWarn(message: string, err: unknown): void {
    this.logger.warn(`${message}: ${err instanceof Error ? err.message : String(err)}`);
  }
  /** provider が実際に cookie 署名へ使っている鍵（= OIDC_COOKIE_KEYS）。env を読み直さない。 */
  private cookieKeys(): string[] {
    const keys = (this.provider as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return [];
    return keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
  }

  /** セッションが持つ認可（client ごとの grantId）を重複なく取り出す。 */
  private grantIds(authorizations: Record<string, { grantId?: string }> | undefined): string[] {
    if (!authorizations || typeof authorizations !== 'object') return [];
    const ids = new Set<string>();
    for (const value of Object.values(authorizations)) {
      const grantId = value?.grantId;
      if (typeof grantId === 'string' && grantId) ids.add(grantId);
    }
    return [...ids];
  }
}
