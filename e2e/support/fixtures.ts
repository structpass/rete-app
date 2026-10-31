/**
 * playwright-bdd のカスタム fixture。
 *
 * playwright-bdd v8 では `test` を "playwright-bdd" から import して extend する。
 * `world` fixture がシナリオ内の Given/When/Then 間で状態を共有する。
 * テスト終了後 world.apiCtx.dispose() が自動実行される（リソースリーク防止）。
 */

import { test as base } from 'playwright-bdd';
import { createBdd } from 'playwright-bdd';
import {
  request,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  alternateFrontendUrl,
  BASE_URL,
  createAuthenticatedContext,
  CREDENTIALS,
  frontendCookies,
  FRONTEND_URL,
} from './auth';
import {
  deferredTeardownValues,
  pendingTeardownSteps,
  type DeferredStep,
} from './deferred-teardown';
import { resolvePlaceholders } from './placeholders';
import { beginScenario, endScenario, resetVerifiedCases, verifiedCasesFor } from './verified-cases';

/** teardown 方法（DELETE が実在するか、無い場合は PATCH archive） */
export type TeardownMethod = 'DELETE' | 'PATCH';

export type CreatedResource = {
  method: TeardownMethod;
  /** id を含む full path（例: /api/v1/roles/<id>） */
  path: string;
};

/**
 * 手順の途中で環境の共通設定を書き換えた時に、後始末で流し直す手順（support/deferred-teardown.ts 参照）。
 * path・body は変数を解決する前の形で持つ。
 */
export type { DeferredStep };

export type World = {
  /** ログイン済み APIRequestContext（セッションクッキーを保持） */
  apiCtx: APIRequestContext | null;
  /** 最後の HTTP レスポンス（Then ステップで検証する） */
  lastResponse: APIResponse | null;
  /** 直前の GET で叩いた先の URL に入っていた id（応答に写っていないことの照合へ渡す・d859） */
  tappedIds?: string[];
  /** シナリオ内で名前付き保存した補助セッション */
  sessions: Record<string, APIRequestContext>;
  /**
   * 保存セッションの持ち主（メールアドレス）。S-OPS-04 の手順は「本人を管理者がリセットする」ため、
   * 管理操作の対象を email から引く。
   */
  sessionOwners: Record<string, string>;
  /** fixture teardown で破棄する補助 context */
  auxiliaryContexts: APIRequestContext[];
  /** シナリオ終了時に isActive=true へ必ず復元する seed account id */
  restoreAccountIds: string[];
  /** シナリオ終了時にログイン試行ロック（lockedUntil）を解除する seed account id */
  unlockAccountIds: string[];
  /**
   * シナリオ終了時に「パスワードの復元」を要するアカウント（S-AUTH-12）。
   *
   * パスワード変更は自己変更の口（`POST /auth/change-password`）しか無いため、確かめるには seed の資格情報を
   * 一時的に変えるしかない。途中で落ちると初期パスワードが元に戻らず、以後のシナリオの前提が崩れる。
   * そこで、変更の前にここへ「元のパスワード」を登録する（最初に登録された値だけを元の値として使う）。
   * 後始末は**元の値で自己変更し直す**。DB を直接書いて戻すと、ハッシュが変わったまま古いセッションが
   * 失効する（セッションはパスワードのハッシュに紐づく・`sessionCredentialVersion`）ため、口を使う。
   */
  passwordResetRows: {
    email: string;
    password: string;
    changedPassword?: string;
    settled: boolean;
  }[];
  /** ロック解除の後始末（メールで登録・シナリオが落ちても流し直す） */
  unlockRows: { email: string; settled: boolean }[];
  /** このシナリオで使い切ったバックアップコード（2 本目以降は未使用のものを選ぶ） */
  consumedBackupCodes: string[];
  /** 現在ログイン中ユーザーの id（P5-04 自己降格防止テスト用） */
  currentUserId: string | null;
  /** シナリオ内で作成し teardown で後始末するリソース（LIFO で処理） */
  createdIds: CreatedResource[];
  /** 途中で作り変えた共通設定の戻し手順（シナリオが落ちても fixtures の後始末で流し直す） */
  deferredSteps: DeferredStep[];
  /** このシナリオが全ユーザー共通のファイル設定を触りうるか（後始末で既定へ戻す目印） */
  touchesFileSettings: boolean;
  /** 一意名生成ヘルパ（path / body の {{key}} プレースホルダ置換用） */
  uniqueNames: Record<string, string>;
  /** このシナリオで通ったユースケース（スコープトラックの「保留」「確認済みにしない」が読む） */
  verifiedCases: string[];
  /** このシナリオで保留にしたユースケース（期待が未確定で、状態を動かさなかったもの） */
  heldCases: string[];
  /** 画面の点検で開いた画面の実測（画面を開かないシナリオでは空） */
  screen: VisitedScreen[];
  /** 画面の点検で起きた失敗（止まった通信・画面の実行時エラー） */
  screenFaults: { networkFailures: string[]; pageErrors: string[] };
};

