/**
 * ファイル画面で「利用者が行った操作」の結果を、画面の実物で確かめる手順 — d821。
 *
 * うまくいった時の確認は API のシナリオ（files.feature）が受け持つ。ここが見るのは、通信の応答だけでは
 * 判定できない 2 点。
 *
 * - S-FILE-14: 拒否拡張子は、サーバーが理由を返して終わる。その理由が画面の通知として残るかを見る
 *   （応答が 400 でも、画面に何も出なければ利用者には「選んだのに何も起きない」に見える）。
 * - S-FILE-04-開発エージェント: 一覧の行をツリーのフォルダへ落として移した後に、画面の現在地（パンくず）が移す前の
 *   フォルダのままか、移し元の一覧から行が消えているか、移し先の一覧に行があるかを見る（d862）。
 *
 * 画面を開くのは管理者（アップロード設定を絞るのは管理者の口）。作ったものは最後の手順で明示的に消す。
 * 世界（world）の後始末へは積まない（同じ id を二度消して 404 で落ちるのを避ける）。
 */

import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { After, Given, Then, When } from '../support/fixtures';
import { openReachableScreen } from '../support/fixtures';
import { BASE_URL, CREDENTIALS, FRONTEND_URL } from '../support/auth';

/** 画面で作ったフォルダ（手順をまたいで読む）。 */
const made: { folderId: string; folderName: string } = { folderId: '', folderName: '' };

/** 画面から出た通知（react-hot-toast の置き場。class 名は変わらない保証が無いので role で拾う）。 */
const toasts: string[] = [];

/** 画面が送った書き込みの応答（通知が出なかった時に、どこまで届いたかを読み取る）。 */
const lastWrite: { method: string; path: string; status: number }[] = [];

/** 一意な名前（作成日時と乱数。並行した試験とぶつからない）。 */
function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 4)}`;
}

/**
 * シナリオが途中で落ちても、この回が作ったフォルダを消す。
 *
 * 後始末は最後の手順（`画面を読み込み直して、画面から片付けができる`）に置いてあるが、そこまで届くのは
 * シナリオが最後まで進んだ時だけ。途中で落ちると手順が飛び、作ったフォルダとファイルが開発DBに残る
 * （実測 2026-10-27・d825: 赤のまま走らせ続けて 546 件が残った）。落ちた時こそ片付けるべきなので、
 * 後始末の手順とは別に、シナリオの後ろで必ず流れるここで消す。名前で消すので、消し済みでも何度でもよい。
 */
After(async ({ screen }) => {
  if (!made.folderName) return;
  const cookies = screen.session?.cookies;
  if (!cookies?.length) return;
  for (const folderId of [made.folderId, screen.made2]) {
    if (!folderId) continue;
    const content = await screenApi(cookies, `/api/v1/files/folders/${folderId}`).catch(() => null);
    if (content) {
      const parsed = JSON.parse(content.body) as { data?: { items?: { id: string }[] } };
      for (const item of parsed.data?.items ?? []) {
        await screenApi(cookies, `/api/v1/files/files/${item.id}`, {
          method: 'DELETE',
        }).catch(() => undefined);
      }
    }
    await screenApi(cookies, `/api/v1/files/folders/${folderId}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
  made.folderId = '';
  screen.made2 = undefined;
});

/**
 * 画面と同じ人・同じセッションで API を叩く。
 *
 * シナリオの API 接続（world.apiCtx）は backend を指す別の接続で、画面とは別のログインになる。
 * 画面と同じ人で確かめるため、画面へ持ち込んだ元の Cookie（support/fixtures.ts が残す）を使う。
 */
async function screenApi(
  cookies: { name: string; value: string }[] | undefined,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  if (!cookies?.length) throw new Error('画面のセッションの Cookie が無い');
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.text() };
}

/** 画面が直近に送ったアップロードの応答（成功したかどうか）。 */
function lastUploadStatus(): number | undefined {
  return lastWrite.filter((w) => /\/files\/folders\/[^/]+\/files$/.test(w.path)).at(-1)?.status;
}

/** 画面が直近に送った移動の応答（成功したかどうか）。 */
function lastMoveStatus(): number | undefined {
  return lastWrite.filter((w) => /\/files\/(files|folders)\/[^/]+\/move$/.test(w.path)).at(-1)
    ?.status;
}

