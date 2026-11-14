import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AllExceptionsFilter } from '../filters/http-exception.filter';
import {
  createCorsMiddleware,
  EXPOSED_RESPONSE_HEADERS,
  oidcIssuerOrigin,
} from './cors.middleware';

/**
 * CORS ミドルウェアの単体テストと、503（混雑）経路との結合テスト。
 *
 * ここで検証すること:
 * - 許可オリジンにだけ CORS ヘッダを付けること（許可は全ルート共通の 1 集合）。
 * - Retry-After が Access-Control-Expose-Headers に載ること（載らないとブラウザ JS から読めない）。
 * - 実応答と preflight の両方で expose が返ること。
 * - 結合: 503 を返す実際の例外経路（AllExceptionsFilter）が Retry-After を立て、同じ応答に
 *   expose ヘッダが載っている＝クライアントが再送目安を読める状態になっていること。
 */

function makeRes() {
  const headers: Record<string, string> = {};
  const res: {
    statusCode: number;
    setHeader: jest.Mock;
    getHeader: (name: string) => string | undefined;
    end: jest.Mock;
    status: jest.Mock;
    json: jest.Mock;
  } = {
    statusCode: 200,
    setHeader: jest.fn((name: string, value: string | number) => {
      headers[name] = String(value);
    }),
    getHeader: (name: string) => headers[name],
    end: jest.fn(),
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  return { res, headers };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/api/tasks',
    headers: { origin: 'http://localhost:3010' },
    ...overrides,
  } as unknown as Request;
}

function run(req: Request, res: ReturnType<typeof makeRes>['res']): jest.Mock {
  const next = jest.fn() as unknown as NextFunction;
  const middleware = createCorsMiddleware({
    allowedOrigins: ['http://localhost:3010'],
  });
  middleware(req, res as unknown as Response, next);
  return next as unknown as jest.Mock;
}

