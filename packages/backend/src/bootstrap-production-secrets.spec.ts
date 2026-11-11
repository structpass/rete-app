/**
 * 本番起動時の secret 検査（main.ts の validateProductionSecrets）を、実 main を起動せずに検証する。
 *
 * main.ts は import した時点で bootstrap() が走る（NestFactory.create で DB・ポートを掴む）ため、
 * モジュールを読み込まずにソースを読み、validateProductionSecrets の関数宣言だけを評価する。
 * これは d558（MFA の暗号鍵を本番必須にしたこと）の回帰検査で、DB・環境に依存しない。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAIN_SOURCE = readFileSync(join(__dirname, 'main.ts'), 'utf8');

type Validate = () => void;

/** main.ts の validateProductionSecrets 宣言を抜き出し、同じモジュール定数と一緒に評価して関数を返す。 */
function loadValidateProductionSecrets(): Validate {
  const start = MAIN_SOURCE.indexOf('function validateProductionSecrets(): void {');
  if (start < 0) throw new Error('validateProductionSecrets が main.ts に見つかりません');
  const end = MAIN_SOURCE.indexOf('\nasync function bootstrap', start);
  if (end < 0) throw new Error('bootstrap 宣言が main.ts に見つかりません');
  // 型注釈（TS の記法）だけ落として JS として評価する。
  const stripTypes = (src: string): string => src.replace(/: void|: string\[\]/g, '');
  const fnSource = stripTypes(MAIN_SOURCE.slice(start, end));

  const constantsStart = MAIN_SOURCE.indexOf('const PRODUCTION_REQUIRED_SECRETS');
  const constantsEnd = MAIN_SOURCE.indexOf('\nfunction validateEnv', constantsStart);
  // 定数ブロックの型注釈（TS の記法）だけ落として JS として評価する。
  const constantsSource = MAIN_SOURCE.slice(constantsStart, constantsEnd).replace(
    /: void|: string\[\]/g,
    '',
  );

  // d1213: OIDC の RP 検査は main.ts が OIDC_RP_DEFINITIONS を回す 1 関数へ寄せた。
  // 補助関数・定数は main.ts と同じ実装を渡す（本体は表を読むので、この spec でも表の全 RP が効く）。
  const { MIN_SECRET_LENGTH, PLACEHOLDER_MARKERS, validateOidcRpSecretsInProduction } =
    jest.requireActual<{
      MIN_SECRET_LENGTH: number;
      PLACEHOLDER_MARKERS: string[];
      validateOidcRpSecretsInProduction: () => string[];
    }>('./common/config/env-validation');

  const factory = new Function(
    'process',
    'validateOidcRpSecretsInProduction',
    'parseMfaTotpEncKey',
    'MIN_SECRET_LENGTH',
    'PLACEHOLDER_MARKERS',
    `${constantsSource}\n${fnSource}\nreturn validateProductionSecrets;`,
  );
  return factory(
    process,
    validateOidcRpSecretsInProduction,
    jest.requireActual<{ parseMfaTotpEncKey: (raw?: string) => Buffer | null }>(
      './common/security/secret-crypto',
    ).parseMfaTotpEncKey,
    MIN_SECRET_LENGTH,
    PLACEHOLDER_MARKERS,
  ) as Validate;
}

