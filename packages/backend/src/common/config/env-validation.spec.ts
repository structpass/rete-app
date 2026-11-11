import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertValidNodeEnv,
  OIDC_GMIS_RP,
  OIDC_REFERENCE_RP,
  OIDC_RP_DEFINITIONS,
  parseOidcRedirectUris,
  validateDatabasePoolLimits,
  validateOidcRpInProduction,
  validateOidcRpSecretsInProduction,
  REQUIRED_DB_POOL_PARAMS,
  VALID_NODE_ENVS,
} from './env-validation';

const OIDC_ENV_KEYS = [
  'NODE_ENV',
  'OIDC_REFERENCE_CLIENT_SECRET',
  'OIDC_REFERENCE_REDIRECT_URIS',
  'OIDC_GMIS_CLIENT_SECRET',
  'OIDC_GMIS_REDIRECT_URIS',
];

describe('assertValidNodeEnv', () => {
  it.each(VALID_NODE_ENVS)('既知値 %s は通過する', (value) => {
    expect(() => assertValidNodeEnv(value)).not.toThrow();
  });

  it('未設定（undefined）は required で throw する', () => {
    expect(() => assertValidNodeEnv(undefined)).toThrow(/NODE_ENV is required/);
  });

  it('空文字は required で throw する', () => {
    expect(() => assertValidNodeEnv('')).toThrow(/NODE_ENV is required/);
  });

  it('既知値以外（typo）は must be one of で throw する', () => {
    expect(() => assertValidNodeEnv('prod')).toThrow(/must be one of/);
    expect(() => assertValidNodeEnv('PRODUCTION')).toThrow(/must be one of/);
  });
});

// cmn-0249: redirect_uris のパースを 1 本化し、起動ガード側と実登録側が同じ結果を返すようにした。
// d1167: Reference と gmis の 2 RP で同じパーサを使う（RP 定義の env 名は OIDC_RP_DEFINITIONS が正本）。
// 共通退避（beforeEach / afterEach）で env を巻き戻し、it ごとの手書き退避を不要にしている。
describe('parseOidcRedirectUris（cmn-0249）', () => {
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
    for (const key of OIDC_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of OIDC_ENV_KEYS) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
  });

  it.each([
    ['undefined', undefined, []],
    ['空文字', '', []],
    ['カンマのみ', ',', []],
    ['空白・カンマのみ', '  ,  ', []],
    ['単一の URI', 'https://ref.example.com/cb', ['https://ref.example.com/cb']],
    [
      '複数 URI',
      'https://ref.example.com/cb,http://ref2.example.com/cb',
      ['https://ref.example.com/cb', 'http://ref2.example.com/cb'],
    ],
    ['trim', '  https://ref.example.com/cb  ', ['https://ref.example.com/cb']],
    [
      '空要素除去',
      'https://a.example.com,,https://b.example.com',
      ['https://a.example.com', 'https://b.example.com'],
    ],
    ['重複除去', 'https://a.example.com/cb,https://a.example.com/cb', ['https://a.example.com/cb']],
  ])('%s を渡したとき %j を返すこと', (_label, input, expected) => {
    expect(parseOidcRedirectUris(input)).toEqual(expected);
  });
});

