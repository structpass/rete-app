import type { AccountClaims, ClientMetadata, Configuration, JWK } from 'oidc-provider';
import { generateKeyPair, exportJWK } from 'jose';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../../database';
import { createOidcPrismaAdapter } from './oidc-prisma.adapter';
import { buildApiPath } from '../../../common/config/api-routes';
import { OIDC_RP_DEFINITIONS, parseOidcRedirectUris } from '../../../common/config/env-validation';
import { LoginSettingsRepository } from '../../login-settings/repositories/login-settings.repository';
import { MfaRepository } from '../../mfa/repositories/mfa.repository';

/**
 * first-party RP（静的登録する OIDC client）へ登録する scope。
 * d1167: Reference と gmis は同じ scope を使う（2 つ目の RP 追加で reference 専用の値ではなくなった）。
 * cmn-0229: 静的 client 登録 (scope) のみが参照する（cmn-0248 で参照箇所を実体確認）。
 * loadExistingGrant の上限算出は実行時の ctx.oidc.client?.scope を参照するため本定数とは別経路。
 */
const FIRST_PARTY_CLIENT_SCOPE = 'openid profile email';

/**
 * 自動付与を見送った際の警告ログ用 Logger。cmn-0229 MEDIUM-2: 無記録だと
 * frontend の consent UI 不在で 400 になった時に原因が追えないため 1 行出す。
 * 運用ポリシー §2 warn = 設定不整合、token / secret は出さない。
 *
 * cmn-0248: 書き込む値は sanitizeForLog を通して印字可能文字のみへ絞り、上限長で切り詰める。
 * 利用者が scope クエリで自由に文字列を送り込めるため、改行や制御文字でログを汚される経路を塞ぐ。
 */
const OIDC_CONFIG_FACTORY_LOGGER = new Logger('OidcConfigFactory');

/** cmn-0248: 警告ログへ書き込む値のサニタイザ。印字可能 ASCII 以外を除去し、上限長で切り詰める。
 * 利用者が URL クエリで自由入力できる値（authorize の scope 等）をログへ入れる前に通す。
 * 改行／制御文字による偽ログ行の混入と、長大値によるログ膨張を防ぐ。token / secret は元から出さない。
 */
const LOG_MAX_LEN = 200;
const sanitizeForLog = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return '<unknown>';
  // 印字可能 ASCII（0x20-0x7E、space 〜 ~）のみ残す。改行／制御文字／非ASCII を一掃する。
  const printable = value.replace(/[^\x20-\x7E]/g, '');
  if (printable.length <= LOG_MAX_LEN) return printable;
  return `${printable.slice(0, LOG_MAX_LEN)}…(truncated ${printable.length - LOG_MAX_LEN})`;
};

/**
 * 本番で「合言葉設定あり＋戻り先未設定」だけを起動エラーにする条件付きバリデータ。
 * cmn-0230 / cmn-0249: 実装は `common/config/env-validation` 側に集約（本ファイルは再エクスポートのみ）。
 * bootstrap / spec は本シンボルを直接 import できる形を維持し、移設後の参照路を保ったままにしている。
 */
export { validateReferenceRedirectUriRequiredInProduction } from '../../../common/config/env-validation';

/**
 * OIDC Provider（Rete=IdP）の設定を組み立てる。
 *
 * - 署名鍵(jwks): 本番は `OIDC_JWKS`（JSON）必須・未設定なら起動を止める（fail-closed）。dev は未設定で起動時に RS256 鍵を生成（再起動で失効＝dev 許容）。
 * - cookie 署名鍵: 本番は `OIDC_COOKIE_KEYS`（カンマ区切り）必須・未設定なら起動を止める（fail-closed）。dev は既定の公開値で継続。
 * - interaction: 自前のログイン画面（frontend）に飛ばす（devInteractions は無効）。
 * - PKCE 必須・claims は最小（sub / name / email）。
 * - first-party RP（Reference / gmis・d1167）の静的 client は、RP 定義（common/config の
 *   OIDC_RP_DEFINITIONS）ごとに secret と有効な redirect URI が両方揃った時だけ登録する。
 *
 * 認証 secret の二重ガード（cmn-0213）: 本番の必須・placeholder・長さ検査は main.ts の
 * validateProductionSecrets が担う。本ファイル側では「prod で未設定なら即 throw」だけを追加し、
 * 起動口の追加や必須一覧の編集で静かに崩れないように隣で存在検査する。
 */
export interface BuiltOidcConfig {
  issuer: string;
  oidc: Configuration;
  /** リバプロ(TLS終端)配下を信頼するか。OidcModuleOptions.proxy に渡す（Configuration ではない）。 */
  proxy: boolean;
}

