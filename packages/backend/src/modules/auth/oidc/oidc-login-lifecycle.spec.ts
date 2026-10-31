import { createHmac } from 'node:crypto';
import { AuthService, type AuthenticatedUser } from '../auth.service';
import type { AccountRepository } from '../repositories/account.repository';
import type { LoginSettingsService } from '../../login-settings/login-settings.service';

describe('OIDC first-factor continuity', () => {
  const current = {
    passwordHash: 'synthetic-hash',
    isActive: true,
    credentialsChangedAt: null as Date | null,
  };
  const version = () =>
    createHmac('sha256', process.env.SESSION_SECRET || 'dev-insecure-session-secret-change-me')
      .update(current.passwordHash)
      .digest('base64url');
  const repo = { findOidcCredentialState: jest.fn() };
  const service = new AuthService(
    repo as unknown as AccountRepository,
    {} as LoginSettingsService,
    { maxAttempts: 5, lockoutMs: 1000 },
  );
  const user = () => ({ id: 'a', sessionCredentialVersion: version() }) as AuthenticatedUser;
  beforeEach(() => {
    current.credentialsChangedAt = null;
    repo.findOidcCredentialState.mockImplementation(async () => current);
  });
  it('accepts unchanged credentials and rejects stale pending first-factor versions', async () => {
    await expect(service.assertCurrentOidcLogin(user(), 10)).resolves.toBeUndefined();
    await expect(
      service.assertCurrentOidcLogin({ ...user(), sessionCredentialVersion: 'old-version' }, 10),
    ).rejects.toThrow('ログインし直して');
    await expect(
      service.assertCurrentOidcLogin({ ...user(), sessionCredentialVersion: undefined }, 10),
    ).rejects.toThrow();
  });
  it('does not relabel authentication started before or within the password-change second', async () => {
    current.credentialsChangedAt = new Date(10_500);
    for (const ts of [9, 10, NaN])
      await expect(service.assertCurrentOidcLogin(user(), ts)).rejects.toThrow();
    await expect(service.assertCurrentOidcLogin(user(), 11)).resolves.toBeUndefined();
  });
});
