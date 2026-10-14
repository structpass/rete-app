# rete E2E テスト

権限境界ジャーニーの退行ガード。将来の改修でガードが外れた時に即落ちする。

## ローカル実行手順

```
cd e2e
npm install
npm test
```

`npm test` の内訳:

1. `bddgen test` — `.feature` ファイルから playwright テスト `.spec.js` を生成
2. `playwright test --config playwright.config.ts` — globalSetup で全ユーザーのセッションを事前生成し、全 spec を実行

### 高速実行（普段の赤緑確認はこちら）

```
npm run test:fast
```

`npm test` は毎回 bddgen 生成・fixture reset・HTML レポートを無条件に実行する。この3つは
テスト件数に関係なく固定でかかる。`test:fast` は入力が変わっていなければスキップする。

| 実行                                        | wall clock（実測・3回中央値） |
| ------------------------------------------- | ----------------------------- |
| `npm test`                                  | 12.4s                         |
| `npm run test:fast`（キャッシュ有効）       | 10.1s                         |
| `npm run test:fast`（キャッシュ無効・初回） | 15.0s                         |

| 段階          | スキップ条件                                                                                    | 外れた時     |
| ------------- | ----------------------------------------------------------------------------------------------- | ------------ |
| bddgen        | `features/`・`steps/`・`playwright.config.ts`・`support/fixtures.ts` の内容ハッシュが前回と一致 | 自動で再生成 |
| fixture reset | 前回成功から 30 分以内（TTL）                                                                   | 自動で再実行 |
| HTML レポート | 既定では出さない（`--report` で出力）                                                           | —            |

- 判定は mtime ではなく**ファイル内容のハッシュ**。取りこぼしは起きない。
- 迷う場合・キャッシュ破損時は必ず実行する側に倒す。
- `npm run test:fast -- --force` で両キャッシュを無視して全段階を実行する。
- `npm run test:fast:report` で HTML レポートも出す（`.report/`）。
- 追加の playwright 引数はそのまま渡る（例: `npm run test:fast -- --grep P4`。1件だけなら 0.7s で返る）。
- **CI は `test:fast` を使わない**（キャッシュに依存させない）。CI が実行するのは `type-check` と `test:unit` で、本体スイートは呼ばれていない（→ §CI 連携）。
- キャッシュは `.cache/fast/state.json`（git 除外）。壊れても削除すれば初回動作に戻るだけ。

### 型検査のみ回したい時

```
npm run type-check
```

e2e/tsconfig.json の `include` が steps / support / ui / playwright.config.ts の 4 経路を全て
含むことは `scripts/check-e2e-type-check-scope.test.mjs` で固定されている（cmn-0272 項目2）。
include を縮める（例: `["steps/**/*.ts"]`）と CI が赤くなる。

## 前提

- rete dev server が稼働中（backend: `http://127.0.0.1:3011`）
- DB に seed データが投入済み（`pnpm prisma:seed`）

### 固定フィクスチャの復元（`pretest` が自動実行）

dev DB は e2e 専用ではなく手動デバッグ・UI 操作と共有されているため、E2E の前提が
外から崩れることがある。`reset:e2e-fixtures` が実行前に既知のベースラインへ戻す:

- Space(30)=入荷 / Space(31)=出荷 の `archivedAt = null`
- **残骸ユーザーグループの所属を除去**（下記）

`seed.ts` はユーザーグループを一切作らない。dev DB にあるグループは手動操作・UI 検証・
過去のチケット検証が残したもの＝すべて残骸。set-0164（ユーザーグループ管理の新設）で
実効ロールが「個別 membership **OR** グループ経由 grant」に変わり、残骸グループが seed
ユーザーをメンバーに持っていると **grant 経由で可視範囲が広がる**。

実測例: 「テストグループ」の PROJECT(..22) grant により `wh-user` が非メンバー PJ の
チャネル一覧を 200 で取得でき、`S-SPC-05` が赤化した（grant を1行消すと 403 に戻る）。
実装側の認可（`spaces.service.ts` の `findEffectiveMembership` ガード）は正しい。

グループ本体は消さない（UI 検証中の他セッションの作業を壊しうるため）。外すのは
seed ユーザーの所属だけ。冪等（既にベースラインなら no-op ログのみ）。

### レート制限の素通し（cmn-0395・推奨）

e2e 通し実行は login 系のレート制限（5req/60s）で throttle 由来の 429 が出ることがある。
**開発機では素通しを有効にして走らせる**（backend の `.env` に追記）:

```
E2E_THROTTLE_BYPASS="true"
```

