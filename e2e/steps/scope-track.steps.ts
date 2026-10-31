/**
 * rete E2E — スコープトラック（docs/scenarios/tracks/06-scope.md）の追加ステップ（d776 / d823）
 *
 * 既存のステップで書けなかった「保留（HOLD）の印」を足す。シナリオの中で「ここから先は
 * 未確定の値に当たったので状態を進めない」と分かった時、**状態を動かす行より手前で** この行を
 * 置くと、次の 2 つが同時に成り立つ:
 *
 *   - 実行が緑のまま最後まで進む（赤くして次の実行を止めない）
 *   - ユースケースの印が動かない（README §5 の「状態は実行の結果でだけ動かす」を保ったまま、
 *     判定は ⚠ で残す）
 *
 * 状態を動かす行（markVerifiedCase）は throw で止まるが、保留は止めない。読み分けは「実測して
 * 挙動が決まった」ではなく「未確定なので確認済みにしない」という文言で行う。
 *
 * 重複定義は playwright-bdd が禁止するため、パターンは既存（common / extended / org-change /
 * auth-track）と衝突しない語順にしてある。引数は入口で 1 度 resolvePlaceholders する（cmn-0397）。
 *
 * d823: S-SPC-08 の「他人の個人メモ・DM・未所属の器のどれも、存在しない器と同じ応答になる」を
 * 見分けられるよう、他人の個人メモと、見えないチャネルを後始末つきで用意する。用意したものは
 * `world.createdIds` に積み、後始末でしまう（チャネル→プロジェクト→組織の順・`support/fixtures.ts`）。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { When, Then } from '../support/fixtures';
import { resolvePlaceholders } from '../support/placeholders';
import { echoesExternalId, responseFingerprint } from '../support/response-fingerprint';

When('未確定なので {string} の結果は保留する', async ({ world }, trackIdArg: string) => {
  const trackId = resolvePlaceholders(trackIdArg, world.uniqueNames);
  if (!world.heldCases.includes(trackId)) world.heldCases.push(trackId);
});

// 「保留」と「確認済み」を同じ行に見せない（保留したものを確認済みと読み違えない）。
Then('{string} は確認済みにしない', async ({ world }, trackIdArg: string) => {
  const trackId = resolvePlaceholders(trackIdArg, world.uniqueNames);
  if (world.verifiedCases.includes(trackId)) {
    throw new Error(
      `${trackId} は保留したのに確認済みとして控えられている（状態を動かさないという前提が崩れている）`,
    );
  }
});

// ----------------------------------------------------------------
// 他人の個人メモ（S-SPC-08）
// ----------------------------------------------------------------

/**
 * 別の接続（控え済みのセッション）で個人メモを作り、id を控える。
 * シナリオ本体の接続と重ならないログインを使いたい時に使う（`org-change.steps.ts` の
 * 「seed ユーザー … としてログインし、セッションと自分の id を … に保存する」で控えた接続を取る）。
 * 名前はシナリオ側で一意名として控えておく（`一意名 … を生成して … に保存する`）。控えが無ければ
 * 実行ごとの一意名を作る（個人メモは消す口が無いため、名前だけは重ねない）。
 */