Given(
  'ファイル画面の点検に使う管理者でログインし直し、ファイル画面を開く',
  async ({ screen, screenFaults }) => {
    toasts.length = 0;
    lastWrite.length = 0;
    made.folderId = '';
    screen.made2 = undefined;
    // 画面の置き場を開けること自体を先に確かめる（落ちている時に「全部赤」となる前に切り分けられるように）。
    // アップロード設定を絞る操作は管理者の口なので、画面の点検と同じく管理者でログインし直して開く。
    // 試験は画面を `localhost` で開く前提（support/auth.ts の FRONTEND_URL・セッションは backend の
    // 名 `127.0.0.1` で作った Cookie を `localhost` の画面へ向け直して持ち込む）。
    const opened = await openReachableScreen(screen, screenFaults, '/files', CREDENTIALS.admin);
    expect(
      opened.base,
      'アップロードの試験は画面を `localhost` で開く前提（support/auth.ts の FRONTEND_URL）',
    ).toBe(FRONTEND_URL);
    const page = opened.page;
    // 画面を開き直す（開いた時点の画面はまだ描き上がっておらず、読み込みの完了を待てない）。開き直した後に
    // 押し戻されていないことを確かめる。置き場を別名で開くと保存の Cookie が戻らず、数秒後にログイン画面へ
    // 押し戻され、その一瞬の殻の上でアップロードを送って全件失敗していた（実測 2026-10-27・d825）。
    const res = await page.goto(`${opened.base}/files`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    expect(res?.status() ?? 0, 'ファイル画面が開けない').toBeLessThan(500);
    await page.waitForLoadState('networkidle', { timeout: 90_000 }).catch(() => undefined);
    // 押し戻しは数秒遅れて起きる。押し戻しそのものを待って、起きたら理由を添えて止める。
    await page
      .waitForURL((url) => /\/login(\?|$)/.test(url.pathname), { timeout: 3_000 })
      .then(
        () => {
          throw new Error(
            'ファイル画面がログイン画面へ押し戻された（画面の置き場が別名で開いた）。' +
              '試験は画面を `localhost` で開く前提（support/auth.ts の FRONTEND_URL）',
          );
        },
        () => undefined,
      );
    expect(new URL(page.url()).pathname, '押し戻されていない画面').toContain('/files');

    // 以後の書き込みの応答を控える（通知が出なかった時の切り分けに使う）。
    page.on('response', (response) => {
      const url = new URL(response.url());
      const method = response.request().method();
      if (url.pathname.startsWith('/api/v1/files') && method !== 'GET') {
        lastWrite.push({ method, path: url.pathname, status: response.status() });
      }
    });
  },
);

When('画面から一意名のフォルダを作り、ツリーで開く', async ({ screen }) => {
  const page = screen.pages.at(-1);
  if (!page) throw new Error('先にファイル画面を開く');
  // 前提を既定に戻す（前の実行が途中で落ちて残した設定を、共有の設定から外す。何度行っても同じ結果）。
  const reset = await screenApi(screen.session?.cookies, '/api/v1/files/settings', {
    method: 'PATCH',
    body: { allowedExtensions: [], rejectedExtensions: [] },
  });
  expect(reset.status, `アップロード設定を既定に戻せない: ${reset.body}`).toBe(200);
  const name = uniqueName('e2e-d821');
  const created = await screenApi(screen.session?.cookies, '/api/v1/files/folders', {
    method: 'POST',
    // 器は画面が最初に開いているフォルダと同じ器（既定の器）。
    body: { name, parentFolderId: null, spaceId: '00000000-0000-4000-b000-000000000003' },
  });
  const parsed = JSON.parse(created.body) as { data?: { id?: string } };
  if (!parsed.data?.id) throw new Error(`フォルダを作れない: ${created.status} ${created.body}`);
  made.folderId = parsed.data.id;
  made.folderName = name;
  await page.reload({ waitUntil: 'networkidle' });
  // ツリーの名前は幅が足りないと「…」で切られる。切られない頭の文字列で指す。
  await page.locator('.ftree-label').getByText(name.slice(0, 20)).first().click();
  // 現在地の欄に開いたフォルダ名が出るまで待つ（読み込みの途中で次へ進まない）。
  await expect(page.locator('.tc-path-row')).toContainText(name.slice(0, 12), { timeout: 30_000 });
});

When('許可一覧の拒否拡張子を {string} に絞る', async ({ screen }, extension: string) => {
  // 拒否の一覧（rejectedExtensions）で絞る。許可の一覧（allowedExtensions）は「空＝何でも通る」。
  // 前に絞った許可が残っていると、拒否の一覧と無関係な拡張子でも弾かれたように見える（実測 2026-10-26）。
  const allow = await screenApi(screen.session?.cookies, '/api/v1/files/settings', {
    method: 'PATCH',
    body: { allowedExtensions: [] },
  });
  expect(allow.status, `許可の一覧を空にできない: ${allow.body}`).toBe(200);
  const res = await screenApi(screen.session?.cookies, '/api/v1/files/settings', {
    method: 'PATCH',
    body: { rejectedExtensions: [extension] },
  });
  expect(res.status, `拒否拡張子を絞れない（管理者でない画面を使っている）: ${res.body}`).toBe(200);
});

When('画面から {string} をアップロードする', async ({ screen }, fileName: string) => {
  const page = screen.pages.at(-1);
  if (!page) throw new Error('先にファイル画面を開く');
  toasts.length = 0;
  // 通知は出てから数秒で消える。監視は先に始め、選んだ直後から見に行く（4 秒ほど残るので
  // 送った後の最初の読み取りで間に合う。送る前に通知が残っていると、前の操作の通知を今回の理由と
  // 読み違えるため、押す前に残りが出そろうのを待つ）。
  await page
    .locator('[role="status"]')
    .first()
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined);

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: fileName,
      mimeType: 'text/csv',
      buffer: Buffer.from('a,b'),
    });
  for (let i = 0; i < 40 && toasts.length === 0; i += 1) {
    const now = (
      await page
        .locator('[role="status"]')
        .allInnerTexts()
        .catch(() => [])
    )
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (now.length > 0) toasts.push(...now);
    else await page.waitForTimeout(250);
  }
  // 選択欄に渡すと画面がその場でアップロードを送る（選んだ中身を送る）。通知だけを待つ。
});