describe('createCorsMiddleware', () => {
  it('許可オリジンには CORS ヘッダを付け、Retry-After を expose する', () => {
    const { res, headers } = makeRes();

    const next = run(makeReq(), res);

    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3010');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers['Vary']).toBe('Origin');
    // 既定の 7 ヘッダに Retry-After は含まれないため、明示しないとクライアントから読めない。
    expect(headers['Access-Control-Expose-Headers']).toContain('Retry-After');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('未許可オリジンの安全メソッドは一切ヘッダを付けず後続へ進む', () => {
    const { res, headers } = makeRes();

    const next = run(
      makeReq({ headers: { origin: 'http://evil.example' } } as Partial<Request>),
      res,
    );

    expect(Object.keys(headers)).toHaveLength(0);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('未許可Originの状態変更要求はcontrollerへ進めず403で拒否する', () => {
    const { res, headers } = makeRes();

    const next = run(
      makeReq({
        method: 'POST',
        headers: { origin: 'https://untrusted.example' },
      } as Partial<Request>),
      res,
    );

    expect(Object.keys(headers)).toHaveLength(0);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Origin is not allowed' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('Originなしのserver-to-server状態変更要求は引き続き許可する', () => {
    const { res, headers } = makeRes();

    const next = run(makeReq({ method: 'POST', headers: {} } as Partial<Request>), res);

    expect(Object.keys(headers)).toHaveLength(0);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('Origin ヘッダが無い（同一オリジン / サーバ間）なら素通しする', () => {
    const { res, headers } = makeRes();

    const next = run(makeReq({ headers: {} } as Partial<Request>), res);

    expect(Object.keys(headers)).toHaveLength(0);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ルート単位の追加許可は無い（旧クロスサービス対象ルートでも別オリジンは許可されない）', () => {
    // d1264/d1265: reference の表示設定の写しを廃止し、クロスサービス許可を撤去した。
    // 旧対象ルートだけが例外的に開く状態へ戻っていないことを、当時のパスで固定する。
    const { res, headers } = makeRes();

    run(
      makeReq({
        path: '/api/v1/accounts/me/display-preference',
        headers: { origin: 'http://localhost:3000' },
      } as Partial<Request>),
      res,
    );

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  // d1269: oidc-provider の end_session 確認フォームは backend 自身が返す HTML で、送信先も backend
  // 自身（同一オリジン）。form POST には Origin が付くため、許可オリジン（frontend）だけを見ていると
  // 403 で止まり、RP 起点のログアウトが完了しない。
  it('同一オリジン（Origin のホスト:ポートが Host と一致）の状態変更要求は通す（d1269）', () => {
    const { res, headers } = makeRes();

    const next = run(
      makeReq({
        method: 'POST',
        path: '/api/v1/oidc/session/end/confirm',
        headers: { origin: 'http://localhost:3011', host: 'localhost:3011' },
      } as Partial<Request>),
      res,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('別オリジン（同じホストでもポートが違う）は同一オリジン扱いにしない', () => {
    const { res } = makeRes();

    const next = run(
      makeReq({
        method: 'POST',
        headers: { origin: 'http://localhost:4010', host: 'localhost:3011' },
      } as Partial<Request>),
      res,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // d1269: Referrer-Policy が no-referrer の文書からの form POST は `Origin: null` になる（実測）。
  // null は「同一オリジン」ではないので、状態変更要求を通してはいけない（任意の no-referrer
  // ページから状態変更できる穴になる）。画面側は same-origin を明示して実 Origin を送らせる。
  it('Origin: null（不透明オリジン）の状態変更要求は 403 で拒否する', () => {
    const { res } = makeRes();

    const next = run(
      makeReq({
        method: 'POST',
        headers: { origin: 'null', host: 'localhost:3011' },
      } as Partial<Request>),
      res,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('preflight（OPTIONS）でも expose ヘッダを返し 204 で終える', () => {
    const { res, headers } = makeRes();

    run(
      makeReq({
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3010',
          'access-control-request-headers': 'content-type',
        },
      } as Partial<Request>),
      res,
    );

    expect(headers['Access-Control-Expose-Headers']).toContain('Retry-After');
    expect(headers['Access-Control-Allow-Methods']).toContain('POST');
    expect(headers['Access-Control-Allow-Headers']).toBe('content-type');
    expect(res.statusCode).toBe(204);
    expect(res.end).toHaveBeenCalled();
  });

  it('未許可Originのpreflightは拒否する', () => {
    const { res } = makeRes();
    const next = run(
      makeReq({
        method: 'OPTIONS',
        headers: { origin: 'https://untrusted.example' },
      } as Partial<Request>),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('（結合）503 の応答で Retry-After が立ち、同じ応答が expose ヘッダを持つ', () => {
    // filter は 5xx を error ログへ出す（本テストの検証対象ではないので黙らせる）。
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { res, headers } = makeRes();
    run(makeReq(), res);

    // 混雑（P2024 / P2028 → PrismaExceptionFilter）が最終的に投げるのと同じ形の 503 を通す。
    const filter = new AllExceptionsFilter();
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ url: '/api/tasks', method: 'GET' }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(
      new ServiceUnavailableException({
        code: 'SERVICE_UNAVAILABLE',
        message: '現在混み合っています。しばらくしてからもう一度お試しください',
        retryAfter: 5,
      }),
      host,
    );

    expect(headers['Retry-After']).toBe('5');
    // 立っているだけでは CORS 越しに読めない。露出とセットで初めて意味を持つ。
    for (const header of EXPOSED_RESPONSE_HEADERS) {
      expect(headers['Access-Control-Expose-Headers']).toContain(header);
    }
  });

  // d1269: 同一オリジン判定の根拠は「設定として知っている自分の公開オリジン」を第一にする。
  // リバプロが Host を上流名へ書き換えても end_session の確認フォーム（同一オリジン POST）が通る。
  it('sameOrigins に載っている自分の公開オリジンは Host が違っても通す（プロキシの Host 書換に耐える）', () => {
    const { res, headers } = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    createCorsMiddleware({
      allowedOrigins: ['http://localhost:3010'],
      sameOrigins: ['http://localhost:3011'],
    })(
      makeReq({
        method: 'POST',
        headers: { origin: 'http://localhost:3011', host: 'rete-prod-backend:3011' },
      } as Partial<Request>),
      res as unknown as Response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    // 同一オリジンは CORS の外なので CORS ヘッダは付けない（許可オリジン扱いにしない）。
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('sameOrigins を設定しても、載っていない別オリジンの状態変更は拒否する', () => {
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    createCorsMiddleware({
      allowedOrigins: ['http://localhost:3010'],
      sameOrigins: ['http://localhost:3011'],
    })(
      makeReq({
        method: 'POST',
        headers: { origin: 'http://localhost:9999', host: 'localhost:3011' },
      } as Partial<Request>),
      res as unknown as Response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('oidcIssuerOrigin は OIDC_ISSUER のオリジンを返し、未設定なら provider 既定を使う', () => {
    expect(oidcIssuerOrigin('https://rete.example.com/api/v1/oidc', '3011')).toBe(
      'https://rete.example.com',
    );
    expect(oidcIssuerOrigin(undefined, '3011')).toBe('http://localhost:3011');
    expect(oidcIssuerOrigin('not a url', '3011')).toBeUndefined();
  });

  // d1269: Origin: null の専用分岐に判別力を持たせる。CORS_ORIGIN の誤設定などで 'null' が
  // 許可一覧へ紛れ込んでも、不透明オリジンからの状態変更は通さない（分岐を消すとここが落ちる）。
  it('allowedOrigins に null が混ざっていても、Origin: null の状態変更は拒否する', () => {
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    createCorsMiddleware({ allowedOrigins: ['null'] })(
      makeReq({
        method: 'POST',
        headers: { origin: 'null', host: 'localhost:3011' },
      } as Partial<Request>),
      res as unknown as Response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // d1269: 同一オリジン判定は scheme も見る。https のホストを http で開いたページ（ダウングレード・
  // ホスト乗っ取り）が同一オリジン扱いにならないこと。
  it('scheme が違う同一ホストは同一オリジン扱いにしない', () => {
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    createCorsMiddleware({
      allowedOrigins: ['http://localhost:3010'],
      sameOrigins: ['https://rete.example.com'],
    })(
      makeReq({
        method: 'POST',
        secure: true,
        headers: { origin: 'http://rete.example.com', host: 'rete.example.com' },
      } as unknown as Partial<Request>),
      res as unknown as Response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // 上のテスト群は「ミドルウェアの中身」しか見ない＝main.ts から app.use を消しても全部緑になる。
  // 配線が生きていることは bootstrap のソースを文字列で pin して守る（bootstrap は起動副作用が
  // 大きく import できないため、この形が最も安い）。
  it('main.ts が本ミドルウェアを実際に配線している', () => {
    const mainSource = readFileSync(join(__dirname, '../../main.ts'), 'utf8');

    expect(mainSource).toContain('createCorsMiddleware');
    expect(mainSource).toMatch(/app\.use\(\s*createCorsMiddleware\(/);
  });

  // cmn-0347: CORS は session より**前**に適用する（helmet → cors → session の順）。
  // cors を session の後ろへ移すと、未認証リクエストが session 確立後に CORS 判定される順序になり
  // （express は app.use の登録順に実行する）、preflight やヘッダ露出の扱いが変わってしまう。
  // 順序の崩れをソース文字列で機械検出する（同ファイルの配線 pin と同じ流儀）。
  it('main.ts のミドルウェア適用順が helmet → cors → session である（cors を session より後ろへ移すと落ちる）', () => {
    const mainSource = readFileSync(join(__dirname, '../../main.ts'), 'utf8');

    const helmetIdx = mainSource.indexOf('app.use(helmet(');
    // d1269: 配線が複数行になった（sameOrigins を渡す）ため、改行を許す正規表現で位置を取る。
    const corsMatch = /app\.use\(\s*createCorsMiddleware\(/.exec(mainSource);
    const corsIdx = corsMatch ? corsMatch.index : -1;
    const sessionIdx = mainSource.search(/app\.use\(\s*session\(/);
    expect(helmetIdx).toBeGreaterThanOrEqual(0);
    expect(corsIdx).toBeGreaterThanOrEqual(0);
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    // この順序で並んでいること（前後が入れ替わると assert が落ちる）。
    expect(helmetIdx).toBeLessThan(corsIdx);
    expect(corsIdx).toBeLessThan(sessionIdx);
  });
});
