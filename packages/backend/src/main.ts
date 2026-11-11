import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import session from 'express-session';
import passport from 'passport';
import { AppModule } from './app.module';
import { createCorsMiddleware } from './common/security/cors.middleware';
import { createSessionStore } from './common/session/session-store.config';
import {
  assertValidNodeEnv,
  MIN_SECRET_LENGTH,
  PLACEHOLDER_MARKERS,
  validateDatabasePoolLimits,
  validateOidcRpSecretsInProduction,
} from './common/config/env-validation';
import { API_GLOBAL_PREFIX, CROSS_SERVICE_ROUTES } from './common/config/api-routes';
import { parseMfaTotpEncKey } from './common/security/secret-crypto';
import { throttleBypassEnabled } from './common/security/throttle-skip';

const REQUIRED_ENV_VARS = ['DATABASE_URL'];

// 本番でのみ存在+強度を検証する認証 secret（operational-policy §4）。dev は未設定で安全な既定にフォールバック。
const PRODUCTION_REQUIRED_SECRETS = ['SESSION_SECRET', 'OIDC_COOKIE_KEYS', 'OIDC_JWKS'];

/**
 * MFA の暗号鍵（MFA_TOTP_ENC_KEY）。本番では必須にする。
 *
 * 未設定のまま本番が起動すると、鍵生成系（setup/confirm/disable/regenerate）が常に 503 になり
 * 多要素認証を提供できない。さらに全体強制 MFA を ON にすると、local ユーザーは
 * MFA_SETUP_REQUIRED で遮断されたまま設定を完了できず締め出される（強制を戻せるのは
 * /settings/login に到達できる ADMIN だけ）。したがって「未設定＝起動できる」graceful degradation は
 * dev / test に限り、本番は欠落・形不正を起動時に弾く（d558）。形の判定は暗号化と同じ関数を使う。
 * 既に有効化済みの MFA はログイン検証もこの鍵に依存するため、鍵を失うと全ユーザーが再登録になる。
 */
const MFA_TOTP_ENC_KEY_NAME = 'MFA_TOTP_ENC_KEY';

function validateEnv(): void {
  // NODE_ENV は本番ハードニングの発火条件のため、未設定・未知値での fail-open を起動時に弾く。
  assertValidNodeEnv(process.env.NODE_ENV);

  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill in all required values.',
    );
  }
}

/**
 * 本番では認証 secret の欠落・placeholder・長さ不足を起動時に弾く（operational-policy §4）。
 * OIDC_JWKS は長さ検証の対象外（JSON 構造のため存在と非 placeholder のみ確認）。
 *
 * cmn-0249: OIDC_REFERENCE_CLIENT_SECRET の条件付き検査（cmn-0230 採用方針＝未設定の本番は
 * 落とさない）と redirect_uris の必須化検査を、本関数に集約して problems[] へ載せる。
 * 以前は validateEnv 側で単独 throw していたため、不備が1件ずつ順に落ちる往復が増えた。
 *
 * d558: MFA の暗号鍵（MFA_TOTP_ENC_KEY）は本番必須として同じ problems[] に載せる。
 */
function validateProductionSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  for (const key of PRODUCTION_REQUIRED_SECRETS) {
    const value = process.env[key];
    if (!value) {
      problems.push(`${key} is required in production`);
      continue;
    }
    const lower = value.toLowerCase();
    if (PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))) {
      problems.push(`${key} looks like a placeholder — set a real secret`);
    }
    if (key !== 'OIDC_JWKS' && value.length < MIN_SECRET_LENGTH) {
      problems.push(`${key} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }
  // d558: MFA の暗号鍵。本番は必須（欠落・placeholder・hex64/base64_32byte 以外の形を弾く）。
  // 未設定のまま起動すると MFA を提供できず、全体強制 ON 時に local ユーザーが締め出される。
  const mfaKey = process.env[MFA_TOTP_ENC_KEY_NAME];
  if (!mfaKey) {
    problems.push(`${MFA_TOTP_ENC_KEY_NAME} is required in production`);
  } else if (
    PLACEHOLDER_MARKERS.some((marker) => mfaKey.toLowerCase().includes(marker)) ||
    parseMfaTotpEncKey(mfaKey) === null
  ) {
    problems.push(
      `${MFA_TOTP_ENC_KEY_NAME} must be a real key: 64 hex characters or base64 of 32 bytes`,
    );
  }
  // OIDC の first-party RP は OIDC_RP_DEFINITIONS を正本にする（d1213）。RP ごとに検査を写経すると、
  // 表へ RP を足した時に登録だけ増えて本番の資格情報検査が素通りする（fail-open）。
  // 未設定の RP は連携を使わないので検査しない（cmn-0230）。
  problems.push(...validateOidcRpSecretsInProduction());
  if (problems.length > 0) {
    throw new Error(`Insecure production secrets:\n  - ${problems.join('\n  - ')}`);
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  validateEnv();
  validateProductionSecrets();

  // cmn-0395 criteria 9: レート制限の素通しが有効なまま起動したことをログに残す
  // （有効なまま気づかず放置される状態を作らない）。本番は throttleBypassEnabled が常に false のため
  // この warn は出ない。
  if (throttleBypassEnabled()) {
    logger.warn(
      'E2E_THROTTLE_BYPASS=true: レート制限を素通ししています（開発用）。本番では無効です。',
    );
  }

  // 接続プールの上限（cmn-0251）。テンプレート（.env.example）に書くだけでは既存の .env へ伝播しない
  // ため、実際の接続文字列を起動時に見る。本番は fail-fast（枯渇が認証系まで巻き込むため）、
  // dev / test は warn に留める（手元の起動を止めない）。
  const poolProblem = validateDatabasePoolLimits(process.env.DATABASE_URL);
  if (poolProblem) {
    if (process.env.NODE_ENV === 'production') throw new Error(poolProblem);
    logger.warn(poolProblem);
  }

  const app = await NestFactory.create(AppModule);

  // セキュリティヘッダー
  // crossOriginResourcePolicy: helmet 既定値 same-origin だと、CORS で明示許可した origin
  // からの正当な fetch すら CORP でブロックされる（ref-0037・実機検証で発見）。同一 site（port 違いのみ、
  // または本番で同一 registrable domain のサブドメイン）からの読み込みは通し、真に無関係なオリジンからの
  // 埋め込みは引き続き CORP でブロックする same-site を採用（security-reviewer 指摘: cross-origin まで
  // 緩めると任意オリジンに対して Spectre 系サイドチャネル対策が失われる。同一 site でない別ドメイン構成の
  // 場合は SameSite=Lax cookie 自体が届かず本機能はフォールバックするだけなので cross-origin まで緩める理由はない）。
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

  // CORS設定（カンマ区切りで複数オリジン対応）
  const rawOrigins = process.env.CORS_ORIGIN || 'http://localhost:3000';
  const allowedOrigins = rawOrigins.split(',').map((o) => o.trim());

  // ref-0037: reference frontend が表示設定 API を直接 fetch するためのクロスサービス許可。
  // 対象ルートだけに限定する（security-reviewer 指摘: enableCors のグローバル allowlist に
  // 混ぜると reference 侵害時の blast radius が accounts/tasks/chat 等の全API・全操作に及ぶ）。
  const crossServiceOrigins = (process.env.CROSS_SERVICE_CORS_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // 対象ルートは共有定数（common/config/api-routes.ts）から組み立てる。コントローラ側の
  // デコレータも同じ定数を参照し、実パスとの一致は accounts.controller.spec.ts が固定する（cmn-0132）。
  const crossServiceRoutes = CROSS_SERVICE_ROUTES;

  // 判定と expose ヘッダの本体は common/security/cors.middleware.ts（spec で固定するため切り出し）。
  app.use(createCorsMiddleware({ allowedOrigins, crossServiceOrigins, crossServiceRoutes }));

  // express-session + passport（Rete 自身のログイン session）。
  // OIDC provider は自前 cookie + adapter で session を持つため、これは Hub 等アプリ側の認証用。
  // 本番は connect-pg-simple で既存 PostgreSQL に永続化（operational-policy §4）。
  // dev は既定 MemoryStore（SESSION_STORE=pg で pg に切替可）。
  const isProd = process.env.NODE_ENV === 'production';
  const sessionLogger = new Logger('SessionStore');
  const sessionStore = createSessionStore(session, process.env, {
    // connect-pg-simple のエラーを NestJS Logger に振る（operational-policy §2 / 既定 console.error を回避）。
    errorLog: (...args) =>
      sessionLogger.error(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')),
  });

  // 本番で永続ストアが解決できないまま MemoryStore で起動するのを構造的に禁止する
  // （createSessionStore も本番 DATABASE_URL 欠落で throw するが、呼び出し側でも不変条件を明示する）。
  if (isProd && !sessionStore) {
    throw new Error(
      'A persistent session store is required in production (operational-policy §4).',
    );
  }

  app.use(
    session({
      store: sessionStore,
      secret: process.env.SESSION_SECRET || 'dev-insecure-session-secret-change-me',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        maxAge: 1000 * 60 * 60 * 24, // 1 day
      },
    }),
  );
  app.use(passport.initialize());
  app.use(passport.session());

  logger.log(
    `session store: ${sessionStore ? 'connect-pg-simple (PostgreSQL)' : 'MemoryStore (dev only)'}`,
  );

  // グローバルバリデーションパイプ
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // APIプレフィックス
  app.setGlobalPrefix(API_GLOBAL_PREFIX);

  // trust proxy は既定 false（1 台直結デプロイで X-Forwarded-For を信頼しない secure default＝
  // XFF 詐称による IP 許可リスト=IpAllowlistGuard のバイパス不可）。本番コンテナは共有 Caddy 1 段の
  // 背後に立つため（cmn-0402 docker-compose.prod.yml）、TRUST_PROXY=true の時だけ hop 数 1 で有効化する
  // （過大信頼は XFF 詐称を招くので boolean true や大きい hop 数にはしない）。
  // 詳細は docs/architecture/operational-policy.md §9（set-0025 P1）。
  if (process.env.TRUST_PROXY === 'true') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    logger.log(
      'trust proxy: 1 (TRUST_PROXY=true — reverse proxy 1 段の背後で実クライアント IP を採用)',
    );
  }

  // Swagger 公開条件: デフォルト非公開。SWAGGER_ENABLED=true を明示した時のみ有効化する。
  const swaggerEnabled = process.env.SWAGGER_ENABLED === 'true';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Struct Rete API')
      .setDescription('タスク + チャット連結軸 REST API')
      .setVersion('0.1')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);
    logger.log(`Swagger documentation: http://localhost:${process.env.PORT || 3001}/api`);
  }

  const port = process.env.PORT || 3001;
  if (process.env.BIND_HOST) {
    await app.listen(port, process.env.BIND_HOST);
  } else {
    await app.listen(port);
  }
  logger.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
