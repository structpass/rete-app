# frontend の作業規約

`packages/frontend` を触る時の規約。全体の規約（リポジトリ直下の `AGENTS.md`）への補足で、食い違う時は下を優先する。
`AGENTS.md`（このディレクトリ）は `next dev` が毎回書き出す案内で、記録の対象外（`.gitignore`）。本文の置き場にしない。

## 画面を変える前に読む

- 共通仕様の正本は `src/features/model/content/*.ts`。用語・画面の命名・画面の組み方を変える前に該当テーマを読む
- 見た目や操作が変わる時は `docs/architecture/ui-verification-gate.md` に従い、変更前後の PNG と操作結果を残す
- 認証・権限の境界に触る時は `docs/architecture/architecture-invariants.md` を確認する

## 書き方

- 除外は `undefined` の判定で書く（`!value` は空文字や 0 を落とす）
- 画面の部品は `src/features/<領域>/` の決まった場所へ置き、横断の部品は `src/components/` へ置く
- 空状態・読み込み中・エラーの 3 つを、同じ画面の中で同じ形にする
- 日時の扱いは日本時間に揃える（カレンダーは `features/calendar` の日付関数を通す）

## 試験

- 実行は `corepack pnpm exec vitest run <path>`。テストの後始末は testing-library の自動 cleanup に任せ、自分で `cleanup()` を呼ばない
- 日時を固定する時は `vi.useFakeTimers` ではなく、対象の関数へ時刻を渡して決める
- `fetch` と `XMLHttpRequest` は `vitest.setup.ts` が遮断する。実ネットワークへ出る試験を書かない
- 全件で赤・単体で緑になる試験は、前の試験の描画が残っている疑いを持つ（決定 d873）

## 検査

```
corepack pnpm exec vitest run
corepack pnpm run type-check
corepack pnpm run lint:check
corepack pnpm exec prettier --check .
```

## 記録の対象から外すもの

- `.next/`（ビルドの状況で作り直される）と `next-env.d.ts` の指す先（`.next` は追跡外）
- `next dev` が書き出す `AGENTS.md`

`next-env.d.ts` 自体は追跡する。`next dev` が `.next/dev` を指す形へ書き換えたら元へ戻す（d704）。
