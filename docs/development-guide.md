# 開発・運用の案内

紹介用の架空案件は[在庫管理システム導入の設計開始データ](scenarios/inventory-design-demo.md)を参照してください。

[レーテの紹介](../README.md)

開発と運用に必要な情報をまとめます。以下のコマンドとパスは、リポジトリのルートを基準にしています。

## リポジトリの役割分担

同じ製品系統を、開発の本流と第三者が評価に使う公開版で分けて持つ。名前ではなく役割で読み分ける。

| 役割                    | Rete                                   | Reference                  |
| ----------------------- | -------------------------------------- | -------------------------- |
| 開発元（本流・private） | このリポジトリ（`structpass-dr/Rete`） | `structpass-dr/StructPass` |
| 公開評価版（public）    | `structpass/rete-app`                  | `structpass/reference-app` |

- 開発は開発元で行い、公開版へはスナップショットを生成して反映する（`scripts/publish/`）。開発元の履歴・内部資料を公開側へ合流させない
- 公開版は第三者が clone して評価する窓口で、開発元の private な作業ツリーとは内容が異なる（`AGENTS.md`・`plans/`・`deploy/`・本番 compose は公開しない）
- かつて公開先として作った `structpass/rete`・`structpass/reference` は役割を終えており、現行の公開先ではない

## 設計原則

1. **OSS のソースは使わない** — 機能デザイン・セキュリティの参考情報としてのみ参照
   （※ OIDC 等プロトコル準拠の認証ライブラリ／SDK の部品としての利用は許容。製品まるごとの組み込みは不可。`docs/decisions/0001` 参照）
2. **絞って磨く** — 連結に必要な最小集合だけ実装。機能を増やすことは敗北
3. **アドオン間の疎結合** — ユーザーID だけ共有、システム間通信は最小限
4. **OIDC 標準準拠** — 任意のサブシステムを別実装に載せ替え可能（脱出可能性）
5. **アドオン売り** — 各サブシステム独立提供可能

## 「責任を負いすぎない」の再定義

- **避けたい責任**: 他者の業務クリティカルなデータ・認証を背負う責任。OSS 運用責任を顧客に転嫁する形を含む
- **取ってよい責任**: 自分のコードの保守責任（コントロール下にある）

## ステータス

本節は「どこに何があるか」を指すだけに留める。実装の進み具合は時点で変わるため、ここへ写さない（書いた時点で古くなる）。進捗はトラック別 `docs/<track>/build-status.md`、チケットの状態は Decision Hub、設計判断の理由は `docs/decisions/` で読む。

- **サブシステム** — 認証を受け持つ OIDC の IdP（Rete）と RP 連携、Home（掲示板・FAQ・お気に入り）、Desk（チャット × タスク）、Files（版管理・タグ・添付）、Settings（テナント設定・組織と所属・メンバー・招待・監査）。
- **認証と認可** — 認証は OIDC（RP 連携を含む）とパスワード + 二段階認証（MFA/TOTP）。認可はシステム Role（ADMIN / MEMBER）と所属（Membership / 管理グループの grant）の 2 軸で、機能単位・連携先単位のロール制御は持たない（[ADR 0077](decisions/0077-rbac-layer-removal-and-group-physical-delete.md)）。所属マトリクス（組織・プロジェクト・チャットグループ）で可視範囲が決まり、チャット・タスク・ファイルが同じ可視性の層で見られる点は [ADR 0075](decisions/0075-channel-scope-additive-visibility.md)。管理グループの削除は物理削除（アーカイブして戻す道は無い）で、復元手段を持たない（ADR 0077）。
- **起動時に止まる構成** — 本番は MFA の暗号鍵が無い・形が不正だと起動しない（[ADR 0087](decisions/0087-mfa-encryption-key-required-in-production.md)）。鍵を失うと既存の MFA 登録は復号不能になる。依存障害時に止める／止めないの切り分けと環境変数の一覧は [`operational-policy.md`](architecture/operational-policy.md) §3・§4。
- **セッション** — express-session を connect-pg-simple（PostgreSQL の `session` テーブル）に永続化する。
- **チケットの読み出し** — Decision Hub で読む。

