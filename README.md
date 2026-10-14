# Struct Rete

ストラクト・レーテ。Struct Pass エコシステムの**連結軸**を担うリファレンス実装。

> rete = ラテン語/イタリア語で「網」。学術的には精緻な微細網状構造（rete mirabile 等）を指す。

## 位置づけ

**Rete は StructPass リファレンスのサテライトシステム**である。本リポジトリはRete単独の公開版です。

- **個別呼称**：**Rete**（先頭大文字固定）
- **カテゴリ呼称**：**サテライトシステム**（本体に対し横並びで、エンドユーザーから見える独立プロダクト群の総称）
- **Referenceとの関係**：別のアプリ・DBとして配置し、ReferenceのログインはReteをOIDCの認証元として利用する。Referenceとの連携には別の実装と追加設定が必要です。

## 解く問題

システム開発は、なぜか「最後まで見えない」。設計書で完成形を想像し、関係者は Slack／Teams／メール／Excel に分かれ、システムを初めて触れるのは開発の終盤——認識のズレは、そこで大きな手戻りとなって現れます。

Rete はこの順序を逆転させる参照実装です。システムより先に顧客との回線を通し、本物の UI を見せながら、一緒に作っていく。想像してもらう開発から、触って決めてもらう開発へ。

構想の全体像（従来開発の課題・繋ぐ手段・モック・第4の道）は [Rete構想スライド](./Rete構想.html) で説明しています。

## 画面で見るRete

日々の連絡をHomeで確認し、Deskで会話とタスクをつなぎ、Filesで資料を共有します。Settingsでは、利用する組織とアカウントの設定をまとめて管理します。

以下はローカルのデモ環境を撮影した画面例です。表示名・業務内容はサンプルです。表示されるメニューや操作は、利用者の所属・権限・接続設定によって変わります。

### Home — 共通の入口と掲示板

Hubの入口となるHomeで、全体へのお知らせとFAQを確認します。左に一覧、右に本文を表示し、画面上部のタブから各サブシステムへ移動できます。

![Homeの掲示板。お知らせ一覧と選択した本文を左右に表示](./docs/screenshots/home.png)

### Desk — 会話とタスクを同じ場所に

組織やプロジェクトのチャネルを選び、相談の内容と担当者・期日・進捗を一緒に確認します。会話から実行する仕事へつなぐ画面です。

![Deskの業務チャネル。会話とタスクの状況を同じ画面で確認](./docs/screenshots/desk.png)

### Files — 資料を整理して共有

フォルダごとに資料を整理し、更新者・更新日・版数を一覧で確認します。タグで探したり、Deskの会話へファイルを共有したりできます。画面上のタブ名は「File」です。

![Filesの共有ドキュメント。フォルダと資料の更新情報を一覧表示](./docs/screenshots/files.png)

### Settings — 利用環境を管理

テナントの表示名・表示色、組織、メンバーなどの設定を管理します。画面例はテナント設定です。画面上のタブ名は「Setting」です。

![Settingsのテナント設定。表示名と表示色を設定する画面](./docs/screenshots/settings.png)

Referenceは別のアプリです。連携の利用条件は、このREADMEの「Referenceと一緒に評価する」を参照してください。

## 構成

```
Struct Hub（共通ダッシュボード + ユーザーID）
  ├ Struct Reference（業界参照実装、別リポ: reference・OIDC RP）
  ├ Home（通知/ダッシュボード）
  ├ Desk（チャット×タスク融合 + 添付 + 通知）
  ├ Files（共有 + バージョン履歴 + 権限）
  └ Settings（テナント設定 + RBAC + 招待 + 監査ログ）
```

各サブシステムは OIDC 標準で Hub と接続。アドオン提供可能な疎結合構成。

## 設計原則

1. **OSS のソースは使わない** — 機能デザイン・セキュリティの参考情報としてのみ参照
   （※ OIDC 等プロトコル準拠の認証ライブラリ／SDK の部品としての利用は許容。製品まるごとの組み込みは不可）
2. **絞って磨く** — 連結に必要な最小集合だけ実装。機能を増やすことは敗北
3. **アドオン間の疎結合** — ユーザーID だけ共有、システム間通信は最小限
4. **OIDC 標準準拠** — 任意のサブシステムを別実装に載せ替え可能（脱出可能性）
5. **アドオン売り** — 各サブシステム独立提供可能

## 実装構成

pnpm monorepo（TypeScript）。

```
packages/
├ backend/   ← NestJS REST API（Prisma + PostgreSQL）
├ frontend/  ← Next.js App Router（React 19 + Tailwind CSS）
└ shared/    ← 共通型定義（TaskStatus 等の SSOT）
```

アーキテクチャの不変条件：Response DTO 境界 / Repository 分離（Entity → DTO の mapping は Service）/
共通エラーフィルタ。

実装済みの主要機能：OIDC 認証基盤（Rete=IdP）・Desk（チャット×タスク融合）・
Files（版管理・タグ・添付）・HOME 掲示板・Settings（テナント設定 + RBAC + MFA）・
PostgreSQL セッション永続化。

