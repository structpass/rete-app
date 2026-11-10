/**
 * cmn-0408: teardown method 判定（依存ゼロの単独モジュール）。
 *
 * 元は `steps/common.steps.ts` の module private だったが、あちらは import した時点で
 * step 登録の副作用が走るため単体テストから直接触れない（placeholders.ts と同じ理由・cmn-0336）。
 * **playwright / playwright-bdd を一切 import しない** ここへ切り出した
 * （単体テスト = `__tests__/teardown.test.ts`）。
 */

/** PATCH archive で片付ける名指し資源（Delete エンドポイント無し） */
export const ARCHIVE_TEARDOWN_RESOURCES: ReadonlySet<string> = new Set([
  'organizations',
  'projects',
  'spaces',
]);

/**
 * POST 先 path に応じて teardown method を決定する（cmn-0365・判定を裏返し）。
 * - /api/v1/organizations|projects|spaces（裸の /api/v1/<resource> のみ）→ PATCH archive
 * - それ以外 → DELETE（実在する消し口へ倒す。知らないリソースが「黙ってアーカイブ」され
 *   teardown が静かに失敗する経路を塞ぐ＝消せない時は例外として表に出る）
 *
 * 名指しの照合は「/api/v1/ 直後のセグメントがちょうど 1 個」のときだけ行う（cmn-0408）。
 * 第 1 セグメント一致だけだと /api/v1/spaces/<id>/members のような入れ子 path も名指し側へ
 * 落ちてアーカイブが撃たれ、「静かな失敗」が同じ形で戻るため。入れ子は DELETE へ倒す。
 */
