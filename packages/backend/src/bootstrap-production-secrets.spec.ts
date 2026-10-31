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

  const factory = new Function(
    'process',
    'validateReferenceRedirectUriRequiredInProduction',
    'parseMfaTotpEncKey',
    `${constantsSource}\n${fnSource}\nreturn validateProductionSecrets;`,
  );
  // 補助関数は main.ts と同じ実装を渡す（OIDC の redirect 検査は本テストの対象外なので null 固定）。
  return factory(
    process,
    () => null,
    jest.requireActual<{ parseMfaTotpEncKey: (raw?: string) => Buffer | null }>(
      './common/security/secret-crypto',
    ).parseMfaTotpEncKey,
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
});