未了の作業は README に列挙しない。Hub の未対応の並びと各トラックの `build-status.md` が正本。

## 構成（実装）

pnpm monorepo（TypeScript）。

```
packages/
├ backend/   ← NestJS REST API（Prisma + PostgreSQL）
├ frontend/  ← Next.js App Router（React 19 + Tailwind CSS）
└ shared/    ← 共通型定義（TaskStatus 等の SSOT）
```

アーキテクチャの不変条件：Response DTO 境界 / Repository 分離（Entity → DTO の mapping は Service）/
共通エラーフィルタ。設計上の判断は `docs/decisions/`（ADR）に記録する。

### リポジトリ直下のローカル専用ファイル

直下の `chk-rete.ps1`・`chk-rete.cmd`・`chk-restart.ps1`・`rete-dev-watchdog.ps1`・`register-rete-watchdog.ps1`・`run-hidden.vbs`・`run-watchdog-hidden.vbs`（と `dev-watchdog.log`・`dev-watchdog-state.json`・`dev-server*.log`）は、**この機械のローカル開発専用**で製品コードではない。`.gitignore` の「ローカル dev 雑多」節により追跡対象外（譲渡対象外）で、タスクスケジューラ 4 件と PowerShell プロファイル、dsh スキル `chk-rete`／`chk-ref` が直下の絶対パスを直接参照する。

役割と、置き場を動かす場合に同時に変える組は [ADR 0085](decisions/0085-dev-recovery-tooling-stays-at-root.md) を正本とする。

### ドキュメントの入口（凡例）

このリポジトリの入口は[レーテの紹介](../README.md)で、開発・運用の情報は本案内から各正本へ辿る。ARCHITECTURE.md は置かない（構造・運用・共通仕様はそれぞれ下記の正本に一元化しており、集約ファイルを別置すると二重正本になるため）。

- `docs/architecture/` — 運用ポリシーと手順（operational-policy / UI 検証ゲート / セッションロック 等）
- `docs/pitfalls.md` — 作業前に読む再発手順ミスの一覧（書く側は点検の記録、ここは読む側）
- `docs/<track>/build-plan.md` + `build-status.md` — トラック別の計画と進捗（索引は `docs/backlog.md`）
- 文書の相対リンク先の欠落は `pwsh -NoProfile -File scripts/check-doc-links.ps1` で横断検査する（欠落時は場所を表示して終了コード1。URL・見出しアンカーは対象外。旧メモリへのリンクを引用する2026-06-21の生ログ1件は、除外を表示して保存する）。
- `docs/decisions/` — 判断のなぜ（ADR）
- モデルタブ（`packages/frontend/src/features/model/content/*.ts`）— rete 固有の共通仕様の正本（UI 規約・用語・画面命名・モデル概念）

各事実クラス（構造 / 運用 / 共通仕様 / 計画）を「どこに書くか」の正本割り当て自体は ADR 0047 が本文。上の凡例は入口ポインタで、内容は再掲しない。

## 開発

> このリポジトリには**評価用のデモ資格情報が公開**されています（`e2e/support/auth.ts` 6 件）。本番運用・公開面では必ず変更してください。詳細: [docs/architecture/public-repo-demo-credentials.md](architecture/public-repo-demo-credentials.md) ／ 判断記録 [ADR 0061](decisions/0061-public-repo-demo-credentials.md)

前提：Node.js 24 系（`.nvmrc`）／ pnpm 10.34.5 ／ Docker（DB 用）。

```bash
# 1. DB を起動（PostgreSQL コンテナ）
docker compose up -d

# 2. 依存をインストール
pnpm install

# 3. backend の環境変数を用意（DATABASE_URL を DB に合わせる）
cp packages/backend/.env.example packages/backend/.env

# 4. マイグレーション + 初期データ（カテゴリ）投入
pnpm --filter @rete/backend prisma:migrate
pnpm --filter @rete/backend prisma:seed

# 5. 開発サーバー起動（backend + frontend 並行）
pnpm dev
```

- frontend: http://localhost:3000 ／ backend: http://localhost:3001/api/v1
- ポート・接続情報は `.env` / `.env.local` で上書き（12-factor）。譲渡先は `.env.example` の素直な値で 1 台起動できる
