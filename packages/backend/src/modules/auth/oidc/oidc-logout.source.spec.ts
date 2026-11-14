import { createHash } from 'node:crypto';

import type { KoaContextWithOIDC } from 'oidc-provider';
import { createRpInitiatedLogout, hintMatchesSession } from './oidc-logout.source';

/**
 * RP 起点ログアウト画面（d1269）の単体テスト。
 *
 * 検証すること:
 * - id_token_hint の本人が今のセッションの本人と一致する時だけ自動送信（確認を挟まない）
 * - 一致しない時（hint 無し・他人の hint）は確認ページ（自動送信しない）
 * - インライン script の sha256 が CSP の script-src に入る（入らないと本番で動かない）
 * - provider が渡した form（xsrf 入り）をそのまま使う（自前で xsrf を組み立てない）
 */

type MutableCtx = {
  type: string;
  status: number;
  body: string;
  host: string;
  oidc: {
    entities: Record<string, unknown>;
    session?: {
      accountId?: string;
      state?: { secret?: string; postLogoutRedirectUri?: string };
    };
    urlFor: (name: string) => string;
  };
  response: { get: (name: string) => string | undefined };
  set: (name: string, value: string) => void;
  headers: Record<string, string>;
};

function makeCtx(overrides: Partial<MutableCtx> = {}): MutableCtx {
  const ctx: MutableCtx = {
    type: '',
    status: 0,
    body: '',
    host: 'localhost:3011',
    oidc: {
      entities: {},
      session: { accountId: 'account-1', state: { secret: 'xsrf-secret' } },
      urlFor: (name: string) => `http://localhost:3011/api/v1/oidc/session/${name}`,
    },
    headers: {},
    response: {
      get: (name: string) => ctx.headers[name.toLowerCase()],
    },
    set: (name: string, value: string) => {
      ctx.headers[name.toLowerCase()] = value;
    },
    ...overrides,
  };
  return ctx;
}

const FORM =
  '<form id="op.logoutForm" method="post" action="/end/confirm"><input type="hidden" name="xsrf" value="xsrf-secret"/></form>';

describe('createRpInitiatedLogout', () => {
  it('id_token_hint の本人がセッションの本人と一致する時は自動送信のページを返す（d1269）', () => {
    const ctx = makeCtx();
    ctx.oidc.entities.IdTokenHint = { payload: { sub: 'account-1' } };

    createRpInitiatedLogout().logoutSource(ctx as unknown as KoaContextWithOIDC, FORM);

    expect(ctx.type).toBe('html');
    expect(ctx.status).toBe(200);
    // 自動送信: 利用者の追加操作なしに end_session が完了する。
    expect(ctx.body).toContain("document.getElementById('op.logoutForm')");
    expect(ctx.body).toContain("i.name='logout'");
    // provider の form（xsrf 入り）をそのまま使う。
    expect(ctx.body).toContain('id="op.logoutForm"');
  });

  it('インライン script の sha256 を CSP の script-src に足す（足さないと本番で実行されない）', () => {
    const ctx = makeCtx();
    ctx.headers['content-security-policy'] =
      "default-src 'self'; script-src 'self'; object-src 'none'";
    ctx.oidc.entities.IdTokenHint = { payload: { sub: 'account-1' } };

    createRpInitiatedLogout().logoutSource(ctx as unknown as KoaContextWithOIDC, FORM);

    const csp = ctx.headers['content-security-policy'];
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    // 他のディレクティブを落とさない。
    expect(csp).toContain("object-src 'none'");
  });

  it('id_token_hint が無い時は確認ページ（自動送信しない・ログアウト攻撃を成立させない）', () => {
    const ctx = makeCtx();

    createRpInitiatedLogout().logoutSource(ctx as unknown as KoaContextWithOIDC, FORM);

    expect(ctx.body).not.toContain("i.name='logout'");
    expect(ctx.body).toContain('ログアウトしますか');
    expect(ctx.body).toContain(FORM);
  });

  it('id_token_hint の本人がセッションの本人と違う時も確認ページにする', () => {
    const ctx = makeCtx();
    ctx.oidc.entities.IdTokenHint = { payload: { sub: 'someone-else' } };

    createRpInitiatedLogout().logoutSource(ctx as unknown as KoaContextWithOIDC, FORM);

    expect(ctx.body).not.toContain("i.name='logout'");
    expect(ctx.body).toContain('ログアウトしますか');
  });

  it('CSP ヘッダが無い時は script-src を足さない（開発でヘッダを外していても壊さない）', () => {
    const ctx = makeCtx();
    ctx.oidc.entities.IdTokenHint = { payload: { sub: 'account-1' } };

    createRpInitiatedLogout().logoutSource(ctx as unknown as KoaContextWithOIDC, FORM);

    expect(ctx.headers['content-security-policy']).toBeUndefined();
    expect(ctx.body).toContain("document.getElementById('op.logoutForm')");
  });

  // d1269: Referrer-Policy が no-referrer（helmet 既定）だと、Chrome はこの画面からの form POST に
  // `Origin: null` を付ける（実測）。すると CORS ミドルウェアが同一オリジンと判定できず 403 になり、
  // RP 起点ログアウトが完了しない。画面側で same-origin を明示して実際の Origin を送らせる。
  it('Referrer-Policy を same-origin にする（Origin: null で 403 になるのを防ぐ）', () => {
    const ctx = makeCtx();
    ctx.headers['referrer-policy'] = 'no-referrer';
    ctx.oidc.entities.IdTokenHint = { payload: { sub: 'account-1' } };

    createRpInitiatedLogout().logoutSource(ctx as unknown as KoaContextWithOIDC, FORM);

    expect(ctx.headers['referrer-policy']).toBe('same-origin');
  });
});