- 有効なまま起動すると backend の起動ログに warn 1 行が出る（素通しが効いている状態）。
- 本番（`NODE_ENV=production`）では無効（立てても効かない）。アカウント凍結（login-lockout）は
  素通しの対象外＝効き続ける。
- 素通しを入れていない機械でも e2e は動く（セッション事前生成・シナリオ集約・`workers:1` の
  構造が throttle 消費を抑える）。素通しは「確実に緑にしたい時の追加手段」。

### UI-E2E（cmn-0141）の追加前提

`npm run test:ui`（`ui-sso` project）は上記に加え、**reference FE/BE（3000/3001）** と **board v2（3072・`/v2.html`）** の3スタック稼働を要する。Rete Dev Watchdog（`project_rete_dev_watchdog`）が target 3 系統を常時充足する想定。**不達なら `test.skip` で明示スキップ（red にしない）**。

## 対象ジャーニー

| Feature ファイル           | 対応シナリオ           | 退行ガード対象                                                                                                                                                   |
| -------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-authz.feature`      | P5-01/02/04/11         | @Roles(ADMIN) / 自己降格チェック                                                                                                                                 |
| `file-permissions.feature` | S-FILE-10              | @Roles(ADMIN) on PATCH /files/settings                                                                                                                           |
| `settings-authz.feature`   | S-SET-07               | @Roles(ADMIN) on settings 書き込み                                                                                                                               |
| `space-scope.feature`      | S-SPC-05               | membershipRepo 可視性チェック                                                                                                                                    |
| `setup-admin.feature`      | P0-01/02/10/11/12      | 管理者設定 + 器作成の幸せ道（cmn-0054）                                                                                                                          |
| `partner-scope.feature`    | P3c-01/02/03/04        | 社外連携 権限境界（cmn-0055）                                                                                                                                    |
| `org-change.feature`       | P4-01/03/06/09/10-11   | 組織変更 運用イベント: 退職ロック即時失効 / 部署移動 / 脱退復帰 / チャネル追加認可 / 参加者増減の可視トグル（cmn-0140）                                          |
| `mfa-login.feature`        | P2-02/03               | MFA ログイン幸せ道（cmn-0139）                                                                                                                                   |
| `daily-hub.feature`        | DAILY-HUB-01/02        | セッション健全＋お知らせフルライフサイクルの幸せ道（cmn-0138）                                                                                                   |
| `daily-collab.feature`     | DAILY-COLLAB-01/02/03  | chat/task/file 基本操作の幸せ道（cmn-0138）                                                                                                                      |
| `ui/sso.spec.ts`           | SSO-PWD / SSO-SEAMLESS | SSO 横断ジャーニー（reference RP × rete IdP）の UI-E2E — reference 全体の入場不能となる SSO 退行ガード（cmn-0141）。**CI 未配線・前提不達時は skip**（§CI 連携） |

### setup-admin.feature の除外シナリオ

- **P0-05 / P0-06（MFA enforced / 未設定者の誘導）** — otplib 等の追加依存と MFA 有効 seed ユーザーが
  必要。`cmn-0139` へ退避（waiting_c2）。
- **P0-09（非 ADMIN によるセキュリティ設定変更）** — `settings-authz.feature` で別途検証済。
- **P0-03 / P0-04（IP 遮断未配線 / パスワード違反 UX 未確定）** — 仕様未確定項目。
- **P0-13 / P0-14 / P0-15 / P0-16** — 事業部初期払い出しフロー未定義 / SSO 連携 / silent SSO deferred / 個人 DM 不可視。

### partner-scope.feature の除外シナリオ

- **SSO 横断ジャーニー（reference OIDC）** — OIDC は browser redirect + consent UI の UI フローで、API のみだと interaction endpoint の内部手順模倣＝実装詳細密結合となり退行ガードとして脆い。かつ reference 別スタック起動前提が本 e2e README の前提（rete backend のみ）を破る。`cmn-0141`（SSO 横断ジャーニーの UI-E2E 化検討）へ退避。
- **board iframe postMessage** — 純フロント挙動で API レベル表現が構造的に不能。UI-E2E トラックへ退避（将来起票）。
- **招待→受諾フルジャーニー** — 生 token が API レスポンスに返らない設計（`packages/backend/src/modules/invite/invite.controller.ts:75-83,146-152` + `invite.service.ts:46-47,62`）で API テスト不能。招待受諾の UI ジャーニー化は別退避。

### mfa-login.feature の除外シナリオ

- **MFA 強制トグル（enforced 設定の管理者操作）** — settings-authz 系の管理者設定変更経路として別途検証対象。
- **OTP URI 改ざん耐性 / 暗号化鍵不備** — backend 単体テスト（mfa.service.spec / mfa.controller.spec）で担保。
- **MFA 復旧 UI（set-0033：admin mfa-reset の UI 経路）** — admin 操作 UI は cmn-0139 スコープ外（API で直接呼ぶ）。

## ディレクトリ構造

```
e2e/
  features/         .feature (Gherkin) ファイル
  steps/            ステップ定義 (TypeScript)
  ui/               UI-E2E 通常 spec（playwright-bdd なし・cmn-0141）
  support/
    auth.ts         認証ヘルパー（セッション再利用）
    fixtures.ts     playwright-bdd カスタム fixture
    global-setup.ts 全ユーザーのセッション事前生成
  playwright.config.ts
  package.json
  .cache/
    bdd/            bddgen が生成した .spec.js（git 除外）
    sessions/       globalSetup が保存したセッション（git 除外）
  .report/          playwright HTML レポート（git 除外）
