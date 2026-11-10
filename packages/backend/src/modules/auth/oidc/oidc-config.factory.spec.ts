/**
 * buildOidcConfiguration のユニットテスト（cmn-0194）。
 * 検証対象: 返る設定オブジェクトの shape と環境変数による分岐
 *   （署名鍵 jwks / 静的 client 登録 / claims 許可リスト / cookie / ttl / findAccount / loadExistingGrant / proxy / issuer）。
 * 委譲: oidc-provider の実起動・実 HTTP フロー（authorize〜token）は E2E / 実機確認へ。
 *       jose の実鍵生成はライブラリ責務のため jest.mock で差し替える。
 * 実 DB は使わない（PrismaService は object literal のモック）。
 */
import type { BuiltOidcConfig } from './oidc-config.factory';

// jose は ESM-only で backend の jest（ts-jest / CJS）では素の import が suite 全体を SyntaxError に
// する（実測済）。共有 jest 設定（transformIgnorePatterns）は他 suite へ波及するため触らず、
// 本 spec 内でモックへ差し替える。鍵生成自体は jose の責務で、ここで検証するのは
// 「生成した鍵へ use / alg / kid を付ける」factory 側の処理。
jest.mock('jose', () => ({
  generateKeyPair: jest.fn(),
  exportJWK: jest.fn(),
}));

import { generateKeyPair, exportJWK } from 'jose';
import { Logger } from '@nestjs/common';
import {
  buildOidcConfiguration,
  validateReferenceRedirectUriRequiredInProduction,
} from './oidc-config.factory';
import type { PrismaService } from '../../../database/prisma.service';

const mockPrisma = {
  account: {
    findUnique: jest.fn(),
  },
  // d963: loadExistingGrant は必須MFAの判定に passwordPolicy と mfaSetting を読む。
  passwordPolicy: {
    findUnique: jest.fn(),
  },
  mfaSetting: {
    findFirst: jest.fn(),
  },
};

const prisma = mockPrisma as unknown as PrismaService;

/** factory が読む env を一括で消す（親プロセスの .env 混入で分岐が揺れないように）。 */
const OIDC_ENV_KEYS = [
  'OIDC_JWKS',
  'OIDC_ISSUER',
  'OIDC_COOKIE_KEYS',
  'OIDC_REFERENCE_CLIENT_ID',
  'OIDC_REFERENCE_CLIENT_SECRET',
  'OIDC_REFERENCE_REDIRECT_URIS',
  'OIDC_GMIS_CLIENT_ID',
  'OIDC_GMIS_CLIENT_SECRET',
  'OIDC_GMIS_REDIRECT_URIS',
  'CORS_ORIGIN',
  'PORT',
  'NODE_ENV',
];

/** 秘密鍵と公開鍵を識別可能にする（実装が公開鍵を export したら検知できるように）。 */
const PRIVATE_KEY = { __kind: 'private' };
const PUBLIC_KEY = { __kind: 'public' };

const build = (): Promise<BuiltOidcConfig> => buildOidcConfiguration(prisma);

