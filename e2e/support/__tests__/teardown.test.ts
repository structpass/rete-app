/**
 * cmn-0408: teardown.ts（resolveTeardownMethod）の Node --test 単体検証。
 *
 * 実行: e2e の `npm run test:unit`（node --experimental-strip-types --test support/__tests__/*.test.ts）
 * → CI では test.yml の e2e 独立 job「Unit test (E2E)」ステップが実行する（cmn-0376 と同経路）。
 *
 * ここが本件の唯一の証明手段なのは、現行の id 記録 POST が全て裸の /api/v1/<resource> で
 * 入れ子 path を通らず、判定が緩くても通しの e2e は緑になるため（cmn-0365 の MEDIUM 1）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTeardownMethod,
  buildCreatedResourceTeardown,
  teardownAttemptOrder,
  resolveOwnContext,
  readTeardown404,
  teardownCreatedResource,
  type TeardownHttp,
  type TeardownResponse,
} from '../teardown.ts';

test('名指し 3 資源の裸 path は PATCH（archive 消し口）', () => {
  assert.equal(resolveTeardownMethod('/api/v1/organizations'), 'PATCH');
  assert.equal(resolveTeardownMethod('/api/v1/projects'), 'PATCH');
  assert.equal(resolveTeardownMethod('/api/v1/spaces'), 'PATCH');
  // 末尾スラッシュは空セグメントとして無視する（裸 path 扱いのまま）。
  assert.equal(resolveTeardownMethod('/api/v1/spaces/'), 'PATCH');
  // クエリ文字列は資源名と別文字列になるため名指しに一致しない（新旧同挙動＝DELETE）。
  assert.equal(resolveTeardownMethod('/api/v1/spaces?x=1'), 'DELETE');
});

test('名指し以外は DELETE（実在する消し口へ倒す・現行 id 記録 POST の残り 5 資源）', () => {
  assert.equal(resolveTeardownMethod('/api/v1/roles'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/tasks'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/announcements'), 'DELETE');
  // 2 セグメント資源（chat/themes・files/folders）は修正前後とも DELETE（非回帰）。
  assert.equal(resolveTeardownMethod('/api/v1/chat/themes'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/files/folders'), 'DELETE');
});

test('入れ子 path は名指し資源配下でも DELETE（アーカイブ誤射の遮断・cmn-0408）', () => {
  // 第 1 セグメント一致だけだと PATCH へ落ちて「静かな失敗」が戻る形（MEDIUM 1 の穴）。
  assert.equal(resolveTeardownMethod('/api/v1/spaces/sp-1/members'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/organizations/org-1/invites'), 'DELETE');
  assert.equal(resolveTeardownMethod('/api/v1/projects/pj-1/tasks'), 'DELETE');
});

// d793: 予定（calendar-events）の消し口は revision を要求する。id だけの path を撃つと 400 で
// 断られ、作った予定が開発 DB に残り続けた。記録の時点で revision を添える。
test('予定は作った直後の revision を添えた消し口で記録する（d793）', () => {
  assert.deepEqual(
    buildCreatedResourceTeardown('/api/v1/calendar-events', {
      id: '4d9fb660-262c-4cff-9f09-c8c8b6f45f80',
      revision: 1,
    }),
    {
      method: 'DELETE',
      path: '/api/v1/calendar-events/4d9fb660-262c-4cff-9f09-c8c8b6f45f80?revision=1',
    },
  );
});

test('予定以外の資源は今までどおり id だけの path で記録する（非回帰）', () => {
  // タスク等の id は数値。予定（UUID）と取り違えない。
  assert.deepEqual(buildCreatedResourceTeardown('/api/v1/tasks', { id: 42, revision: 3 }), {
    method: 'DELETE',
    path: '/api/v1/tasks/42',
  });
  // 名指し資源（archive）の判定は resolveTeardownMethod のまま。
  assert.deepEqual(buildCreatedResourceTeardown('/api/v1/spaces', { id: 'sp-1' }), {
    method: 'PATCH',
    path: '/api/v1/spaces/sp-1',
  });
  // id が文字列でも、予定以外は revision を付けない。
  assert.deepEqual(
    buildCreatedResourceTeardown('/api/v1/announcements', { id: 'a-1', revision: 2 }),
    { method: 'DELETE', path: '/api/v1/announcements/a-1' },
  );
});

test('応答に id が無ければ記録しない（従来の「記録しない」判定の維持）', () => {
  assert.equal(buildCreatedResourceTeardown('/api/v1/tasks', null), null);
  assert.equal(buildCreatedResourceTeardown('/api/v1/tasks', {}), null);
  assert.equal(buildCreatedResourceTeardown('/api/v1/tasks', { id: '' }), null);
});

// d964: 手順が読む形（`レスポンスの "data.revision" を…`）は本体が `data` で包まれている。
// 包みを素通しすると `data.id`（UUID の文字列）を資源の id と取り違え、revision を見失った
// id だけの消し口が登録されて後始末が 400 で落ちた（S-HOME-10/11/12 の予定が残留）。
test('包み（{ success, data }）の応答から資源の id と revision を読む（d964）', () => {
  const wrapped = {
    success: true,
    data: { id: '4d9fb660-262c-4cff-9f09-c8c8b6f45f80', revision: 1 },
  };
  assert.deepEqual(buildCreatedResourceTeardown('/api/v1/calendar-events', wrapped), {
    method: 'DELETE',
    path: '/api/v1/calendar-events/4d9fb660-262c-4cff-9f09-c8c8b6f45f80?revision=1',
  });
  // 包みでも予定以外は今までどおり id だけの path。
  assert.deepEqual(
    buildCreatedResourceTeardown('/api/v1/tasks', { success: true, data: { id: 42 } }),
    {
      method: 'DELETE',
      path: '/api/v1/tasks/42',
    },
  );
});

// d971: 入れ子の作成口で作った子資源は、素の消し口と形が違う（実測: 入れ子の DELETE は 404）。
test('入れ子で作った発話・ファイルは、実在する消し口で記録する（d971）', () => {
  assert.deepEqual(
    buildCreatedResourceTeardown('/api/v1/chat/themes/theme-1/messages', {
      success: true,
      data: { id: 'msg-1' },
    }),
    { method: 'DELETE', path: '/api/v1/chat/messages/msg-1' },
  );
  assert.deepEqual(
    buildCreatedResourceTeardown('/api/v1/files/folders/folder-1/files', {
      success: true,
      data: { id: 'file-1' },
    }),
    { method: 'DELETE', path: '/api/v1/files/files/file-1' },
  );
  // 表に無い入れ子は今までどおり「作成先 + /id」（消し口が無い時は後始末の失敗として出る）。
  assert.deepEqual(
    buildCreatedResourceTeardown('/api/v1/spaces/sp-1/members', {
      success: true,
      data: { id: 'member-1' },
    }),
    { method: 'DELETE', path: '/api/v1/spaces/sp-1/members/member-1' },
  );
});

// d971: 後始末は「作った人の接続」を先に試し、通らなければ今までどおりの消し方へ倒す。
test('後始末の順序: 作った人の消し方を先に、通らなければ既存の消し方へ', () => {
  assert.deepEqual(
    teardownAttemptOrder({
      method: 'PATCH',
      path: '/api/v1/spaces/sp-1',
      own: { method: 'DELETE', path: '/api/v1/spaces/sp-1' },
    }),
    { first: { method: 'DELETE', path: '/api/v1/spaces/sp-1' }, fallback: 'PATCH' },
  );
  assert.deepEqual(teardownAttemptOrder({ method: 'DELETE', path: '/api/v1/tasks/1', own: null }), {
    first: null,
    fallback: 'DELETE',
  });
});

// d1024: 後始末で消しに行く接続は、保存セッション → 登録時に控えた接続 → own.ctx の順で選ぶ。
// 登録時の `world.apiCtx` は手順の途中で差し替わるため、`own.ctx` だけを頼ると別の人の接続で消しに行く。
test('後始末の接続: 保存セッションを名乗った資源はその保存セッションの接続を使う', () => {
  const worldCtx = { who: 'world' };
  const savedCtx = { who: 'saved' };
  assert.equal(
    resolveOwnContext(
      { session: 'member', ownCtx: worldCtx, own: { ctx: worldCtx } },
      { member: savedCtx },
    ),
    savedCtx,
  );
});

test('後始末の接続: 名乗っていない資源は、登録の時点で控えた接続を使う（差し替わった world の接続に追従しない）', () => {
  const registeredCtx = { who: 'creator' };
  assert.equal(
    resolveOwnContext({ ownCtx: registeredCtx, own: { ctx: { who: 'someone-else' } } }, {}),
    registeredCtx,
  );
});

test('後始末の接続: 控えた接続が無ければ own.ctx、それも無ければ null', () => {
  const ownCtx = { who: 'own' };
  assert.equal(resolveOwnContext({ own: { ctx: ownCtx } }, {}), ownCtx);
  assert.equal(resolveOwnContext({}, {}), null);
});
// d1025: 消しに行った先の 404 は、もう無い（片付いた）と、こちらから見えない（中身は残っている）の
// 2 つの意味を持つ。器の中に作った資源は、器が無いと言い切れる時だけ片付いたと読む。
test('後始末の 404: 器に属さない資源の 404 は「もう無い」と読む', () => {
  assert.deepEqual(readTeardown404({}, false), { settled: true });
});

test('後始末の 404: 器の中の資源は、器がもう無い時だけ片付いたと読む', () => {
  assert.deepEqual(readTeardown404({ ownerSpaceId: 'space-1' }, true), { settled: true });
  // 器は消せなかった（または消した結果が読めない）＝中身が残っているかもしれない。静かに通さない。
  assert.deepEqual(readTeardown404({ ownerSpaceId: 'space-1' }, false), { settled: false });
});

// d1139: 名乗った保存セッションが後始末の時点に残っていない時、控えた接続へ落とす。
// ここで null を返すと admin 接続での消し方へ倒れ、作った人が消せる資源が残る。
test('後始末の接続: 名乗った保存セッションが無ければ、控えた接続へ落とす (d1139)', () => {
  const registeredCtx = { who: 'creator' };
  assert.equal(
    resolveOwnContext({ session: 'gone', ownCtx: registeredCtx, own: { ctx: null } }, {}),
    registeredCtx,
  );
  // 控えた接続も無ければ own.ctx、それも無ければ null（今までどおり）。
  assert.deepEqual(resolveOwnContext({ session: 'gone', own: { ctx: { who: 'own' } } }, {}), {
    who: 'own',
  });
  assert.equal(resolveOwnContext({ session: 'gone' }, {}), null);
});

// ── d1139: 後始末の手順そのもの（fixtures の After から引き上げた配線）────────
// 器の削除に失敗した時の throw・器が残ったまま 404 の時の throw は、判定だけを試験しても
// 走らない（配線が壊れても単体は緑のままだった）。HTTP の口だけを差し替えて手順を通す。

/** 台本どおりの status を返し、呼ばれた口を控える偽の HTTP の口。 */
function fakeHttp(script: { delete?: number[]; patch?: number[] } = {}): TeardownHttp & {
  calls: string[];
} {
  const del = [...(script.delete ?? [])];
  const pat = [...(script.patch ?? [])];
  const calls: string[] = [];
  const respond = (status: number): TeardownResponse => ({
    status: () => status,
    ok: () => status >= 200 && status < 300,
  });
  return {
    calls,
    async delete(path: string) {
      calls.push(`DELETE ${path}`);
      return respond(del.length > 0 ? del.shift()! : 204);
    },
    async patch(path: string, _options: { data: unknown }) {
      calls.push(`PATCH ${path}`);
      return respond(pat.length > 0 ? pat.shift()! : 204);
    },
  };
}

