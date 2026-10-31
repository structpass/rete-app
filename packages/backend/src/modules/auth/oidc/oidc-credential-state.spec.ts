import type { AdapterPayload } from 'oidc-provider';
import type { PrismaService } from '../../../database/prisma.service';
import { createOidcPrismaAdapter } from './oidc-prisma.adapter';

describe('OIDC credential revocation across provider models', () => {
  const changed = new Date('2026-10-22T01:00:00.500Z');
  const oldTime = Math.floor(changed.getTime() / 1000);
  const newTime = oldTime + 1;
  const prisma = {
    account: { findUnique: jest.fn() },
    oidcPayload: { upsert: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
  };
  const build = (model: string) =>
    new (createOidcPrismaAdapter(prisma as unknown as PrismaService))(model);
  const row = (payload: object) => ({
    payload,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
  });
  beforeEach(() => {
    prisma.account.findUnique.mockResolvedValue({ isActive: true, credentialsChangedAt: changed });
  });

  it.each(['find', 'findByUid', 'findByUserCode'] as const)(
    '%s rejects a pre-change IdP session',
    async (method) => {
      prisma.oidcPayload.findUnique.mockResolvedValue(row({ accountId: 'a', loginTs: oldTime }));
      prisma.oidcPayload.findFirst.mockResolvedValue(row({ accountId: 'a', loginTs: oldTime }));
      expect(await build('Session')[method]('old')).toBeUndefined();
    },
  );

  it.each(['Session', 'AuthorizationCode', 'RefreshToken', 'Grant'])(
    'stale %s cannot be recreated by an in-flight save',
    async (model) => {
      const payload = {
        accountId: 'a',
        loginTs: oldTime,
        authTime: oldTime,
        iat: oldTime,
      } as AdapterPayload;
      await expect(build(model).upsert('old', payload, 60)).rejects.toThrow('authenticate again');
      expect(prisma.oidcPayload.upsert).not.toHaveBeenCalled();
    },
  );

  it.each(['Session', 'AuthorizationCode', 'RefreshToken', 'Grant'])(
    'fresh %s keeps its normal save/read contract',
    async (model) => {
      const payload = {
        accountId: 'a',
        loginTs: newTime,
        authTime: newTime,
        iat: newTime,
      } as AdapterPayload;
      await build(model).upsert('new', payload, 60);
      prisma.oidcPayload.findUnique.mockResolvedValue(row(payload));
      expect(await build(model).find('new')).toEqual(payload);
    },
  );

  it('legacy authenticated state fails after a change, but a different unchanged account remains usable', async () => {
    prisma.oidcPayload.findUnique.mockResolvedValue(row({ accountId: 'a' }));
    expect(await build('Session').find('old')).toBeUndefined();
    prisma.account.findUnique.mockResolvedValue({ isActive: true, credentialsChangedAt: null });
    expect(await build('Session').find('unchanged')).toEqual({ accountId: 'a' });
  });

  it('access tokens resolve original session authentication, not their own fresh issuance time', async () => {
    prisma.oidcPayload.findUnique.mockResolvedValue(
      row({ accountId: 'a', sessionUid: 'uid', iat: newTime }),
    );
    prisma.oidcPayload.findFirst.mockResolvedValue(row({ accountId: 'a', loginTs: oldTime }));
    expect(await build('AccessToken').find('token')).toBeUndefined();
    prisma.oidcPayload.findFirst.mockResolvedValue(row({ accountId: 'a', loginTs: newTime }));
    expect(await build('AccessToken').find('token')).toMatchObject({ accountId: 'a' });
    prisma.oidcPayload.findFirst.mockResolvedValue(null);
    expect(await build('AccessToken').find('token')).toBeUndefined();
  });

  it('inactive/deleted accounts fail closed and unauthenticated interaction state remains available', async () => {
    prisma.account.findUnique.mockResolvedValue(null);
    await expect(
      build('Session').upsert('old', { accountId: 'a', loginTs: newTime } as AdapterPayload, 60),
    ).rejects.toThrow();
    await expect(
      build('Interaction').upsert('pending', {} as AdapterPayload, 60),
    ).resolves.toBeUndefined();
  });
  it.each(['result', 'lastSubmission'])(
    'completed interaction %s preserves original authentication, including legacy results without ts',
    async (field) => {
      for (const ts of [undefined, oldTime]) {
        prisma.oidcPayload.findUnique.mockResolvedValue(
          row({ [field]: { login: { accountId: 'a', ts, remember: false } } }),
        );
        expect(await build('Interaction').find('pending-resume')).toBeUndefined();
      }
      const payload = { [field]: { login: { accountId: 'a', ts: newTime, remember: false } } };
      prisma.oidcPayload.findUnique.mockResolvedValue(row(payload));
      expect(await build('Interaction').find('fresh')).toEqual(payload);
    },
  );
  it('missing login provenance is rejected before the first password change too', async () => {
    prisma.account.findUnique.mockResolvedValue({ isActive: true, credentialsChangedAt: null });
    prisma.oidcPayload.findUnique.mockResolvedValue(row({ result: { login: { accountId: 'a' } } }));
    expect(await build('Interaction').find('legacy')).toBeUndefined();
  });
});
