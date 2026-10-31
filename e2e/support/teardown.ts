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
 * 予定（calendar-events）の消し口は「id だけ」では足りない（d793）。
 *
 * DELETE /api/v1/calendar-events/:id は楽観ロックの `?revision=` を要求し、無い・古い revision は 400 で
 * 断られる。id から組み立てた後始末の path をそのまま撃つと 400 になり、作った予定が開発 DB に
 * 残り続けた（2026-10-25/26 の実行で 19 件残留）。作った直後の応答が返す revision を添えて消す。
 *
 * 予定の id は UUID のため、「直前の応答の id」として数字（タスク等）が来た時は予定として扱わない。
 */
export function buildCreatedResourceTeardown(
  createdUrlPath: string,
  responseData: { id?: unknown; revision?: unknown } | null | undefined,
): { method: 'DELETE' | 'PATCH'; path: string } | null {
  const id = responseData?.id;
  if (id === undefined || id === null || id === '') return null;
  const path = `${createdUrlPath.replace(/\/$/, '')}/${String(id)}`;
  const segments = createdUrlPath
    .replace(/^\/api\/v1\//, '')
    .split('/')
    .filter((s) => s !== '');
  const isCalendarEvent =
    segments.length === 1 && segments[0] === 'calendar-events' && typeof id === 'string';
  if (!isCalendarEvent) return { method: resolveTeardownMethod(createdUrlPath), path };
  // revision が返らなかった時も path は作る（消し口が 400 で落ちる形は今までどおり後始末で表に出る）。
  const revision = responseData?.revision;
  const suffix =
    revision === undefined || revision === null
      ? ''
      : `?revision=${encodeURIComponent(String(revision))}`;
  return { method: 'DELETE', path: `${path}${suffix}` };
}
