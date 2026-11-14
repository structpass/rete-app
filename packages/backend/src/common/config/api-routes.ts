/**
 * ルートパスの共有定数（cmn-0132）。
 *
 * route-scoped CORS（main.ts）の対象ルートと、実際にそのルートを生やしているコントローラの
 * デコレータ引数が、別々の場所に書かれた文字列リテラルで暗黙に結ばれている状態を解消する。
 * 片側だけ改名すると「reference から設定が読めなくなる」か「意図しない API が外部へ開いたまま
 * 残る」のどちらかが無言で起きるため、両者が同じ定数を参照する形にし、実パスとの一致は
 * accounts.controller.spec.ts の回帰テストがコントローラのメタデータ経由で固定する。
 *
 * 許可するオリジンの集合は CORS_ORIGIN の 1 つ（d1264/d1265 でクロスサービス許可を撤去）。
 *
 * auth/guards の `/api/v1` 直書き（ip-allowlist / mfa-enforcement / password-change-enforcement）と
 * audit-log.interceptor・oidc-config.factory の同義リテラルは cmn-0182 で本ファイルへ寄せ済み。
 * ガードは req.path から prefix を剥がすため先頭スラッシュ付きの API_GLOBAL_PREFIX_PATH を参照する。
 */

/** app.setGlobalPrefix に渡すグローバルプレフィックス（先頭スラッシュ無し）。 */
export const API_GLOBAL_PREFIX = 'api/v1';

/**
 * req.path と同形＝先頭スラッシュ付きのグローバルプレフィックス（= `/${API_GLOBAL_PREFIX}`）。
 * ガードの prefix 剥がし（raw.startsWith / raw.slice）用。API_GLOBAL_PREFIX を直接使うと
 * 先頭スラッシュが無く startsWith('api/v1') が常に false になり全除外パスが失効するため、
 * ガードは必ずこの派生定数を経由する（cmn-0182）。
 */
export const API_GLOBAL_PREFIX_PATH = `/${API_GLOBAL_PREFIX}`;

/** @Controller('accounts') のパス。 */
export const ACCOUNTS_CONTROLLER_PATH = 'accounts';

/** AccountsController の表示個人設定ルート（@Get / @Put 共通のパス）。 */
export const ACCOUNTS_DISPLAY_PREFERENCE_PATH = 'me/display-preference';

/** 断片を実際のリクエストパス（req.path と同形＝先頭スラッシュ付き）へ組み立てる。 */
export const buildApiPath = (...segments: string[]): string =>
  `/${[API_GLOBAL_PREFIX, ...segments].join('/')}`;

/**
 * クロスサービス CORS（別サービス frontend のオリジンにも開くルート）の対象。
 * ここに載っているルートだけが他サービスのブラウザから直接 fetch 可能になる。
 *
 * 現在は対象ルートが無い（d1264/d1265 で Reference の写しを廃止したため空配列）。
 * 追加許可オリジン自体を配線していないので、ここへルートを足すだけでは何も開かない。
 */
export const CROSS_SERVICE_ROUTES: readonly string[] = [];
