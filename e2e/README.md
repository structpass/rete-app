# rete E2E テスト

権限境界ジャーニーの退行ガード。将来の改修でガードが外れた時に即落ちする。

## 再起動直後のログイン確認

開発環境の再起動が終わったら、他のE2Eより先に次を実行する。画面から開発用管理者で
1回ログインし、ホームへの移動と再読込後の認証維持を確認する。

```powershell
cd D:/Dev/product/rete/e2e
npm run test:startup-login
```

前提はReteのfrontend（localhost:3010）・backend（localhost:3011）・開発DBと、
既存の開発用管理者。Chromium未導入なら `npx playwright install chromium` を先に実施する。
通常の `npm test` と異なり、セッションの事前生成・再利用・fixture reset・自動再試行は行わない。
サーバーやPCの再起動自体はこの検査では行わず、既存の開発環境の起動手順を使う。

結果はリポジトリ直下の `tmp/startup-login/` のテスト別フォルダに保存する。
成功・失敗とも `result.json` に開始/終了時刻（UTC）、画面URL、確認段階、ログイン応答の状態、
失敗時の応答文言と画面通知、通信失敗・画面実行エラーを残し、`screen.png` も保存する。
入力欄は画像で覆い、パスワード・cookie・応答本文全体・URLのquery/fragmentは保存しない。
実行ごとに別フォルダを作るため、次の検査でも前回分は残る。失敗時は**再起動・再試行の前に**
エラー文・URL・時刻とその回のフォルダを決定へ記録する。

終了コード0だけを合格とする。MFA・パスワード変更画面へ進んだ場合も通常ログインの合格にはせず、
設定を自動で変えずに状況を記録する。失敗しても繰り返しログインせず、文言・応答状態から
画面/通信/認証/DBのどこで止まったかを切り分ける。

記録処理の回帰確認は、稼働中の開発画面に対して
`npx playwright test --config startup-login.config.ts recording.spec.ts` を使う。
ブラウザ内でログイン応答だけを503へ差し替えるため、実際の認証失敗回数は増やさない。

## ローカル実行手順

```
cd e2e
npm install
npm test
```

`npm test` の内訳:

1. `bddgen test` — `.feature` ファイルから playwright テスト `.spec.js` を生成
2. `playwright test --config playwright.config.ts` — globalSetup で全ユーザーのセッションを事前生成し、全 spec を実行

### 画面の点検（`@screen`・d784）

通信の応答だけでは画面の破損は捕まらない（実測 2026-10-25: 画面 6 枚が 500 で真っ白の間に、
シナリオは緑のまま・d784）。`features/zz-screen.feature` は実ブラウザで主要な画面 5 枚
（`/hub`・`/hub/faq`・`/desk`・`/files`・`/settings`）を開き、次を 1 本で判定する。

| 見るもの     | 期待                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| 白い画面     | 本文がほぼ無い空白の画面にならない（本文 50 字以下は赤）                         |
| 壊れた表示   | 「この画面は壊れています」の表示（`data-screen-broken`・d785）が出ていない       |
| 押し戻し     | ログイン画面へ押し戻されない（パスワード欄・`Rete Login` の見出しで見分ける）    |
| 例外の枠     | `Application error` などの例外表示、画面の実行時エラーが無い                     |
| 導線         | ホームに掲示板・カレンダー・FAQ の行き先が出る。本文が殻だけ（200 字以下）でない |
| 止まった通信 | 画面の置き場（:3010）への通信が失敗していない                                    |
| 描き上がり   | 1 枚あたり 15 秒を超えない                                                       |

- 実行は `npm test` / `npm run test:fast` に含まれる（project `screen`）。API だけのシナリオは従来どおりブラウザを起動しない。
- 1 本だけ回す時は `npx playwright test --config playwright.config.ts --project=screen`。
- 画面の置き場は `E2E_FRONTEND_URL`（既定 `http://localhost:3010`）。cookie は backend 用の保存済みセッションを画面の置き場へ向け直して使う。
  置き場は、既定の名前（localhost）で開けなければもう一方のローカル名（127.0.0.1）でも試す。
