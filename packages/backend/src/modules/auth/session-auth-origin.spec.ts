import type { Request } from 'express';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setLocalAuthOrigin } from './session-auth-origin';

/**
 * セッションの認証の出自（d1022）。書き手を 1 か所に置き、判定（enforcement-gate）と食い違わないことを固定する。
 */
describe('session-auth-origin', () => {
  const makeReq = () => ({ session: {} }) as unknown as Request;

  it('ログイン経路は出自を local と書き、旧欄も併記する（互換・d955）', () => {
    const req = makeReq();
    setLocalAuthOrigin(req);
    expect(req.session.authOrigin).toBe('local');
    expect(req.session.authMethod).toBe('local');
  });

  it('authOrigin を書くのはこの関数だけ（backend の src を走査）', () => {
    const root = resolve(__dirname, '../../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p);
      }
    };
    walk(root);
    const writes = files
      .filter((f) => /session\.authOrigin\s*=/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(/^.*modules[\\/]/, 'modules/').replace(/\\/g, '/'));
    expect(writes).toEqual(['modules/auth/session-auth-origin.ts']);
  });
});
