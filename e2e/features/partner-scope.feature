# rete 社外連携 P3c — partner-scope（権限境界ジャーニー退行ガード・cmn-0055）
#
# 検証対象:
#   P3c-01  スコープ越境遮断 — membership 無い PJ のメンバー一覧 GET は 403
#   P3c-02  管理操作拒否     — 他 space の categories POST は 404（存在秘匿・ADR 0042）/
#                              files settings PATCH は 403（@Roles ADMIN）
#   P3c-03  削除境界         — chat theme: 非所有者 MEMBER 403 / 所有者本人/ADMIN 204
#   P3c-04  誤共有 URL 相当  — 他 scope の chat theme GET は 404（存在秘匿）/ 一覧には出ない
#
# design からの前提崩れ:
#   - GET /api/v1/projects/:id と GET /api/v1/spaces/:id は**実装されていない**（一覧エンドポイントのみ）= 設計時に存在を前提にしていた個別 GET は使えない
#   - 存在秘匿（ADR 0042）に従い、他 scope リソースの個別 GET は 403 ではなく 404 を返す実装方針 = design §正解像の「403」は実装上「404」にドリフト
#
# 退行ガード目的: 権限境界の IDOR 防御が継続することを保証する。
# of-admin を他スコープの MEMBER 代役として使用（auth.ts CREDENTIALS 既存）。
# 連続2回実行 green = teardown で org/PJ/channel を archive、theme を DELETE。
#
# 除外（e2e/README.md に退避チケット id 付きで明記）:
#   - SSO 横断ジャーニー（reference 別スタック） → cmn-0141 退避
#   - board iframe postMessage                 → UI-E2E トラックへ退避
#   - 招待→受諾フルジャーニー（生 token が API レスポンスに返らない） → 別退避

@authz
Feature: P3c 社外連携 権限境界（partner-scope）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # P3c-01 スコープ越境遮断 — 他人の PJ のメンバー一覧 GET は 403
  # ------------------------------------------------------------------
  @P3c-01
  Scenario: MEMBER は自分が membership を持たない PJ のメンバー一覧を GET すると 403
    # e2e:verified AUTHZ pass "MEMBER は自分が membership を持たない PJ のメンバー一覧を GET すると 403"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "partner-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"{{orgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    And システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/memberships?scopeType=PROJECT&scopeId={{pjId}}" を叩く
    Then ステータスコード 403 が返る

  # ------------------------------------------------------------------
  # P3c-02 管理操作拒否 — categories POST は 404（存在秘匿・ADR 0042）/
  #                     files settings PATCH は 403（@Roles ADMIN）
  # ------------------------------------------------------------------
  @P3c-02
  Scenario: MEMBER は他 space への分類追加で 404、files settings PATCH で 403 を受け取る
    # e2e:verified AUTHZ pass "MEMBER は他 space への分類追加で 404、files settings PATCH で 403 を受け取る"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "mgr-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"{{orgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    When POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\",\"name\":\"{{orgName}}-ch1\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "channelId" に保存する
    And システムMEMBER "of-admin@struct-pass.example" でログインする
    When POST "/api/v1/categories" を body "{\"spaceId\":\"{{channelId}}\",\"name\":\"分類A\"}" で叩く
    Then ステータスコード 404 が返る
    When PATCH "/api/v1/files/settings" を body "{\"enabled\":false}" で叩く
    Then ステータスコード 403 が返る

  # ------------------------------------------------------------------
  # P3c-03 削除境界 — chat theme: 非所有者 MEMBER 403 / 所有者本人/ADMIN 204
  # ------------------------------------------------------------------
  @P3c-03
  Scenario: chat theme の削除は所有者本人と ADMIN のみ（MEMBER は 404 = 存在秘匿・ADR 0042）
    # e2e:verified AUTHZ pass "chat theme の削除は所有者本人と ADMIN のみ（MEMBER は 404 = 存在秘匿・ADR 0042）"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "del-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"{{orgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    When POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\",\"name\":\"{{orgName}}-ch1\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "channelId" に保存する
    When POST "/api/v1/chat/themes" を body "{\"spaceId\":\"{{channelId}}\",\"title\":\"境界テストテーマ\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    And システムMEMBER "of-admin@struct-pass.example" でログインする
    When DELETE "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 404 が返る
    And システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # P3c-04 誤共有 URL 相当 — 他 scope の chat theme id 直指定 GET は 404（存在秘匿）/
  #                       一覧にも出ない
  # ------------------------------------------------------------------
  @P3c-04
  Scenario: MEMBER は他 scope の chat theme id を直指定 GET すると 404（一覧にも出ない）
    # e2e:verified AUTHZ pass "MEMBER は他 scope の chat theme id を直指定 GET すると 404（一覧にも出ない）"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "url-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"{{orgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    When POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\",\"name\":\"{{orgName}}-ch1\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "channelId" に保存する
    When POST "/api/v1/chat/themes" を body "{\"spaceId\":\"{{channelId}}\",\"title\":\"共有URL相当\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    And システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 404 が返る
    When GET "/api/v1/chat/themes" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{themeId}}" が含まれない