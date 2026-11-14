import type { Request, Response, NextFunction } from 'express';

/**
 * ブラウザ JS へ読み取りを許可する応答ヘッダ。
 *
 * CORS 越しの fetch では、既定の 7 ヘッダ（Cache-Control / Content-Language / Content-Length /
 * Content-Type / Expires / Last-Modified / Pragma）以外は明示しない限りクライアントから読めない。
 * Retry-After は 503（混雑）時の再送目安で、読めなければクライアント側の待ち時間制御が働かず
 * 「即やり直して再び 503」を招く（cmn-0235 で足したヘッダが cmn-0251 まで隠れていた）。
 */
export const EXPOSED_RESPONSE_HEADERS = ['Retry-After'] as const;

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface CorsMiddlewareConfig {
  /** 全ルートで許可するオリジン（CORS_ORIGIN 由来）。 */
  allowedOrigins: string[];
  /**
   * 同一オリジン扱いにするオリジン（backend 自身の公開オリジン・d1269）。
   *
   * 何のためか: oidc-provider の end_session 確認フォームは backend 自身が返す HTML から
   * backend 自身へ POST する。判定を `Host` ヘッダだけに頼ると、本番のリバプロ（Caddy）が
   * Host を上流名へ書き換えた時に同一オリジンと判定できず 403 になり、ログアウトが止まる。
   * また Host は要求側が決められる値なので、判定の根拠は「サーバーが設定として知っている自分の
   * 公開オリジン（OIDC_ISSUER のオリジン）」である方が強い。Origin はブラウザが付ける値で、
   * 他サイトのページから自分のオリジンへ偽装できない。
   */
  sameOrigins?: string[];
}

/**
 * Origin が「このリクエスト自身の置き場」と同じか（同一オリジン）。
 *
 * なぜ要るか（d1269）: oidc-provider の end_session 確認フォームは backend 自身が返す HTML で、
 * 送信先も backend 自身（同一オリジン）。ブラウザは form POST に Origin を付けるため、
 * 許可オリジン（frontend）に無いと 403 で弾かれ、RP 起点のログアウトが完了しない。
 * 同一オリジンは CORS の許可対象ではない（そもそも CORS の外）ので、ホスト:ポートと scheme の
 * 一致を見て素通しする。scheme は `req.secure`（trust proxy 配下では実際の scheme）で判定する。
 */
function isSameOrigin(origin: string, host: string | undefined, isSecure: boolean): boolean {
  if (!host) return false;
  try {
    const url = new URL(origin);
    // scheme も比較する（レビュー指摘）: ホスト:ポートだけで比べると、同じホスト名の平文ページ
    // （https のサイトを http で開いた場合やホスト乗っ取り時）が同一オリジン扱いになる。
    // TLS 終端のリバプロ配下では req.secure（trust proxy）が実際の scheme を表す。
    const expectedScheme = isSecure ? 'https:' : 'http:';
    return url.host === host && url.protocol === expectedScheme;
  } catch {
    return false;
  }
}

/**
 * issuer / PORT から「自分の公開オリジン」を求める（main.ts の配線用・d1269）。
 *
 * OIDC_ISSUER が未設定なら provider と同じ既定（`http://localhost:${PORT || 3001}/...`）を使う。
 * 解釈できない値は undefined（呼び出し側で除外）。
 */
export function oidcIssuerOrigin(
  issuer: string | undefined,
  port: string | undefined,
): string | undefined {
  const raw = issuer?.trim() || `http://localhost:${port || '3001'}`;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/**
 * Origin が `null`（不透明オリジン）か。
 *
 * ブラウザは Referrer-Policy: no-referrer の文書から form POST すると `Origin: null` を送る
 * （実測: Chrome。oidc-provider の end_session 確認フォームがこれに当たった）。`null` は
 * 「同一オリジン」を意味しないため、ここで許可すると任意の no-referrer ページから状態変更要求を
 * 通してしまう。したがって null は許可しない（送信元の画面側で Referrer-Policy を same-origin に
 * して実際の Origin を送らせる・d1269）。
 */
function isOpaqueOrigin(origin: string | undefined): boolean {
  return origin === 'null';
}

/**
 * CORS ヘッダを手書きで付与するミドルウェア（enableCors は使わない）。
 *
 * 許可オリジンは全ルート共通の 1 集合（CORS_ORIGIN 由来）だけを持つ。かつては ref-0037 の
 * クロスサービス許可（reference frontend が表示設定 API を直接 fetch する）をルート単位で
 * 追加していたが、Reference 側の写し自体が廃止されたため（d1264/d1265）口ごと撤去した。
 * 対象ルートが無い「追加許可の入口」を残すと、実体のないオリジン集合が静かに復活する。
 *
 * main.ts から切り出してある理由は、許可判定と expose ヘッダを spec で固定できるようにするため
 * （bootstrap の中に埋めると、どの経路でも検証できない・cmn-0251）。
 */
export function createCorsMiddleware(config: CorsMiddlewareConfig) {
  const { allowedOrigins } = config;
  // 設定済みの自分の公開オリジン（前後の空白と末尾スラッシュを落として比較する）。
  const sameOrigins = new Set(
    (config.sameOrigins ?? []).map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean),
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (!origin) return next();

    // `Origin: null` は不透明オリジン（sandbox iframe・data: 文書・no-referrer 文書など）。
    // 同一オリジンではないので、状態変更要求は許可しない（isSameOrigin でも false になる）。
    if (isOpaqueOrigin(origin)) {
      if (req.method === 'OPTIONS' || STATE_CHANGING_METHODS.has(req.method.toUpperCase())) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Origin is not allowed' },
        });
        return;
      }
      return next();
    }

    if (!allowedOrigins.includes(origin)) {
      // d1269: 同一オリジン（backend 自身が返した HTML からの form POST）は CORS の外なので通す。
      // ここを許可オリジンだけにすると、oidc-provider の end_session 確認フォームが 403 で
      // 止まり、RP 起点のログアウトが完了しない。判定は「設定として知っている自分の公開オリジン」
      // を第一にし、無い時だけ Host を見る（プロキシの Host 書き換えで止まらない・Host 偽装に強い）。
      const normalizedOrigin = origin.replace(/\/+$/, '');
      if (sameOrigins.has(normalizedOrigin) || isSameOrigin(origin, req.headers.host, req.secure)) {
        return next();
      }
      // CORS response headers alone do not stop a form or other simple request from reaching a
      // state-changing endpoint. Reject untrusted browser origins before session/controller code
      // runs. Requests without Origin remain available to same-origin and server-to-server callers.
      if (req.method === 'OPTIONS' || STATE_CHANGING_METHODS.has(req.method.toUpperCase())) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Origin is not allowed' },
        });
        return;
      }
      return next();
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // 実応答（GET / POST など）と preflight の両方で返す。preflight だけに付けても実応答側で
    // 読み取り許可が付かないため意味がない。
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_RESPONSE_HEADERS.join(', '));

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
      const requestedHeaders = req.headers['access-control-request-headers'];
      if (requestedHeaders) {
        res.setHeader('Access-Control-Allow-Headers', requestedHeaders as string);
      }
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
}