/**
 * 画面を開く fixture（画面の点検）。
 *
 * 画面は Cookie のドメインでしか入場しないため、同じ backend へ向けたセッションを画面の置き場へ
 * 向け直して持ち込む。画面の描画に要る通信の失敗（止まった通信・画面の実行時エラー）は控えへ残し、
 * シナリオ側が「どの画面でも 1 件も起きていないこと」を確かめられるようにする。
 */
export type Screen = {
  browser: Browser;
  /** 開いた画面（後片付けで閉じる） */
  pages: Page[];
  /** 画面ごとに作ったブラウザの文脈（後片付けで閉じる） */
  contexts: BrowserContext[];
  /** 開けた画面の置き場（最初に開いた画面で決まる。cookie の向け直し先） */
  base?: string;
  /**
   * 画面がログインに使っている人と、そのセッションの Cookie（backend の置き場向け）。
   *
   * 画面から操作した時の後始末や、画面と同じ人の立場で確かめる時に使う。画面へ持ち込んだ Cookie は
   * 画面の置き場向けに向け直した写しで、そこから引き直すと空になる（結び付いた置き場が違う）ため、
   * 元の値をここに残す。
   */
  session?: {
    account: { email: string; password: string };
    cookies: { name: string; value: string; path: string }[];
  };
  /** 画面の操作で見つけた 2 つ目の対象（移動の移し先など、後始末で消すもの）。 */
  made2?: string;
};

/** 画面の描画中に起きた失敗（止まった通信 URL と画面の実行時エラー）。 */
export type ScreenFaults = { networkFailures: string[]; pageErrors: string[] };

/**
 * 1 枚開いた画面の実測。
 *
 * `textLength`・`broken`・`login`・`crashed` は**その画面を開いた時点**の値。画面の点検は 1 つの
 * ページで 5 枚を順に開くため、判定の時に読むと最後の 1 枚しか見えない（実測 2026-10-26: 2 枚目を
 * 壊しても緑のまま通った・d785 の独立の指摘）。開いた瞬間の値を控えて、判定は 5 組すべてを見る。
 */
export type VisitedScreen = {
  route: string;
  elapsedMs: number;
  textLength: number;
  /** 壊れた画面の表示（data-screen-broken）が出ていたか */
  broken: boolean;
  /** ログイン画面へ押し戻されていたか（パスワード欄・「Rete Login」の見出しで見分ける） */
  login: boolean;
  /** 例外の枠（Application error 等）が出ていたか */
  crashed: boolean;
};

/** ログイン状態で画面を開くページを 1 つ用意する（呼び出し側は screen.pages へ入れる）。 */
export async function openSignedInPage(
  screen: Screen,
  faults: ScreenFaults,
  account: { email: string; password: string } = CREDENTIALS.admin,
  base: string = FRONTEND_URL,
): Promise<{ page: Page }> {
  const session = await createAuthenticatedContext(account.email, account.password);
  const saved = (await session.storageState()) as {
    cookies: { name: string; value: string; path: string }[];
  };
  await session.dispose();
  const ctx = await screen.browser.newContext();
  await ctx.addCookies(frontendCookies(saved.cookies, base));
  const page = await ctx.newPage();
  screen.contexts.push(ctx);
  screen.pages.push(page);
  screen.session = { account, cookies: saved.cookies };
  page.on('requestfailed', (req) => {
    const url = req.url();
    // 画面は backend を別名（127.0.0.1）で呼ぶ。画面側（3010）の失敗だけを控える＝backend の
    // 呼び出しは API のシナリオが受け持つ（ここで数えると画面の破損ではない赤が混ざる）。
    if (!url.includes(':3010')) return;
    faults.networkFailures.push(`${req.method()} ${url.split('?')[0]}`);
  });
  page.on('pageerror', (err) => {
    faults.pageErrors.push(String(err?.message ?? err));
  });
  // 例外の枠（画面の実行時エラーを包んで出す表示）は、画面の中身として描かれる。文字だけを見ると
  // 見落とすので、枠そのものの印も控える。
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (!/Unhandled Runtime Error|Application error|Hydration failed/i.test(text)) return;
    faults.pageErrors.push(text.split('\n')[0]);
  });
  return { page };
}

