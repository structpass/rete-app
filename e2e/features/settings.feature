# rete トラック 5（設定）— 管理者の操作と境界
#
# 対応: docs/scenarios/tracks/05-settings.md
#   S-SET-02 管理グループで範囲の権限を束ねられる
#   S-SET-03 操作ログの検索と期間上限
#   S-SET-05 パスワードポリシーと IP 許可リストを保存できる
#   S-SET-08 招待の発行と二重発行の拒否
#   S-SET-13 所属管理でスコープのメンバーを増減できる
#
# 実測（2026-10-25・backend 3011）:
#   - 設定系は @Roles(ADMIN)。MEMBER は 403（読み取りは一部 200）
#   - IP 許可リストは entries: [{cidr, note}] の形（配列の要素はオブジェクト）
#   - 不正 CIDR は 400、正しい CIDR は 200
#   - 招待の二重発行は 400。SMTP は開発機で設定済み（mail-status.configured=true）
#   - 操作ログの書き出しは 92 日上限（93 日で 400）

@settings
Feature: 設定の管理者操作と境界（S-SET-02 / 03 / 05 / 08 / 13）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-SET-07 非管理者の設定変更拒否（既存 feature の裏取り）
  # ------------------------------------------------------------------
  @S-SET-07
  Scenario: 非管理者は設定の更新ができない
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When PATCH "/api/v1/settings/tenant" を空ボディで叩く
    Then ステータスコード 403 が返る
    When GET "/api/v1/members" を叩く
    Then ステータスコード 403 が返る
    When GET "/api/v1/settings/tenant" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-SET-05 パスワードポリシーと IP 許可リスト
  #   IP 許可リストは、自分の IP を含まないリストを保存すると管理画面ごと締め出されて戻す手が
  #   無くなる（実測 2026-10-26）。そのため保存の入口が、自分の IP を含む時だけ通す（d827）。
  #   試験の接続元は開発機なので、自分の IP を読んでから自分の範囲で保存する。
  # ------------------------------------------------------------------
  @S-SET-05
  Scenario: ポリシーを保存し直せ、不正な CIDR と自分の外に出るリストは拒否される
    Given システムADMIN "admin@rete.local" でログインする
    When PUT "/api/v1/settings/login/password-policy" を body "{\"requireLowercase\":true,\"requireUppercase\":true,\"requireNumber\":true,\"requireSymbol\":true,\"minLength\":12,\"mfaEnforced\":false}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/settings/login/password-policy" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.minLength" が数値 12 と一致する
    When PUT "/api/v1/settings/login/ip-whitelist" を body "{\"entries\":[{\"cidr\":\"192.168.0.300/24\"}]}" で叩く
    Then ステータスコード 400 が返る
    # 自分の IP を含まないリストは、保存を断る（遮断された後では戻せないため、保存の前に止める）。
    When PUT "/api/v1/settings/login/ip-whitelist" を body "{\"entries\":[{\"cidr\":\"203.0.113.0/24\",\"note\":\"本社\"}]}" で叩く
    Then ステータスコード 400 が返る
    # 断った後も、この接続は設定を読める（締め出されていない＝出口が閉じていない）。
    When GET "/api/v1/settings/login/ip-whitelist" を叩く
    Then ステータスコード 200 が返る
    And 直前のレスポンスの data.currentIp を "myCidr" に保存する
    # 自分の IP を含むリストは保存でき、応答にもその CIDR が返る。
    When PUT "/api/v1/settings/login/ip-whitelist" を body "{\"entries\":[{\"cidr\":\"{{myCidr}}\",\"note\":\"試験の接続元\"}]}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/settings/login/ip-whitelist" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.entries.0.cidr" が "{{myCidr}}" と一致する
    # 空のリスト（制限の解除）は、自分の IP を求めずに通る（出口は常にこちらへ開いている）。
    When PUT "/api/v1/settings/login/ip-whitelist" を body "{\"entries\":[]}" で叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-SET-03 操作ログの検索と期間上限
  # ------------------------------------------------------------------
  @S-SET-03
  Scenario: 期間を指定して検索でき、92 日を超える書き出しは拒否される
    Given システムADMIN "admin@rete.local" でログインする
    When GET "/api/v1/audit-logs?from=2026-10-01&to=2026-10-25" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/audit-logs/export?from=2026-01-01&to=2026-10-25" を叩く
    Then ステータスコード 400 が返る
    When GET "/api/v1/audit-logs/export?from=2026-10-18&to=2026-10-25" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-SET-01 / S-SET-12 ロール変更の即時反映と自己降格の拒否
  # ------------------------------------------------------------------
  @S-SET-01
  Scenario: システムロールの変更が次のリクエストに反映される
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "00000000-0000-4000-a000-000000000006" を "tanakaId" に保存する
    When PATCH "/api/v1/members/{{tanakaId}}/system-role" を body "{\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 200 が返る
    And メール "tanaka@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "tanaka" に用意する
    When 保存セッション "tanaka" で GET "/api/v1/members" を叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/members/{{tanakaId}}/system-role" を body "{\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 200 が返る
    When 保存セッション "tanaka" で GET "/api/v1/members" を叩く
    Then ステータスコード 403 が返る

  @S-SET-12
  Scenario: 自分のシステムロールは降格できない
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "00000000-0000-4000-a000-000000000001" を "adminId" に保存する
    When PATCH "/api/v1/members/{{adminId}}/system-role" を body "{\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 400 が返る

  # ------------------------------------------------------------------
  # S-SET-08 招待の発行と二重発行の拒否
  # ------------------------------------------------------------------
  @S-SET-08
  Scenario: 招待を発行でき、同じ宛先への二重発行は拒否される
    Given システムADMIN "admin@rete.local" でログインする
    When GET "/api/v1/invites/mail-status" を叩く
    Then ステータスコード 200 が返る
    And 固定値 "00000000-0000-4000-b000-000000000041" を "groupId" に保存する
    And 一意名 "e2e-invite" を生成して "inviteEmail" に保存する
    When POST "/api/v1/invites" を body "{\"email\":\"{{inviteEmail}}@example.com\",\"spaceId\":\"{{groupId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "inviteId" に保存する
    And レスポンスの "data.status" が "PENDING" と一致する
    When POST "/api/v1/invites" を body "{\"email\":\"{{inviteEmail}}@example.com\",\"spaceId\":\"{{groupId}}\"}" で叩く
    Then ステータスコード 400 が返る
    When GET "/api/v1/invites" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/invites/{{inviteId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-SET-13 所属の追加と削除（見え方が変わる）
  # ------------------------------------------------------------------
  @S-SET-13
  Scenario: 所属を足すと見えるようになり、外すと見えなくなる
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    And 一意名 "e2e-pj" を生成して "pjName" に保存する
    When POST "/api/v1/projects" を body "{\"name\":\"{{pjName}}\",\"organizationId\":\"{{orgId}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    And 一意名 "e2e-ch" を生成して "chName" に保存する
    When POST "/api/v1/spaces" を body "{\"name\":\"{{chName}}\",\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "chId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000002" を "whId" に保存する
    And メール "wh-user@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "wh" に用意する
    When 保存セッション "wh" で GET "/api/v1/tasks/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 404 が返る
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{whId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "membershipId" に保存する
    When 保存セッション "wh" で GET "/api/v1/tasks/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/memberships/{{membershipId}}" を叩く
    Then ステータスコード 204 が返る
    When 保存セッション "wh" で GET "/api/v1/tasks/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 404 が返る
    # 後始末は管理者の権限で行う（作成した器を残さない）
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/spaces/admin/{{chId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/projects/admin/{{pjId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/organizations/admin/{{orgId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
