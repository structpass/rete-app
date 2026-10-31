# rete トラック 1（認証）— セッションの境界
#
# 対応: docs/scenarios/tracks/01-auth.md
#   S-AUTH-01 通常ログインでセッションが確立する
#   S-AUTH-06 未ログインでは保護画面に入れない
#   S-AUTH-07 ログアウトでセッションが破棄される
#
# 実測（2026-10-25・backend 3011）:
#   - /auth/me は未ログインでも 200 で data:null を返す（401 にしない契約）
#   - 保護 API は AuthenticatedGuard が 401、権限不足は RolesGuard が 403
#   - ログアウトは共有セッションキャッシュを壊すため、専用の新規ログインで行う

@auth
Feature: 認証セッションの境界（S-AUTH-01 / 06 / 07）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-AUTH-01 通常ログイン（MFA 未設定の MEMBER）
  # ------------------------------------------------------------------
  @S-AUTH-01
  Scenario: ログインすると自分情報とハブメニューが取れる
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/auth/me" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.email" が "of-admin@struct-pass.example" と一致する
    When GET "/api/v1/hub/menu" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-AUTH-06 未ログインの遮断
  # ------------------------------------------------------------------
  @S-AUTH-06
  Scenario: 未ログインでは自分情報が null で保護 API は 401
    Given 未ログインの接続を "anon" に用意する
    When 保存セッション "anon" で GET "/api/v1/auth/me" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data" が null である
    When 保存セッション "anon" で GET "/api/v1/tasks" を叩く
    Then ステータスコード 401 が返る
    When 保存セッション "anon" で GET "/api/v1/members" を叩く
    Then ステータスコード 401 が返る

  # ------------------------------------------------------------------
  # S-AUTH-07 ログアウト
  #   共有キャッシュを落とさないよう、このシナリオ専用の接続で確かめる
  # ------------------------------------------------------------------
  @S-AUTH-07
  Scenario: ログアウト後はセッションが無効になる
    Given メール "of-admin@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "scratch" に用意する
    When 保存セッション "scratch" で GET "/api/v1/auth/me" を叩く
    Then レスポンスの "data.email" が "of-admin@struct-pass.example" と一致する
    When 保存セッション "scratch" でログアウトする
    Then ステータスコード 200 が返る
    When 保存セッション "scratch" で GET "/api/v1/auth/me" を叩く
    Then レスポンスの "data" が null である
    When 保存セッション "scratch" で GET "/api/v1/tasks" を叩く
    Then ステータスコード 401 が返る