describe('validateOidcRpInProduction（reference・cmn-0249）', () => {
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
    for (const key of OIDC_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of OIDC_ENV_KEYS) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
  });

  it('NODE_ENV 未設定なら redirect URI 不備でも起動を止めないこと', () => {
    process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
    process.env.OIDC_REFERENCE_REDIRECT_URIS = '';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP)).toEqual([]);
  });

  it('NODE_ENV=development なら redirect URI 不備でも起動を止めないこと', () => {
    process.env.NODE_ENV = 'development';
    process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
    process.env.OIDC_REFERENCE_REDIRECT_URIS = '';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP)).toEqual([]);
  });

  it('本番＋CLIENT_SECRET 未設定なら redirect URI 検査は走らないこと（cmn-0230）', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_REFERENCE_REDIRECT_URIS = 'invalid';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP)).toEqual([]);
  });

  it('本番＋CLIENT_SECRET 設定＋有効 URI なら起動 OK', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_REFERENCE_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_REFERENCE_REDIRECT_URIS = 'https://ref.example.com/cb';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP)).toEqual([]);
  });

  // cmn-0249: localhost 宛を本番で禁止する。
  it('本番で localhost 宛 URI を含むと起動エラーを返すこと（cmn-0249）', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_REFERENCE_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_REFERENCE_REDIRECT_URIS = 'http://localhost:3001/api/v1/auth/oidc/callback';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP).join('\n')).toMatch(
      /localhost 宛のため本番では使用できません/,
    );
  });

  it('本番で 127.0.0.1 宛 URI を含むと起動エラーを返すこと（cmn-0249）', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_REFERENCE_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_REFERENCE_REDIRECT_URIS = 'http://127.0.0.1:3001/cb';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP).join('\n')).toMatch(
      /localhost 宛のため本番では使用できません/,
    );
  });

  it('本番で IPv6 ループバック宛 URI（hostname は [::1] とブラケット付きで返る）を含むと起動エラーを返すこと', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_REFERENCE_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_REFERENCE_REDIRECT_URIS = 'https://[::1]:3001/cb';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP).join('\n')).toMatch(
      /localhost 宛のため本番では使用できません/,
    );
  });

  it('本番で 0.0.0.0 宛 URI を含むと起動エラーを返すこと', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_REFERENCE_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_REFERENCE_REDIRECT_URIS = 'http://0.0.0.0:3001/cb';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP).join('\n')).toMatch(
      /localhost 宛のため本番では使用できません/,
    );
  });

  it('本番で http 以外の scheme は起動エラーを返すこと（cmn-0249）', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_REFERENCE_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_REFERENCE_REDIRECT_URIS = 'ftp://ref.example.com/cb';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP).join('\n')).toMatch(
      /scheme は http\/https のみ/,
    );
  });

  it('本番で URL として解析できない値は起動エラーを返すこと（cmn-0249）', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_REFERENCE_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_REFERENCE_REDIRECT_URIS = 'not-a-url';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP).join('\n')).toMatch(
      /有効な URL 形式ではありません/,
    );
  });
});

// d1167: 2 つ目の RP（報告管理 gmis）を追加した。本番の起動検査は Reference と同型・同粒度に揃える
// （secret 設定済みで redirect URI の有効値がゼロなら起動エラー、dev/staging では warn に留める）。
describe('validateOidcRpInProduction（gmis・d1167）', () => {
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
    for (const key of OIDC_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of OIDC_ENV_KEYS) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
  });

  it('NODE_ENV 未設定 / development なら redirect URI 不備でも起動を止めないこと', () => {
    process.env.OIDC_GMIS_CLIENT_SECRET = 's3cret';
    process.env.OIDC_GMIS_REDIRECT_URIS = '';
    expect(validateOidcRpInProduction(OIDC_GMIS_RP)).toEqual([]);

    process.env.NODE_ENV = 'development';
    expect(validateOidcRpInProduction(OIDC_GMIS_RP)).toEqual([]);
  });

  it('本番＋CLIENT_SECRET 未設定なら redirect URI 検査は走らないこと（連携を使わない本番は起動できる）', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_GMIS_REDIRECT_URIS = 'invalid';
    expect(validateOidcRpInProduction(OIDC_GMIS_RP)).toEqual([]);
  });

  it('本番＋CLIENT_SECRET 設定＋有効 URI なら起動 OK', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_GMIS_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_GMIS_REDIRECT_URIS = 'https://gmis.example.com/api/auth/callback';
    expect(validateOidcRpInProduction(OIDC_GMIS_RP)).toEqual([]);
  });

  it.each([
    ['未設定', undefined],
    ['空文字', ''],
    ['空白・カンマのみ', '   ,   ,'],
  ])(
    '本番で CLIENT_SECRET 設定済＋戻り先未設定（%s）なら起動エラーの理由を返すこと',
    (_label, redirectUris) => {
      process.env.NODE_ENV = 'production';
      process.env.OIDC_GMIS_CLIENT_SECRET = 's3cret';
      if (redirectUris === undefined) delete process.env.OIDC_GMIS_REDIRECT_URIS;
      else process.env.OIDC_GMIS_REDIRECT_URIS = redirectUris;

      const reason = validateOidcRpInProduction(OIDC_GMIS_RP).join('\n');
      expect(reason).not.toBe('');
      expect(reason).toMatch(/OIDC_GMIS_REDIRECT_URIS/);
      expect(reason).toMatch(/d1167/);
    },
  );

  it('本番で localhost 宛 URI は起動エラーを返すこと（Reference と同型）', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_GMIS_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_GMIS_REDIRECT_URIS = 'http://127.0.0.1:4188/api/auth/callback';
    expect(validateOidcRpInProduction(OIDC_GMIS_RP).join('\n')).toMatch(
      /localhost 宛のため本番では使用できません/,
    );
  });

  it('本番で URL として解析できない値・http(s) 以外の scheme は起動エラーを返すこと', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_GMIS_CLIENT_SECRET = 'a'.repeat(32);
    process.env.OIDC_GMIS_REDIRECT_URIS = 'not-a-url';
    expect(validateOidcRpInProduction(OIDC_GMIS_RP).join('\n')).toMatch(
      /有効な URL 形式ではありません/,
    );

    process.env.OIDC_GMIS_REDIRECT_URIS = 'ftp://gmis.example.com/cb';
    expect(validateOidcRpInProduction(OIDC_GMIS_RP).join('\n')).toMatch(
      /scheme は http\/https のみ/,
    );
  });

  it('gmis の検査は Reference の env を見ないこと（RP ごとに独立）', () => {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_GMIS_CLIENT_SECRET = 's3cret';
    process.env.OIDC_GMIS_REDIRECT_URIS = '';
    expect(validateOidcRpInProduction(OIDC_REFERENCE_RP)).toEqual([]);
    expect(validateOidcRpInProduction(OIDC_GMIS_RP)).not.toEqual([]);
  });

  it('main.ts が起動経路で RP 定義表を読む（写経へ戻す fail-open の回帰ガード・d1213）', () => {
    // 純関数の spec だけでは main.ts の呼び出しが消えても緑のままになる（DB プール検査と同じ手法）。
    // RP ごとのキー定数・検査ブロックを main.ts へ戻すと、表に足した 3 つ目の RP が素通りする。
    const mainSource = readFileSync(join(__dirname, '../../main.ts'), 'utf8');
    expect(mainSource).toContain('validateOidcRpSecretsInProduction()');
    expect(mainSource).not.toContain("'OIDC_REFERENCE_CLIENT_SECRET'");
    expect(mainSource).not.toContain("'OIDC_GMIS_CLIENT_SECRET'");
  });
});