公開版はこれらのコードとローカル評価用データを提供します。第三者の実データ・実運用資格情報を投入する前に、利用条件と接続先・認証設定を確認してください。MFA、メール送信、Reference連携は追加設定が必要です。Referenceとのログイン連携には現在、未解消の機能不備があります。公開版の評価対象と、その制約を区別してください。

版の目印は各 `package.json` のバージョン（現在 `0.1.0`）と、取得した公開リポジトリのcommitです。変更内容はそのリポジトリのcommit履歴で確認してください。

### ドキュメント

- `docs/architecture/operational-policy.md` — 運用ポリシー（エラー処理 / ログ / env var / データ保持）
- `docs/scenarios/` — ユーザージャーニー（セットアップ〜日常運用〜インシデント対応）
- モデルタブ（`packages/frontend/src/features/model/content/*.ts`）— UI 規約・用語・画面命名・モデル概念の正本（画面からも閲覧可能）
- [SECURITY.md](./SECURITY.md) — 脆弱性の非公開報告と安全な評価
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) — 依存パッケージ・フォント等の出所と表示条件

## 評価環境の起動

前提：Node.js 24 LTS（`.nvmrc` は24）／ pnpm 9.15.4（`packageManager` 指定）／ Docker Compose（DB 用）。フォント取得と依存インストールにはネットワーク接続が必要です。

```bash
# リポジトリのルートで実行。Windows PowerShellではcpの代わりにCopy-Itemも使えます。
# 1. 環境変数の雛形をコピー（既存の設定ファイルは上書きしない）
cp .env.example .env
cp packages/backend/.env.example packages/backend/.env
cp packages/frontend/.env.example packages/frontend/.env.local

# 2. backendのDATABASE_URLを編集し、.envのDB設定と揃えてからDBを起動
docker compose up -d postgres

# 3. 依存、共有コード、Prisma Clientを準備
pnpm install --frozen-lockfile
pnpm run build:shared
pnpm --filter @rete/backend prisma:generate

# 4. 評価用DBへマイグレーションとデモデータを投入
pnpm --filter @rete/backend prisma:migrate
pnpm --filter @rete/backend prisma:seed

# 5. 開発サーバー起動（backend + frontend 並行）
pnpm dev
```

- frontend: `http://localhost:3000` ／ backend: `http://localhost:3001/api/v1`
- `DATABASE_URL` の `<user>` / `<password>` はルート `.env` の値に置き換え、ポートも揃えます。URL内の `connection_limit` / `pool_timeout` は残してください。雛形のままでは接続できません。
- 各環境ファイルの認証鍵placeholderは評価用です。MFAを評価する場合は `MFA_TOTP_ENC_KEY` に有効な32バイトの鍵を設定します。共有・外部公開前の確認は [NOTICE.md](./NOTICE.md) を参照してください。
- 初回の管理者メールは `SEED_ADMIN_EMAIL`（未設定時 `admin@rete.local`）です。管理者とデモユーザーの既定パスワードは [seed.ts](./packages/backend/prisma/seed.ts) にある公開情報です。
- Referenceは別のアプリです。未設定時は連携を評価できません。Reteと同じポートで同時起動せず、各環境ファイルのURLとOIDC設定を揃えてください。
- SMTP未設定時は招待メール等のメール依存機能を利用できません。ローカルでメールを評価する場合は `docker compose --profile dev up -d mailpit` とbackendのSMTP設定が必要です。
- バックログタブは外部チケットツール（本公開版には含まれない）をiframe表示します。接続先が利用できなければ表示されません。
- 上記はリポジトリのスクリプト・設定に合わせたローカル評価手順です。取得した版での初回起動結果と各機能の設定を確認してください。本番運用の手順・動作保証を意味しません。

## Referenceと一緒に評価する

[Reference公開版](https://github.com/structpass/reference-app)をセットで取得します。Referenceの[README](https://github.com/structpass/reference-app#両アプリの認証を接続する)が、ポート分離・OIDC設定の対応・seedのID・起動順序の正本です。

共存時はRete frontend 3010 / backend 3011 / DB 5433、Reference frontend 3000 / backend 3001 / DB 5432を使います。Rete frontendのPORTとAPI URL、backendのPORT・CORS_ORIGIN・DATABASE_URL、ルート.envのRETE_DB_PORTを揃えてから、Rete→Referenceの順に起動します。Referenceのseedはパスワードを持ちません。Reteの公開評価用資格情報を、外部公開や実運用で有効なまま使わないでください。

## 概念モデル

- **system**：完全独立 instance（業種テンプレ別、DB / schema / instance 別）。1 system + Rete で完結
- **team**：system 配下の組織単位（部 / チーム）
- **channel**：team 配下の通信単位（chat channel / task list / file folder）
- **account**：テナント内 identity SoT。複数 system に membership を持てる
- **role**：各 system / team 内での権限（オーナー / 管理者 / メンバー）

## ライセンス

**PolyForm Free Trial License 1.0.0**（source-available）。
特定の用途に適するかを評価するための、連続32暦日未満の利用を許諾します。評価以外の利用・評価期間を超える利用・再配布はこのライセンスの許諾範囲に含まれません。別途許諾・商用契約については窓口へご相談ください。
詳細は [LICENSE.md](./LICENSE.md) と [NOTICE.md](./NOTICE.md) を参照してください。