Then('画面に許可されていない拡張子の理由が出ている', async () => {
  // ここで絞るのは**拒否の一覧**（rejectedExtensions）なので、返る理由はその一覧の文言
  // 「拒否する拡張子です」（ADR 0078 が固定層「常に拒否される拡張子です」と分けて定めている）。
  // 「許可されていない拡張子です」は許可の一覧（allowedExtensions）で弾かれた時の文言で、別の経路。
  expect(toasts.join(' / '), '画面に出た通知').toContain('拒否する拡張子です');
});

When('画面からアップロードしたファイルを、画面から別のフォルダへ移す', async ({ screen }) => {
  const page = screen.pages.at(-1);
  if (!page) throw new Error('先にファイル画面を開く');
  // 移し先を 1 つ用意し、ツリーに出ている状態にする（移動の対象＝一覧の行、移し先＝ツリーのフォルダ）。
  const target = `${made.folderName}-移し先`;
  const created = await screenApi(screen.session?.cookies, '/api/v1/files/folders', {
    method: 'POST',
    body: { name: target, parentFolderId: null, spaceId: '00000000-0000-4000-b000-000000000003' },
  });
  const parsed = JSON.parse(created.body) as { data?: { id?: string } };
  if (!parsed.data?.id) throw new Error(`移し先を作れない: ${created.status} ${created.body}`);
  screen.made2 = parsed.data.id;
  await page.reload({ waitUntil: 'networkidle' });
  const treeLabel = page.locator('.ftree-label').getByText(made.folderName.slice(0, 20)).first();
  await treeLabel.click();
  await expect(page.locator('.tc-path-row')).toContainText(made.folderName.slice(0, 12), {
    timeout: 30_000,
  });
  // 落とす先（ツリーの移し先の行）を、ツリーの中で画面の見える所へ送る。一覧はフォルダの中の全件を
  // 縦に並べるため、ツリーが画面の 4,000px 下にあることがある（実測 2026-10-27）。
  // 指すのは**この回の移し先だけ**。頭 20 文字では足りない（移し先の名は移し元の名の後ろに「-移し先」を
  // 足したもので、頭 20 文字は移し元とまったく同じになる。実測 2026-10-27: 移し元の上で離していたため、
  // 移動の要求が一度も出なかった）。「-移し先」だけでも足りない（前に落ちた回が残した移し先が同じ題で
  // 並ぶ）。この回の移し元の一意名から作った移し先を、名前の全体一致で指す。
  const targetLabel = page
    .locator('.ftree-label')
    .filter({ hasText: new RegExp(`^${target}$`) })
    .first();
  await expect(targetLabel, 'ツリーに移し先が出ていない').toHaveCount(1, { timeout: 30_000 });
  // 掴む側（一覧の行）を、一覧の中で画面の見える所へ送る。その後に落とす先の位置を読む
  // （一覧を送ると、ツリーの位置は動かない）。
  const row = page.locator('tr.file-row').filter({ hasText: 'e2e-d821-移す.txt' }).first();
  await expect(row, '一覧に移す対象の行が無い').toHaveCount(1, { timeout: 30_000 });
  const from = await reveal(row.locator('.col-name'));
  if (!from) throw new Error('掴む行の位置が取れない');
  await dragTo(page, { x: from.x + 40, y: from.y + from.height / 2 }, targetLabel);
  // 移動の応答が返るまで待つ（画面の通知ではなく応答で止める。通知の見え方に判定を依存させない）。
  for (let i = 0; i < 60 && lastMoveStatus() === undefined; i += 1) {
    await page.waitForTimeout(500);
  }
  expect(lastMoveStatus(), '移動の要求が届かなかった').toBe(200);
});