// d1269: Chrome は form-action をリダイレクト先にも適用する。戻り先オリジンが許可に無いと
// end_session の確認フォーム送信そのものが CSP でブロックされ、ログアウトが完了しない（実測）。
describe('form-action（d1269）', () => {
  it('CSP の form-action にログアウト後の戻り先オリジンを足す', () => {
    const ctx = makeCtx();
    ctx.headers['content-security-policy'] = "form-action 'self'";
    ctx.oidc.entities.IdTokenHint = { payload: { sub: 'account-1' } };
    ctx.oidc.session = {
      accountId: 'account-1',
      state: {
        secret: 'xsrf-secret',
        postLogoutRedirectUri: 'http://127.0.0.1:4188/login?logout=1',
      },
    };

    createRpInitiatedLogout().logoutSource(ctx as unknown as KoaContextWithOIDC, FORM);

    expect(ctx.headers['content-security-policy']).toContain(
      "form-action 'self' http://127.0.0.1:4188",
    );
  });

  it('戻り先が無い時は form-action を変えない（不要なオリジンを開かない）', () => {
    const ctx = makeCtx();
    ctx.headers['content-security-policy'] = "form-action 'self'";
    ctx.oidc.entities.IdTokenHint = { payload: { sub: 'account-1' } };

    createRpInitiatedLogout().logoutSource(ctx as unknown as KoaContextWithOIDC, FORM);

    expect(ctx.headers['content-security-policy']).toBe("form-action 'self'");
  });
});

describe('hintMatchesSession', () => {
  it('sub と accountId が一致し、どちらも文字列の時だけ true', () => {
    const ctx = makeCtx();
    ctx.oidc.entities.IdTokenHint = { payload: { sub: 'account-1' } };
    expect(hintMatchesSession(ctx as unknown as KoaContextWithOIDC)).toBe(true);

    ctx.oidc.entities.IdTokenHint = { payload: { sub: 1 } };
    expect(hintMatchesSession(ctx as unknown as KoaContextWithOIDC)).toBe(false);

    ctx.oidc.entities.IdTokenHint = undefined;
    expect(hintMatchesSession(ctx as unknown as KoaContextWithOIDC)).toBe(false);
  });
});

// 自動送信 script の sha256 を CSP 計算と一致させる実装であること（文字列のコピー漏れ防止）。
it('CSP に足す sha256 は、本文に入れた script と同じ文字列から計算されている', () => {
  const ctx = makeCtx();
  ctx.headers['content-security-policy'] = "script-src 'self'";
  ctx.oidc.entities.IdTokenHint = { payload: { sub: 'account-1' } };

  createRpInitiatedLogout().logoutSource(ctx as unknown as KoaContextWithOIDC, FORM);

  const script = ctx.body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const digest = createHash('sha256').update(script).digest('base64');
  expect(ctx.headers['content-security-policy']).toContain(`'sha256-${digest}'`);
});
