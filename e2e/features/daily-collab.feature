# rete 日常幸せ道ジャーニー — 日常協働（daily-collab / cmn-0138）
#
# 検証対象:
#   DAILY-COLLAB-01  chat: テーマ作成 → メッセージ投稿 → 一覧反映 → 削除
#   DAILY-COLLAB-02  task: 作成 → 一覧反映 → 削除
#   DAILY-COLLAB-03  file: フォルダ作成 → 一覧反映 → 削除
#
# 退行ガード目的: chat/task/file の基本操作（幸せ道）が成功し続けることを
# 保証する（拒否側のみだった既存 feature を補完 / cmn-0050 P2 後半）。
#
# 全シナリオ「一意名作成 → アサート → シナリオ内削除」で連続2回実行 green（冪等）。
# 操作者は日常協働の実ユーザー像＝システム MEMBER（chat/task/file CRUD 可）。
# 一覧は okPaginated({items}) だが、包含アサート step が
# shape を正規化するため feature 側は意識しない。

@daily
Feature: 日常幸せ道 — 日常協働（daily-collab）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # DAILY-COLLAB-01 チャット: テーマ作成 → 投稿 → 一覧反映 → 詳細 → 削除
  # ------------------------------------------------------------------
  @DAILY-COLLAB-01
  Scenario: チャットテーマを作成しメッセージ投稿、一覧反映後に削除できる
    # e2e:verified AUTHZ pass "チャットテーマを作成しメッセージ投稿、一覧反映後に削除できる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-theme" を生成して "themeTitle" に保存する
    When POST "/api/v1/chat/themes" を body "{\"title\":\"{{themeTitle}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    When POST "/api/v1/chat/themes/{{themeId}}/messages" を body "{\"body\":\"e2e からの最初の発話\"}" で叩く
    Then ステータスコード 201 が返る
    When GET "/api/v1/chat/themes" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{themeTitle}}" が含まれる
    When GET "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.title" が "{{themeTitle}}" と一致する
    When DELETE "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/chat/themes" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{themeTitle}}" が含まれない

  # ------------------------------------------------------------------
  # DAILY-COLLAB-02 タスク: 作成 → 一覧反映 → 詳細 → 削除
  # ------------------------------------------------------------------
  @DAILY-COLLAB-02
  Scenario: タスクを作成し一覧反映後に削除できる
    # e2e:verified AUTHZ pass "タスクを作成し一覧反映後に削除できる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-task" を生成して "taskTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{taskTitle}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "taskId" に保存する
    When GET "/api/v1/tasks" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{taskTitle}}" が含まれる
    When GET "/api/v1/tasks/{{taskId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.title" が "{{taskTitle}}" と一致する
    When DELETE "/api/v1/tasks/{{taskId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/tasks" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{taskTitle}}" が含まれない

  # ------------------------------------------------------------------
  # DAILY-COLLAB-03 ファイル: フォルダ作成（ルート直下）→ tree 反映 → 詳細 → 削除
  # tree は器（Space）スコープ必須・ルート直下作成も spaceId 必須（ADR 0063・fil-0137）。
  # 既定チャネル（DEFAULT_CHANNEL_ID）は seed の固定 ID。
  # ------------------------------------------------------------------
  @DAILY-COLLAB-03
  Scenario: フォルダを作成し tree 一覧反映後に削除できる
    # e2e:verified AUTHZ pass "フォルダを作成し tree 一覧反映後に削除できる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderName}}\",\"parentFolderId\":null,\"spaceId\":\"00000000-0000-4000-b000-000000000003\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    When GET "/api/v1/files/tree?spaceId=00000000-0000-4000-b000-000000000003" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{folderName}}" が含まれる
    When GET "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.name" が "{{folderName}}" と一致する
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/files/tree?spaceId=00000000-0000-4000-b000-000000000003" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{folderName}}" が含まれない
