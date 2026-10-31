import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { config as middlewareConfig } from '@/middleware';

// API_BASE_URL 等はモジュールロード時に固定されるため、env ごとに再 import する。
async function loadMiddleware(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return import('@/middleware');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('safeOrigin', () => {
  it('有効な URL は origin だけを返す', async () => {
    const { safeOrigin } = await loadMiddleware();
    expect(safeOrigin('http://localhost:3001/api/v1')).toBe('http://localhost:3001');
    expect(safeOrigin('https://app.example.com:3020/path?q=1')).toBe(
      'https://app.example.com:3020',
    );
  });

  it('パース不能な URL は空文字へ縮退する（例外を投げない）', async () => {
    const { safeOrigin } = await loadMiddleware();
    expect(safeOrigin('not a url')).toBe('');
    expect(safeOrigin('')).toBe('');
  });
});

describe('buildCsp（本番）', () => {
  it('script-src は nonce + strict-dynamic で、unsafe-inline / unsafe-eval は出ない', async () => {
    const { buildCsp } = await loadMiddleware({ NODE_ENV: 'production' });
    const csp = buildCsp('TESTNONCE123');
    expect(csp).toContain("script-src 'self' 'nonce-TESTNONCE123' 'strict-dynamic'");
    // style-src の 'unsafe-inline' は従来どおり維持（cmn-0298 の撤去対象は script-src のみ）。
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '))!;
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('本番専用 directive が含まれる（導出 origin が全て https の時・cmn-0349 criteria 1）', async () => {
    const { buildCsp } = await loadMiddleware({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/api/v1',
      NEXT_PUBLIC_REFERENCE_APP_URL: 'https://ref.example.com',
    });
    const csp = buildCsp('n');
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('本番は style-src を三層に分離する（cmn-0351）: style-src-elem が nonce のみ・style-src-attr が unsafe-inline・style-src は fallback 維持', async () => {
    const { buildCsp } = await loadMiddleware({ NODE_ENV: 'production' });
    const csp = buildCsp('TESTNONCE123');
    const styleElem = csp.split('; ').find((d) => d.startsWith('style-src-elem '))!;
    expect(styleElem).toBe("style-src-elem 'self' 'nonce-TESTNONCE123'");
    expect(styleElem).not.toContain('unsafe-inline');
    const styleAttr = csp.split('; ').find((d) => d.startsWith('style-src-attr '))!;
    expect(styleAttr).toBe("style-src-attr 'unsafe-inline'");
    // style-src は fallback（style-src-elem/attr 未対応ブラウザ用）として従来どおり維持。
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('本番でも導出 origin に http が 1 つあれば UIR を出さない（cmn-0349 criteria 2・他 directive は維持）', async () => {
    // reference だけ http（本番相当 :3999 で reference 到達確認を潰さないための条件分岐）。
    const { buildCsp } = await loadMiddleware({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/api/v1',
      NEXT_PUBLIC_REFERENCE_APP_URL: 'http://localhost:3000',
    });
    const csp = buildCsp('n');
    expect(csp).not.toContain('upgrade-insecure-requests');
    // 他 directive は 1 と同一（connect-src の許可先が減らない）。
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' https://api.example.com http://localhost:3000");
  });

  it('本番は board を CSP に含めず、frame-src は self だけ・UIR を維持する（Board 廃止）', async () => {
    // Board（instruction-board）は廃止した。connect-src / frame-src に board のオリジンが
    // 載らないこと（残骸の許可先を残さない）を固定する。
    const { buildCsp } = await loadMiddleware({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/api/v1',
      NEXT_PUBLIC_REFERENCE_APP_URL: 'https://ref.example.com',
    });
    const csp = buildCsp('n');
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('localhost');
    expect(csp).not.toContain('board');
    expect(csp).toContain("frame-src 'self'; ");
  });

  it('safeOrigin が空文字へ縮退した値は http 判定に数えない（不正 env で UIR が誤って消えない・cmn-0349 criteria 4）', async () => {
    // API のみ不正 URL（空文字へ縮退）で、残り 2 つが https → UIR は維持される。
    const { buildCsp } = await loadMiddleware({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'not a url',
      NEXT_PUBLIC_REFERENCE_APP_URL: 'https://ref.example.com',
    });
    const csp = buildCsp('n');
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('undefined');
  });

  it('本番で http オリジン混入（設定ミス）は 1 回だけ警告する（security-reviewer HIGH 対応・cmn-0349）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { middleware } = await loadMiddleware({
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/api/v1',
        NEXT_PUBLIC_REFERENCE_APP_URL: 'http://localhost:3000',
      });
      middleware(new NextRequest('http://localhost:3000/desk'));
      middleware(new NextRequest('http://localhost:3000/desk'));
      const warned = errorSpy.mock.calls.filter((c) => String(c[0]).includes('[CSP]'));
      // http 混入の警告は初回 1 回のみ（毎リクエスト出さない）。
      expect(warned).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('本番で全オリジン https なら警告しない', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { middleware } = await loadMiddleware({
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/api/v1',
        NEXT_PUBLIC_REFERENCE_APP_URL: 'https://ref.example.com',
      });
      middleware(new NextRequest('http://localhost:3000/desk'));
      expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes('[CSP]'))).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('connect-src に env の2オリジンが導出され、frame-src は self だけになる', async () => {
    const { buildCsp } = await loadMiddleware({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/api/v1',
      NEXT_PUBLIC_REFERENCE_APP_URL: 'https://ref.example.com',
    });
    const csp = buildCsp('n');
    expect(csp).toContain("connect-src 'self' https://api.example.com https://ref.example.com");
    // Board 廃止に伴い、iframe の許可先は自オリジンだけ（外部オリジンを許可しない）。
    expect(csp).toContain("frame-src 'self'; ");
    // 本番は ws 系を許可しない
    expect(csp).not.toContain('ws:');
  });

  it('不正な env URL は originated せず、undefined 混入も起きない', async () => {
    const { buildCsp } = await loadMiddleware({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_BASE_URL: 'not a url',
    });
    const csp = buildCsp('n');
    expect(csp).not.toContain('undefined');
    expect(csp).toContain("connect-src 'self'");
  });
});

describe('buildCsp（開発）', () => {
  it('dev は React Refresh 用に unsafe-inline / unsafe-eval を維持し nonce は出ない', async () => {
    const { buildCsp } = await loadMiddleware({ NODE_ENV: 'development' });
    const csp = buildCsp('DEVNONCE');
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(csp).not.toContain('DEVNONCE');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('dev は style-src を分離しない（cmn-0351・React Refresh / dev overlay が style 注入するため）', async () => {
    const { buildCsp } = await loadMiddleware({ NODE_ENV: 'development' });
    const csp = buildCsp('DEVNONCE');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('style-src-elem');
    expect(csp).not.toContain('style-src-attr');
  });

  it('dev は HMR 用の ws/wss を許可する', async () => {
    const { buildCsp } = await loadMiddleware({ NODE_ENV: 'development' });
    const csp = buildCsp('n');
    expect(csp).toContain('ws: wss:');
  });
});

describe('middleware（nonce 運用）', () => {
  it('CSP 応答ヘッダに生成 nonce が含まれ、128bit（base64 24 文字）である（cmn-0350）', async () => {
    const { middleware } = await loadMiddleware({ NODE_ENV: 'production' });
    const res = middleware(new NextRequest('http://localhost:3000/desk'));
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    const m = csp!.match(/'nonce-([A-Za-z0-9+/=]+)'/);
    expect(m).not.toBeNull();
    // 16 バイト → base64 24 文字（CSP3 推奨 128bit・cmn-0350）。
    expect(m![1].length).toBe(24);
  });

  it('nonce はリクエストごとに新鮮（2回連続で異なる値）', async () => {
    const { middleware } = await loadMiddleware({ NODE_ENV: 'production' });
    const nonceOf = (res: ReturnType<typeof middleware>) =>
      res.headers.get('content-security-policy')!.match(/'nonce-([A-Za-z0-9+/=]+)'/)![1];
    const a = nonceOf(middleware(new NextRequest('http://localhost:3000/desk')));
    const b = nonceOf(middleware(new NextRequest('http://localhost:3000/desk')));
    expect(a).not.toBe(b);
  });
});

describe('config（matcher 形状ピン）', () => {
  it('_next 静的資産を除外し、prefetch には nonce を発行しない（拡張子除外は撤去・cmn-0350）', async () => {
    const mod = await loadMiddleware();
    const config = mod.config as typeof middlewareConfig;
    const rule = config.matcher[0] as { source: string; missing: Array<{ key: string }> };
    // 全体を完全一致で固定する（部分一致だと拡張子除外が変形して再挿入されても検出漏れになる）。
    expect(rule.source).toBe('/((?!_next/static|_next/image|favicon.ico).*)');
    // 拡張子除外（.*\\.(?:png|jpg|...) 形）の再挿入を明示的に検知する。
    expect(rule.source).not.toMatch(/\\\.\(\?:/);
    const keys = rule.missing.map((m) => m.key);
    expect(keys).toContain('next-router-prefetch');
    expect(keys).toContain('purpose');
  });
});