/**
 * 1 点から落とす先へドラッグする（画面の操作と同じ順で動かす）。
 *
 * - 掴む前の位置で「何を掴むか」が決まる（@dnd-kit は押した位置の要素から掴む物を選ぶ）。少しだけ
 *   動かして掴み放しを始めてから、落とす先へ送る。
 * - 掴むと一覧の並びが詰まり、下にあるツリーが画面の外へ押し出されることがある（実測 2026-10-27:
 *   掴む前は画面の下にあった移し先の行が、掴んだ後は画面の 6,000px 下にいた）。掴んだ状態のまま、
 *   落とす先を画面の見える所へ送る。送らずに離すと、落とす先が画面の外のままで移動が起きない。
 * - 落とす先の位置は、掴んだ**後**に読む（掴む前の位置は、掴んだ時点で画面が詰まって変わる）。
 * - 離す前に、落とす先が「重なっている」状態（.drag-over）になっていることを確かめる。掴み放しが
 *   途中で終わっていると、離しても何も起きないため（実測 2026-10-27）。
 */
async function dragTo(
  page: import('@playwright/test').Page,
  from: { x: number; y: number },
  destination: import('@playwright/test').Locator,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 6, { steps: 5 });
  await page.mouse.move(from.x + 12, from.y - 10, { steps: 5 });
  await page.waitForTimeout(200);
  // 掴むと一覧の並びが詰まり、下にあるツリーが画面の外へ押し出されることがある（実測 2026-10-27:
  // 掴む前は画面の中にあった移し先の行が、掴んだ後は画面の 10,000px 下にいた）。掴んだ状態のまま、
  // 落とす先を画面の見える所へ送ってから位置を読む（送った先の位置は、掴む前の位置とは違う）。
  await destination.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const box = await destination.boundingBox();
  if (!box) throw new Error('落とす先の位置が取れない');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  await page.waitForTimeout(300);
  // 離す前に、落とす先が「重なっている」状態（.drag-over）になっていることを確かめる。掴み放しが
  // 途中で終わっていると、離しても何も起きない（闇雲に待たず、選ばれるまで待つ）。
  await page
    .waitForFunction(
      () => document.querySelectorAll('.ftree-node.drag-over').length > 0,
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => undefined);
  await page.mouse.up();
}
/** 縦に長い置き場の中の対象を、画面の見える所まで送る（置き場の外は動かさない）。 */
async function revealInPane(target: import('@playwright/test').Locator): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
}

/** 縦に長い置き場の中の対象を、画面の見える所まで送り、送った後の位置を返す。 */
async function reveal(
  target: import('@playwright/test').Locator,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  await revealInPane(target);
  return target.boundingBox();
}