test('後始末の手順: 作った人の接続で消せたら admin 接続へは行かない (d1139)', async () => {
  const own = fakeHttp({});
  const admin = fakeHttp({});
  await teardownCreatedResource(
    {
      method: 'DELETE',
      path: '/api/v1/tasks/1',
      own: { method: 'DELETE', path: '/api/v1/tasks/1' },
    },
    own,
    admin,
  );
  assert.deepEqual(own.calls, ['DELETE /api/v1/tasks/1']);
  assert.deepEqual(admin.calls, []);
});

test('後始末の手順: 作った人の接続が通らなければ、admin 接続で消し直す (d1139)', async () => {
  const own = fakeHttp({ delete: [403] });
  const admin = fakeHttp({ delete: [204] });
  await teardownCreatedResource(
    {
      method: 'DELETE',
      path: '/api/v1/tasks/1',
      own: { method: 'DELETE', path: '/api/v1/tasks/1' },
    },
    own,
    admin,
  );
  assert.deepEqual(own.calls, ['DELETE /api/v1/tasks/1']);
  assert.deepEqual(admin.calls, ['DELETE /api/v1/tasks/1']);
});

test('後始末の手順: 器ごと消せなければ throw する（中身が残ったまま緑にしない・d1024）', async () => {
  // 個別の消し口は作った人・admin のどちらからも 404（見えない）、器の消し口は 500。
  const own = fakeHttp({ delete: [404, 500] });
  const admin = fakeHttp({ delete: [404] });
  await assert.rejects(
    teardownCreatedResource(
      {
        method: 'DELETE',
        path: '/api/v1/chat/messages/msg-1',
        ownerSpaceId: 'space-1',
        own: { method: 'DELETE', path: '/api/v1/chat/messages/msg-1' },
      },
      own,
      admin,
    ),
    /DELETE \/api\/v1\/spaces\/space-1 .* failed: 500/,
  );
  // 個別の消し口（作った人 → admin）→ 器の消し口、の順に撃っている（道連れの配線が生きている）。
  assert.deepEqual(admin.calls, ['DELETE /api/v1/chat/messages/msg-1']);
  assert.deepEqual(own.calls, [
    'DELETE /api/v1/chat/messages/msg-1',
    'DELETE /api/v1/spaces/space-1',
  ]);
});

