/**
 * playwright globalSetup — 認証セッションの事前生成（mtime キャッシュ）
 *
 * - セッションファイルが 1 時間以内に作成されていればスキップ（再ログインしない）
 * - セッション TTL は backend で 24 時間に設定されているため 1 時間は安全圏
 * - これにより連続実行してもスロットル（5req/60s）を超過しない
 *   （cmn-0395: 開発機は E2E_THROTTLE_BYPASS=true で素通しにできる＝e2e/README.md §前提。
 *   このキャッシュ構造は素通しを入れていない機械でも落ちないために残す）
 *
 * dsk-0413: 冒頭で admin を使い、e2e 一意名組織（プロセス中断で残った stash）を
 * archived=true にスイープしてから通常セッション生成へ入る。
 */

import { request } from '@playwright/test';
import path from 'path';
import fs from 'fs/promises';
import { BASE_URL, CREDENTIALS } from './auth';
import { isE2ENamedOrg } from './sweep-e2e-orgs';

const SESSION_DIR = path.join(__dirname, '..', '.cache', 'sessions');

/** セッションファイルの有効期間（ミリ秒）— backend の maxAge(24h) より短く設定 */
const SESSION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// cmn-0161: 認証情報は support/auth.ts の CREDENTIALS を単一ソースとし派生する（リテラル重複を排除）。
// mfaUser/tanaka はここでは事前生成しない（既存4件のまま）。cmn-0395: 旧コメント「連続ログイン6件化は
// ログイン throttle 5req/60s に対しキャッシュ冷え時 429 を招くため」の懸念は、E2E_THROTTLE_BYPASS=true
// の開発機では解消されるが、素通しを入れていない機械でも落ちないよう 4 件のまま維持する。
const USERS = [
  CREDENTIALS.admin,
  CREDENTIALS.member,
  CREDENTIALS.whUser,
  CREDENTIALS.newcomer,
] as const;

async function isSessionFileFresh(sFile: string): Promise<boolean> {
  try {
    const stat = await fs.stat(sFile);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < SESSION_CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * dsk-0413: 管理者セッションで残った e2e 一意名組織を archived=true 化する。
 * グローバルセットアップの冒頭で実行し、UI に散在する stash を後続スイープなしで除去する。
 * admin エンドポイント（system ADMIN 専用・membership 非依存）で操作するため、
 * 組織 ADMIN membership を持たない stash でも archive 可能。
 */
async function sweepE2EOrgs(adminCookie: string): Promise<void> {
  const listRes = await fetch(`${BASE_URL}/api/v1/organizations/admin?includeArchived=true`, {
    headers: { Cookie: `connect.sid=${adminCookie}` },
  });
  if (!listRes.ok) {
    console.warn(`[globalSetup] e2e org sweep: list failed ${listRes.status}`);
    return;
  }
  const listJson = (await listRes.json()) as {
    data?: Array<{ id: string; name: string; archived?: boolean }>;
  };
  const orgs = listJson.data ?? [];
  const targets = orgs.filter((o) => !o.archived && isE2ENamedOrg(o.name));
  if (targets.length === 0) {
    console.log('[globalSetup] e2e org sweep: 0 targets');
    return;
  }
  for (const o of targets) {
    const res = await fetch(`${BASE_URL}/api/v1/organizations/admin/${o.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `connect.sid=${adminCookie}`,
      },
      body: JSON.stringify({ archived: true }),
    });
    if (res.ok) {
      console.log(`[globalSetup] swept e2e org: ${o.name} (${o.id})`);
    } else {
      console.warn(`[globalSetup] sweep failed for ${o.name}: ${res.status}`);
    }
  }
  console.log(`[globalSetup] e2e org sweep: ${targets.length} archived`);
}

export default async function globalSetup() {
  await fs.mkdir(SESSION_DIR, { recursive: true });

  // dsk-0413: 残った e2e 一意名組織を、admin のセッションで archived=true にする。
  // d969: 掃除は admin をログインし直さなくても毎回行う。以前は「セッションが有効なら掃除もしない」
  // 形で、1 時間以内の再実行では残骸が掃かれなかった（積み上がりの原因の 1 つ）。
  const adminSFile = path.join(SESSION_DIR, `${CREDENTIALS.admin.key}.json`);
  const adminFresh = await isSessionFileFresh(adminSFile);
  if (adminFresh) {
    const state = JSON.parse(await fs.readFile(adminSFile, 'utf-8')) as {
      cookies?: Array<{ name: string; value: string }>;
    };
    const sid = state.cookies?.find((c) => c.name === 'connect.sid')?.value;
    if (sid) await sweepE2EOrgs(sid);
  } else {
    const adminCtx = await request.newContext({ baseURL: BASE_URL });
    try {
      const res = await adminCtx.post('/api/v1/auth/login', {
        data: {
          email: CREDENTIALS.admin.email,
          password: CREDENTIALS.admin.password,
        },
      });
      if (!res.ok()) {
        const body = await res.text();
        throw new Error(`admin login for sweep failed: ${res.status()} ${body}`);
      }
      const cookieHeader = res.headers()['set-cookie'];
      const m = cookieHeader?.match(/connect\.sid=([^;]+)/);
      const adminCookie = m ? m[1] : '';
      if (!adminCookie) {
        console.warn('[globalSetup] admin cookie extraction failed; sweep skipped');
      } else {
        await sweepE2EOrgs(adminCookie);
      }
    } finally {
      await adminCtx.dispose();
    }
  }

  for (const user of USERS) {
    const sFile = path.join(SESSION_DIR, `${user.key}.json`);

    // 1 時間以内に作成したセッションがあればスキップ（throttle 対策）
    if (await isSessionFileFresh(sFile)) {
      console.log(`[globalSetup] session reused (< 1h): ${user.key}`);
      continue;
    }

    const ctx = await request.newContext({ baseURL: BASE_URL });
    try {
      const res = await ctx.post('/api/v1/auth/login', {
        data: { email: user.email, password: user.password },
      });
      if (!res.ok()) {
        const body = await res.text();
        throw new Error(`Login failed for ${user.email}: ${res.status()} ${body}`);
      }
      const storageState = await ctx.storageState();
      await fs.writeFile(sFile, JSON.stringify(storageState, null, 2), 'utf-8');
      console.log(`[globalSetup] session saved: ${user.key} (${user.email})`);
    } finally {
      await ctx.dispose();
    }
  }
}
