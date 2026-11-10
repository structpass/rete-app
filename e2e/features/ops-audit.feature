# rete トラック 7（運用）— 操作ログの大量データ
#
# 対応: docs/scenarios/tracks/07-ops.md
#   S-OPS-13 大量データでも一覧が開ける（初期表示は既定の期間で返り、固まらない。件数はページ単位で区切られる）
#
# 実測（2026-10-25・backend 3011）:
#   - GET /api/v1/audit-logs は ADMIN 限定。既定は page=1 / limit=20 で、meta に total・page・limit・totalPages が返る
#   - from/to は ISO 日付。92 日を超える範囲は export 側が 400 で拒むが、一覧は期間を広げても 200 で返る
#   - 1 年分の操作ログは seed しない（量の作り方そのものが論点のため）。ここで確かめるのは
#     「期間を広げても既定の頁で返り切る」ことまでで、実データ量での往復時間は別途実測する

@ops
Feature: 運用トラック — 操作ログの一覧が期間を広げても開ける（S-OPS-13）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-OPS-13 大量データでも一覧が開ける
  # ------------------------------------------------------------------
  @S-OPS-13
  Scenario: 操作ログの一覧は既定の頁で返り、期間を 92 日に広げても開ける
    # e2e:verified AUTHZ pass "操作ログの一覧は既定の頁で返り、期間を 92 日に広げても開ける"
    Given システムADMIN "admin@rete.local" でログインする
    When GET "/api/v1/audit-logs" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "meta.limit" が数値 20 と一致する
    And レスポンスの "meta.page" が数値 1 と一致する
    And レスポンスの "data" が空でない
    When GET "/api/v1/audit-logs?from=2026-07-25&to=2026-10-25&limit=20" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "meta.limit" が数値 20 と一致する
    And レスポンスの "data" が空でない