/**
 * 画面の置き場へ向けたセッションで、既定の置き場を試した後に開く（画面の点検の入口）。
 *
 * 置き場の候補は「既定の置き場（localhost）→ もう一方のローカル名（127.0.0.1）」。cookie は置き場ごとに
 * 違うため、開けた置き場へ cookie を向け直して同じ画面をもう一度開く。どこも開けなければ、開けなかった
 * 理由を添えて落とす（置き場が無い時に「白い画面」と読ませない）。
 */
export async function openReachableScreen(
  screen: Screen,
  faults: ScreenFaults,
  route: string,
  account: { email: string; password: string } = CREDENTIALS.admin,
): Promise<{ page: Page; base: string }> {
  const candidates = [
    screen.base ?? FRONTEND_URL,
    alternateFrontendUrl(screen.base ?? FRONTEND_URL),
  ].filter(Boolean) as string[];
  const reasons: string[] = [];
  for (const base of candidates) {
    const probeCtx = await screen.browser.newContext();
    const probe = await probeCtx.newPage();
    try {
      const res = await probe.goto(`${base}${route}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      if ((res?.status() ?? 500) < 500) {
        screen.base = base;
        const opened = await openSignedInPage(screen, faults, account, base);
        return { page: opened.page, base };
      }
      reasons.push(`${base}: HTTP ${res?.status()}`);
    } catch (e) {
      reasons.push(`${base}: ${String(e).split('\n')[0]}`);
    } finally {
      await probeCtx.close().catch(() => undefined);
    }
  }
  throw new Error(`画面の置き場を開けない（${reasons.join(' / ')}）`);
}

/**
 * 一時的に変えたパスワードを元へ戻す（S-AUTH-12 の後始末）。
 *
 * 戻しは本人の自己変更の口を使う。今のパスワードで入り直さなくても自己変更は要らないように見えるが、
 * 変更の口は認証済みの接続を前提とするため、入り直してから叩く。入り直せない時は false を返し、
 * 呼び出し側が「戻せなかった」と明示して止まる（黙って seed の資格情報を変えたままにしない）。
 */
async function restorePassword(
  email: string,
  currentPassword: string,
  originalPassword: string,
): Promise<boolean> {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  try {
    const login = await ctx.post('/api/v1/auth/login', {
      data: { email, password: currentPassword },
    });
    if (!login.ok()) return false;
    const res = await ctx.post('/api/v1/auth/change-password', {
      data: { currentPassword, newPassword: originalPassword },
    });
    return res.status() < 400;
  } finally {
    await ctx.dispose();
  }
}

/** メールから account id を引く（後始末で解除を流す時に使う）。 */
async function memberIdByEmail(
  ctx: Awaited<ReturnType<typeof createAuthenticatedContext>>,
  email: string,
): Promise<string> {
  const res = await ctx.get('/api/v1/members');
  const body = (await res.json()) as { data?: Array<{ id: string; email: string }> };
  const hit = body.data?.find((m) => m.email === email);
  if (!hit) throw new Error(`seed に存在しないメール: ${email}`);
  return hit.id;
}

export const test = base.extend<{ world: World; screen: Screen; screenFaults: ScreenFaults }>({
  // 画面の点検で起きた失敗（止まった通信・画面の実行時エラー）。画面を開かないシナリオでは空。
  screenFaults: async ({}, use) => {
    await use({ networkFailures: [], pageErrors: [] });
  },
  // 画面を開く fixture。使うシナリオだけブラウザを起動し、後片付けで必ず閉じる
  // （API だけのシナリオは今までどおりブラウザ無しで走る）。
  screen: async ({ browser }, use) => {
    const pages: Page[] = [];
    const contexts: BrowserContext[] = [];
    await use({ browser, pages, contexts });
    for (const page of pages) await page.close().catch(() => undefined);
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
  },
  world: async ({ screenFaults }, use) => {
    // 「実測して挙動が決まった」ことの控えはシナリオごとに空から始める（前のシナリオを持ち越さない）。
    resetVerifiedCases();
    // 控えは「その控えを要求したシナリオの最後が緑だった時だけ」残す（support/verified-cases.ts）。
    // 判定に使う番号・結果は beginScenario / endScenario が同じ worker 内で持ち回る。
    const scenarioId = beginScenario();
    const w: World = {
      apiCtx: null,
      lastResponse: null,
      tappedIds: [],
      sessions: {},
      sessionOwners: {},
      auxiliaryContexts: [],
      restoreAccountIds: [],
      unlockAccountIds: [],
      unlockRows: [],
      passwordResetRows: [],
      consumedBackupCodes: [],
      currentUserId: null,
      createdIds: [],
      deferredSteps: [],
      touchesFileSettings: false,
      uniqueNames: {},
      // 後始末（このシナリオの最後）で作り直す。控えの実体は verified-cases.ts が持つ。
      verifiedCases: [],
      heldCases: [],
      screen: [],
      screenFaults: { networkFailures: [], pageErrors: [] },
    };
    await use(w);
    const needsAdminCleanup =
      w.createdIds.length > 0 ||
      w.restoreAccountIds.length > 0 ||
      w.unlockAccountIds.length > 0 ||
      w.passwordResetRows.length > 0;
    // 後始末は「その時に有効なセッション」を使う。このシナリオが全員への MFA 強制を掛けたまま落ちた場合、
    // 前回保存したセッションは強制後に作られたもの（パスワード段で止まった状態）として残っていて、
    // それを使うと後始末まで 403 になり、設定を戻せずに次のシナリオへ流れる（＝出口が閉じたまま）。
    // そこで、あらかじめ捨てた接続でログインし直し、本物のパスワードで入ったセッションで後始末する。
    const freshAdminCtx =
      needsAdminCleanup ||
      w.touchesFileSettings ||
      w.deferredSteps.length > 0 ||
      w.unlockRows.length > 0 ||
      w.passwordResetRows.length > 0
        ? await createAuthenticatedContext(CREDENTIALS.admin.email, CREDENTIALS.admin.password)
        : null;
    const cleanupCtx = needsAdminCleanup ? freshAdminCtx : null;
    // 画面の点検の失敗を、シナリオの後始末が終わる前に読めるようにする。
    w.screenFaults.networkFailures = screenFaults.networkFailures;
    w.screenFaults.pageErrors = screenFaults.pageErrors;
    // 設定の戻し用の接続は try の外でも参照する（finally でまとめて破棄するため）。
    let backCtx: Awaited<ReturnType<typeof createAuthenticatedContext>> | null = null;

    try {
      // 途中で作り変えた共通設定（ファイル設定など）を先に戻す。シナリオが途中で落ちても、
      // 設定が戻らず後続のシナリオや手元の操作を壊すのを防ぐ。
      //
      // 戻しは「登録された手順」に依存させない。手順を登録する前の画面操作で落ちた場合
      // （ブラウザ操作・Given の途中など）は手順が残らず、そのままだと設定が作り変えられたまま
      // 次のシナリオへ流れる。そこで、このシナリオがファイル設定を触りうるなら、値に関係なく
      // 既定（許可一覧は空＝全許可）へ戻す。既定へ戻す操作は何度行っても同じ結果になる。
      // そのうえで、後始末に登録された未実行の手順も流す（既定以外の状態へ戻す手順が
      // あればそちらが最後に効く）。
      const needBack = w.touchesFileSettings || w.deferredSteps.some((s) => !s.settled);
      if (needBack) backCtx = freshAdminCtx;
      if (backCtx) {
        // MFA を強制したシナリオの後片付けは、何より先に「強制を外す」を流す。強制が残っていると他の
        // 管理者操作（ファイル設定の復帰）が 403 で止まり、戻しがそこで途切れて出口が閉じたままになる。
        // 戻し手順（deferredSteps）にパスワードポリシーの PUT が登録されていれば、それをここで先に流す。
        const policyRestores = pendingTeardownSteps(w.deferredSteps).filter(
          (s) => s.path === '/api/v1/settings/login/password-policy',
        );
        for (const step of deferredTeardownValues(
          policyRestores,
          w.uniqueNames,
          resolvePlaceholders,
        )) {
          const res = await backCtx.put(step.path, { data: JSON.parse(step.body) as unknown });
          if (res.status() >= 400) {
            throw new Error(`[teardown] MFA 強制の解除に失敗: ${res.status()}`);
          }
        }
        // 流し終えた行に印を付ける（下の未実行手順のループで二度流さない）。行の識別は登録時の値で行う。
        for (const step of policyRestores) step.settled = true;
        // 強制を外す操作は「登録された行」とは別に、状態そのものを既定へ戻す。行の登録より前（Given の
        // ような手順）で強制を掛けたシナリオでは行が残らないため、行に頼らず必ず 1 回戻す。
        await backCtx
          .put('/api/v1/settings/login/password-policy', {
            data: {
              requireLowercase: true,
              requireUppercase: true,
              requireNumber: true,
              requireSymbol: true,
              minLength: 12,
              mfaEnforced: false,
            },
          })
          .catch(() => undefined);
        if (w.touchesFileSettings) {
          const res = await backCtx.patch('/api/v1/files/settings', {
            data: { allowedExtensions: [] },
          });
          if (res.status() >= 400) {
            throw new Error(`[teardown] ファイル設定の既定への復帰に失敗: ${res.status()}`);
          }
        }
        for (const step of deferredTeardownValues(
          w.deferredSteps,
          w.uniqueNames,
          resolvePlaceholders,
        )) {
          const res = await backCtx.patch(step.path, { data: JSON.parse(step.body) as unknown });
          if (res.status() >= 400) {
            throw new Error(`[teardown] 設定の戻しに失敗: ${step.path} → ${res.status()}`);
          }
        }
      }

      // P4-01: 本体が途中失敗しても seed アカウントを必ず復元する。
      for (const accountId of new Set(w.restoreAccountIds)) {
        if (!cleanupCtx) break;
        const res = await cleanupCtx.patch(`/api/v1/members/${accountId}`, {
          data: { isActive: true },
        });
        if (res.status() !== 200) {
          throw new Error(`[teardown] PATCH /api/v1/members/${accountId} failed: ${res.status()}`);
        }
      }

      // メールで登録された解除（行として流し直すもの）。途中で落ちても解除する。
      for (const row of w.unlockRows) {
        if (row.settled || !backCtx) continue;
        const res = await backCtx.patch(
          `/api/v1/members/${await memberIdByEmail(backCtx, row.email)}/unlock`,
        );
        if (res.status() !== 200) {
          throw new Error(`[teardown] unlock ${row.email} failed: ${res.status()}`);
        }
      }

      // パスワード変更（S-AUTH-12）の戻し。新しいパスワードへ変えたシナリオが途中で落ちても、
      // 元のパスワードへ戻してから次のシナリオへ渡す（戻さないと以後のログインが全部 401 になる）。
      // 戻しは本人の自己変更の口で行う（元のパスワードで入り直し、今のパスワードを添えて戻す）。
      // 戻しは 1 回だけ流す（今のパスワードは「一時的な新しいもの」を持っている。行に控えておく）。
      for (const row of w.passwordResetRows) {
        if (row.settled || !row.changedPassword) continue;
        if (!(await restorePassword(row.email, row.changedPassword, row.password))) {
          throw new Error(
            `[teardown] パスワードの戻しに失敗: ${row.email}（一時的なパスワードで入れなかった）`,
          );
        }
      }

      // ログイン試行ロックの解除。ロックはシナリオが途中で落ちてもアカウントに残り、同じ seed ユーザーを
      // 使う後続のシナリオを 429 で赤にする（throttle の素通しはロックには効かない）。
      // 解除済みなら何も起きない（失敗回数 0・ロック無しの解除は冪等）。
      for (const accountId of new Set(w.unlockAccountIds)) {
        if (!cleanupCtx) break;
        const res = await cleanupCtx.patch(`/api/v1/members/${accountId}/unlock`);
        if (res.status() !== 200) {
          throw new Error(
            `[teardown] PATCH /api/v1/members/${accountId}/unlock failed: ${res.status()}`,
          );
        }
      }

      // 作成リソースを admin context で LIFO 後始末し、失敗を握りつぶさない。
      for (const r of [...w.createdIds].reverse()) {
        if (!cleanupCtx) break;
        const res =
          r.method === 'DELETE'
            ? await cleanupCtx.delete(r.path)
            : await cleanupCtx.patch(r.path, { data: { archived: true } });
        if (res.status() >= 400) {
          throw new Error(`[teardown] ${r.method} ${r.path} failed: ${res.status()}`);
        }
      }
    } finally {
      const contexts = new Set([
        ...w.auxiliaryContexts,
        ...(w.apiCtx ? [w.apiCtx] : []),
        ...(cleanupCtx ? [cleanupCtx] : []),
        ...(backCtx ? [backCtx] : []),
      ]);
      await Promise.all([...contexts].map((ctx) => ctx.dispose()));
    }
    // このシナリオの最後: 控えを「これまでに落ちていないか」で作り直してから、結果を番号へ渡す。
    // 後で落ちたシナリオの後始末が、その番号を見て控えを外す（verified-cases.ts）。
    w.verifiedCases.splice(0, w.verifiedCases.length, ...verifiedCasesFor());
    endScenario(scenarioId, 'passed');
  },
});

export const { Given, When, Then, After } = createBdd(test);
