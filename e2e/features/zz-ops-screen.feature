# rete トラック 7（運用）— 画面から確かめる（モデルタブの deep-link）
#
# 対応: docs/scenarios/tracks/07-ops.md
#   S-OPS-10 モデルタブを直接開いて用語を引く（`/model#<テーマ>` でそのテーマの本文が開く）
#
# 画面を開くため実ブラウザで走る（project `screen`。playwright.config.ts）。
# 07-ops.md の手順 2・3（別テーマを選ぶと URL のハッシュが追従する／戻るで前のテーマへ戻る）は、
# 画面の選択が履歴を積まない（replaceState）ため自動で戻る先が作れず、手動ケース（S-OPS-10-C1）に残す。
# ここでは 1 手目（deep-link でそのテーマが開く）を、本文の題で確かめる。
#
# ⚠ 状態は動かさない: 07-ops.md の期待は「該当テーマが選ばれた状態で開き、戻る操作でも位置が保たれる」で、
# 戻る側が未確認のまま ✅ にはできない（README §5 の「⚠ が付いたユースケースは ✅ にしない」）。

@ops-screen
Feature: 運用トラック — 画面から確かめる（S-OPS-10）

  # 共通仕様の正本（packages/frontend/src/features/model/content）から選ぶ 2 テーマ。
  # 直接開くテーマは「DTO境界」（id=dto-boundary）、もう 1 つは「エラー一元化」（id=error-centralization）。
  @S-OPS-10
  Scenario: モデルタブを直接開くとそのテーマの本文が出る
    Given 画面の点検に使う管理者でログインし直し、モデルタブを開く準備をする
    When モデルタブを "dto-boundary" のテーマで直接開く
    Then 画面に "DTO境界" の題で本文が出ている
    When モデルタブを "error-centralization" のテーマで直接開く
    Then 画面に "エラーハンドリングの一元化" の題で本文が出ている
