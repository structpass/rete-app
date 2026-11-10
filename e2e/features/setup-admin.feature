# rete P0 立ち上げ・準備ジャーニー — 管理者初期設定（setup-admin）
#
# 検証対象:
#   P0-01  パスワードポリシーの保存反映（PUT /settings/login/password-policy）
#   P0-02  不正 CIDR の入力拒否 (400・PUT /settings/login/ip-whitelist)
#   P0-10  組織作成 → 作成者が自動 ADMIN
#   P0-11  プロジェクト作成は親組織 ADMIN のみ・非 ADMIN は 403
#   P0-12  チャネル作成 → 親 PJ ADMIN のみ
#
# 退行ガード目的: 管理者設定と器作成の基本操作が成功し続けることを保証する
# (拒否側のみだった既存 4 feature を補完する幸せ道側の網)。
#
# 除外: P0-05/06 (MFA enforced/未設定者誘導) は otplib 等の追加依存と MFA 有効
# seed ユーザーが要るため cmn-0139 へ退避。P0-09 は settings-authz.feature で別途
# 検証済。P0-03/04/13/14/15/16 は仕様未確定または SSO 連携の deferred 項目。

@authz
Feature: P0 管理者初期設定（setup-admin）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # P0-01 パスワードポリシーの初期設定（ADMIN / 全置換）
  # 最小12文字・複雑性要件ON（大小+数字+記号）・MFA 全体強制 OFF
  # ------------------------------------------------------------------
  @P0-01
  Scenario: ADMIN はパスワードポリシー（最小長12・大小+数字+記号・MFA OFF）を保存できる
    # e2e:verified AUTHZ pass "ADMIN はパスワードポリシー（最小長12・大小+数字+記号・MFA OFF）を保存できる"
    Given システムADMIN "admin@rete.local" でログインする
    When PUT "/api/v1/settings/login/password-policy" を body "{\"requireLowercase\":true,\"requireUppercase\":true,\"requireNumber\":true,\"requireSymbol\":true,\"minLength\":12,\"mfaEnforced\":false}" で叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.minLength" が "12" と一致する

  # ------------------------------------------------------------------
  # P0-02 不正 CIDR の入力拒否（誤操作）
  # オクテット範囲外 (192.168.0.300) と プレフィクス長不正 (10.0.0.0/40) は 400
  # ------------------------------------------------------------------
  @P0-02
  Scenario: ADMIN が不正 CIDR（オクテット範囲外 / プレフィクス長不正）を保存しようとすると 400
    # e2e:verified AUTHZ pass "ADMIN が不正 CIDR（オクテット範囲外 / プレフィクス長不正）を保存しようとすると 400"
    Given システムADMIN "admin@rete.local" でログインする
    When PUT "/api/v1/settings/login/ip-whitelist" を body "{\"entries\":[{\"cidr\":\"192.168.0.300/24\"},{\"cidr\":\"10.0.0.0/40\"}]}" で叩く
    Then ステータスコード 400 が返る

  # ------------------------------------------------------------------
  # P0-10 + P0-11 + P0-12 連鎖
  # 組織 → プロジェクト → チャネル × 2 を作成。
  # teardown は PATCH archive (LIFO: channel → project → organization)
  # CreateOrganizationDto に description フィールドは無い（@IsString のみ）
  # ------------------------------------------------------------------
  @P0-10
  @P0-11
  @P0-12
  Scenario: ADMIN は組織→プロジェクト→チャネルを連鎖作成できる（シナリオ内 PATCH archive teardown）
    # e2e:verified AUTHZ pass "ADMIN は組織→プロジェクト→チャネルを連鎖作成できる（シナリオ内 PATCH archive teardown）"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "org-logistics" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"{{orgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    When POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\",\"name\":\"{{orgName}}-ch1\"}" で叩き id を記録する
    And POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\",\"name\":\"{{orgName}}-ch2\"}" で叩き id を記録する
    Then ステータスコード 201 が返る

  # ------------------------------------------------------------------
  # P0-11 拒否 — MEMBER は自分が所属しない組織の配下にプロジェクトを作成できない（403）
  # 新規組織を ADMIN が作成し、その組織 id を使って MEMBER が PJ 作成 → service 層で 403
  # ------------------------------------------------------------------
  @P0-11
  Scenario: MEMBER は自分が所属しない組織の配下にプロジェクトを作成できない
    # e2e:verified AUTHZ pass "MEMBER は自分が所属しない組織の配下にプロジェクトを作成できない"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "org-refuse" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    And システムMEMBER "of-admin@struct-pass.example" でログインする
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"should-fail\"}" で叩く
    Then ステータスコード 403 が返る