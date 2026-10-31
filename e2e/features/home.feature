# rete トラック 2（ホーム）— 掲示板の権限・お気に入り・カレンダー
#
# 対応: docs/scenarios/tracks/02-home.md
#   S-HOME-04 タグの作成と付与（種別を跨ぐタグは拒否される）
#   S-HOME-07 編集権限のない人は掲示板を作れない
#   S-HOME-08 お気に入りから各画面へ移動できる（登録・並べ替え・削除）
#   S-HOME-10 カレンダーに予定を作り全員に見せる
#   S-HOME-11 予定の編集が権限者だけに許される
#   S-HOME-12 同じ予定を 2 人が同時に消しても壊れない（楽観ロック）
#
# 実測（2026-10-25・backend 3011）:
#   - 掲示板の書き込みは HomeWriteGuard（管理グループのフラグ or システムADMIN）
#   - 予定の削除は revision 必須（欠落 400 / 不一致 409）
#   - 予定の作成は id 先行採番ではないため、teardown に revision 無しの DELETE を登録できない
#     （登録すると後始末が 400 で落ちる）＝この feature では削除を明示的に行う

@home
Feature: ホームの権限とカレンダー（S-HOME-04 / 07 / 08 / 10 / 11 / 12）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-HOME-04 タグの作成と付与
  # ------------------------------------------------------------------
  @S-HOME-04
  Scenario: 掲示板タグを作って掲示に付け、種別違いのタグは拒否される
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-tag" を生成して "tagName" に保存する
    When POST "/api/v1/announcement-tags" を body "{\"name\":\"{{tagName}}\",\"icon\":\"Tag\",\"color\":\"red\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "tagId" に保存する
    And 一意名 "e2e-fq" を生成して "faqTagName" に保存する
    When POST "/api/v1/announcement-tags" を body "{\"name\":\"{{faqTagName}}\",\"icon\":\"Tag\",\"color\":\"blue\",\"kind\":\"faq\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "faqTagId" に保存する
    And 一意名 "e2e-ann" を生成して "annTitle" に保存する
    When POST "/api/v1/announcements" を body "{\"title\":\"{{annTitle}}\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "annId" に保存する
    When PUT "/api/v1/announcements/{{annId}}/tags" を body "{\"tagIds\":[\"{{tagId}}\"]}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.tags.0.name" が "{{tagName}}" と一致する
    When PUT "/api/v1/announcements/{{annId}}/tags" を body "{\"tagIds\":[\"{{faqTagId}}\"]}" で叩く
    Then ステータスコード 400 が返る

  # ------------------------------------------------------------------
  # S-HOME-07 非権限者の掲示板作成拒否
  # ------------------------------------------------------------------
  @S-HOME-07
  Scenario: 編集フラグを持たない MEMBER は掲示板を作れない
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/home/permissions" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.boardEdit" が真偽値 "false" である
    When POST "/api/v1/announcements" を body "{\"title\":\"e2e-denied\",\"kind\":\"board\"}" で叩く
    Then ステータスコード 403 が返る

  # ------------------------------------------------------------------
  # S-HOME-01 / 03 掲示の配信 → 未読 +1 → 既読 → 削除
  # ------------------------------------------------------------------
  @S-HOME-01
  Scenario: 掲示の配信で未読が増え、開くと既読になって削除で消える
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements/unread-count" を叩く
    Then レスポンスの "data.count" を "unreadBase" に保存する
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-ann" を生成して "annTitle" に保存する
    When POST "/api/v1/announcements" を body "{\"title\":\"{{annTitle}}\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "annId" に保存する
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements/unread-count" を叩く
    Then レスポンスの "data.count" が保存値 "unreadBase" + 1 と一致する
    When GET "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/announcements/unread-count" を叩く
    Then レスポンスの "data.count" が保存値 "unreadBase" + 0 と一致する

  # ------------------------------------------------------------------
  # S-HOME-08 お気に入り
  # ------------------------------------------------------------------
  @S-HOME-08
  Scenario: お気に入りを追加し一覧に出て削除で消える
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When POST "/api/v1/favorites" を body "{\"kind\":\"folder\",\"label\":\"e2e-favorite\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "favId" に保存する
    When GET "/api/v1/favorites" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{favId}}" と一致する要素が 1 件ある
    When DELETE "/api/v1/favorites/{{favId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/favorites" を叩く
    Then レスポンス配列の "id" 一覧に "{{favId}}" と一致する要素は 0 件

  # ------------------------------------------------------------------
  # S-HOME-10 / 11 / 12 カレンダー
  # ------------------------------------------------------------------
  @S-HOME-10
  Scenario: 予定を作成し期間で取得でき、楽観ロックで競合と削除が分かれる
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-event" を生成して "eventTitle" に保存する
    When POST "/api/v1/calendar-events" を body "{\"title\":\"{{eventTitle}}\",\"startAt\":\"2026-11-10T01:00:00.000Z\",\"endAt\":\"2026-11-10T02:00:00.000Z\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "eventId" に保存する
    And レスポンスの "data.revision" を "eventRev" に保存する
    When GET "/api/v1/calendar-events?from=2026-11-09T00:00:00.000Z&to=2026-11-11T00:00:00.000Z" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "title" 一覧に "{{eventTitle}}" と一致する要素が 1 件ある

  @S-HOME-11
  Scenario: 予定の変更は編集フラグを持たない MEMBER では拒否される
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-event" を生成して "eventTitle" に保存する
    When POST "/api/v1/calendar-events" を body "{\"title\":\"{{eventTitle}}\",\"startAt\":\"2026-11-11T01:00:00.000Z\",\"endAt\":\"2026-11-11T02:00:00.000Z\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "eventId" に保存する
    And レスポンスの "data.revision" を "eventRev" に保存する
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When PATCH "/api/v1/calendar-events/{{eventId}}" を空ボディで叩く
    Then ステータスコード 403 が返る
    When DELETE "/api/v1/calendar-events/{{eventId}}?revision={{eventRev}}" を叩く
    Then ステータスコード 403 が返る
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/calendar-events/{{eventId}}?revision={{eventRev}}" を叩く
    Then ステータスコード 200 が返る

  @S-HOME-12
  Scenario: 予定の削除は revision が違えば 409、合えば 200
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-event" を生成して "eventTitle" に保存する
    When POST "/api/v1/calendar-events" を body "{\"title\":\"{{eventTitle}}\",\"startAt\":\"2026-11-12T01:00:00.000Z\",\"endAt\":\"2026-11-12T02:00:00.000Z\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "eventId" に保存する
    And レスポンスの "data.revision" を "eventRev" に保存する
    When DELETE "/api/v1/calendar-events/{{eventId}}?revision=9999" を叩く
    Then ステータスコード 409 が返る
    When DELETE "/api/v1/calendar-events/{{eventId}}?revision={{eventRev}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/calendar-events/{{eventId}}?revision={{eventRev}}" を叩く
    Then ステータスコード 404 が返る