test('後始末の手順: 器の無事を言い切れない 404 は throw する（静かに通さない・d1025）', async () => {
  // 器の中に作った資源なのに、作った人の消し方が控えられていない（`own` が無い）回。
  // 器を消しに行く枝へ入れない＝中身が残っているか言い切れないので、静かに通さない。
  await assert.rejects(
    teardownCreatedResource(
      { method: 'DELETE', path: '/api/v1/chat/messages/msg-1', ownerSpaceId: 'space-1' },
      null,
      fakeHttp({ delete: [404] }),
    ),
    /may still hold it/,
  );
});

test('後始末の手順: 器ごと片付いた 404 は通す (d1025)', async () => {
  // 個別は 404（見えない）、器も 404（もう無い）＝中身も片付いたと言い切れる。
  await teardownCreatedResource(
    {
      method: 'DELETE',
      path: '/api/v1/chat/messages/msg-1',
      ownerSpaceId: 'space-1',
      own: { method: 'DELETE', path: '/api/v1/chat/messages/msg-1' },
    },
    fakeHttp({ delete: [404, 404] }),
    fakeHttp({ delete: [404] }),
  );
});

test('後始末の手順: 器に属さない資源の 404 は片付いたとして通す (d1025)', async () => {
  await teardownCreatedResource(
    { method: 'DELETE', path: '/api/v1/tasks/1' },
    null,
    fakeHttp({ delete: [404] }),
  );
});

