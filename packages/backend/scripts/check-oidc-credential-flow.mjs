// Real provider, PKCE and HTTP redirects against a disposable in-memory persistence adapter.
// No backend build, product database, account, key or external URL is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const { default: Provider } = await import(pathToFileURL(require.resolve('oidc-provider')));
const ts = require('typescript');
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const build = join(root, 'tmp/oidc-flow');
mkdirSync(build, { recursive: true });
for (const name of ['oidc-credential-state', 'oidc-prisma.adapter']) {
  const source = readFileSync(
    join(root, `packages/backend/src/modules/auth/oidc/${name}.ts`),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  });
  writeFileSync(join(build, `${name}.js`), compiled.outputText);
}
const { createOidcPrismaAdapter } = require(join(build, 'oidc-prisma.adapter.js'));
const account = { isActive: true, credentialsChangedAt: null };
const rows = new Map();
const lookup = (where) =>
  [...rows.values()].find((row) => Object.entries(where).every(([k, v]) => row[k] === v));
const prisma = {
  account: { findUnique: async () => account },
  oidcPayload: {
    upsert: async ({ where, create, update }) => {
      const { type, modelId } = where.type_modelId;
      const key = `${type}:${modelId}`;
      rows.set(key, structuredClone(rows.has(key) ? { ...rows.get(key), ...update } : create));
    },
    findUnique: async ({ where }) =>
      structuredClone(rows.get(`${where.type_modelId.type}:${where.type_modelId.modelId}`) ?? null),
    findFirst: async ({ where }) => structuredClone(lookup(where) ?? null),
    update: async ({ where, data }) =>
      Object.assign(rows.get(`${where.type_modelId.type}:${where.type_modelId.modelId}`), data),
    deleteMany: async ({ where }) => {
      for (const [key, row] of rows)
        if (Object.entries(where).every(([k, v]) => row[k] === v)) rows.delete(key);
    },
  },
};
let provider;
let loginTs = Math.floor(Date.now() / 1000) - 5;
let loginPrompts = 0;
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/interaction/')) {
      loginPrompts += 1;
      await provider.interactionFinished(
        req,
        res,
        { login: { accountId: 'synthetic-account', ts: loginTs, remember: false } },
        { mergeWithLastSubmission: false },
      );
    } else {
      provider.callback()(req, res);
    }
  } catch (error) {
    res.statusCode = 500;
    res.end(error.message);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const redirect = `${origin}/callback`;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
provider = new Provider(origin, {
  adapter: createOidcPrismaAdapter(prisma),
  jwks: {
    keys: [
      { ...privateKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'synthetic-only' },
    ],
  },
  cookies: { keys: ['synthetic-test-cookie-key-32-bytes-only'] },
  clients: [
    {
      client_id: 'synthetic-rp',
      redirect_uris: [redirect],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  ],
  features: { devInteractions: { enabled: false } },
  pkce: { required: () => true },
  findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
  interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
  loadExistingGrant: async (ctx) => {
    const grantId = ctx.oidc.session?.grantIdFor(ctx.oidc.client.clientId);
    if (grantId) return ctx.oidc.provider.Grant.find(grantId);
    if (!ctx.oidc.session?.accountId) return undefined;
    const grant = new ctx.oidc.provider.Grant({
      accountId: ctx.oidc.session.accountId,
      clientId: ctx.oidc.client.clientId,
    });
    grant.addOIDCScope('openid');
    await grant.save();
    return grant;
  },
});
const jar = new Map();
async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'manual',
    headers: { ...options.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const split = pair.indexOf('=');
    jar.set(pair.slice(0, split), pair.slice(split + 1));
  }
  return response;
}
async function authorize({ stopAtLogin = false, stopAfterLogin = false } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let url = `${origin}/auth?${new URLSearchParams({ client_id: 'synthetic-rp', redirect_uri: redirect, response_type: 'code', scope: 'openid', code_challenge: challenge, code_challenge_method: 'S256' })}`;
  for (let i = 0; i < 12; i += 1) {
    if (stopAtLogin && new URL(url).pathname.startsWith('/interaction/'))
      return { needsLogin: true };
    const response = await request(url);
    assert.ok(
      response.status >= 300 && response.status < 400,
      `authorization status=${response.status}: ${await response.text()}`,
    );
    const completedLogin = new URL(url).pathname.startsWith('/interaction/');
    url = new URL(response.headers.get('location'), url).href;
    if (stopAfterLogin && completedLogin) return { resumeUrl: url };
    if (url.startsWith(redirect)) {
      assert.equal(new URL(url).searchParams.get('error'), null, 'authorization error');
      return { code: new URL(url).searchParams.get('code'), verifier };
    }
  }
  throw new Error('authorization did not finish');
}
async function redeem({ code, verifier }) {
  return request(`${origin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'synthetic-rp',
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
    }),
  });
}
try {
  const initial = await authorize();
  assert.equal(loginPrompts, 1);
  const good = await redeem(initial);
  assert.equal(good.status, 200, await good.text());
  const pendingCode = await authorize();
  assert.equal(loginPrompts, 1, 'unchanged IdP cookie should provide normal seamless SSO');
  account.credentialsChangedAt = new Date();
  const staleCode = await redeem(pendingCode);
  assert.equal(staleCode.status, 400, 'pre-change authorization code must not redeem');
  assert.equal((await staleCode.json()).error, 'invalid_grant');
  assert.equal(
    (await authorize({ stopAtLogin: true })).needsLogin,
    true,
    'old IdP cookie must require a fresh first factor',
  );
  const delay = 1001 - (Date.now() % 1000);
  await new Promise((resolve) => setTimeout(resolve, delay));
  loginTs = Math.floor(Date.now() / 1000);
  const fresh = await authorize();
  assert.equal((await redeem(fresh)).status, 200, 'fresh login after password change must work');
  account.credentialsChangedAt = null;
  jar.clear();
  const pendingLegacy = await authorize({ stopAfterLogin: true });
  // Fixture from the prior release: its completed Interaction did not contain login.ts.
  for (const row of rows.values()) {
    if (row.type === 'Interaction' && row.payload.result?.login) delete row.payload.result.login.ts;
  }
  account.credentialsChangedAt = new Date();
  const legacyResume = await request(pendingLegacy.resumeUrl);
  assert.equal(
    legacyResume.status,
    400,
    'legacy completed login must not be restamped during resume',
  );
  console.log(
    'OIDC HTTP/PKCE: normal SSO, stale-cookie rejection, stale-code rejection, fresh reauthentication passed',
  );
  console.log('OIDC rollout: completed legacy interaction cannot resume after password change');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