- 対象から外した画面は `docs/scenarios/tracks/08-screen.md` §2 に書く（カレンダーは開発機の起動直後の初回だけ 35 秒前後かかるため）。

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

`npm run test:ui`（`ui-sso` project）は上記に加え、**reference FE/BE（3000/3001）** の2スタック稼働を要する。Rete Dev Watchdog（`project_rete_dev_watchdog`）が target 3 系統を常時充足する想定。**不達なら `test.skip` で明示スキップ（red にしない）**。

## 対象ジャーニー

| Feature ファイル           | 対応シナリオ                | 退行ガード対象                                                                                                                                                   |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-session.feature`     | S-AUTH-01/06/07             | ログイン成立・未ログインの遮断（`/auth/me` は 200+null）・ログアウト後の失効                                                                                     |
| `home.feature`             | S-HOME-01/04/07/08/10/11/12 | 掲示板の書き込み権限（HomeWriteGuard）・タグの種別スコープ・お気に入り・予定の楽観ロック（revision）                                                             |
| `desk.feature`             | S-DESK-02/05/06/07/11/14    | リアクションのトグル・タスク移動（数値 id）・所有者境界（他人の発話は 403 / ADMIN は通る）・使用中分類の削除 409                                                 |
| `files.feature`            | S-FILE-03/05/06/09/10       | 版の追加（同名で versionNo +1）・タグの全置換と一括追加・横断検索・非空フォルダの削除 409                                                                        |
| `settings.feature`         | S-SET-01/03/05/07/08/12/13  | 設定の管理者境界・IP 許可リストの CIDR 検証・監査の 92 日上限・招待の二重発行 400・所属の増減で可視が変わる・自己降格の拒否                                      |
| `scope.feature`            | S-SPC-01〜05/07             | 組織/PJ/チャネルの作成権限・招いた人だけが届く・越境は 404（一覧は 403）・配下ありの組織削除 409                                                                 |
| `admin-authz.feature`      | P5-01/02/04/11              | @Roles(ADMIN) / 自己降格チェック                                                                                                                                 |
| `file-permissions.feature` | S-FILE-10                   | @Roles(ADMIN) on PATCH /files/settings                                                                                                                           |
| `settings-authz.feature`   | S-SET-07                    | @Roles(ADMIN) on settings 書き込み                                                                                                                               |
| `space-scope.feature`      | S-SPC-05                    | membershipRepo 可視性チェック                                                                                                                                    |
| `setup-admin.feature`      | P0-01/02/10/11/12           | 管理者設定 + 器作成の幸せ道（cmn-0054）                                                                                                                          |
| `partner-scope.feature`    | P3c-01/02/03/04             | 社外連携 権限境界（cmn-0055）                                                                                                                                    |
| `org-change.feature`       | P4-01/03/06/09/10-11        | 組織変更 運用イベント: 退職ロック即時失効 / 部署移動 / 脱退復帰 / チャネル追加認可 / 参加者増減の可視トグル（cmn-0140）                                          |
| `mfa-login.feature`        | P2-02/03                    | MFA ログイン幸せ道（cmn-0139）                                                                                                                                   |
| `daily-hub.feature`        | DAILY-HUB-01/02             | セッション健全＋お知らせフルライフサイクルの幸せ道（cmn-0138）                                                                                                   |
| `daily-collab.feature`     | DAILY-COLLAB-01/02/03       | chat/task/file 基本操作の幸せ道（cmn-0138）                                                                                                                      |
| `ui/sso.spec.ts`           | SSO-PWD / SSO-SEAMLESS      | SSO 横断ジャーニー（reference RP × rete IdP）の UI-E2E — reference 全体の入場不能となる SSO 退行ガード（cmn-0141）。**CI 未配線・前提不達時は skip**（§CI 連携） |
| `zz-screen.feature`        | S-SCR-01/02/03              | 画面の点検 — ログイン後に主要な画面 5 枚が白くならず、行き先と本文が出る（実ブラウザ・project `screen`・d784。§画面の点検）                                      |

### ケース定義との対応

`docs/scenarios/tracks/*.md` の実施ケースの `実行` 欄に、このディレクトリの feature のタグを書く。
どのユースケースがどの feature で確かめられているかは `docs/scenarios/index.md` §3 が一覧。

- **step の追加は `steps/extended.steps.ts`**。既存の `POST … を body … で叩く` は「JSON.parse → 文字列値だけ置換」
  の順なので、`{"categoryId":{{catId}}}` のような**数値位置**のプレースホルダを書けない。
  数値を埋める時は `… を body … で置換してから叩く` を使う（文字列置換 → parse の順）。
- **multipart のアップロードは専用 step**（文脈の `Content-Type: application/json` を外した別 context で送る）。
- **後始末（teardown）に登録してよいのは「id から消し口が組み立てられる資源」だけ**。予定（削除に revision が要る）・
  スコープ（PATCH archive が要る）・messages（親の削除で連鎖する）は登録せず、シナリオ内で明示的に消す。
  同名アップロードは同じ file id を返すため、二重登録すると後始末が 404 で落ちる（step 側で重複を弾いている）。

### 途中でも戻す設定

`PATCH /api/v1/files/settings` のように**全ユーザー共通の単一行を作り変える**手順は、シナリオが途中で
落ちると設定が戻らず、後続のシナリオや手元の操作を壊す。該当行の末尾へ

```gherkin
When PATCH "/api/v1/files/settings" を body "{\"allowedExtensions\":[]}" で叩く => システムADMIN "admin@rete.local"
```

と書くと、その行は「後始末でも流し直す手順」として登録される（`=> …` は叩く人の指定で、手順の本文ではない）。
シナリオが最後まで進んだ時は流さない（二重実行しない）。判定は `support/deferred-teardown.ts`、
手順の配線は `steps/extended.steps.ts`、後始末の呼び出しは `support/fixtures.ts`。

### setup-admin.feature の除外シナリオ

- **P0-05 / P0-06（MFA enforced / 未設定者の誘導）** — otplib 等の追加依存と MFA 有効 seed ユーザーが
  必要。`cmn-0139` へ退避（waiting_c2）。
- **P0-09（非 ADMIN によるセキュリティ設定変更）** — `settings-authz.feature` で別途検証済。
- **P0-03 / P0-04（IP 遮断未配線 / パスワード違反 UX 未確定）** — 仕様未確定項目。
- **P0-13 / P0-14 / P0-15 / P0-16** — 事業部初期払い出しフロー未定義 / SSO 連携 / silent SSO deferred / 個人 DM 不可視。

### partner-scope.feature の除外シナリオ

- **SSO 横断ジャーニー（reference OIDC）** — OIDC は browser redirect + consent UI の UI フローで、API のみだと interaction endpoint の内部手順模倣＝実装詳細密結合となり退行ガードとして脆い。かつ reference 別スタック起動前提が本 e2e README の前提（rete backend のみ）を破る。`cmn-0141`（SSO 横断ジャーニーの UI-E2E 化検討）へ退避。
- **招待→受諾の UI ジャーニー** — メールを画面で開く操作は対象外。発行からメール経由の受諾、所属とログインまでは下記の隔離 API 試験で自動確認する。

#### 招待の受諾を隔離環境で試す

専用の PostgreSQL と Mailpit、別ポートの backend を使う。既存の開発 DB、メール受信箱、セッションを使わない。ポートが使用中の場合は起動せず、既存環境へ向けない。Docker の `postgres:16-alpine` と `axllent/mailpit:latest` が必要。

Windows の PowerShell をリポジトリのルートで開き、`cd packages/backend` の後に `node test/run-invite-accept.mjs` を実行する。専用の一時 DB・メール受信先・ファイル保存先を作り、API をループバックに限定して起動する。ポートが使用中なら失敗して停止する。作成したコンテナ ID だけを終了時に破棄する。

試験は発行メールから値を読み、受諾、所属、再使用拒否と本人のログインを確認する。メール本文や値は出力しない。
強制終了などで後始末が走らなかった時は、今回の実行が作った `invite-db-` / `invite-mail-` コンテナをラベルと作成時刻で特定してから、その ID に対して `docker rm -f -v` を実行する。他のコンテナは消さない。

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
    auth.ts         認証ヘルパー（セッション再利用・画面の置き場への cookie の向け直し）
    fixtures.ts     playwright-bdd カスタム fixture（API の world・画面の screen）
    global-setup.ts 全ユーザーのセッション事前生成
  playwright.config.ts
  package.json
  .cache/
    bdd/            bddgen が生成した .spec.js（git 除外）
    sessions/       globalSetup が保存したセッション（git 除外）
  .report/          playwright HTML レポート（git 除外）
```

## 使用ユーザー（seed 済み）

| キー     | メール                       | system role | 備考                                                                                                                         |
| -------- | ---------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| admin    | admin@rete.local             | ADMIN       | bootstrap admin                                                                                                              |
| member   | of-admin@struct-pass.example | MEMBER      | org-change / space-scope の越境・可視シナリオで使用                                                                          |
| whUser   | wh-user@struct-pass.example  | MEMBER      | 非メンバー PJ のチャネルが見えないこと（S-SPC-05）                                                                           |
| newcomer | newcomer@struct-pass.example | MEMBER      | 異動・脱退で可視が切れること（org-change）                                                                                   |
| mfaUser  | mfa-user@rete.local          | MEMBER      | mfa-login.feature 専用（MFA 無効で seed 焼き込み・シナリオ内 setup）                                                         |
| tanaka   | tanaka@struct-pass.example   | ADMIN       | org-change.feature 退職ロック対象（シナリオ冒頭で復元後に専用セッションを確立・事前生成4ユーザーのセッションを壊さないため） |

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

`ui/sso.spec.ts`（reference 全損＝SSO 退行の唯一の自動ガード）は、行き先スタックに到達できない時 `test.skip(...)` で明示スキップする。skip は赤にしないため、**前提を整えずに CI へ載せると実行 0 件で緑になる**。

現方針: **本体スイートは CI に載せない**（必要になった時点で載せる）。載せる時に足すものは次のとおり。

| 項目                  | 足すもの                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 実行ステップ          | `e2e` job へ `npm run test:authz`（= `test`）と `npm run test:ui`                                                           |
| Playwright ブラウザ   | 現行 install は `npm ci --ignore-scripts` のみで browser を持たない。`npx playwright install --with-deps chromium` が要る   |
| スタック（authz 系）  | rete FE(3010) / BE(3011)・DB・seed。`pretest` / `pretest:authz` の `reset:e2e-fixtures` が既知ベースラインへ戻す            |
| スタック（ui-sso 系） | 上記に加えて reference FE(3000) / BE(3001)（→ §UI-E2E の追加前提）                                                          |
| ホスト名              | SSO 経路は `localhost` 固定。`127.0.0.1` を混ぜると cookie ドメイン不一致と CORS で壊れる＝スタックの置き方で最初に効く制約 |
| throttle 素通し       | 通し実行は login 系 5req/60s で 429 が出る。backend へ `E2E_THROTTLE_BYPASS="true"`（→ §レート制限の素通し）                |
| skip を緑にしない検査 | skip 件数を検査して落とす（前提不達のまま実行 0 件で緑になるのを防ぐ）                                                      |
| 実行経路の固定        | CI 側のステップは `scripts/check-ci-workflow.test.mjs` へ固定を足す（knip・format・`test:unit` の3本と同じ運用）            |

CI の `test` job は DB へ接続しない（Prisma Client の生成のみ）ため、これらスタックを起動する仕組みは現状どの job にも無い。