test('後始末の手順: 404 以外の失敗は throw する（静かに緑にしない）', async () => {
  await assert.rejects(
    teardownCreatedResource(
      { method: 'DELETE', path: '/api/v1/tasks/1' },
      null,
      fakeHttp({ delete: [500] }),
    ),
    /DELETE \/api\/v1\/tasks\/1 failed: 500/,
  );
});

test('後始末の手順: 個人メモの archive が 400 なら、持ち主の DELETE へ倒す (d971)', async () => {
  // 個人メモは既存の更新口（archive）が 400 で断る。持っていれば消せる（DELETE）へ倒す枝。
  // 作った人の PATCH も admin の PATCH も 400 → 持ち主の DELETE が 204 で通る。
  const own = fakeHttp({ patch: [400], delete: [204] });
  const admin = fakeHttp({ patch: [400], delete: [200] });
  await teardownCreatedResource(
    {
      method: 'PATCH',
      path: '/api/v1/spaces/space-1',
      own: { method: 'PATCH', path: '/api/v1/spaces/space-1' },
    },
    own,
    admin,
  );
  assert.deepEqual(own.calls, ['PATCH /api/v1/spaces/space-1', 'DELETE /api/v1/spaces/space-1']);
  // 持ち主の DELETE で通ったので、admin の DELETE は撃たない（PATCH の 1 回だけ）。
  assert.deepEqual(admin.calls, ['PATCH /api/v1/spaces/space-1']);
});

test('後始末の手順: 個人メモの持ち主 DELETE も通らなければ admin の DELETE へ倒す (d971)', async () => {
  const own = fakeHttp({ patch: [400], delete: [403] });
  const admin = fakeHttp({ patch: [400], delete: [204] });
  await teardownCreatedResource(
    {
      method: 'PATCH',
      path: '/api/v1/spaces/space-1',
      own: { method: 'PATCH', path: '/api/v1/spaces/space-1' },
    },
    own,
    admin,
  );
  assert.deepEqual(own.calls, ['PATCH /api/v1/spaces/space-1', 'DELETE /api/v1/spaces/space-1']);
  assert.deepEqual(admin.calls, ['PATCH /api/v1/spaces/space-1', 'DELETE /api/v1/spaces/space-1']);
});

test('後始末の手順: spaces 以外の PATCH が 400 でも、個人メモの道には入らない (d1139)', async () => {
  // 400 を「個人メモだから」と読み替えて DELETE へ倒す枝は、`/api/v1/spaces/` の時だけ。
  // 組織・プロジェクトの archive が 400 で断られた時に DELETE を撃つと、消してはいけない
  // 資源を消しに行く（`spaces/` の判定を外すと、この試験が赤くなる）。
  const own = fakeHttp({ patch: [400] });
  const admin = fakeHttp({ patch: [400] });
  await assert.rejects(
    teardownCreatedResource(
      {
        method: 'PATCH',
        path: '/api/v1/organizations/org-1',
        own: { method: 'PATCH', path: '/api/v1/organizations/org-1' },
      },
      own,
      admin,
    ),
    /PATCH \/api\/v1\/organizations\/org-1 failed: 400/,
  );
  // 持ち主の DELETE は撃たない（PATCH の 1 回ずつだけ）。
  assert.deepEqual(own.calls, ['PATCH /api/v1/organizations/org-1']);
  assert.deepEqual(admin.calls, ['PATCH /api/v1/organizations/org-1']);
});