describe('validateDatabasePoolLimits（cmn-0251）', () => {
  const BASE = 'postgresql://u:p@localhost:5432/rete?schema=public';

  it('connection_limit / pool_timeout が揃っていれば null（OK）', () => {
    expect(validateDatabasePoolLimits(`${BASE}&connection_limit=5&pool_timeout=20`)).toBeNull();
  });

  it.each(REQUIRED_DB_POOL_PARAMS)('%s が欠けていたら理由を返す（起動時に気付ける）', (param) => {
    const params = REQUIRED_DB_POOL_PARAMS.filter((p) => p !== param)
      .map((p) => `${p}=5`)
      .join('&');
    const reason = validateDatabasePoolLimits(`${BASE}&${params}`);
    expect(reason).toContain(param);
  });

  it('プール指定が一切無い接続文字列（既存 .env の形）は理由を返す', () => {
    // テンプレートに書くだけでは既存 .env へ伝播しない＝この検査が唯一の歯止め。
    const reason = validateDatabasePoolLimits(BASE);
    expect(reason).toMatch(/connection_limit/);
    expect(reason).toMatch(/pool_timeout/);
  });

  it('値が空文字なら「指定あり」と見なさない（?connection_limit= のような書き損じ）', () => {
    expect(validateDatabasePoolLimits(`${BASE}&connection_limit=&pool_timeout=20`)).toContain(
      'connection_limit',
    );
  });

  it('DATABASE_URL 未設定は本検査の対象外（必須検査は別で行う）', () => {
    expect(validateDatabasePoolLimits(undefined)).toBeNull();
    expect(validateDatabasePoolLimits('')).toBeNull();
  });

  it('URL として解析できない接続文字列は本検査の対象外（形式不正は Prisma が落とす）', () => {
    expect(validateDatabasePoolLimits('not-a-url')).toBeNull();
  });

  // ここから下は「存在するだけ」では目的を満たさない値の検査（cmn-0251 Quality cycle 2 の反映）。
  it('pool_timeout=0（無限待ち）は通さない＝防ぎたい状態そのもの', () => {
    expect(validateDatabasePoolLimits(`${BASE}&connection_limit=5&pool_timeout=0`)).toContain(
      'pool_timeout',
    );
  });

  it('pool_timeout が最長トランザクション上限（15 秒）未満なら通さない', () => {
    // 短すぎると、tx を占有している側より先に無関係なリクエストが接続待ち超過で 503 になる。
    expect(validateDatabasePoolLimits(`${BASE}&connection_limit=5&pool_timeout=10`)).toContain(
      'pool_timeout',
    );
  });

  it('connection_limit=0 や過大な指定は通さない（上限の意味が失われる）', () => {
    expect(validateDatabasePoolLimits(`${BASE}&connection_limit=0&pool_timeout=20`)).toContain(
      'connection_limit',
    );
    expect(validateDatabasePoolLimits(`${BASE}&connection_limit=500&pool_timeout=20`)).toContain(
      'connection_limit',
    );
  });

  it('整数でない値は通さない', () => {
    expect(validateDatabasePoolLimits(`${BASE}&connection_limit=abc&pool_timeout=20`)).toContain(
      'connection_limit',
    );
    expect(validateDatabasePoolLimits(`${BASE}&connection_limit=5&pool_timeout=20.5`)).toContain(
      'pool_timeout',
    );
  });

  it('main.ts が起動経路でこの検査を呼び、本番だけ起動を止める', () => {
    // 純関数の spec だけでは配線が消えても緑のままになる（CORS 側と同じ手法で bootstrap を pin する）。
    const mainSource = readFileSync(join(__dirname, '../../main.ts'), 'utf8');
    expect(mainSource).toContain('validateDatabasePoolLimits(process.env.DATABASE_URL)');
    expect(mainSource).toMatch(/NODE_ENV === 'production'/);
    expect(mainSource).toContain('logger.warn(poolProblem)');
  });

  it('seed.ts も同じ検査を呼び、警告を出して完走する（throw しない・cmn-0347）', () => {
    // criteria 3: seed は独立プロセスで main.ts の検査を通らないため、環境構築の順序
    // （DB 作成 → seed → アプリ配備）でプール指定なしのまま進むのを防ぐ。警告のみで止めない
    // （本番同様の起動拒否をすると環境構築の順序が壊れる）。
    const seedSource = readFileSync(join(__dirname, '../../../prisma/seed.ts'), 'utf8');
    expect(seedSource).toContain('validateDatabasePoolLimits(process.env.DATABASE_URL)');
    expect(seedSource).toContain('console.warn(`[seed]');
  });
});