describe('validateProductionSecrets（本番の MFA 暗号鍵・d558）', () => {
  const validateProductionSecrets = loadValidateProductionSecrets();
  const ENV_KEYS = [
    'NODE_ENV',
    'SESSION_SECRET',
    'OIDC_COOKIE_KEYS',
    'OIDC_JWKS',
    'OIDC_REFERENCE_CLIENT_SECRET',
    'OIDC_REFERENCE_REDIRECT_URIS',
    'OIDC_GMIS_CLIENT_SECRET',
    'OIDC_GMIS_REDIRECT_URIS',
    'MFA_TOTP_ENC_KEY',
  ] as const;
  const original: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 's'.repeat(64);
    process.env.OIDC_COOKIE_KEYS = 'c'.repeat(64);
    process.env.OIDC_JWKS = '{"keys":[]}';
    delete process.env.OIDC_REFERENCE_CLIENT_SECRET;
    delete process.env.OIDC_GMIS_CLIENT_SECRET;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('鍵がそろっていれば通る', () => {
    process.env.MFA_TOTP_ENC_KEY = 'a'.repeat(64);
    expect(() => validateProductionSecrets()).not.toThrow();
  });

  it('鍵が未設定なら起動を止める（本番必須）', () => {
    delete process.env.MFA_TOTP_ENC_KEY;
    expect(() => validateProductionSecrets()).toThrow(/MFA_TOTP_ENC_KEY is required in production/);
  });

  it('鍵の形が不正なら起動を止める（hex64 でも base64_32byte でもない）', () => {
    process.env.MFA_TOTP_ENC_KEY = 'too-short';
    expect(() => validateProductionSecrets()).toThrow(/MFA_TOTP_ENC_KEY must be a real key/);
  });

  it('placeholder の鍵は起動を止める', () => {
    process.env.MFA_TOTP_ENC_KEY = 'change-me-64-hex-chars-or-base64-32-bytes-for-mfa-key';
    expect(() => validateProductionSecrets()).toThrow(/MFA_TOTP_ENC_KEY must be a real key/);
  });

  it('base64 の 32 byte は受理する', () => {
    process.env.MFA_TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
    expect(() => validateProductionSecrets()).not.toThrow();
  });

  it('dev は鍵が無くても起動を止めない（graceful degradation を維持）', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.MFA_TOTP_ENC_KEY;
    expect(() => validateProductionSecrets()).not.toThrow();
  });

  // d1167: 2 つ目の RP（報告管理 gmis）の client secret も Reference と同水準に検査する。
  // 認証境界の secret のため placeholder と短さは本番で通さない（未設定なら連携を使わないので起動可）。
  it('gmis の secret が placeholder なら起動を止める（d1167・Reference と同水準）', () => {
    process.env.MFA_TOTP_ENC_KEY = 'a'.repeat(64);
    process.env.OIDC_GMIS_CLIENT_SECRET = 'change-me-gmis-client-secret';
    expect(() => validateProductionSecrets()).toThrow(
      /OIDC_GMIS_CLIENT_SECRET looks like a placeholder/,
    );
  });

  it('gmis の secret が短すぎるなら起動を止める（d1167・Reference と同水準）', () => {
    process.env.MFA_TOTP_ENC_KEY = 'a'.repeat(64);
    process.env.OIDC_GMIS_CLIENT_SECRET = 'short';
    expect(() => validateProductionSecrets()).toThrow(
      /OIDC_GMIS_CLIENT_SECRET must be at least 32 characters/,
    );
  });

  it('gmis の secret 未設定なら gmis の検査は走らない（連携を使わない本番は従来どおり起動できる）', () => {
    process.env.MFA_TOTP_ENC_KEY = 'a'.repeat(64);
    delete process.env.OIDC_GMIS_CLIENT_SECRET;
    expect(() => validateProductionSecrets()).not.toThrow();
  });

  it('gmis の secret が実値なら通り、redirect URI が揃っていれば起動できる（d1167）', () => {
    process.env.MFA_TOTP_ENC_KEY = 'a'.repeat(64);
    process.env.OIDC_GMIS_CLIENT_SECRET = 'g'.repeat(64);
    // d1213: 表を回す検査は redirect URI も見るため、実値 secret だけでは通らない
    // （redirect URI の条件分岐は env-validation.spec が同型を網羅している）。
    process.env.OIDC_GMIS_REDIRECT_URIS = 'https://gmis.example.com/api/auth/callback';
    expect(() => validateProductionSecrets()).not.toThrow();
  });
});
