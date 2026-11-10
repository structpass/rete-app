# rete Desk トラック（docs/scenarios/tracks/03-desk.md）の未確認行 — 2026-10-25
#
# 対応:
#   S-DESK-03 チャットをタスクへ昇格できる（昇格元テーマ ID がタスクに残り、器も割れない）
#   S-DESK-10 器を切り替えると中身が入れ替わる（前の器の内容が残らない）
#   S-DESK-12 発話にファイルを添付できる（添付時点の版に固定され、解除しても実体は残る）
#   S-DESK-15 タスクの顛末を書いて閉じられる（完了には顛末が要り、ツリーからも読める）
#   S-DESK-16 同時に 2 人が同じタスクを動かしても壊れない（循環を作らず、後の操作が勝つ）
#
# 実測して期待を決めた行（未確認ではないが、期待が実行で確かまっていなかったもの）:
#   S-DESK-08 右（スレッド）と左（タスク詳細）の重なりが常に 1 枚。画面の部品の試験
#             （desk-shell「二重オーバーレイ禁止: promoteDraft があるとタスク詳細を出さないこと」）が持つ
#   S-DESK-09 編集中に離れると確認が出て、取り消すと編集内容が残る。同じ部品の試験
#             （desk-shell「編集中に余白クリックすると破棄ダイアログが出て、キャンセルなら閉じない」）が持つ
#
# 実行の並び: ファイル名の辞書順で走るため、他の feature の後ろへ回す。「zz-」を先頭に置く。
# 作ったデータ（テーマ・発話・タスク・分類・フォルダ・ファイル・添付）は、シナリオ内で明示的に消す。
#
# 状態（tracks の表）は、この feature が緑になった結果でだけ ✅ にする（README §5）。