async function resolveJwks(isProd: boolean): Promise<JWK[]> {
  const raw = process.env.OIDC_JWKS?.trim();
  // 空文字は「設定したのに中身が無い」状態。dev 一時鍵へ黙って落ちないよう明示的に落とす
  // （本番の必須チェックは main.ts の validateProductionSecrets が別途担う）。
  if (process.env.OIDC_JWKS !== undefined && !raw) {
    throw new Error(
      'OIDC_JWKS が空です。鍵を設定するか、環境変数ごと外してください（dev は自動生成）。',
    );
  }
  if (raw) {
    // 素の配列 `[{...}]` と `{"keys":[...]}` の両形式を受ける。Array.isArray で先に分岐しないと
    // `parsed.keys` が Array.prototype.keys（関数）に当たり、鍵ゼロの壊れた設定ができる（cmn-0204）。
    // JSON.parse の SyntaxError は入力の先頭断片をメッセージへ埋めるため、そのまま投げると
    // 署名鍵が起動失敗ログへ漏れる。原文を伝播させず定型メッセージに置き換える。
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('OIDC_JWKS が JSON として解析できません。');
    }
    const keys = Array.isArray(parsed)
      ? parsed
      : ((parsed as { keys?: unknown } | null)?.keys ?? null);
    // 署名鍵がゼロだと OIDC 連携が全滅するため、鍵配列として解釈できない値は起動時に落とす（fail-closed）。
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error(
        'OIDC_JWKS は鍵の配列 `[{...}]` または `{"keys":[{...}]}` 形式で、1本以上の鍵を含む必要があります。',
      );
    }
    // 各要素の妥当性（kty / 秘密鍵成分）は oidc-provider の keystore 初期化が assert するため二重に検証しない。
    return keys as JWK[];
  }
  // 未設定。prod では起動を止める（fail-closed＝cmn-0213）。dev は起動ごとに一時鍵を生成する。
  if (isProd) {
    throw new Error(
      'OIDC_JWKS が未設定です。本番では起動ごとに署名鍵が変わり既発行 token が検証不能になるため、env を設定してください。',
    );
  }
  // dev: 起動時に署名鍵を生成する。extractable=true で JWK へエクスポート可能にする。
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = (await exportJWK(privateKey)) as JWK;
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  jwk.kid = 'dev-rete-rs256';
  return [jwk];
}

