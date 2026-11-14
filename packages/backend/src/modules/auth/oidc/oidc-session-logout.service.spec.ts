import type { Provider } from 'oidc-provider';
import type { Request } from 'express';
import { OidcSessionLogoutService } from './oidc-session-logout.service';
import { OIDC_SESSION_COOKIE, signCookieValue } from './oidc-session-cookie';

/**
 * d1269: logout で oidc-provider の SSO セッションをサーバー側で終わらせる。
 * 固定するのは ①署名が合った cookie だけを対象にすること ②grant とセッションの両方を消すこと。
 */
describe('OidcSessionLogoutService', () => {
  const KEY = 'dev-rete-cookie-key-0123456789abcdef0123';

  const buildService = (
    keys: unknown = [KEY],
    sessionByid: (id: string) => Promise<unknown> = async () => undefined,
  ) => {
    const revoked: string[] = [];
    const find = jest.fn((id: string) => sessionByid(id));
    const provider = {
      keys,
      Session: { find },
      AccessToken: {
        revokeByGrantId: jest.fn(async (grantId: string) => {
          revoked.push(grantId);
        }),
      },
    } as unknown as Provider;
    const service = new OidcSessionLogoutService(provider);
    return { service, find, revoked };
  };

  /** 署名付き `_session` cookie を持つリクエスト。 */
  const makeReq = (sessionId: string | null, key = KEY): Request => {
    if (sessionId === null) return { headers: {} } as unknown as Request;
    const value = `${OIDC_SESSION_COOKIE}=${sessionId}`;
    return {
      headers: { cookie: `${value}; ${OIDC_SESSION_COOKIE}.sig=${signCookieValue(key, value)}` },
    } as unknown as Request;
  };

  /** grant を 2 つ持つセッション（client ごとの認可）。 */
  const sessionWithGrants = () => {
    const destroyed = new Set<string>();
    const session = {
      authorizations: { ref: { grantId: 'grant-ref' }, gmis: { grantId: 'grant-gmis' } },
      destroy: jest.fn(async () => {
        destroyed.add('session');
      }),
    };
    return { session, destroyed };
  };

  it('署名が正しい cookie なら grant を失効させてからセッションを破棄すること', async () => {
    const { session } = sessionWithGrants();
    const { service, revoked } = buildService([KEY], async () => session);

    const id = await service.endSession(makeReq('session-1'));

    expect(id).toBe('session-1');
    expect(revoked).toEqual(['grant-ref', 'grant-gmis']);
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  // ここが緩むと「他人の session id を POST するだけで他人をログアウトさせられる」経路になる。
  it('署名が合わない cookie では何も消さないこと（他人のセッションを消せない）', async () => {
    const { session } = sessionWithGrants();
    const { service, find, revoked } = buildService([KEY], async () => session);

    const id = await service.endSession(makeReq('victim-session', 'attacker-key'));

    expect(id).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    expect(revoked).toEqual([]);
    expect(session.destroy).not.toHaveBeenCalled();
  });

  it('署名 cookie 自体が無いリクエストでは何も消さないこと', async () => {
    const { service, find } = buildService();
    await expect(service.endSession(makeReq(null))).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('セッションが既に無い（期限切れ・二重ログアウト）なら undefined を返すこと', async () => {
    const { service, revoked } = buildService([KEY], async () => undefined);
    await expect(service.endSession(makeReq('gone'))).resolves.toBeUndefined();
    expect(revoked).toEqual([]);
  });

  it('署名鍵が provider から取れない時は何も消さないこと（鍵の取り違えで他人を消さない）', async () => {
    const { session } = sessionWithGrants();
    // provider.keys が未設定（Koa の keys 未設定時）を模す。空配列を渡すと検証対象が無くなる。
    const { service, find } = buildService(null, async () => session);
    await expect(service.endSession(makeReq('session-1'))).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('grant 失効が失敗してもセッション破棄は続けること（ログアウトを止めない）', async () => {
    const { session } = sessionWithGrants();
    const revoked: string[] = [];
    const provider = {
      keys: [KEY],
      Session: { find: jest.fn(async () => session) },
      AccessToken: {
        revokeByGrantId: jest.fn(async (grantId: string) => {
          revoked.push(grantId);
          if (grantId === 'grant-ref') throw new Error('db down');
        }),
      },
    } as unknown as Provider;
    const service = new OidcSessionLogoutService(provider);

    await expect(service.endSession(makeReq('session-1'))).resolves.toBe('session-1');
    expect(revoked).toEqual(['grant-ref', 'grant-gmis']);
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('セッション破棄が失敗しても throw しないこと（ログアウト全体を失敗させない）', async () => {
    const failing = {
      authorizations: {},
      destroy: jest.fn(async () => {
        throw new Error('db down');
      }),
    };
    const { service } = buildService([KEY], async () => failing);

    await expect(service.endSession(makeReq('session-1'))).resolves.toBeUndefined();
  });
});