@desk-track
Feature: Desk トラックの未確認行（S-DESK-03 / 10 / 12 / 15 / 16）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している
    And 固定値 "00000000-0000-4000-b000-000000000003" を "spaceId" に保存する

  # ------------------------------------------------------------------
  # S-DESK-03 チャットをタスクへ昇格する
  # ------------------------------------------------------------------
  @S-DESK-03
  Scenario: チャットの相談をタスクへ昇格すると昇格元がタスクに残る
    # e2e:verified ZZ-DESK-TRACK pass "チャットの相談をタスクへ昇格すると昇格元がタスクに残る"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-theme" を生成して "themeTitle" に保存する
    When POST "/api/v1/chat/themes" を body "{\"title\":\"{{themeTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    # 昇格（画面では発話をタスク側へドラッグする）。行き先はタスク作成の sourceThemeId。
    And 一意名 "e2e-task" を生成して "taskTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{taskTitle}}\",\"spaceId\":\"{{spaceId}}\",\"sourceThemeId\":\"{{themeId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "taskId" に保存する
    # 昇格元の発話への参照が残る（詳細と一覧の両面で読める）。
    When GET "/api/v1/tasks/{{taskId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.sourceThemeId" が保存値 "themeId" と一致する
    # タスクはテーマと同じ器に置かれる（昇格しても器が割れない）。
    # タスクの応答に器の欄は無いので、同じ器を絞りにしたツリーに載ることで確かめる。
    When GET "/api/v1/tasks/tree?spaceId={{spaceId}}" を叩く
    Then ステータスコード 200 が返る
    And タスクのツリーに保存値 "taskTitle" が入っている
    And タスクのツリーに保存値 "taskTitle" の行が "TODO" の状態で入っている
    # 一覧の応答でも昇格元が読める（キーワードは一意名の先頭で掘れば 1 件に絞れる）。
    When GET "/api/v1/tasks?search={{taskTitle}}&limit=100" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "sourceThemeId" が保存値 "themeId" の行で入っている
    When DELETE "/api/v1/tasks/{{taskId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-DESK-10 器を切り替えると中身が入れ替わる
  # ------------------------------------------------------------------
  @S-DESK-10
  Scenario: 器を切り替えると前の器の中身が入れ替わり、前の器の内容が残らない
    # e2e:verified ZZ-DESK-TRACK pass "器を切り替えると前の器の中身が入れ替わり、前の器の内容が残らない"
    Given システムMEMBER "wh-user@struct-pass.example" でログインする
    # 既定チャット（...0003）と入荷チャネル（...0030）の 2 つの器を、両方に居る人（倉庫 一郎）で切り替える。
    And 固定値 "00000000-0000-4000-b000-000000000030" を "spaceId" に保存する
    And 一意名 "e2e-switch-a" を生成して "titleA" に保存する
    When POST "/api/v1/chat/themes" を body "{\"title\":\"{{titleA}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeA" に保存する
    And 一意名 "e2e-switch-b" を生成して "titleB" に保存する
    When POST "/api/v1/chat/themes" を body "{\"title\":\"{{titleB}}\",\"spaceId\":\"00000000-0000-4000-b000-000000000003\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeB" に保存する
    # 1. 入荷チャネルを選んでいる: 入荷の明細だけが出る（既定チャットの明細は出ない）
    When GET "/api/v1/chat/themes?spaceId={{spaceId}}&limit=100" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "themeA" の行で入っている
    And 一覧に "id" が保存値 "themeB" の行が入っていない
    # 2. 既定チャットへ切り替える: 明細が入れ替わり、前の器（入荷）の明細が残らない
    When GET "/api/v1/chat/themes?spaceId=00000000-0000-4000-b000-000000000003&limit=100" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "themeB" の行で入っている
    And 一覧に "id" が保存値 "themeA" の行が入っていない
    # 3. タスクの明細も器で入れ替わる（入荷チャネルのツリーに、既定チャットで作ったタスクは出ない）
    And 固定値 "00000000-0000-4000-b000-000000000003" を "defaultSpaceId" に保存する
    And 一意名 "e2e-switch-task" を生成して "taskTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{taskTitle}}\",\"spaceId\":\"{{defaultSpaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "taskId" に保存する
    When GET "/api/v1/tasks/tree?spaceId={{spaceId}}" を叩く
    Then ステータスコード 200 が返る
    And タスクのツリーに保存値 "taskTitle" が無い
    When GET "/api/v1/tasks/tree?spaceId={{defaultSpaceId}}" を叩く
    Then ステータスコード 200 が返る
    And タスクのツリーに保存値 "taskTitle" が入っている
    When DELETE "/api/v1/tasks/{{taskId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/chat/themes/{{themeA}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/chat/themes/{{themeB}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-DESK-12 発話にファイルを添付できる
  # ------------------------------------------------------------------
  @S-DESK-12
  Scenario: 発話に添付したファイルは添付時点の版に固定され、解除しても実体は残る
    # e2e:verified ZZ-DESK-TRACK pass "発話に添付したファイルは添付時点の版に固定され、解除しても実体は残る"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-theme" を生成して "themeTitle" に保存する
    When POST "/api/v1/chat/themes" を body "{\"title\":\"{{themeTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    When POST "/api/v1/chat/themes/{{themeId}}/messages" を body "{\"body\":\"見積書を付けます\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "messageId" に保存する
    # ファイルはフォルダの下に置いてから添付する（添付時点の最新版が固定される）。
    And 一意名 "e2e-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"parentFolderId\":null,\"name\":\"{{folderName}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    And 一意名 "e2e-attach" を生成して "fileName" に保存する
    And 固定値 "添付した時の中身です" を "fileBody" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}"・中身 "{{fileBody}}" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "fileId" に保存する
    When POST "/api/v1/attachments" を body "{\"targetType\":\"chatMessage\",\"targetId\":\"{{messageId}}\",\"fileId\":\"{{fileId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "attachmentId" に保存する
    # 添付の後に同じファイルへ新しい版を上げても、添付は挙げた時の版を指し続ける。
    When POST "/api/v1/files/files/{{fileId}}/versions" に名前 "{{fileName}}"・中身 "あとで上げた別の中身です" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    # 発話の詳細から添付が見え、開くと添付した時の中身で返る。
    When GET "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る
    And 保存値 "fileName" と同じ名称の発話の添付を取得する
    Then ステータスコード 200 が返る
    And 取得した中身が保存値 "fileBody" と一致する
    # 添付一覧に出て、解除すると一覧から消える。
    When GET "/api/v1/attachments?targetType=chatMessage&targetId={{messageId}}" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "attachmentId" の行で入っている
    When DELETE "/api/v1/attachments/{{attachmentId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/attachments?targetType=chatMessage&targetId={{messageId}}" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "attachmentId" の行が入っていない
    # 解除してもファイルの実体は消えない（取得できる）。
    When GET "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-DESK-15 タスクの顛末を書いて閉じる
  # ------------------------------------------------------------------
  @S-DESK-15
  Scenario: 完了には顛末が要り、書いた顛末はツリーからも読める
    # e2e:verified ZZ-DESK-TRACK pass "完了には顛末が要り、書いた顛末はツリーからも読める"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-cat" を生成して "catName" に保存する
    When POST "/api/v1/categories" を body "{\"name\":\"{{catName}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "catId" に保存する
    And 一意名 "e2e-task" を生成して "taskTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{taskTitle}}\",\"categoryId\":{{catId}},\"spaceId\":\"{{spaceId}}\"}" で置換してから叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "taskId" に保存する
    # 顛末なしで完了にしようとすると断られる（完了ゲート）。
    When PUT "/api/v1/tasks/{{taskId}}" を body "{\"status\":\"DONE\"}" で叩く
    Then ステータスコード 400 が返る
    # 顛末を書いて完了にできる。
    When PUT "/api/v1/tasks/{{taskId}}" を body "{\"status\":\"DONE\",\"tenmatsu\":\"<p>原因を特定して直した</p>\"}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/tasks/{{taskId}}" を叩く
    Then レスポンスの "data.status" が "DONE" と一致する
    And レスポンスの "data.tenmatsu" が空でない
    # ツリーからも状態が読める（書いた顛末がツリーの行へ載る）。
    When GET "/api/v1/tasks/tree?spaceId={{spaceId}}" を叩く
    Then ステータスコード 200 が返る
    And タスクのツリーに保存値 "taskTitle" の行が "DONE" の状態で入っている
    # 後始末
    When DELETE "/api/v1/tasks/{{taskId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/categories/{{catId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-DESK-16 同時に 2 人が同じタスクを動かしても壊れない
  # ------------------------------------------------------------------
  @S-DESK-16
  Scenario: 2 つの画面から同じタスクを別の位置へ動かしても循環や欠落が起きない
    # e2e:verified ZZ-DESK-TRACK pass "2 つの画面から同じタスクを別の位置へ動かしても循環や欠落が起きない"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-p" を生成して "pTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{pTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pId" に保存する
    And 一意名 "e2e-q" を生成して "qTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{qTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "qId" に保存する
    And 一意名 "e2e-c" を生成して "cTitle" に保存する
    When POST "/api/v1/tasks" を body "{\"title\":\"{{cTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "cId" に保存する
    # 1 人が P の下へ C を動かし、もう 1 人が続けて Q の下へ動かす（後の操作が勝つ）。
    When PATCH "/api/v1/tasks/{{cId}}/move" を body "{\"parentTaskId\":{{pId}},\"categoryId\":null,\"afterTaskId\":null}" で置換してから叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/tasks/{{cId}}/move" を body "{\"parentTaskId\":{{qId}},\"categoryId\":null,\"afterTaskId\":null}" で置換してから叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/tasks/{{cId}}" を叩く
    Then レスポンスの "data.parentTaskId" が保存値 "qId" と一致する
    # 自分の子孫の下へは動かせない（循環を作らない）。
    When PATCH "/api/v1/tasks/{{qId}}/move" を body "{\"parentTaskId\":{{cId}},\"categoryId\":null,\"afterTaskId\":null}" で置換してから叩く
    Then ステータスコード 400 が返る
    # 3 件とも欠けずにツリーへ出ている。
    When GET "/api/v1/tasks/tree?spaceId={{spaceId}}" を叩く
    Then ステータスコード 200 が返る
    And タスクのツリーに保存値 "pTitle" が入っている
    And タスクのツリーに保存値 "qTitle" が入っている
    And タスクのツリーに保存値 "cTitle" が入っている
    # 後始末（子 → 親 → 親 の順）
    When DELETE "/api/v1/tasks/{{cId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/tasks/{{qId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/tasks/{{pId}}" を叩く
    Then ステータスコード 200 が返る