```

## 使用ユーザー（seed 済み）

| キー     | メール                         | system role | 備考                                                                                                                         |
| -------- | ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| admin    | `admin@rete.local`             | ADMIN       | bootstrap admin                                                                                                              |
| member   | `of-admin@struct-pass.example` | MEMBER      | org-change / space-scope の越境・可視シナリオで使用                                                                          |
| whUser   | `wh-user@struct-pass.example`  | MEMBER      | 非メンバー PJ のチャネルが見えないこと（S-SPC-05）                                                                           |
| newcomer | `newcomer@struct-pass.example` | MEMBER      | 異動・脱退で可視が切れること（org-change）                                                                                   |
| mfaUser  | `mfa-user@rete.local`          | MEMBER      | mfa-login.feature 専用（MFA 無効で seed 焼き込み・シナリオ内 setup）                                                         |
| tanaka   | `tanaka@struct-pass.example`   | ADMIN       | org-change.feature 退職ロック対象（シナリオ冒頭で復元後に専用セッションを確立・事前生成4ユーザーのセッションを壊さないため） |

## HTML レポート確認

```
cd e2e && npm run report
```

## CI 連携

CI（`.github/workflows/test.yml` の `e2e` 独立 job）が実行するのは次の2つだけ:

| ステップ         | 実行内容             | 対象                                                             |
| ---------------- | -------------------- | ---------------------------------------------------------------- |
| Type check (E2E) | `npm run type-check` | `tsconfig.json` の include 4 経路（→ §型検査のみ回したい時）     |
| Unit test (E2E)  | `npm run test:unit`  | `support/__tests__/*.test.ts`（placeholders / sweep / teardown） |

本体スイート（`test` / `test:authz` / `test:ui`）は **CI から呼ばれていない**。workflow に `bddgen` も `playwright test` も無く、`npm test` を実行するステップも無い。

### 前提が無い時は赤ではなく緑になる

`ui/sso.spec.ts`（reference 全損＝SSO 退行の唯一の自動ガード）と `ui/backlog.spec.ts` は、行き先スタックに到達できない時 `test.skip(...)` で明示スキップする。skip は赤にしないため、**前提を整えずに CI へ載せると実行 0 件で緑になる**。

現方針: **本体スイートは CI に載せない**（必要になった時点で載せる）。載せる時に足すものは次のとおり。

| 項目                  | 足すもの                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 実行ステップ          | `e2e` job へ `npm run test:authz`（= `test`）と `npm run test:ui`                                                           |
| Playwright ブラウザ   | 現行 install は `npm ci --ignore-scripts` のみで browser を持たない。`npx playwright install --with-deps chromium` が要る   |
| スタック（authz 系）  | rete FE(3010) / BE(3011)・DB・seed。`pretest` / `pretest:authz` の `reset:e2e-fixtures` が既知ベースラインへ戻す            |
| スタック（ui-sso 系） | 上記に加えて reference FE(3000) / BE(3001) と board v2(3072)（→ §UI-E2E の追加前提）                                        |
| ホスト名              | SSO 経路は `localhost` 固定。`127.0.0.1` を混ぜると cookie ドメイン不一致と CORS で壊れる＝スタックの置き方で最初に効く制約 |
| throttle 素通し       | 通し実行は login 系 5req/60s で 429 が出る。backend へ `E2E_THROTTLE_BYPASS="true"`（→ §レート制限の素通し）                |
| skip を緑にしない検査 | skip 件数を検査して落とす（前提不達のまま実行 0 件で緑になるのを防ぐ）                                                      |
| 実行経路の固定        | CI 側のステップは `scripts/check-ci-workflow.test.mjs` へ固定を足す（knip・format・`test:unit` の3本と同じ運用）            |

CI の `test` job は DB へ接続しない（Prisma Client の生成のみ）ため、これらスタックを起動する仕組みは現状どの job にも無い。
