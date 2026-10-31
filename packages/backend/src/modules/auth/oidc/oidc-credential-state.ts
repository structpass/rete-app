import type { AdapterPayload } from 'oidc-provider';
import type { PrismaService } from '../../../database/prisma.service';

/** Preserve the original authentication instant: never restamp a stale provider model on save. */
export async function isCurrentOidcCredentialState(
  prisma: PrismaService,
  model: string,
  payload: AdapterPayload,
): Promise<boolean> {
  // Completed interactions store login under result (or lastSubmission), not accountId.
  // Legacy results omit ts; never let provider resume replace that absence with "now".
  if (model === 'Interaction') {
    for (const result of [payload.result, payload.lastSubmission]) {
      const login = (result as { login?: { accountId?: unknown; ts?: unknown } } | undefined)
        ?.login;
      if (
        login &&
        (typeof login.accountId !== 'string' ||
          typeof login.ts !== 'number' ||
          !Number.isFinite(login.ts))
      )
        return false;
      if (
        login &&
        !(await isCurrentOidcCredentialState(prisma, 'Session', {
          accountId: login.accountId,
          loginTs: login.ts,
        } as AdapterPayload))
      )
        return false;
    }
  }
  const accountId = payload.accountId;
  if (typeof accountId !== 'string') return true; // unauthenticated interactions / client-only state
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { isActive: true, credentialsChangedAt: true },
  });
  if (!account?.isActive) return false;
  if (!account.credentialsChangedAt) return true;
  const cutoff = account.credentialsChangedAt.getTime();
  if (model === 'AccessToken') {
    if (typeof payload.sessionUid !== 'string') return false;
    const session = await prisma.oidcPayload.findFirst({
      where: { type: 'Session', uid: payload.sessionUid },
    });
    if (!session || (session.expiresAt && session.expiresAt.getTime() <= Date.now())) return false;
    const original = session.payload as unknown as AdapterPayload;
    return original.accountId === accountId && isAfter(original.loginTs, cutoff);
  }
  const authenticatedAt = model === 'Session' ? payload.loginTs : payload.authTime;
  // Grants carry their immutable creation time rather than authTime. A fresh grant is not
  // authentication authority: the Session and every resulting code are independently checked.
  return isAfter(model === 'Grant' ? payload.iat : authenticatedAt, cutoff);
}

function isAfter(seconds: unknown, cutoff: number): boolean {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds * 1000 > cutoff;
}
