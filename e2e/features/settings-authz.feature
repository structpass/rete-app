# rete 権限境界ジャーニー — S-SET-07 非ADMIN の設定変更拒否
#
# SettingsController: 書き込み系（PATCH / DELETE）は @Roles(Role.ADMIN) 限定。
# 読み取り（GET）は全認証ユーザー許可。
#
# 松本由美 = システム MEMBER = of-admin@struct-pass.example

@authz
Feature: S-SET-07 非ADMIN の設定変更拒否

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-SET-07 テナント情報更新拒否
  # ------------------------------------------------------------------
  @S-SET-07
  Scenario: 非ADMIN はテナント情報を更新できない
    # e2e:verified AUTHZ pass "非ADMIN はテナント情報を更新できない"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When PATCH "/api/v1/settings/tenant" を body "{\"name\":\"改ざんテスト\"}" で叩く
    Then ステータスコード 403 が返る

  # ------------------------------------------------------------------
  # S-SET-07 システム並び替え拒否
  # ------------------------------------------------------------------
  @S-SET-07
  Scenario: 非ADMIN はテナント契約システムを並び替えできない
    # e2e:verified AUTHZ pass "非ADMIN はテナント契約システムを並び替えできない"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When PATCH "/api/v1/settings/tenant/systems" を body "{\"orderedIds\":[]}" で叩く
    Then ステータスコード 403 が返る

  # ------------------------------------------------------------------
  # 正常系: 読み取りは全認証ユーザー許可
  # ------------------------------------------------------------------
  @S-SET-07-positive
  Scenario: 非ADMIN でもテナント情報を取得できる
    # e2e:verified AUTHZ pass "非ADMIN でもテナント情報を取得できる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/settings/tenant" を叩く
    Then ステータスコード 200 が返る