describe('buildOidcConfiguration', () => {
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
    for (const key of OIDC_ENV_KEYS) delete process.env[key];
    // 既定は「必須MFA OFF」＝grant の再利用・自動付与を従来どおり行う（各テストが必要に応じて上書きする）。
    mockPrisma.passwordPolicy.findUnique.mockResolvedValue(null);
    mockPrisma.mfaSetting.findFirst.mockResolvedValue(null);
    (generateKeyPair as jest.Mock).mockResolvedValue({
      privateKey: PRIVATE_KEY,
      publicKey: PUBLIC_KEY,
    });
    // 実装が use/alg/kid を破壊的に付与するため、呼び出しごとに新しいオブジェクトを返す。
    (exportJWK as jest.Mock).mockImplementation(async () => ({
      kty: 'RSA',
      n: 'n-value',
      e: 'AQAB',
      d: 'd-value',
    }));
  });

  afterEach(() => {
    // process.env への丸ごと再代入は env オブジェクトの特殊性（Windows のキー大小無視・libuv 反映）を
    // 壊すため、触ったキーだけを個別に戻す。jest worker は同一プロセスで後続 suite を走らせる。
    for (const key of OIDC_ENV_KEYS) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
  });

  describe('jwks（署名鍵）', () => {
    it('OIDC_JWKS 未設定なら dev 鍵を生成し use/alg/kid を付けること', async () => {
      const built = await build();

      expect(built.oidc.jwks?.keys).toHaveLength(1);
      expect(built.oidc.jwks?.keys[0]).toEqual(
        expect.objectContaining({ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'dev-rete-rs256' }),
      );
      expect(generateKeyPair).toHaveBeenCalledWith('RS256', { extractable: true });
      // JWKS へ入れるのは秘密鍵（署名に使う）。公開鍵を export すると provider が ID Token を
      // 署名できなくなるため、どちらを渡しているかまで固定する。
      expect(exportJWK).toHaveBeenCalledWith(PRIVATE_KEY);
    });

    it('NODE_ENV=production かつ OIDC_JWKS 未設定なら起動を止めること（cmn-0213）', async () => {
      // main.ts の validateProductionSecrets は本 spec では走らないため、factory 単体の検査を発火させる。
      // cookieKeys の fail-closed を満たすために併記（cookieKeys の検査が先に走る）。
      process.env.NODE_ENV = 'production';
      process.env.OIDC_COOKIE_KEYS = 'a'.repeat(40);

      await expect(build()).rejects.toThrow(/OIDC_JWKS が未設定/);
      expect(generateKeyPair).not.toHaveBeenCalled();
    });

    it('NODE_ENV=production かつ OIDC_JWKS 設定済みなら env の鍵をそのまま使うこと（cmn-0213）', async () => {
      // cookieKeys の fail-closed を満たすために併記。
      process.env.NODE_ENV = 'production';
      process.env.OIDC_COOKIE_KEYS = 'a'.repeat(40);
      process.env.OIDC_JWKS = JSON.stringify({ keys: [{ kid: 'prod-key', kty: 'RSA' }] });

      const built = await build();

      expect(built.oidc.jwks?.keys).toEqual([{ kid: 'prod-key', kty: 'RSA' }]);
      expect(generateKeyPair).not.toHaveBeenCalled();
    });

    it('OIDC_JWKS が {keys:[...]} 形式なら生成せず env の鍵をそのまま使うこと', async () => {
      process.env.OIDC_JWKS = JSON.stringify({ keys: [{ kid: 'from-env', kty: 'RSA' }] });

      const built = await build();

      expect(built.oidc.jwks?.keys).toEqual([{ kid: 'from-env', kty: 'RSA' }]);
      expect(generateKeyPair).not.toHaveBeenCalled();
    });

    it('OIDC_JWKS が素の配列でも鍵配列としてそのまま読み込むこと（cmn-0204）', async () => {
      // `parsed.keys ?? parsed` は配列に対して Array.prototype.keys（関数）へ当たり、
      // 鍵ゼロの壊れた設定を作っていた。Array.isArray で先に分岐する。
      process.env.OIDC_JWKS = JSON.stringify([{ kid: 'bare-array', kty: 'RSA' }]);

      const built = await build();

      expect(built.oidc.jwks?.keys).toEqual([{ kid: 'bare-array', kty: 'RSA' }]);
      expect(generateKeyPair).not.toHaveBeenCalled();
    });

    it('OIDC_JWKS が不正な JSON なら reject すること（壊れた設定で黙って立ち上がらない）', async () => {
      process.env.OIDC_JWKS = 'not-json';

      // cmn-0335: 例外の種類とメッセージまで固定（どんな例外でも緑になる書き方を残さない）。
      // JSON.parse の SyntaxError は鍵漏れ防止のため Error（定型メッセージ）に置き換えられる実装。
      await expect(build()).rejects.toThrow('OIDC_JWKS が JSON として解析できません。');
    });

    it('不正な JSON の失敗メッセージに env の生値が混ざらないこと（起動失敗ログへの鍵漏れ防止）', async () => {
      // JSON.parse の SyntaxError は入力の先頭断片をメッセージへ埋めるため、秘密鍵を直接貼ると漏れる。
      process.env.OIDC_JWKS = 'MIIEpAIBAAKCAQEAsecretkeymaterial';

      await expect(build()).rejects.toThrow('OIDC_JWKS が JSON として解析できません。');
      await expect(build()).rejects.not.toThrow(/MIIEpAIBAA/);
    });

    it.each([
      ['空文字', ''],
      ['空白のみ', '   '],
    ])(
      'OIDC_JWKS が %s なら reject すること（dev 一時鍵へ黙って落ちない）',
      async (_label, raw) => {
        process.env.OIDC_JWKS = raw;

        await expect(build()).rejects.toThrow(/OIDC_JWKS/);
        expect(generateKeyPair).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['どちらの形でもないオブジェクト', JSON.stringify({ kid: 'no-keys-prop' })],
      ['keys が配列でないオブジェクト', JSON.stringify({ keys: 'not-an-array' })],
      ['空配列', JSON.stringify([])],
      ['keys が空配列', JSON.stringify({ keys: [] })],
      ['null', JSON.stringify(null)],
    ])(
      'OIDC_JWKS が鍵配列として解釈できない値（%s）なら reject すること＝鍵ゼロで起動しない（cmn-0204）',
      async (_label, raw) => {
        process.env.OIDC_JWKS = raw;

        await expect(build()).rejects.toThrow(/OIDC_JWKS/);
      },
    );
  });

  describe('clients（RP 静的登録）', () => {
    it('OIDC_REFERENCE_CLIENT_SECRET 未設定なら clients が空であること（既定 secret の流出防止）', async () => {
      const built = await build();

      expect(built.oidc.clients).toEqual([]);
    });

    it('secret 設定時のみ 1 件登録され redirect_uris がカンマ分割＋trim されること', async () => {
      process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
      process.env.OIDC_REFERENCE_REDIRECT_URIS = 'http://a/cb , http://b/cb';

      const built = await build();

      expect(built.oidc.clients).toEqual([
        {
          client_id: 'struct-pass-reference',
          client_secret: 's3cret',
          redirect_uris: ['http://a/cb', 'http://b/cb'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          scope: 'openid profile email',
        },
      ]);
    });

    it('OIDC_REFERENCE_REDIRECT_URIS 未設定なら clients が空になること（fail-closed・dev 既定を撤去）', async () => {
      // cmn-0230: 「未設定なら登録 0 件」を値で固定する。cmn-0206 の既定値
      // (localhost:3001/api/v1/auth/oidc/callback) は撤去されたので、登録されない。
      process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';

      const built = await build();

      expect(built.oidc.clients).toEqual([]);
    });

    // AND 条件の逆側。secret 未設定側だけが既存 spec で固定されており、redirect URI だけを
    // 設定した時に登録されてしまう実装（条件を OR に取り違える／URI 側の存在検査を落とす）を
    // 検出できなかった。本番の登録条件は「secret と redirect URI の両方」なので、
    // 片側だけの時に登録されないことを固定する（v2-502）。
    it('OIDC_REFERENCE_REDIRECT_URIS だけ設定して secret 未設定なら clients が空になること（AND 条件の逆側）', async () => {
      process.env.OIDC_REFERENCE_REDIRECT_URIS =
        'https://ref.example.com/api/v1/auth/oidc/callback';

      const built = await build();

      expect(built.oidc.clients).toEqual([]);
    });

    // 登録される1件の形を全量で固定する。本番接続先が確定して env を入れた時に効く経路そのもので、
    // grant_types / response_types / scope のどれかが変わると本番の SSO が壊れるため、
    // 部分一致でなく toEqual で固定する（OIDC_REFERENCE_CLIENT_ID の既定値も同時に固定される・v2-502）。
    it('secret と redirect URI が揃った時は client_id 既定値・grant/response・scope を含む1件が登録されること', async () => {
      process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
      process.env.OIDC_REFERENCE_REDIRECT_URIS =
        'https://ref.example.com/api/v1/auth/oidc/callback';

      const built = await build();

      expect(built.oidc.clients).toHaveLength(1);
      expect(built.oidc.clients?.[0]).toEqual({
        client_id: 'struct-pass-reference',
        client_secret: 's3cret',
        redirect_uris: ['https://ref.example.com/api/v1/auth/oidc/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
      });
    });

    // cmn-0230: env の値に空要素（末尾カンマ・空白のみ）が混じっても、空要素を除いた残りで登録される。
    // 既存 cookieKeys のパース規律と同型。残りが 0 件になる場合は登録 0 件。
    it.each([
      ['末尾カンマ', 'http://a/cb,', ['http://a/cb']],
      ['空白のみ要素', 'http://a/cb,   ,', ['http://a/cb']],
      ['先頭・末尾 trim', '  http://a/cb  , http://b/cb  ', ['http://a/cb', 'http://b/cb']],
      ['全要素が空', '   ,   ,', []],
    ])('redirect_uris の空要素は除外される（%s）', async (_label, rawValue, expected) => {
      process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
      process.env.OIDC_REFERENCE_REDIRECT_URIS = rawValue;

      const built = await build();

      if (expected.length === 0) {
        expect(built.oidc.clients).toEqual([]);
      } else {
        expect(built.oidc.clients?.[0].redirect_uris).toEqual(expected);
      }
    });

    it('redirect_uris が空文字 env のときは clients が空になること（未設定と同扱い）', async () => {
      process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
      process.env.OIDC_REFERENCE_REDIRECT_URIS = '';

      const built = await build();

      expect(built.oidc.clients).toEqual([]);
    });

    it('OIDC_REFERENCE_CLIENT_ID 設定時は client_id が上書きされること', async () => {
      // cmn-0230: REDIRECT_URIS も必須（同条件で 1 件登録される）ため併せて設定する。
      process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
      process.env.OIDC_REFERENCE_CLIENT_ID = 'other-rp';
      process.env.OIDC_REFERENCE_REDIRECT_URIS = 'http://example/cb';

      const built = await build();

      expect(built.oidc.clients?.[0].client_id).toBe('other-rp');
    });

    it('OIDC_REFERENCE_REDIRECT_URIS の末尾カンマ由来で空要素が混じってもフィルタされること（cmn-0230）', async () => {
      // cmn-0230: cookieKeys と同型に split→trim→filter(Boolean) を入れたため、空要素は除外される。
      // provider 起動時に空要素で原因の分かりにくいエラーになる状況を排除する。
      process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
      process.env.OIDC_REFERENCE_REDIRECT_URIS = 'http://a/cb,';

      const built = await build();

      expect(built.oidc.clients?.[0].redirect_uris).toEqual(['http://a/cb']);
    });

    // d1167: 2 つ目の first-party RP（報告管理 gmis）。Reference と同じ登録条件・同じ scope で登録される。
    it('gmis は secret と redirect URI が揃った時だけ既定 client_id "gmis" で登録されること（d1167）', async () => {
      process.env.OIDC_GMIS_CLIENT_SECRET = 'gmis-secret';
      process.env.OIDC_GMIS_REDIRECT_URIS = 'http://127.0.0.1:4188/api/auth/callback';

      const built = await build();

      expect(built.oidc.clients).toEqual([
        {
          client_id: 'gmis',
          client_secret: 'gmis-secret',
          redirect_uris: ['http://127.0.0.1:4188/api/auth/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          scope: 'openid profile email',
        },
      ]);
    });

    it('gmis は secret 未設定なら redirect URI だけ設定されても登録されないこと（AND 条件）', async () => {
      process.env.OIDC_GMIS_REDIRECT_URIS = 'http://127.0.0.1:4188/api/auth/callback';

      const built = await build();

      expect(built.oidc.clients).toEqual([]);
    });

    it('gmis は redirect URI 未設定なら secret だけ設定されても登録されないこと（AND 条件）', async () => {
      process.env.OIDC_GMIS_CLIENT_SECRET = 'gmis-secret';

      const built = await build();

      expect(built.oidc.clients).toEqual([]);
    });

    it('OIDC_GMIS_CLIENT_ID 設定時は gmis の client_id が上書きされること', async () => {
      process.env.OIDC_GMIS_CLIENT_SECRET = 'gmis-secret';
      process.env.OIDC_GMIS_CLIENT_ID = 'gmis-custom';
      process.env.OIDC_GMIS_REDIRECT_URIS = 'https://gmis.example.com/api/auth/callback';

      const built = await build();

      expect(built.oidc.clients?.[0].client_id).toBe('gmis-custom');
    });

    it('Reference と gmis の両方が設定されれば 2 件登録されること（Reference の登録は従来どおり）', async () => {
      process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
      process.env.OIDC_REFERENCE_REDIRECT_URIS =
        'https://ref.example.com/api/v1/auth/oidc/callback';
      process.env.OIDC_GMIS_CLIENT_SECRET = 'gmis-secret';
      process.env.OIDC_GMIS_REDIRECT_URIS = 'https://gmis.example.com/api/auth/callback';

      const built = await build();

      expect(built.oidc.clients?.map((client) => client.client_id)).toEqual([
        'struct-pass-reference',
        'gmis',
      ]);
      // Reference 側の登録内容（scope / grant / response）は 2 つ目を足しても不変。
      expect(built.oidc.clients?.[0]).toEqual({
        client_id: 'struct-pass-reference',
        client_secret: 's3cret',
        redirect_uris: ['https://ref.example.com/api/v1/auth/oidc/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile email',
      });
    });

    it('gmis の redirect_uris も空要素除去・trim されること（Reference と同じ正規化）', async () => {
      process.env.OIDC_GMIS_CLIENT_SECRET = 'gmis-secret';
      process.env.OIDC_GMIS_REDIRECT_URIS = ' http://a/cb , , http://b/cb ';

      const built = await build();

      expect(built.oidc.clients?.[0].redirect_uris).toEqual(['http://a/cb', 'http://b/cb']);
    });

    it('dev で gmis の secret だけ設定されていると warn を 1 行出して登録しないこと（cmn-0249 と同型）', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      process.env.OIDC_GMIS_CLIENT_SECRET = 'gmis-secret';

      const built = await build();

      expect(built.oidc.clients).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = String(warnSpy.mock.calls[0][0]);
      expect(warnArg).toContain('OIDC_GMIS_CLIENT_SECRET is set but OIDC_GMIS_REDIRECT_URIS');
      expect(warnArg).toContain('gmis');
      warnSpy.mockRestore();
    });
  });

  describe('cookies', () => {
    it('OIDC_COOKIE_KEYS 未設定なら dev 既定キーになること', async () => {
      const built = await build();

      expect(built.oidc.cookies?.keys).toEqual(['dev-insecure-cookie-key-change-me']);
    });

    it('NODE_ENV=production かつ OIDC_COOKIE_KEYS 設定済みなら env のキーをそのまま使うこと（cmn-0213）', async () => {
      process.env.NODE_ENV = 'production';
      process.env.OIDC_JWKS = JSON.stringify({ keys: [{ kid: 'k', kty: 'RSA' }] });
      process.env.OIDC_COOKIE_KEYS = 'a'.repeat(40);

      const built = await build();

      expect(built.oidc.cookies?.keys).toEqual(['a'.repeat(40)]);
    });

    it('OIDC_COOKIE_KEYS はカンマ分割で trim＋空要素除去されること', async () => {
      process.env.OIDC_COOKIE_KEYS = 'k1, k2,';

      const built = await build();

      expect(built.oidc.cookies?.keys).toEqual(['k1', 'k2']);
    });

    it('NODE_ENV=production かつ OIDC_COOKIE_KEYS 未設定なら起動を止めること（cookieKeys 側・cmn-0213）', async () => {
      // client_secret は secret 未設定時に client を登録しない prod ガードがあるが、cookie 署名鍵には
      // 同種のガードが無く、既定文字列（公開されている）のまま session cookie を署名しうる状態だった。
      // cmn-0213 で factory 側 fail-closed を入れたため、prod + 未設定では起動を止める。
      process.env.NODE_ENV = 'production';
      process.env.OIDC_JWKS = JSON.stringify({ keys: [{ kid: 'k', kty: 'RSA' }] });

      await expect(build()).rejects.toThrow(/OIDC_COOKIE_KEYS が未設定/);
    });

    it('short / long cookie が path:"/" ・sameSite:"lax" であること（別オリジンの frontend へ届かせる）', async () => {
      const built = await build();

      // toEqual（部分一致でなく全量一致）で固定する。httpOnly:false / secure:false のような
      // セッション奪取に直結するフラグを後から足せないようにするため。
      expect(built.oidc.cookies?.short).toEqual({ path: '/', sameSite: 'lax' });
      expect(built.oidc.cookies?.long).toEqual({ path: '/', sameSite: 'lax' });
    });
  });

  describe('固定ポリシー', () => {
    it('PKCE が必須で devInteractions が無効・revocation / introspection が有効であること', async () => {
      const built = await build();

      expect(built.oidc.pkce?.required?.({} as never, {} as never)).toBe(true);
      expect(built.oidc.features?.devInteractions?.enabled).toBe(false);
      expect(built.oidc.features?.revocation?.enabled).toBe(true);
      expect(built.oidc.features?.introspection?.enabled).toBe(true);
      // ライブラリ既定に委ねている無効機能。features へ1行足すだけで静かに開くため回帰ガードを置く。
      expect(built.oidc.features?.registration?.enabled).toBeFalsy();
      expect(built.oidc.features?.clientCredentials?.enabled).toBeFalsy();
      expect(built.oidc.features?.deviceFlow?.enabled).toBeFalsy();
    });

    it('token / session の寿命が明示されていること（provider 既定の 14 日 RefreshToken を避ける）', async () => {
      const built = await build();

      expect(built.oidc.ttl).toEqual({
        AccessToken: 60 * 60,
        AuthorizationCode: 10 * 60,
        IdToken: 60 * 60,
        Interaction: 60 * 60,
        Session: 14 * 24 * 60 * 60,
        Grant: 14 * 24 * 60 * 60,
      });
    });

    it('claims 許可リストが sub / name / email に限定されること（RP へ出せる claim の上限）', async () => {
      const built = await build();

      expect(built.oidc.claims).toEqual({
        openid: ['sub'],
        profile: ['name'],
        email: ['email', 'email_verified'],
      });
    });

    it('adapter が配線され、build 時点では prisma へクエリを発行しないこと', async () => {
      const built = await build();

      expect(built.oidc.adapter).toBeDefined();
      expect(mockPrisma.account.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('interactions.url', () => {
    it('CORS_ORIGIN の先頭オリジンだけを採用してログイン画面へ飛ばすこと', async () => {
      process.env.CORS_ORIGIN = 'http://x:3010,http://y';

      const built = await build();

      expect(built.oidc.interactions?.url?.({} as never, { uid: 'U1' } as never)).toBe(
        'http://x:3010/login?uid=U1',
      );
    });

    it('CORS_ORIGIN 未設定なら frontendUrl を :3000 として組み立てられること（dev 既定の固定・cmn-0214）', async () => {
      // env 指定側のテスト（前述）だけだと、既定値が黙って別のポートへ差し替わっても検出できない。
      // 値で固定することで既定ドリフトを検知する。
      const built = await build();

      expect(built.oidc.interactions?.url?.({} as never, { uid: 'U1' } as never)).toBe(
        'http://localhost:3000/login?uid=U1',
      );
    });
  });

  describe('findAccount', () => {
    const findAccount = async (built: BuiltOidcConfig, id: string) =>
      built.oidc.findAccount?.({} as never, id, undefined);

    it('アカウントが存在しなければ undefined を返すこと', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);
      const built = await build();

      await expect(findAccount(built, 'acc-1')).resolves.toBeUndefined();
      expect(mockPrisma.account.findUnique).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        select: { id: true, name: true, email: true, isActive: true },
      });
    });

    it('isActive:false のアカウントは undefined を返すこと（無効化の即時反映）', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'acc-1',
        name: 'Taro',
        email: 't@example.com',
        isActive: false,
      });
      const built = await build();

      await expect(findAccount(built, 'acc-1')).resolves.toBeUndefined();
      expect(mockPrisma.account.findUnique).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        select: { id: true, name: true, email: true, isActive: true },
      });
    });

    it('select は claims で使う 4 列（id / name / email / isActive）に限定する（cmn-0232 LOW5）', async () => {
      mockPrisma.account.findUnique.mockResolvedValue(null);
      const built = await build();

      await findAccount(built, 'acc-1');

      const arg = mockPrisma.account.findUnique.mock.calls[0][0];
      // passwordHash / failedLoginAttempts / lockedUntil 等の機微列が select に混ざっていないことを
      // allowlist 比較で固定する。将来 claims が増えて列が要るなら select も併せて拡張する
      // （拡張しないと provider が起動時に落ちる）ことを assert。
      expect(Object.keys(arg.select).sort()).toEqual(['email', 'id', 'isActive', 'name']);
    });

    it('claims が scope に応じて sub / name / email を出し分けること', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'acc-1',
        name: 'Taro',
        email: 't@example.com',
        isActive: true,
      });
      const built = await build();
      const account = await findAccount(built, 'acc-1');

      await expect(account?.claims('id_token', 'openid', {}, [])).resolves.toEqual({
        sub: 'acc-1',
      });
      await expect(account?.claims('id_token', 'openid profile', {}, [])).resolves.toEqual({
        sub: 'acc-1',
        name: 'Taro',
      });
      await expect(account?.claims('id_token', 'openid profile email', {}, [])).resolves.toEqual({
        sub: 'acc-1',
        name: 'Taro',
        email: 't@example.com',
        email_verified: false,
      });
    });

    it('email_verified は常に false であること（未実装の検証済みを RP へ偽らない）', async () => {
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'acc-1',
        name: 'Taro',
        email: 't@example.com',
        isActive: true,
      });
      const built = await build();
      const account = await findAccount(built, 'acc-1');

      const claims = await account?.claims('id_token', 'openid email', {}, []);
      expect(claims?.email_verified).toBe(false);
    });

    it('scope 判定が部分一致であること: "profileish" / "emailish" のような別語でも name / email が出る（現状挙動の記録・cmn-0214）', async () => {
      // 実装は scope.includes('profile') / scope.includes('email') の部分一致。
      // 'openid profileish' でも name が漏れる境界をテストとして残し、是正判断は実装側へ送る。
      mockPrisma.account.findUnique.mockResolvedValue({
        id: 'acc-1',
        name: 'Taro',
        email: 't@example.com',
        isActive: true,
      });
      const built = await build();
      const account = await findAccount(built, 'acc-1');

      await expect(account?.claims('id_token', 'openid profileish', {}, [])).resolves.toEqual({
        sub: 'acc-1',
        name: 'Taro',
      });
      await expect(account?.claims('id_token', 'openid emailish', {}, [])).resolves.toEqual({
        sub: 'acc-1',
        email: 't@example.com',
        email_verified: false,
      });
    });
  });

  describe('loadExistingGrant', () => {
    type GrantInstance = { addOIDCScope: jest.Mock; save: jest.Mock };

    const makeGrant = (): {
      GrantMock: jest.Mock & { find: jest.Mock };
      instance: GrantInstance;
    } => {
      const instance: GrantInstance = { addOIDCScope: jest.fn(), save: jest.fn() };
      const GrantMock = jest.fn(() => instance) as unknown as jest.Mock & { find: jest.Mock };
      GrantMock.find = jest.fn();
      return { GrantMock, instance };
    };

    const makeCtx = (opts: {
      GrantMock: jest.Mock & { find: jest.Mock };
      consentGrantId?: string;
      sessionGrantId?: string;
      accountId?: string;
      clientId?: string;
      clientScope?: string;
      requestedScope?: unknown;
    }) =>
      ({
        oidc: {
          result: opts.consentGrantId ? { consent: { grantId: opts.consentGrantId } } : undefined,
          session: {
            accountId: opts.accountId,
            grantIdFor: jest.fn(() => opts.sessionGrantId),
          },
          client: opts.clientId ? { clientId: opts.clientId, scope: opts.clientScope } : undefined,
          params: { scope: opts.requestedScope },
          provider: { Grant: opts.GrantMock },
        },
      }) as never;

    it('consent 結果に grantId があれば Grant.find の戻りを返し新規生成しないこと', async () => {
      const { GrantMock } = makeGrant();
      GrantMock.find.mockResolvedValue({ jti: 'existing' });
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          consentGrantId: 'g-1',
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
        }),
      );

      expect(GrantMock.find).toHaveBeenCalledWith('g-1');
      expect(result).toEqual({ jti: 'existing' });
      expect(GrantMock).not.toHaveBeenCalled();
    });

    it('session に client 向けの grantId があればそれを引くこと', async () => {
      const { GrantMock } = makeGrant();
      GrantMock.find.mockResolvedValue({ jti: 'from-session' });
      const built = await build();

      const ctx = makeCtx({
        GrantMock,
        sessionGrantId: 'g-2',
        accountId: 'acc-1',
        clientId: 'struct-pass-reference',
      });
      const result = await built.oidc.loadExistingGrant?.(ctx);

      // client ごとの grant を引いていること（引数を無視した実装でも緑にならないよう固定）。
      expect(
        (ctx as unknown as { oidc: { session: { grantIdFor: jest.Mock } } }).oidc.session
          .grantIdFor,
      ).toHaveBeenCalledWith('struct-pass-reference');
      expect(GrantMock.find).toHaveBeenCalledWith('g-2');
      expect(result).toEqual({ jti: 'from-session' });
    });

    it('reference 以外の client では grant を作らず undefined を返すこと（無確認の自動付与は first-party 限定）', async () => {
      const { GrantMock } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'other',
          clientScope: 'openid profile email',
          requestedScope: 'openid',
        }),
      );

      expect(result).toBeUndefined();
      expect(GrantMock).not.toHaveBeenCalled();
    });

    it('未ログイン（accountId 不在）では grant を作らず undefined を返すこと', async () => {
      const { GrantMock } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({ GrantMock, clientId: 'struct-pass-reference', requestedScope: 'openid' }),
      );

      expect(result).toBeUndefined();
      expect(GrantMock).not.toHaveBeenCalled();
    });

    it('付与 scope が「要求 ∩ 登録」に限定されること（over-grant 防止）', async () => {
      const { GrantMock, instance } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
          clientScope: 'openid profile email',
          requestedScope: 'openid email admin',
        }),
      );

      expect(GrantMock).toHaveBeenCalledWith({
        accountId: 'acc-1',
        clientId: 'struct-pass-reference',
      });
      expect(instance.addOIDCScope).toHaveBeenCalledWith('openid email');
      expect(instance.save).toHaveBeenCalled();
      expect(result).toBe(instance);
    });

    it('reference の実要求（openid profile email）では全 scope が付与され SSO が従来どおり通ること', async () => {
      const { GrantMock, instance } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
          clientScope: 'openid profile email',
          requestedScope: 'openid profile email',
        }),
      );

      expect(instance.addOIDCScope).toHaveBeenCalledWith('openid profile email');
      expect(instance.save).toHaveBeenCalled();
      expect(result).toBe(instance);
    });

    // d963: provider 側の grant 再利用・自動付与は MfaEnforcementGuard の外側で動くため、
    // 必須MFAを満たさないアカウントには grant を渡さない（interaction をやり直させる）。
    it('必須MFA ON × 未設定なら既存 grant を再利用しないこと（d963）', async () => {
      const { GrantMock } = makeGrant();
      GrantMock.find.mockResolvedValue({ jti: 'existing' });
      mockPrisma.passwordPolicy.findUnique.mockResolvedValue({ mfaEnforced: true });
      mockPrisma.mfaSetting.findFirst.mockResolvedValue(null);
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          consentGrantId: 'g-1',
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
        }),
      );

      expect(result).toBeUndefined();
      expect(mockPrisma.mfaSetting.findFirst).toHaveBeenCalledWith({
        where: { accountId: 'acc-1', enabled: true, confirmedAt: { not: null } },
      });
    });

    it('必須MFA ON でも confirmed MFA があれば既存 grant を再利用すること（d963 の対照）', async () => {
      const { GrantMock } = makeGrant();
      GrantMock.find.mockResolvedValue({ jti: 'existing' });
      mockPrisma.passwordPolicy.findUnique.mockResolvedValue({ mfaEnforced: true });
      mockPrisma.mfaSetting.findFirst.mockResolvedValue({ id: 'mfa-1' });
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          sessionGrantId: 'g-2',
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
        }),
      );

      expect(result).toEqual({ jti: 'existing' });
    });

    it('必須MFA ON × 未設定なら自動付与もしないこと（d963・interaction を強制する）', async () => {
      const { GrantMock } = makeGrant();
      mockPrisma.passwordPolicy.findUnique.mockResolvedValue({ mfaEnforced: true });
      mockPrisma.mfaSetting.findFirst.mockResolvedValue(null);
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
          clientScope: 'openid profile email',
          requestedScope: 'openid profile email',
        }),
      );

      expect(result).toBeUndefined();
      expect(GrantMock).not.toHaveBeenCalled();
    });

    it('grant はあるが session の accountId が無い時は再利用しない（fail-closed・d963）', async () => {
      const { GrantMock } = makeGrant();
      GrantMock.find.mockResolvedValue({ jti: 'existing' });
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({ GrantMock, consentGrantId: 'g-1', clientId: 'struct-pass-reference' }),
      );

      expect(result).toBeUndefined();
      expect(GrantMock).not.toHaveBeenCalled();
    });

    // cmn-0229 LOW-1: 要求 ⊂ 登録（要求が登録の真部分集合）のケース。
    // clientScope と requestedScope が同一集合だと上限を無視する実装でも緑になる
    // ため、要求を 'openid profile' に絞って「要求 ⊂ 登録」で addOIDCScope('openid profile')
    // が呼ばれることを固定する（回帰ガードの独立検出力を確保）。
    it('要求が登録の真部分集合のときはその部分集合だけが grant に積まれること', async () => {
      const { GrantMock, instance } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
          clientScope: 'openid profile email',
          requestedScope: 'openid profile',
        }),
      );

      expect(GrantMock).toHaveBeenCalledWith({
        accountId: 'acc-1',
        clientId: 'struct-pass-reference',
      });
      expect(instance.addOIDCScope).toHaveBeenCalledWith('openid profile');
      expect(instance.save).toHaveBeenCalled();
      expect(result).toBe(instance);
    });

    // cmn-0229 LOW-2: 要求 scope に重複があっても付与 scope は重複しない。
    // 'openid openid profile' を Set 化してから登録 scope と積集合を取ると 'openid profile'
    // だけが grant に積まれる。
    it('要求 scope に重複があっても付与 scope は重複しないこと', async () => {
      const { GrantMock, instance } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
          clientScope: 'openid profile email',
          requestedScope: 'openid openid profile',
        }),
      );

      expect(instance.addOIDCScope).toHaveBeenCalledWith('openid profile');
      expect(instance.save).toHaveBeenCalled();
      expect(result).toBe(instance);
    });

    // cmn-0229 MEDIUM-1: 登録 scope（client.scope）が読めない場合は古い広い値へ
    // フォールバックせず、登録 scope 不明として fail-closed へ倒す。要求が
    // 'openid' だけでも積集合は「空」（登録 scope 不明）となり grant を作らない。
    // cmn-0248: 警告ログは jest.spyOn(Logger.prototype, 'warn') で「実際に出る」ことを固定する
    // （従来は「コードパスとして Logger.warn を呼ぶ実装」を既存 spec の通過で担保していたが
    // warn を丸ごと削除しても 66 件全緑のまま通る＝回帰ガードがゼロだった）。
    it('client.scope が無いとき登録 scope 不明として fail-closed で grant を作らず警告ログを出すこと（cmn-0248）', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { GrantMock, instance } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
          requestedScope: 'openid',
        } as Parameters<typeof makeCtx>[0]),
      );

      expect(result).toBeUndefined();
      expect(GrantMock).not.toHaveBeenCalled();
      expect(instance.addOIDCScope).not.toHaveBeenCalled();
      expect(instance.save).not.toHaveBeenCalled();
      // 回帰ガード: warn が呼ばれ、引数には clientId（サニタイズ済）と scope が含まれる。
      // ここが落ちれば「警告ログを削った／clientId / scope を埋めなくなった」退行を検出できる。
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = String(warnSpy.mock.calls[0][0]);
      expect(warnArg).toContain('loadExistingGrant: empty intersection');
      expect(warnArg).toContain('clientId=struct-pass-reference');
      expect(warnArg).toContain('requested=[');
      expect(warnArg).toContain('openid');
      warnSpy.mockRestore();
    });

    // cmn-0248 MEDIUM-1: 改行入り / 制御文字入り / 非ASCII を混ぜた scope を要求しても
    // 警告ログが1行に収まる（改行が混入して別行へ分裂しない）。
    it('警告ログに混入された改行・制御文字・非ASCII がサニタイズされ1行に収まること（cmn-0248）', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { GrantMock } = makeGrant();
      const built = await build();

      await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
          requestedScope: 'admin\n 日本語 scope',
        }),
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = String(warnSpy.mock.calls[0][0]);
      // 1行に収まる（改行を含まない）。
      expect(warnArg).not.toMatch(/[\r\n]/);
      // 非印字文字（改行/制御/非ASCII）は除去され、ASCII の 'admin' 部分だけが残る。
      expect(warnArg).toContain('admin');
      expect(warnArg).not.toContain('日本語');
      // clientId 側は先頭行のサニタイズ済文字列だけが残る（'struct-pass-reference'）。
      expect(warnArg).toContain('clientId=struct-pass-reference');
      warnSpy.mockRestore();
    });

    // cmn-0248 MEDIUM-2: 極端に長い scope を要求しても上限長で打ち切られる。
    it('極端に長い scope は上限長で打ち切られ「…(truncated N)」が付与されること（cmn-0248）', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { GrantMock } = makeGrant();
      const built = await build();

      // 500 文字の scope（ASCII 印字可能だけ）。
      const longScope = 'a'.repeat(500);
      await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
          requestedScope: longScope,
        }),
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = String(warnSpy.mock.calls[0][0]);
      expect(warnArg).toContain('…(truncated 300)'); // 200 で打ち切り、残 300 を報告
      // 切り詰め後は 200 文字の 'a' + サフィックスで全長が大きく伸びない。
      expect(warnArg.length).toBeLessThan(longScope.length + 200);
      warnSpy.mockRestore();
    });

    // cmn-0248 MEDIUM-3 / criteria 4: 正常要求（openid profile email）は grant が成立し、警告ログは出ない。
    it('正常な要求（openid profile email）では警告ログを出さず grant を成立させること（cmn-0248）', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { GrantMock, instance } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
          clientScope: 'openid profile email',
          requestedScope: 'openid profile email',
        }),
      );

      expect(result).toBe(instance);
      expect(instance.addOIDCScope).toHaveBeenCalledWith('openid profile email');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // cmn-0205: 「要求 ∩ 登録」が空のとき登録 scope 全量へフォールバックしていた挙動を是正した。
    // 空集合では自動付与そのものを成立させない（fail-closed）＝要求されていない scope が
    // 無確認で外部 RP へ渡らない。cmn-0194 で記録していた現状挙動2件を是正後の期待値へ置換。
    it.each([
      ['要求が未登録 scope のみ', 'admin'],
      ['params.scope が文字列でない（undefined）', undefined],
      ['params.scope が文字列でない（配列）', ['openid']],
      ['要求 scope が空文字', ''],
    ])(
      '積集合が空（%s）なら grant を作らず undefined を返すこと',
      async (_label, requestedScope) => {
        const { GrantMock, instance } = makeGrant();
        const built = await build();

        const result = await built.oidc.loadExistingGrant?.(
          makeCtx({
            GrantMock,
            accountId: 'acc-1',
            clientId: 'struct-pass-reference',
            clientScope: 'openid profile email',
            requestedScope,
          }),
        );

        expect(result).toBeUndefined();
        expect(GrantMock).not.toHaveBeenCalled();
        expect(instance.addOIDCScope).not.toHaveBeenCalled();
        expect(instance.save).not.toHaveBeenCalled();
      },
    );

    it('consent 結果と session に異なる grantId があるとき consent 経路を優先すること（cmn-0214）', async () => {
      // 既存の :424 テストは consent 側しか grantId を入れないため、実装の `??` を左右入れ替えても
      // `undefined ?? 'g-1'` で緑のまま通る。両方に別 ID を入れることで優先順位を固定する。
      const { GrantMock } = makeGrant();
      GrantMock.find.mockResolvedValue({ jti: 'consent-grant' });
      const built = await build();

      const ctx = makeCtx({
        GrantMock,
        consentGrantId: 'g-consent',
        sessionGrantId: 'g-session',
        accountId: 'acc-1',
        clientId: 'struct-pass-reference',
      });
      const result = await built.oidc.loadExistingGrant?.(ctx);

      expect(GrantMock.find).toHaveBeenCalledWith('g-consent');
      expect(GrantMock.find).not.toHaveBeenCalledWith('g-session');
      // consent 側が勝ったとき、session.grantIdFor は short-circuit で呼ばれない（実装の `??` を保証）。
      expect(
        (ctx as unknown as { oidc: { session: { grantIdFor: jest.Mock } } }).oidc.session
          .grantIdFor,
      ).not.toHaveBeenCalled();
      expect(result).toEqual({ jti: 'consent-grant' });
    });

    it('既存 grant を返す際に accountId / clientId の一致を検証しないこと（factory 単体の現状挙動・cmn-0214）', async () => {
      // factory 単体では別アカウント／別クライアント由来の grant をそのまま返す。
      // ただし provider 側の loadGrant（oidc-provider/lib/actions/authorization/load_grant.js:11-16）が
      // accountId / clientId の不一致を検出して throw するため、システム全体としては cross-account
      // grant 再利用は阻止される。本 spec は factory の境界条件だけを記録する。
      // 将来 factory 側にも同種チェックを入れるなら、この assertion を是正後の期待値へ書き換える。
      const { GrantMock } = makeGrant();
      GrantMock.find.mockResolvedValue({
        jti: 'from-other-account',
        accountId: 'other-acc',
        clientId: 'other-client',
      });
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          consentGrantId: 'g-1',
          accountId: 'acc-1',
          clientId: 'struct-pass-reference',
        }),
      );

      expect(result).toEqual({
        jti: 'from-other-account',
        accountId: 'other-acc',
        clientId: 'other-client',
      });
    });

    // d1167: 自動付与の first-party 判定は Reference 固定ではなく、RP 定義（Reference + gmis）から
    // 作る client_id 集合で行う。Reference の挙動は従来どおり（上のテスト群）で、gmis も同じ扱いになる。
    it('gmis client でも first-party として grant を自動付与すること（d1167）', async () => {
      const { GrantMock, instance } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'gmis',
          clientScope: 'openid profile email',
          requestedScope: 'openid profile email',
        }),
      );

      expect(GrantMock).toHaveBeenCalledWith({ accountId: 'acc-1', clientId: 'gmis' });
      expect(instance.addOIDCScope).toHaveBeenCalledWith('openid profile email');
      expect(instance.save).toHaveBeenCalled();
      expect(result).toBe(instance);
    });

    it('gmis でも付与 scope は「要求 ∩ 登録」に限定されること（over-grant 防止）', async () => {
      const { GrantMock, instance } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'gmis',
          clientScope: 'openid profile email',
          requestedScope: 'openid admin',
        }),
      );

      expect(instance.addOIDCScope).toHaveBeenCalledWith('openid');
      expect(result).toBe(instance);
    });

    it('OIDC_GMIS_CLIENT_ID を変えた時もその client_id が first-party として扱われること', async () => {
      process.env.OIDC_GMIS_CLIENT_ID = 'gmis-custom';
      const { GrantMock, instance } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'gmis-custom',
          clientScope: 'openid profile email',
          requestedScope: 'openid',
        }),
      );

      expect(result).toBe(instance);
      expect(instance.addOIDCScope).toHaveBeenCalledWith('openid');
    });

    it('gmis でも必須MFA ON × 未設定なら自動付与しないこと（MFA ガード維持・d963）', async () => {
      mockPrisma.passwordPolicy.findUnique.mockResolvedValue({ mfaEnforced: true });
      mockPrisma.mfaSetting.findFirst.mockResolvedValue(null);
      const { GrantMock } = makeGrant();
      const built = await build();

      const result = await built.oidc.loadExistingGrant?.(
        makeCtx({
          GrantMock,
          accountId: 'acc-1',
          clientId: 'gmis',
          clientScope: 'openid profile email',
          requestedScope: 'openid profile email',
        }),
      );

      expect(result).toBeUndefined();
      expect(GrantMock).not.toHaveBeenCalled();
    });
  });

  describe('issuer / proxy', () => {
    it('OIDC_ISSUER 未設定なら PORT から localhost の issuer を組み立てること', async () => {
      process.env.PORT = '3011';

      const built = await build();

      expect(built.issuer).toBe('http://localhost:3011/api/v1/oidc');
    });

    it('PORT 未設定なら既定の :3001 で issuer を組み立てること（dev 既定の固定・cmn-0214）', async () => {
      // env 指定側（前述・PORT=3011）のテストだけだと、既定値が黙って別のポートへ差し替わっても検出できない。
      // 値で固定することで既定ドリフトを検知する。
      const built = await build();

      expect(built.issuer).toBe('http://localhost:3001/api/v1/oidc');
    });

    it('OIDC_ISSUER 設定時はその値をそのまま使うこと', async () => {
      process.env.OIDC_ISSUER = 'https://id.example.com/api/v1/oidc';

      const built = await build();

      expect(built.issuer).toBe('https://id.example.com/api/v1/oidc');
    });

    it('proxy は NODE_ENV=production のときだけ true であること', async () => {
      // prod で factory の fail-closed を満たすために両 env を併記（cmn-0213）。
      process.env.OIDC_JWKS = JSON.stringify({ keys: [{ kid: 'k', kty: 'RSA' }] });
      process.env.OIDC_COOKIE_KEYS = 'a'.repeat(40);
      process.env.NODE_ENV = 'production';
      expect((await build()).proxy).toBe(true);

      // dev 側は両 env を外しても dev 既定で通る（cookieKeys は dev 既定、jwks は dev 一時鍵）。
      delete process.env.OIDC_JWKS;
      delete process.env.OIDC_COOKIE_KEYS;
      process.env.NODE_ENV = 'development';
      expect((await build()).proxy).toBe(false);

      delete process.env.NODE_ENV;
      expect((await build()).proxy).toBe(false);
    });
  });

  // cmn-0230: 本番での条件付きチェック（合言葉設定あり＋戻り先未設定）の単体テスト。
  // main.ts の validateEnv 内に組み込まれ、main.spec は本スペックで代替する。
  describe('validateReferenceRedirectUriRequiredInProduction（cmn-0230）', () => {
    it.each([
      ['NODE_ENV 未設定', undefined, 'no-secret', undefined],
      ['NODE_ENV=development', 'development', 'no-secret', undefined],
      ['CLIENT_SECRET 未設定', 'production', undefined, undefined],
      [
        'CLIENT_SECRET 設定 + REDIRECT_URIS 設定済み',
        'production',
        's3cret',
        'https://ref.example.com/api/v1/auth/oidc/callback',
      ],
    ])('起動 OK（%s）', (_label, nodeEnv, clientSecret, redirectUris) => {
      const prevNodeEnv = process.env.NODE_ENV;
      const prevSecret = process.env.OIDC_REFERENCE_CLIENT_SECRET;
      const prevUris = process.env.OIDC_REFERENCE_REDIRECT_URIS;
      try {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        if (clientSecret === undefined) delete process.env.OIDC_REFERENCE_CLIENT_SECRET;
        else process.env.OIDC_REFERENCE_CLIENT_SECRET = clientSecret;
        if (redirectUris === undefined) delete process.env.OIDC_REFERENCE_REDIRECT_URIS;
        else process.env.OIDC_REFERENCE_REDIRECT_URIS = redirectUris;

        expect(validateReferenceRedirectUriRequiredInProduction()).toBeNull();
      } finally {
        if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevNodeEnv;
        if (prevSecret === undefined) delete process.env.OIDC_REFERENCE_CLIENT_SECRET;
        else process.env.OIDC_REFERENCE_CLIENT_SECRET = prevSecret;
        if (prevUris === undefined) delete process.env.OIDC_REFERENCE_REDIRECT_URIS;
        else process.env.OIDC_REFERENCE_REDIRECT_URIS = prevUris;
      }
    });

    it.each([
      ['REDIRECT_URIS 未設定', undefined],
      ['REDIRECT_URIS 空文字', ''],
      ['REDIRECT_URIS 空白・カンマのみ', '   ,   ,'],
    ])(
      '本番で CLIENT_SECRET 設定済＋戻り先未設定（%s）なら起動エラーの理由を返すこと',
      (_label, redirectUris) => {
        const prevNodeEnv = process.env.NODE_ENV;
        const prevSecret = process.env.OIDC_REFERENCE_CLIENT_SECRET;
        const prevUris = process.env.OIDC_REFERENCE_REDIRECT_URIS;
        try {
          process.env.NODE_ENV = 'production';
          process.env.OIDC_REFERENCE_CLIENT_SECRET = 's3cret';
          if (redirectUris === undefined) delete process.env.OIDC_REFERENCE_REDIRECT_URIS;
          else process.env.OIDC_REFERENCE_REDIRECT_URIS = redirectUris;

          const reason = validateReferenceRedirectUriRequiredInProduction();
          expect(reason).not.toBeNull();
          expect(reason).toMatch(/OIDC_REFERENCE_REDIRECT_URIS/);
          expect(reason).toMatch(/cmn-0230/);
        } finally {
          if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = prevNodeEnv;
          if (prevSecret === undefined) delete process.env.OIDC_REFERENCE_CLIENT_SECRET;
          else process.env.OIDC_REFERENCE_CLIENT_SECRET = prevSecret;
          if (prevUris === undefined) delete process.env.OIDC_REFERENCE_REDIRECT_URIS;
          else process.env.OIDC_REFERENCE_REDIRECT_URIS = prevUris;
        }
      },
    );
  });
});
