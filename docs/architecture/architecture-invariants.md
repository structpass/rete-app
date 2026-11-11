# Rete architecture invariants

Reteで継続して守る構造上の境界です。例外を採用する場合は、理由と影響を`docs/decisions/`へ記録します。

## Product sources

- UI規約、用語、画面命名、モデル概念は`packages/frontend/src/features/model/content/*.ts`を正本とする。
- 脱モック前の静的モック（`index.html`・各タブの `index.html` 等）は`docs/_archive/mock/`に置き、現在状態の正本にしない（[ADR 0084](../decisions/0084-mock-shell-html-archived-out-of-root.md)）。
- 同じ仕様をAGENTS、memory、ADR本文へ複製しない。AGENTSは発火条件と入口だけを持つ。
- ADR を指す時は、docs の文書では実体への相対リンク（例 `[ADR 0084](../decisions/0084-mock-shell-html-archived-out-of-root.md)`）で書く。画面定義（frontend の content の文字列）は画面にそのまま出るため番号のみ（例 `ADR 0084`）で書き、リンクにしない。

## Backend boundaries

- 基本の依存方向は`Controller -> Service -> Repository -> Prisma`とする。
- Serviceは業務判断を担当し、Repositoryはquery、永続化、transactionを担当する。
- RepositoryはEntityを返し、Serviceがmapperを使ってResponse DTOへ変換する。
- Prismaを直接使う例外は、基盤処理など具体的な必要性をコードとADRで説明する。
- raw SQLなどの例外はRepository内へ閉じ、必要性と安全性をADRへ記録する。受容済みの例はログインロックアウト（[ADR 0033](../decisions/0033-login-lockout-db-store-429.md)）、チャット投稿の親更新（[ADR 0094](../decisions/0094-chat-theme-lock-no-key-update.md)）、お気に入りの並べ替え（[ADR 0095](../decisions/0095-favorites-reorder-json-lock.md)）。

## Errors and security

- 想定内の業務エラーは具体的なHTTP exceptionで表す。
- 想定外例外とPrisma例外は共通filterで処理し、汎用try/catchを各モジュールへ散らさない。
- 認証、認可、入力検証、rate limit、lockoutはAPI境界で強制し、UI上の制御だけに依存しない。
- secretや本番資格情報をリポジトリ、Board、ログへ記録しない。

## Cross-system boundary

- Reteはidentityの正本とOIDC issuerを担い、ReferenceはOIDC relying partyとして接続する。
- 片方の障害やdeployで相手のruntime、container、データを巻き込まない。
- 両製品の接続変更は、双方の設定、health、ログイン往復を確認する。

## Verification

- 機械的に強制できる規則は、AGENTSへ重ねず型、test、lint、CIへ置く。
- UI変更は`ui-verification-gate.md`、移植は`porting-parity-check.md`を適用する（Board は 2026-10-18 に廃止したため `board-session-lock.md` の適用対象は無い）。
- 完了はコード、テスト、CI、証跡またはlive状態で裏付ける。
