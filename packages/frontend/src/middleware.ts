import { NextResponse, type NextRequest } from 'next/server';

// CSP の唯一の生成元（cmn-0298）。next.config.ts の headers() には CSP を置かない
// （二重生成元は nonce 無し応答の穴になるため）。他の security header は next.config.ts 側が持つ。
//
// nonce 配線は Next.js 15 標準: request header の Content-Security-Policy に nonce を含めて
// 渡すと、フレームワークが自身の出す <script> タグへ同じ nonce を自動付与する。
// 全ページは RootLayout の `export const dynamic = 'force-dynamic'` で動的描画に固定してあり、
// nonce 付き HTML が静的化・ISR で再利用されることはない。

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001/api/v1';
const REFERENCE_APP_URL = process.env.NEXT_PUBLIC_REFERENCE_APP_URL || 'http://localhost:3000';

// safeOrigin / buildCsp は test seam として export する（src/__tests__/middleware.test.ts）。
// middleware の CSP 生成は本番の全 script 実行を左右するため、純関数部分をユニットテストで固定する。
export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * 導出 origin のいずれかが http:// か（cmn-0349）。buildCsp の UIR 付与判定と
 * warnIfProductionHttpMixed の警告判定の両方が使う共通述語（二重実装を避ける）。
 * safeOrigin が空文字へ縮退した値（不正 env）は http 判定に数えない（criteria 4）。
 */
function hasHttpOrigin(...origins: string[]): boolean {
  return origins.some((origin) => origin.startsWith('http://'));
}

export function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  const apiOrigin = safeOrigin(API_BASE_URL);
  const referenceOrigin = safeOrigin(REFERENCE_APP_URL);
  // 開発時は React Refresh / dev overlay が inline・eval を使うため従来どおり許可し、
  // 本番だけ nonce + strict-dynamic で inline 注入を遮断する。
  const scriptSrc = isDev
    ? "'self' 'unsafe-inline' 'unsafe-eval'"
    : // strict-dynamic（cmn-0350）: nonce 付きスクリプトが動的ロードする後続スクリプトへ信頼が
      // 自動伝搬する。**第三者スクリプトを nonce 付きで入れると、そのスクリプトが読む全スクリプトが
      // 許可面に入る**＝nonce は「1 枚の実行許可証」でなく「信頼の起点」になる。script-src の
      // ホストリストを増やすより厳格だが、外部スクリプト導入時は必ずこの伝搬を考慮すること。
      `'self' 'nonce-${nonce}' 'strict-dynamic'`;
  // cmn-0351: スタイルの持ち込みも三層に分離する（CSS exfiltration 対策）。
  // - style-src: fallback として現状維持（style-src-elem/attr 未対応ブラウザは今までと同じ挙動）。
  // - style-src-elem: <style>/<link> の注入は 'self' + リクエスト毎 nonce 付きのみ許可（本番）。
  //   goober（トースト）は window.__nonce__、react-colorful・Tiptap は公式の nonce 受け口を経由する。
  // - style-src-attr: style 属性（React style={{}}・53 ファイル 374 箇所）は 'unsafe-inline' のまま（本番）。
  //   対応前ブラウザ（Safari 15.4 未満・Firefox 108 未満等）は style-src-attr 未対応で
  //   style-src 側へフォールバックするため挙動不変。
  // 遮断が実効となる範囲（cmn-0383 / MDN browser-compat-data 実測）: Chrome 75+ / Edge 79+ /
  // Firefox 108+ / Safari 26.2+。Safari 15.4〜26.1 は style-src-elem をパースするだけで効果が無く
  // （WebKit bug 276931）、style-src の 'unsafe-inline' へ実質フォールバックする＝この範囲外の
  // ブラウザでは遮断が効かず挙動も変わらない、が受容済みのトレードオフ。
  // dev は React Refresh / dev overlay が style 注入を行うため現状維持（style-src のみ）。
  // 三層分離の実装は下の 1 行（styleElemSrc 定義）＋ directives へのスプレッド 1 箇所で完結し、
  // 「本番だけ style-src-elem を追加し dev は style-src 単層のまま」を 1 行で明記している。
  const styleElemSrc = isDev ? undefined : `'self' 'nonce-${nonce}'`;
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    ...(styleElemSrc ? [`style-src-elem ${styleElemSrc}`, "style-src-attr 'unsafe-inline'"] : []),
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // referenceOrigin: システムタブの reachability probe（no-cors fetch）が reference へ到達確認するため許可。
    `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}${referenceOrigin ? ` ${referenceOrigin}` : ''}${isDev ? ' ws: wss:' : ''}`,
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  if (!isDev) {
    // cmn-0349: UIR（upgrade-insecure-requests）は「http を https へ強制昇格」する指令で、
    // connect-src で http オリジンを明示許可しているのと自己矛盾する。本番相当（:3999）で
    // reference（http://localhost:3000）への reachability probe が https へ昇格されて遮断され、
    // システムタブが非活性にラッチ固着する（一度 false になると戻らない）。
    // → 導出 origin のいずれか 1 つでも http なら UIR を付けない（本番デプロイは 3 つとも https なので
    // 本番の CSP は変わらない。http が混ざるのは設定ミスの状況であり、security-reviewer 指摘どおり
    // HSTS preload（next.config.ts）は別ホストの http fetch を守らないため、設定ミスを黙らせない
    // 警告を module ロード時 1 回だけ出す＝buildCsp は純関数のまま・副作用は middleware() 側に寄せる）。
    if (!hasHttpOrigin(apiOrigin, referenceOrigin)) {
      directives.push('upgrade-insecure-requests');
    }
  }
  return directives.join('; ');
}