// d1213: RP の本番検査は OIDC_RP_DEFINITIONS を回す 1 本。表へ RP を足せば検査も自動で追随する
// （以前は main.ts が RP ごとに検査を写経しており、3 つ目の RP が素通りした＝fail-open）。
describe('validateOidcRpSecretsInProduction（表が SSOT・d1213）', () => {
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
    for (const key of OIDC_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of OIDC_ENV_KEYS) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
    delete process.env.OIDC_THIRD_CLIENT_SECRET;
    delete process.env.OIDC_THIRD_REDIRECT_URIS;
  });

  it('OIDC_RP_DEFINITIONS の全 RP が本番検査の対象になる（表へ足せば自動で追随する）', () => {
    process.env.NODE_ENV = 'production';
    for (const rp of OIDC_RP_DEFINITIONS) process.env[rp.clientSecretEnvKey] = 'change-me';
    const problems = validateOidcRpSecretsInProduction().join('\n');
    for (const rp of OIDC_RP_DEFINITIONS) {
      expect(problems).toContain(`${rp.clientSecretEnvKey} looks like a placeholder`);
      // 長さの検査も同じ経路で全 RP に掛かる（'change-me' は 9 文字なので両方が返る）。
      expect(problems).toContain(`${rp.clientSecretEnvKey} must be at least 32 characters`);
    }
  });

  it('表に無い 3 つ目の RP も同じ関数で検査できる（RP 別の写経に戻さない）', () => {
    process.env.NODE_ENV = 'production';
    const third = {
      label: 'third',
      clientIdEnvKey: 'OIDC_THIRD_CLIENT_ID',
      clientSecretEnvKey: 'OIDC_THIRD_CLIENT_SECRET',
      redirectUrisEnvKey: 'OIDC_THIRD_REDIRECT_URIS',
      defaultClientId: 'third',
      ticketRef: 'test',
    };
    process.env.OIDC_THIRD_CLIENT_SECRET = 'change-me';
    const problems = validateOidcRpInProduction(third).join('\n');
    expect(problems).toMatch(/OIDC_THIRD_CLIENT_SECRET looks like a placeholder/);
    expect(problems).toMatch(/OIDC_THIRD_REDIRECT_URIS に有効な値が1件も設定されていません/);
  });
});