Then('移しても画面の現在地は移す前のフォルダのまま', async ({ screen }) => {
  const page = screen.pages.at(-1);
  if (!page) throw new Error('先にファイル画面を開く');
  // 画面の現在地は、移す前のフォルダのまま（一覧の行をツリーへ落とす移動では、パンくずを動かさない・
  // d862 で決めた姿）。移せたこと自体は、移す手順が移動の応答（PATCH が 200）で見ている。
  const stillHere = (await page.locator('.tc-path-row').innerText()).replace(/\s+/g, ' ');
  // パンくずは幅が足りないと名前が切られるので、一意名の後半（日時と乱数）で指す。
  expect(stillHere, '移した後の画面の現在地（移す前のフォルダのまま）').toContain(
    made.folderName.slice(-8),
  );
  expect(stillHere, '移した後の画面の現在地が移し先へ勝手に替わっていない').not.toContain(
    `${made.folderName}-移し先`,
  );
});

Then('移し元の一覧から移した行が消えている', async ({ screen }) => {
  const page = screen.pages.at(-1);
  if (!page) throw new Error('先にファイル画面を開く');
  // 一覧は移した後の状態に描き直される（移動の応答の後に一覧を取り直す・d862）。読み込み直さずに、
  // 利用者が見ている一覧そのものを確かめる（読み直して消えているだけでは、移した直後に残る可能性を拾えない）。
  await expect(
    page.locator('tr.file-row').filter({ hasText: 'e2e-d821-移す.txt' }),
    '移した後も、移し元の一覧にその行が残っている',
  ).toHaveCount(0, { timeout: 30_000 });
});

Then('ツリーで移し先を開くと、移した行がそこにある', async ({ screen }) => {
  const page = screen.pages.at(-1);
  if (!page) throw new Error('先にファイル画面を開く');
  const target = `${made.folderName}-移し先`;
  // 何度行っても同じ結果にする（前の実行が移し損ねた行が残っていても、ここで確かめられるように）。
  await page.reload({ waitUntil: 'networkidle' });
  const targetLabel = page
    .locator('.ftree-label')
    .filter({ hasText: new RegExp(`^${target}$`) })
    .first();
  await expect(targetLabel, 'ツリーに移し先が出ていない').toHaveCount(1, { timeout: 30_000 });
  await targetLabel.click();
  await expect(page.locator('.tc-path-row')).toContainText(target, { timeout: 30_000 });
  await expect(
    page.locator('tr.file-row').filter({ hasText: 'e2e-d821-移す.txt' }),
    'ツリーで開いた移し先の一覧に、移したファイルが居ない',
  ).toHaveCount(1, { timeout: 30_000 });
});

Then('画面を読み込み直して、画面から片付けができる', async ({ screen }) => {
  const page = screen.pages.at(-1);
  if (!page) throw new Error('先にファイル画面を開く');
  // 画面の後始末（最後の書き込みの応答を失敗にせず、DOM の更新と競わせない）。
  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch {
    // 読み込み直せなくても後始末（下の API）は続ける。
  }
  // 拒否の一覧と許可の一覧を空へ戻す（戻さないと後続のシナリオが影響を受ける）。
  const restore = await screenApi(screen.session?.cookies, '/api/v1/files/settings', {
    method: 'PATCH',
    body: { allowedExtensions: [], rejectedExtensions: [] },
  });
  expect(restore.status, `拒否拡張子を戻せない: ${restore.body}`).toBe(200);
  const folders = [made.folderId, screen.made2].filter((id): id is string => Boolean(id));
  for (const folderId of folders) {
    const content = await screenApi(screen.session?.cookies, `/api/v1/files/folders/${folderId}`);
    const parsed = JSON.parse(content.body) as { data?: { items?: { id: string }[] } };
    for (const item of parsed.data?.items ?? []) {
      await screenApi(screen.session?.cookies, `/api/v1/files/files/${item.id}`, {
        method: 'DELETE',
      });
    }
    const del = await screenApi(screen.session?.cookies, `/api/v1/files/folders/${folderId}`, {
      method: 'DELETE',
    });
    expect(del.status, `片付けに失敗した: ${del.body}`).toBeLessThan(400);
  }
  made.folderId = '';
  screen.made2 = undefined;
});