When(
  '保存セッション {string} で 管理者の個人メモを一意名 {string} で作り id を {string} に保存する',
  async ({ world }, sessionArg: string, nameKeyArg: string, idKeyArg: string) => {
    const sessionKey = resolvePlaceholders(sessionArg, world.uniqueNames);
    const ctx = world.sessions[sessionKey];
    if (!ctx) throw new Error(`保存セッション ${sessionKey} が見つからない`);
    const nameKey = resolvePlaceholders(nameKeyArg, world.uniqueNames);
    const idKey = resolvePlaceholders(idKeyArg, world.uniqueNames);
    if (!world.uniqueNames[nameKey]) {
      world.uniqueNames[nameKey] =
        `e2e-memo-own-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    }
    const created = await ctx.post('/api/v1/spaces', {
      data: { kind: 'PERSONAL_MEMO', name: world.uniqueNames[nameKey] },
    });
    world.lastResponse = created;
    if (!created.ok()) {
      throw new Error(`個人メモの作成に失敗: ${created.status()} ${await created.text()}`);
    }
    const body = (await created.json()) as { data?: { id?: string } };
    if (!body.data?.id) throw new Error('個人メモの作成の応答に id が無い');
    world.uniqueNames[idKey] = body.data.id;
  },
);

// ----------------------------------------------------------------
// 見えないチャネルの用意（S-SPC-08）
// ----------------------------------------------------------------

/**
 * 管理者が新しい組織・プロジェクト・チャネルを 1 つずつ作り、チャネルの id を控える。
 * 誰も所属していない組織の下なので、一般ユーザー（`wh-user`）からは未所属の器になる。
 * 作ったものは `world.createdIds` に積み、後始末でしまう（物理削除ではなく archive）。
 *
 * 接続は「保存セッション で …」の形で渡す（シナリオ本体の接続を一般ユーザーのまま残すため）。
 */
When(
  '保存セッション {string} で 管理者が新しい組織からチャネルを 1 つ作って id を {string} に保存する',
  async ({ world }, sessionArg: string, idKeyArg: string) => {
    const sessionKey = resolvePlaceholders(sessionArg, world.uniqueNames);
    const ctx = world.sessions[sessionKey];
    if (!ctx) throw new Error(`保存セッション ${sessionKey} が見つからない`);
    const idKey = resolvePlaceholders(idKeyArg, world.uniqueNames);
    const stamp = Date.now().toString(36).slice(-6);
    const name = `e2e-unseen-${stamp}`;

    const org = await ctx.post('/api/v1/organizations', { data: { name: `${name}-org` } });
    if (!org.ok()) throw new Error(`組織の作成に失敗: ${org.status()} ${await org.text()}`);
    const orgId = ((await org.json()) as { data?: { id?: string } }).data?.id;
    if (!orgId) throw new Error('組織の作成の応答に id が無い');

    const project = await ctx.post('/api/v1/projects', {
      data: { name: `${name}-pj`, organizationId: orgId },
    });
    if (!project.ok()) {
      throw new Error(`プロジェクトの作成に失敗: ${project.status()} ${await project.text()}`);
    }
    const projectId = ((await project.json()) as { data?: { id?: string } }).data?.id;
    if (!projectId) throw new Error('プロジェクトの作成の応答に id が無い');

    // チャネルは管理経路（system ADMIN 専用・所属を問わない）で作る。通常の作成口はプロジェクトの
    // 管理者であることを求めるが、管理経路で作ったプロジェクトには所属行が無く、通常の口は通らない。
    const channel = await ctx.post('/api/v1/spaces/admin', {
      data: { kind: 'CHANNEL', name: `${name}-ch`, projectId },
    });
    if (!channel.ok()) {
      throw new Error(`チャネルの作成に失敗: ${channel.status()} ${await channel.text()}`);
    }
    const channelId = ((await channel.json()) as { data?: { id?: string } }).data?.id;
    if (!channelId) throw new Error('チャネルの作成の応答に id が無い');

    // 後始末は LIFO（チャネル → プロジェクト → 組織）。物理削除はチャネルだけが対象なので archive を使う。
    world.createdIds.push({ method: 'PATCH', path: `/api/v1/spaces/admin/${channelId}` });
    world.createdIds.push({ method: 'PATCH', path: `/api/v1/projects/admin/${projectId}` });
    world.createdIds.push({ method: 'PATCH', path: `/api/v1/organizations/admin/${orgId}` });
    world.uniqueNames[idKey] = channelId;
    world.lastResponse = channel;
  },
);

// ----------------------------------------------------------------
// 応答の指紋（S-SPC-08）
// ----------------------------------------------------------------

/**
 * 直前の応答を「状態と本文の形」の指紋として控える。
 * 比べる対象と除くものは `support/response-fingerprint.ts`（正本）に書いてある。
 * 本文の生値（id など）は控えないため、同じ呼び方を 2 回しても同じ形なら一致する。
 */
When('直前の応答の状態と本文を {string} に控える', async ({ world }, keyArg: string) => {
  const key = resolvePlaceholders(keyArg, world.uniqueNames);
  if (!world.lastResponse) throw new Error('レスポンスが未取得');
  const res = world.lastResponse;
  const text = await res.text();
  world.uniqueNames[`fingerprint:${key}`] = responseFingerprint(res.status(), text);
  world.uniqueNames[`fingerprintText:${key}`] = text;
  world.uniqueNames[`fingerprintTappedIds:${key}`] = (world.tappedIds ?? []).join(',');
});

/** 控えた指紋がもう一方の指紋と一致することを確かめる（存在しない器と同じ応答になっている）。 */
Then(
  '控えた {string} は {string} と応答の形が同じである',
  async ({ world }, leftArg: string, rightArg: string) => {
    const left = resolvePlaceholders(leftArg, world.uniqueNames);
    const right = resolvePlaceholders(rightArg, world.uniqueNames);
    const a = world.uniqueNames[`fingerprint:${left}`];
    const b = world.uniqueNames[`fingerprint:${right}`];
    if (!a || !b)
      throw new Error(`指紋が控えられていない（${left}=${a ?? 'なし'} / ${right}=${b ?? 'なし'}）`);
    // 叩いた id が本文へ写っていないこと（存在するものとして扱われていない）。
    // 控えに叩いた id が無いまま比べると、この照合が黙って効かなくなるので止める。
    const capturedIds = world.uniqueNames[`fingerprintTappedIds:${left}`];
    if (capturedIds === undefined) {
      throw new Error(`${left} に、叩いた id の控えが無い（照合が効かないまま比べている）`);
    }
    const tapped = capturedIds.split(',').filter(Boolean);
    const echoed = echoesExternalId(world.uniqueNames[`fingerprintText:${left}`] ?? '', tapped);
    if (echoed) {
      throw new Error(`${left} の本文に、叩いた id（${echoed}）がそのまま写っている`);
    }
    if (a !== b) {
      throw new Error(
        `${left} と ${right} の応答の形が違う（${a} / ${b}）。存在しない器と他人の器を読み分けられる`,
      );
    }
  },
);

/** 右の指紋が左の指紋と違うことを確かめる（見分け側の陰性対照）。 */
Then(
  '控えた {string} は {string} と応答の形が違う',
  async ({ world }, leftArg: string, rightArg: string) => {
    const left = resolvePlaceholders(leftArg, world.uniqueNames);
    const right = resolvePlaceholders(rightArg, world.uniqueNames);
    const a = world.uniqueNames[`fingerprint:${left}`];
    const b = world.uniqueNames[`fingerprint:${right}`];
    if (!a || !b)
      throw new Error(`指紋が控えられていない（${left}=${a ?? 'なし'} / ${right}=${b ?? 'なし'}）`);
    if (a === b) {
      throw new Error(
        `${left} と ${right} の応答が同じ（${a}）。見分けられるはずの 2 つが区別できていない`,
      );
    }
  },
);

/**
 * 存在しない器の id を 1 つ作って控える（UUID v4）。
 * 形の違う id は入力検査で 400 になり、存在しない器の応答と比べられないため、形を揃えた id を使う。
 */
When('新しい UUID を {string} に保存する', async ({ world }, keyArg: string) => {
  const key = resolvePlaceholders(keyArg, world.uniqueNames);
  world.uniqueNames[key] = randomUUID();
});