/** 本番で http オリジン混入（設定ミス）を検出し、一度だけ警告する（cmn-0349・security-reviewer HIGH 対応）。 */
let warnedHttpMixed = false;
function warnIfProductionHttpMixed(apiOrigin: string, referenceOrigin: string): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!hasHttpOrigin(apiOrigin, referenceOrigin) || warnedHttpMixed) return;
  warnedHttpMixed = true;
  // eslint-disable-next-line no-console
  console.error(
    '[CSP] production で導出 origin に http が含まれています（upgrade-insecure-requests を付与しない設定です）。' +
      '本番では NEXT_PUBLIC_API_BASE_URL / NEXT_PUBLIC_REFERENCE_APP_URL を' +
      'すべて https にしてください（cmn-0349）。',
  );
}

export function middleware(request: NextRequest) {
  // cmn-0350: nonce は CSP3 推奨の 128bit（16 バイト）を crypto.getRandomValues から直接引く。
  // 旧実装（btoa(crypto.randomUUID())）は UUIDv4 由来の 122bit で推奨強度を満たさない。
  // base64 エンコードで 24 文字（16 bytes → ceil(16/3)*4 = 24）。連続 2 回が異なることは
  // テストで固定（乱数生成器の 128bit は UUID と同等以上のエントロピー）。
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  let nonce = '';
  for (const b of nonceBytes) nonce += String.fromCharCode(b);
  nonce = btoa(nonce);
  // 設定ミス（本番で http オリジン混入）を黙らせない（警告は初回 1 回のみ・毎リクエストは出さない）。
  warnIfProductionHttpMixed(safeOrigin(API_BASE_URL), safeOrigin(REFERENCE_APP_URL));
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  // nonce の伝搬は request header の Content-Security-Policy 経由のみ（Next.js 15 がここから
  // 抽出して framework script へ付与）。x-nonce のような別経路は作らない（生成元を一本に保つ）。
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // 内部の静的資産（nonce 不要・cache 対象）を除く全ルートへ適用する。
      // cmn-0350: 拡張子による除外は撤去した（public/ は存在せず守るべき静的資産は _next 配下のみ。
      // 拡張子除外があると /foo.json 等の存在しないパスへの直接遷移＝404 エラーページがセキュリティ
      // ヘッダ無しで返る経路が残る。エラーページにもヘッダは適用されてしかるべき）。
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      // prefetch 応答は本描画で再利用されうるため nonce を発行しない。
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