export async function buildOidcConfiguration(prisma: PrismaService): Promise<BuiltOidcConfig> {
  const port = process.env.PORT || '3001';
  const issuer = process.env.OIDC_ISSUER || `http://localhost:${port}${buildApiPath('oidc')}`;
  const isProd = process.env.NODE_ENV === 'production';
  const rawCookieKeys = process.env.OIDC_COOKIE_KEYS;
  // 本番で未設定なら起動を止める（fail-closed）。main.ts の validateProductionSecrets は長さ＋placeholder を検査し、
  // ここでは存在だけを検査する（役割が違う＝ cmn-0213）。
  if (isProd && !rawCookieKeys) {
    throw new Error(
      'OIDC_COOKIE_KEYS が未設定です。本番では既定の公開 cookie 署名鍵でセッション cookie が偽造されうるため、env を設定してください。',
    );
  }
  const cookieKeys = (rawCookieKeys || 'dev-insecure-cookie-key-change-me')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Rete 自身のログイン画面（frontend）。CORS_ORIGIN の先頭を Rete frontend とみなす。
  const frontendUrl = (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',')[0].trim();
  const jwks = await resolveJwks(isProd);

  // d963: provider 側の grant 再利用・自動付与は MfaEnforcementGuard の外側（Rete のセッションを見ない）で動く。
  // 必須MFAなのに confirmed MFA を持たないアカウントへは grant を渡さず、interaction（=ログイン＋MFA）を
  // やり直させる。判定は MfaEnforcementGuard と同じデータ（passwordPolicy.mfaEnforced / mfaSetting）を読む。
  const loginSettingsRepo = new LoginSettingsRepository(prisma);
  const mfaRepo = new MfaRepository(prisma);
  const requiresMfaSetupForAccount = async (accountId: string | undefined): Promise<boolean> => {
    if (!accountId) return false;
    const policy = await loginSettingsRepo.findPasswordPolicy();
    if (!policy?.mfaEnforced) return false;
    return (await mfaRepo.findConfirmedSetting(accountId)) === null;
  };

  // 静的 RP client は secret が明示設定された時だけ登録する（既定 secret が本番に流出するのを防ぐ）。
  // 登録対象の RP（env 名・既定 client_id）は common/config の OIDC_RP_DEFINITIONS を正本とし、
  // 3 つ目の RP を足す時はあの表へ 1 件追加する（d1167）。
  // cmn-0230: redirect_uris も「有効値が1件以上ある」ことが登録の必要条件（AND）。
  // cmn-0249: 起動ガード側と同一の parser を common/config から呼ぶ（検査-実施ドリフト防止）。
  // 未設定 / 空要素のみ / 空文字 env / 重複 URI は parser 段階で除去される。
  const clients: ClientMetadata[] = [];
  // first-party（セット売り）の client_id 集合。consent 省略の自動付与はこの集合だけに許す。
  const firstPartyClientIds = new Set<string>();
  for (const rp of OIDC_RP_DEFINITIONS) {
    const clientId = process.env[rp.clientIdEnvKey] || rp.defaultClientId;
    firstPartyClientIds.add(clientId);
    const secret = process.env[rp.clientSecretEnvKey];
    const redirectUris = parseOidcRedirectUris(process.env[rp.redirectUrisEnvKey]);
    // cmn-0249: 非本番で「合言葉あり・戻り先有効値なし」は無言で client 0 件になると SSO 試行まで
    // 不備に気づけない。本番は validateProductionSecrets 側で起動エラーになる（cmn-0230）、
    // dev/staging ではここで warn を 1 行出して気付けるようにする。
    if (secret && redirectUris.length === 0 && !isProd) {
      OIDC_CONFIG_FACTORY_LOGGER.warn(
        `${rp.clientSecretEnvKey} is set but ${rp.redirectUrisEnvKey} has no valid entries. ` +
          `The ${rp.label} RP client will not be registered; SSO attempts for it will fail with invalid_client until the URIs are set (cmn-0249).`,
      );
    }
    if (!secret || redirectUris.length === 0) continue;
    clients.push({
      client_id: clientId,
      client_secret: secret,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: FIRST_PARTY_CLIENT_SCOPE,
    });
  }

  const oidc: Configuration = {
    adapter: createOidcPrismaAdapter(prisma),
    clients,
    claims: {
      openid: ['sub'],
      profile: ['name'],
      email: ['email', 'email_verified'],
    },
    cookies: {
      keys: cookieKeys,
      // interaction(short) / session(long) cookie を全 path に広げる。
      // ログイン UI は frontend（別ポート＝同一サイト・別オリジン）にあり、そこから backend の
      // interaction endpoint へ credentials 付き fetch する。path を '/' にしないと cookie が届かない。
      short: { path: '/', sameSite: 'lax' },
      long: { path: '/', sameSite: 'lax' },
    },
    jwks: { keys: jwks },
    // token / session の寿命を明示（未指定だと provider が警告を出し、RefreshToken 既定 14 日は長すぎる）。
    ttl: {
      AccessToken: 60 * 60, // 1h
      AuthorizationCode: 10 * 60, // 10m
      IdToken: 60 * 60, // 1h
      Interaction: 60 * 60, // 1h
      Session: 14 * 24 * 60 * 60, // 14d
      Grant: 14 * 24 * 60 * 60, // 14d
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: true },
    },
    pkce: { required: () => true },
    findAccount: async (_ctx, id) => {
      // OIDC 基盤の限定した読み出しとして Prisma を直接使う（業務 Service の一般的な例外ではない）。
      // 理由・範囲・再検討条件: docs/decisions/0073-oidc-sso-decisions-consolidated.md 判断4。
      // cmn-0232 LOW5: cmn-0208 で cmn-0185 の資格情報 lookup に JSDoc 注意書き（詰め替え必須）
      // を入れたが、本経路は Repository を介さず全列取得しており、その注意書きが届かない第二の
      // 「全列読み出し」になっていた（invariants §2 逸脱）。claims で使う列（id / name /
      // email / isActive）に絞り、account.repository.ts:findByEmail/findById と同じ payload
      // 形へ揃える。将来 claims が増えて select を拡張しないと provider が起動時に落ちる形に
      // なるため、assert 的役割も兼ねる。
      const account = await prisma.account.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, isActive: true },
      });
      if (!account || !account.isActive) return undefined;
      return {
        accountId: id,
        claims: async (_use: string, scope: string): Promise<AccountClaims> => {
          const out: AccountClaims = { sub: id };
          if (scope.includes('profile')) out.name = account.name;
          if (scope.includes('email')) {
            out.email = account.email;
            // Rete にメール検証フローは未実装。検証済みを偽って RP に伝えない（verified=false が honest）。
            // 将来 Account.emailVerifiedAt を追加したら、その有無から導出する。
            out.email_verified = false;
          }
          return out;
        },
      };
    },
    // first-party（セット売り）の RP client（Reference / gmis・d1167）は consent を省略し
    // grant を自動付与する。これが無いと login 後に consent prompt が発生し、frontend 未配線だと
    // authorize が完了しない。判定は OIDC_RP_DEFINITIONS から作った first-party の client_id 集合で行う。
    // 第三者 client（将来追加されうる）には適用せず、従来どおり consent prompt を出す（無確認の grant 発行を防ぐ）。
    loadExistingGrant: async (ctx) => {
      const existingGrantId =
        ctx.oidc.result?.consent?.grantId ??
        (ctx.oidc.session && ctx.oidc.client
          ? ctx.oidc.session.grantIdFor(ctx.oidc.client.clientId)
          : undefined);
      if (existingGrantId) {
        const existingGrant = await ctx.oidc.provider.Grant.find(existingGrantId);
        // d963: 再利用は interaction を省略するため、必須MFAを満たさないアカウントには渡さない
        // （渡すと RP のトークンが MFA 無しで再取得でき、Rete のセッション遮断を迂回できる）。
        // どのアカウントの grant かを決められない（session 無し）なら再利用しない（fail-closed）。
        const sessionAccountId = ctx.oidc.session?.accountId;
        if (!sessionAccountId) {
          return undefined;
        }
        if (existingGrant && (await requiresMfaSetupForAccount(sessionAccountId))) {
          return undefined;
        }
        return existingGrant;
      }
      const accountId = ctx.oidc.session?.accountId;
      const clientId = ctx.oidc.client?.clientId;
      if (!accountId || !clientId || !firstPartyClientIds.has(clientId)) {
        return undefined;
      }
      // d963: 自動付与も interaction を省略する。必須MFAを満たさないアカウントには付与せず、
      // provider にログイン（＋MFA）をやり直させる。
      if (await requiresMfaSetupForAccount(accountId)) {
        return undefined;
      }
      // 付与 scope は client 登録済み scope を上限とし、要求 scope との積集合に限定する
      // （要求 scope を素通しで信用して over-grant しない＝consent 省略の前提を破らない）。
      // cmn-0229: client.scope が読めない場合（登録情報欠落）は古い広い値へフォールバックせず、
      // 登録 scope 不明として fail-closed へ倒す（fail-open 残滓を作らない）。
      const registeredScopesRaw = ctx.oidc.client?.scope;
      const requestedScopes =
        typeof ctx.oidc.params?.scope === 'string' ? ctx.oidc.params.scope.split(' ') : [];
      // 要求 scope の重複を落とし（実害なしだが同一 scope を素通ししない＝cmn-0229 LOW-2）、
      // 登録 scope も Set 化して includes 判定を O(1) にする。
      const requestedSet = new Set(requestedScopes.filter(Boolean));
      const registeredSet = new Set((registeredScopesRaw ?? '').split(' ').filter(Boolean));
      const grantedScopes = [...requestedSet].filter((s) => registeredSet.has(s));
      // 積集合が空（scope 未要求 / 非文字列 / 未登録 scope のみ / 登録 scope 不明）なら
      // 自動付与を成立させない。登録済み scope 全量へ広げると、要求されていない scope が
      // 無確認で外部 RP へ渡る（cmn-0205）。登録 scope 不明も同じく空として扱う（cmn-0229 MEDIUM-1）。
      if (grantedScopes.length === 0) {
        // cmn-0248: 利用者が自由入力できる clientId / scope は sanitizeForLog を通してから書く。
        // 改行入りや制御文字で「別のログ行」が紛れ込む経路と、長大値でログが膨らむ経路を塞ぐ。
        OIDC_CONFIG_FACTORY_LOGGER.warn(
          `loadExistingGrant: empty intersection (clientId=${sanitizeForLog(clientId)}, requested=[${
            [...requestedSet].map(sanitizeForLog).join(' ') || '<none>'
          }], registered=[${[...registeredSet].map(sanitizeForLog).join(' ') || '<none>'}])`,
        );
        return undefined;
      }
      const grant = new ctx.oidc.provider.Grant({ accountId, clientId });
      grant.addOIDCScope(grantedScopes.join(' '));
      await grant.save();
      return grant;
    },
    interactions: {
      url: (_ctx, interaction) => `${frontendUrl}/login?uid=${interaction.uid}`,
    },
  };

  // proxy はリバプロ(TLS終端)配下で ctx.secure を信頼させる設定。OidcModuleOptions レベルで渡す。
  return { issuer, oidc, proxy: isProd };
}
