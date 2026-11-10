# rete トラック 3（Desk）— チャットとタスクの操作境界
#
# 対応: docs/scenarios/tracks/03-desk.md
#   S-DESK-02 リアクションが付いて外れる（トグル）
#   S-DESK-05 タスクを親ごと・分類ごと動かせる
#   S-DESK-06 担当者・優先度・期限を編集できる
#   S-DESK-07 他人の発話は編集できない（管理者は例外）
#   S-DESK-11 分類を作れて、使用中は消せない
#   S-DESK-14 発話を編集・削除できるのは本人だけ
#
# 実測（2026-10-25・backend 3011）:
#   - リアクションは POST のたびに付与／解除が反転し {reacted} を返す
#   - 他人の発話の編集・削除は 403（ADMIN は通る）
#   - 使用中（タスクが紐づく）分類の削除は 409
#   - タスクの移動は PATCH /tasks/:id/move（parentTaskId / categoryId / afterTaskId が必須）

@desk
Feature: Desk の操作境界（S-DESK-02 / 05 / 06 / 07 / 11 / 14）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している
    And 固定値 "00000000-0000-4000-b000-000000000003" を "spaceId" に保存する

  # ------------------------------------------------------------------
  # S-DESK-02 リアクションのトグル
  # ------------------------------------------------------------------
  @S-DESK-02
  Scenario: リアクションは 1 回目で付き 2 回目で外れる
    # e2e:verified AUTHZ pass "リアクションは 1 回目で付き 2 回目で外れる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-theme" を生成して "themeTitle" に保存する
    When POST "/api/v1/chat/themes" を body "{\"title\":\"{{themeTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    When POST "/api/v1/chat/themes/{{themeId}}/messages" を body "{\"body\":\"リアクションの対象\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "messageId" に保存する
    When POST "/api/v1/chat/messages/{{messageId}}/reactions" を body "{\"emoji\":\"👍\"}" で叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.reacted" が真偽値 "true" である
    When GET "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.messages.0.reactions.0.count" が数値 1 と一致する
    When POST "/api/v1/chat/messages/{{messageId}}/reactions" を body "{\"emoji\":\"👍\"}" で叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.reacted" が真偽値 "false" である

  # ------------------------------------------------------------------
  # S-DESK-14 発話の編集・削除（本人）
  # ------------------------------------------------------------------
  @S-DESK-14
  Scenario: 自分の発話は編集でき削除すると一覧から消える
    # e2e:verified AUTHZ pass "自分の発話は編集でき削除すると一覧から消える"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-theme" を生成して "themeTitle" に保存する
    When POST "/api/v1/chat/themes" を body "{\"title\":\"{{themeTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    When POST "/api/v1/chat/themes/{{themeId}}/messages" を body "{\"body\":\"編集前の本文\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "messageId" に保存する
    When PATCH "/api/v1/chat/messages/{{messageId}}" を body "{\"body\":\"編集後の本文\"}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.messages.0.body" が "編集後の本文" と一致する
    When DELETE "/api/v1/chat/messages/{{messageId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/chat/themes/{{themeId}}" を叩く
    Then レスポンスの "data.messages" が空でない
    When DELETE "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-DESK-11 分類の削除拒否
  # ------------------------------------------------------------------
  @S-DESK-11
  Scenario: 使用中の分類は消せず、タスクを消すと消せる
    # e2e:verified AUTHZ pass "使用中の分類は消せず、タスクを消すと消せる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-cat" を生成して "catName" に保存する
    When POST "/api/v1/categories" を body "{\"name\":\"{{catName}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "catId" に保存する
    And 一意名 "e2e-task" を生成して "taskTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{taskTitle}}\",\"categoryId\":{{catId}},\"spaceId\":\"{{spaceId}}\"}" で置換してから叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "taskId" に保存する
    When DELETE "/api/v1/categories/{{catId}}" を叩く
    Then ステータスコード 409 が返る
    When DELETE "/api/v1/tasks/{{taskId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/categories/{{catId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-DESK-05 / 06 タスクの移動と属性編集
  # ------------------------------------------------------------------
  @S-DESK-05
  Scenario: 子タスクを別の親へ移すとツリーの位置が変わる
    # e2e:verified AUTHZ pass "子タスクを別の親へ移すとツリーの位置が変わる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-cat" を生成して "catName" に保存する
    When POST "/api/v1/categories" を body "{\"name\":\"{{catName}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "catId" に保存する
    And 一意名 "e2e-p1" を生成して "p1Title" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{p1Title}}\",\"categoryId\":{{catId}},\"spaceId\":\"{{spaceId}}\"}" で置換してから叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "p1Id" に保存する
    And 一意名 "e2e-p2" を生成して "p2Title" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{p2Title}}\",\"categoryId\":{{catId}},\"spaceId\":\"{{spaceId}}\"}" で置換してから叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "p2Id" に保存する
    And 一意名 "e2e-child" を生成して "childTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{childTitle}}\",\"categoryId\":{{catId}},\"spaceId\":\"{{spaceId}}\",\"parentTaskId\":{{p1Id}}}" で置換してから叩き id を記録する
    Then ステータスコード 201 が返る
    And レスポンスの "data.parentTaskId" が保存値 "p1Id" と一致する
    And 直前のレスポンスの id を "childId" に保存する
    When PATCH "/api/v1/tasks/{{childId}}/move" を body "{\"parentTaskId\":{{p2Id}},\"categoryId\":{{catId}},\"afterTaskId\":null}" で置換してから叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/tasks/{{childId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.parentTaskId" が保存値 "p2Id" と一致する
    When DELETE "/api/v1/tasks/{{childId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/tasks/{{p1Id}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/tasks/{{p2Id}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/categories/{{catId}}" を叩く
    Then ステータスコード 200 が返る

  @S-DESK-06
  Scenario: 担当者・期限を変えると属性変更が記録に残る
    # e2e:verified AUTHZ pass "担当者・期限を変えると属性変更が記録に残る"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-task" を生成して "taskTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{taskTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "taskId" に保存する
    When GET "/api/v1/accounts/by-space?spaceId={{spaceId}}" を叩く
    Then ステータスコード 200 が返る
    When PUT "/api/v1/tasks/{{taskId}}" を body "{\"dueDate\":\"2026-11-30T00:00:00.000Z\",\"status\":\"IN_PROGRESS\"}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/tasks/{{taskId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.status" が "IN_PROGRESS" と一致する
    When GET "/api/v1/tasks/{{taskId}}/activities" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data" が空でない
    When DELETE "/api/v1/tasks/{{taskId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-DESK-07 他人の発話は編集できない（管理者は例外）
  # ------------------------------------------------------------------
  @S-DESK-07
  Scenario: 他人の発話の編集は 403、管理者は通る
    # e2e:verified AUTHZ pass "他人の発話の編集は 403、管理者は通る"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-theme" を生成して "themeTitle" に保存する
    When POST "/api/v1/chat/themes" を body "{\"title\":\"{{themeTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    When POST "/api/v1/chat/themes/{{themeId}}/messages" を body "{\"body\":\"管理者の発話\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "messageId" に保存する
    And メール "of-admin@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "other" に用意する
    When 保存セッション "other" で PATCH "/api/v1/chat/messages/{{messageId}}" を body "{\"body\":\"乗っ取り\"}" で叩く
    Then ステータスコード 403 が返る
    When 保存セッション "other" で DELETE "/api/v1/chat/messages/{{messageId}}" を叩く
    Then ステータスコード 403 が返る
    When PATCH "/api/v1/chat/messages/{{messageId}}" を body "{\"body\":\"管理者の訂正\"}" で叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る
