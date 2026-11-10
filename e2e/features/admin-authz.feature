# rete 権限境界ジャーニー — P5 管理者認可境界（admin-authz）
#
# 検証対象:
#   P5-01/02  システムロール変更・MEMBER は管理 API に届かない
#   P5-04     自己ロックアウト防止（ADMIN が自分自身を降格できない）
#
# 退行ガード目的: @Roles(Role.ADMIN) / members.service の自己降格チェックが
# 外れた時に即落ちさせる。

@authz
Feature: P5 管理者認可境界（admin-authz）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # P5-04 自己ロックアウト防止
  # ADMIN が自分自身の system-role を MEMBER へ変更しようとすると 400
  # ------------------------------------------------------------------
  @P5-04
  Scenario: ADMIN は自分自身のシステムロールを降格できない
    # e2e:verified AUTHZ pass "ADMIN は自分自身のシステムロールを降格できない"
    Given システムADMIN "admin@rete.local" でログインする
    When 自分自身の system-role を "MEMBER" に変更しようとする
    Then ステータスコード 400 が返る

  # ------------------------------------------------------------------
  # P5-11 / P5-02 一般 MEMBER はメンバー管理 API にアクセスできない
  # @Roles(Role.ADMIN) + RolesGuard が 403 を返す
  # ------------------------------------------------------------------
  @P5-11
  Scenario: システム MEMBER はメンバー管理一覧 API にアクセスできない
    # e2e:verified AUTHZ pass "システム MEMBER はメンバー管理一覧 API にアクセスできない"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/members" を叩く
    Then ステータスコード 403 が返る

  # ------------------------------------------------------------------
  # P5-11 MEMBER はメンバー個別 PATCH API にアクセスできない
  # ------------------------------------------------------------------
  @P5-11
  Scenario: システム MEMBER はメンバー編集 API にアクセスできない
    # e2e:verified AUTHZ pass "システム MEMBER はメンバー編集 API にアクセスできない"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When PATCH "/api/v1/members/00000000-0000-4000-a000-000000000099" を空ボディで叩く
    Then ステータスコード 403 が返る

  # ------------------------------------------------------------------
  # 正常系: ADMIN はメンバー管理 API にアクセスできる
  # ------------------------------------------------------------------
  @P5-01
  Scenario: システム ADMIN はメンバー管理一覧 API にアクセスできる
    # e2e:verified AUTHZ pass "システム ADMIN はメンバー管理一覧 API にアクセスできる"
    Given システムADMIN "admin@rete.local" でログインする
    When GET "/api/v1/members" を叩く
    Then ステータスコード 200 が返る
