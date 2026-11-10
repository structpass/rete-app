# rete 日常幸せ道ジャーニー — デイリーハブ（daily-hub / cmn-0138）
#
# 検証対象:
#   DAILY-HUB-01  セッション健全: /auth/me が自ユーザーを返す＋ハブメニュー 200
#                 （ログイン成立の e2e 表現。生ログイン API 連打は throttle を食うため
#                  globalSetup セッション再利用で表現＝既存基盤の設計思想に整合）
#   DAILY-HUB-02  お知らせフルライフサイクル: ADMIN 配信 → MEMBER 未読+1 →
#                 一覧反映 → 詳細を開き既読化 → 未読が元に戻る → 削除 → 一覧から消える
#
# 退行ガード目的: ログイン確立（セッション再利用）とお知らせの幸せ道が
# 成功し続けることを保証する（拒否側のみだった既存 feature を補完）。
#
# 未読カウントは差分で検証する（配信前を基準に +1 / 既読で +0 へ復帰）。
# 絶対値アサートは他シナリオの残データで flaky になるため採らない。

@daily
Feature: 日常幸せ道 — デイリーハブ（daily-hub）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # DAILY-HUB-01 セッション健全（ログイン成立の e2e 表現）
  # ------------------------------------------------------------------
  @DAILY-HUB-01
  Scenario: 認証済みセッションで自分情報とハブメニューを取得できる
    # e2e:verified AUTHZ pass "認証済みセッションで自分情報とハブメニューを取得できる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/auth/me" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.email" が "of-admin@struct-pass.example" と一致する
    When GET "/api/v1/hub/menu" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # DAILY-HUB-02 お知らせフルライフサイクル（配信 → 未読+1 → 既読化 → 削除）
  # 一意タイトルで作成 → シナリオ内 DELETE（連続2回実行 green = 冪等）
  # ------------------------------------------------------------------
  @DAILY-HUB-02
  Scenario: ADMIN 配信お知らせが MEMBER の未読+1・一覧反映し、開封で既読化・削除で消える
    # e2e:verified AUTHZ pass "ADMIN 配信お知らせが MEMBER の未読+1・一覧反映し、開封で既読化・削除で消える"
    # 配信前の MEMBER 未読数を基準として保存する
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements/unread-count" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.count" を "unreadBase" に保存する
    # ADMIN がのお知らせを配信（kind=board・hom-0143 で通知先機能撤去＝全認証ユーザー全件可視）
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-ann" を生成して "annTitle" に保存する
    When POST "/api/v1/announcements" を body "{\"title\":\"{{annTitle}}\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "annId" に保存する
    # MEMBER 視点: 未読+1 → 一覧に反映 → 詳細を開き既読化 → 未読が基準へ復帰
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements/unread-count" を叩く
    Then レスポンスの "data.count" が保存値 "unreadBase" + 1 と一致する
    When GET "/api/v1/announcements" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{annTitle}}" が含まれる
    When GET "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.title" が "{{annTitle}}" と一致する
    When GET "/api/v1/announcements/unread-count" を叩く
    Then レスポンスの "data.count" が保存値 "unreadBase" + 0 と一致する
    # ADMIN が削除 → MEMBER 一覧から消える
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{annTitle}}" が含まれない