export function resolveTeardownMethod(urlPath: string): 'DELETE' | 'PATCH' {
  const segments = urlPath
    .replace(/^\/api\/v1\//, '')
    .split('/')
    .filter((s) => s !== '');
  return segments.length === 1 && ARCHIVE_TEARDOWN_RESOURCES.has(segments[0]) ? 'PATCH' : 'DELETE';
}

/**
 * 子資源の消し口（d971）。
 *
 * 作った資源の後始末は「作成先 + /id」をそのまま撃つが、入れ子の作成口で作った資源は
 * 素の消し口と形が違う。`DELETE /api/v1/chat/themes/:id/messages/:id` と
 * `DELETE /api/v1/files/folders/:id/files/:id` は API に無く（404）、実在する消し口は
 * `/api/v1/chat/messages/:id`・`/api/v1/files/files/:id`（実測 2026-10-31）。そのまま撃つと
 * 後始末が 404 で落ち、作った資源が開発 DB に残る。
 *
 * 入れ子の作成口が増えて消し方が決まったら、ここへ対応表を足す。表に無い入れ子は今までどおり
 * 組み立てる（消し口が無い時は後始末の失敗として表に出る）。
 */
const NESTED_DELETE_ROUTES: ReadonlyArray<{
  pattern: RegExp;
  to: (match: RegExpExecArray) => string;
}> = [
  {
    // /api/v1/chat/themes/:themeId/messages/:messageId
    pattern: /^\/api\/v1\/chat\/themes\/[^/]+\/messages\/([^/]+)$/,
    to: (m) => `/api/v1/chat/messages/${m[1]}`,
  },
  {
    // /api/v1/files/folders/:folderId/files/:fileId
    pattern: /^\/api\/v1\/files\/folders\/[^/]+\/files\/([^/]+)$/,
    to: (m) => `/api/v1/files/files/${m[1]}`,
  },
];

/** 作成先 + /id の形から、実在する消し口の path を決める。表に無ければ今までどおり組み立てる。 */
function resolveCreatedResourcePath(createdUrlPath: string, id: string): string {
  const nested = `${createdUrlPath.replace(/\/$/, '')}/${id}`;
  for (const route of NESTED_DELETE_ROUTES) {
    const match = route.pattern.exec(nested);
    if (match) return route.to(match);
  }
  return nested;
}

/**
 * 予定（calendar-events）の消し口は「id だけ」では足りない（d793）。
 *
 * DELETE /api/v1/calendar-events/:id は楽観ロックの `?revision=` を要求し、無い・古い revision は 400 で
 * 断られる。id から組み立てた後始末の path をそのまま撃つと 400 になり、作った予定が開発 DB に
 * 残り続けた（2026-10-25/26 の実行で 19 件残留）。作った直後の応答が返す revision を添えて消す。
 *
 * 予定の id は UUID のため、「直前の応答の id」として数字（タスク等）が来た時は予定として扱わない。
 *
 * 応答の `data` は素の本体と包み（`{ data: { id, revision } }`）のどちらでも読む。包みのときに
 * `data.id` を id として読むと UUID の文字列が来てしまい、revision を見失った id だけの消し口が
 * 登録される（d964: S-HOME-10/11/12 が記録を登録したうえで 400 で落ち、予定が残留した）。
 */
export function buildCreatedResourceTeardown(
  createdUrlPath: string,
  responseData: unknown,
): { method: 'DELETE' | 'PATCH'; path: string } | null {
  const created = unwrapResponseData(responseData);
  const id = created?.id;
  if (created === null || id === undefined || id === null || id === '') return null;
  const path = resolveCreatedResourcePath(createdUrlPath, String(id));
  const segments = createdUrlPath
    .replace(/^\/api\/v1\//, '')
    .split('/')
    .filter((s) => s !== '');
  const isCalendarEvent =
    segments.length === 1 && segments[0] === 'calendar-events' && typeof id === 'string';
  if (!isCalendarEvent) return { method: resolveTeardownMethod(createdUrlPath), path };
  // revision が返らなかった時も path は作る（消し口が 400 で落ちる形は今までどおり後始末で表に出る）。
  const revision = created.revision;
  const suffix =
    revision === undefined || revision === null
      ? ''
      : `?revision=${encodeURIComponent(String(revision))}`;
  return { method: 'DELETE', path: `${path}${suffix}` };
}

/**
 * 作った資源を表す応答のデータを取り出す。
 *
 * 試験の手順が読む形（`レスポンスの "data.revision" を…`）は本体が `data` で包まれている。包みを
 * 素通しすると `data.id`（UUID の文字列）を資源の id と取り違え、revision を見失う。
 * 包みの中の値も読む（応答の包み方が揃っていない場合も、資源を表す値はどちらの階層にある）。
 */
function unwrapResponseData(responseData: unknown): { id?: unknown; revision?: unknown } | null {
  if (responseData === null || typeof responseData !== 'object') return null;
  const outer = responseData as { id?: unknown; revision?: unknown; data?: unknown };
  const inner = outer.data;
  if (inner !== null && typeof inner === 'object')
    return inner as { id?: unknown; revision?: unknown };
  return outer;
}

/**
 * 後始末で、作った資源を消す順序（d971）。
 *
 * それまでの後始末は「admin 接続の system ADMIN 経由」で消していた。しかし
 * - 既存の更新口（PATCH :id・archive）はそのスコープの ADMIN しか通さない（作成者が最後まで消す）
 * - 個人メモは既存の更新口で消せない（400）。一方で、作った人なら自分のメモを消せる（DELETE :id）
 * ため、まず「作った人の接続での消し方」を試し、通らなければ今までどおりの消し方へ倒す。
 */
export function teardownAttemptOrder(entry: {
  method: 'DELETE' | 'PATCH';
  path: string;
  own?: { method: 'DELETE' | 'PATCH'; path: string } | null;
}): { first: { method: 'DELETE' | 'PATCH'; path: string } | null; fallback: 'DELETE' | 'PATCH' } {
  return { first: entry.own ?? null, fallback: entry.method };
}

/**
 * 後始末で、作った資源を消しに行く接続を選ぶ（d1024）。
 *
 * - 保存セッションを名乗った資源は、その保存セッションの接続（後始末の時点で引き直す）
 * - **名乗ったが、その保存セッションが `sessions` に無い**時は、登録の時点で控えた接続（`ownCtx`）へ
 *   落とす。ここで null を返すと、控えてある接続があるのに admin 接続での消し方へ倒れ、作った人が
 *   消せる資源が残る（名乗りは手順の書き方次第で、後始末の時点に接続が残っているとは限らない）
 * - 名乗っていない資源も、登録の時点で控えた接続（`ownCtx`）
 * - どちらも無ければ、控えてある `own.ctx`
 *
 * 登録の時点の `world.apiCtx` は手順の途中で差し替わる（保存セッションを開く手順・別の人のログインを
 * 試す手順）。`own.ctx` だけを頼ると、作った人と同じ立場で消すつもりの手順が別の人の接続で動き、
 * 権限の無い消し方として空振りして、作った人が消せる資源が残る。だから控えた接続を先に読む。
 */
export function resolveOwnContext<T>(
  entry: {
    session?: string;
    ownCtx?: T | null;
    own?: { ctx?: T | null } | null;
  },
  sessions: Record<string, T>,
): T | null {
  if (entry.session !== undefined) {
    const bySession = sessions[entry.session];
    if (bySession !== undefined) return bySession;
    // 名乗った保存セッションが残っていない → 控えた接続へ落とす（null で打ち切らない）。
  }
  return entry.ownCtx ?? entry.own?.ctx ?? null;
}

/**
 * 消しに行った先の 404 を「片付いた」と読んでよいか（d1025）。
 *
 * 404 には 2 つの意味がある。**もう無い**（前の手順で消えた）と、**こちらからは見えない**
 * （読み書きを読み分けさせない器の中の話・発話。器があれば中身は残っている）。後者を片付いたと
 * 読むと、作った資源が開発 DB に残ったまま後始末が緑になる。
 *
 * - `ownerSpaceId` が無い資源は、404 は「もう無い」とだけ読む（今までどおり）
 * - 器の中に作った資源は、器がもう無いと言い切れる時だけ片付いたと読む（`containerGone`）。
 *   言い切れなければ 404 を失敗として表に出す（静かに通さない）
 */
export function readTeardown404(
  entry: { ownerSpaceId?: string },
  containerGone: boolean,
): { settled: boolean } {
  if (entry.ownerSpaceId === undefined) return { settled: true };
  return { settled: containerGone };
}

// ── 1 資源ぶんの後始末（d1139）────────────────────────────────
// 判定（上の 4 つの関数）は試験で押さえてあったが、**判定を呼ぶ配線**は fixtures.ts の After に
// 直書きされていて、器の削除に失敗した時に throw する枝・器が残ったまま 404 の時に throw する枝
// （d1024/d1025 の実効部分）が 1 度も走らされていなかった。配線が壊れても単体は緑のままになる。
// ここへ「1 資源ぶんの手順」を引き上げ、HTTP の口だけを差し替えられる形にして試験から叩く。
// fixtures.ts はこの関数を呼ぶだけにする（判定と手順を同じ場所に置き、試験と本番が同じ道を通る）。

/** 後始末が使う HTTP の口（Playwright の APIRequestContext がそのまま当てはまる最小の形）。 */
export type TeardownResponse = { status(): number; ok(): boolean };
export type TeardownHttp = {
  delete(path: string): Promise<TeardownResponse>;
  patch(path: string, options: { data: unknown }): Promise<TeardownResponse>;
};

/** 後始末の対象 1 件（fixtures の CreatedResource のうち、手順が読む欄だけ）。 */
export type TeardownTarget = {
  method: 'DELETE' | 'PATCH';
  path: string;
  ownerSpaceId?: string;
  own?: { method: 'DELETE' | 'PATCH'; path: string } | null;
};

/**
 * 作った資源 1 件を後始末する。消せなかった時・片付いたと言い切れない時は throw する
 * （静かに緑にしない）。`ownCtx` は作った人と同じ立場の接続（無ければ null）。
 */
export async function teardownCreatedResource(
  r: TeardownTarget,
  ownCtx: TeardownHttp | null,
  cleanupCtx: TeardownHttp,
): Promise<void> {
  const order = teardownAttemptOrder(r);
  let res: TeardownResponse | null = null;
  if (order.first && ownCtx) {
    res =
      order.first.method === 'DELETE'
        ? await ownCtx.delete(order.first.path)
        : await ownCtx.patch(order.first.path, { data: { archived: true } });
  }
  if (!res || res.status() >= 400) {
    res =
      r.method === 'DELETE'
        ? await cleanupCtx.delete(r.path)
        : await cleanupCtx.patch(r.path, { data: { archived: true } });
  }
  if (res.status() === 400 && r.method === 'PATCH' && r.path.startsWith('/api/v1/spaces/')) {
    // 個人メモは既存の更新口（archive）が 400 で断る。持っていれば消せる（DELETE）ようになっている。
    const removed = ownCtx ? await ownCtx.delete(r.path) : null;
    res = removed && removed.status() < 400 ? removed : await cleanupCtx.delete(r.path);
  }
  let containerGone = false;
  if (res.status() === 404 && r.ownerSpaceId && order.first?.method === 'DELETE') {
    // 個人メモの中の話・発話は、どの接続からも個別に消せない（読み書きが 404＝存在を
    // 読み分けさせない）。器を消せば中身は連鎖して消えるので、器ごと消して道連れにする。
    const ctx = ownCtx ?? cleanupCtx;
    const removed = await ctx.delete(`/api/v1/spaces/${r.ownerSpaceId}`);
    if (!removed.ok() && removed.status() !== 404) {
      // 個別の消し方（404）に続いて器も消せないなら、何が残っているか言い切れない。
      throw new Error(
        `[teardown] DELETE /api/v1/spaces/${r.ownerSpaceId} (owner of ${r.path}) failed: ${removed.status()}`,
      );
    }
    res = removed;
    // d1025: 器を消せた（または器がもう無い）時だけ「中身も片付いた」と言い切れる。
    containerGone = removed.status() < 400 || removed.status() === 404;
  }
  // 404 は「もう無い」なら片付いた。器の中に作った資源は、器が無いと言い切れる時だけ片付いたと読む
  // （容器が残ったまま 404 なら、中身は見えないだけで残っている＝静かに通さない・d1025）。
  if (res.status() === 404) {
    const read = readTeardown404(r, containerGone);
    if (!read.settled) {
      throw new Error(
        `[teardown] ${r.method} ${r.path} is 404 but its container may still hold it (ownerSpaceId=${r.ownerSpaceId})`,
      );
    }
  }
  if (res.status() >= 400 && res.status() !== 404) {
    throw new Error(`[teardown] ${r.method} ${r.path} failed: ${res.status()}`);
  }
}
