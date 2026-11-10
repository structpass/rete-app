# rete トラック 4（ファイル）— 版・タグ・削除の境界
#
# 対応: docs/scenarios/tracks/04-files.md
#   S-FILE-03 同じ名前で上げると版が増える
#   S-FILE-05 タグを付けて一括でも付けられる
#   S-FILE-06 名前で全階層から探せる
#   S-FILE-09 中身のあるフォルダは消せない
#
# 実測（2026-10-25・backend 3011）:
#   - アップロードは 201 で FileRowDto（id / versionNo）を返す。同名で上げると versionNo が +1
#   - 中身のあるフォルダの削除は 409
#   - タグは ADMIN が POST /tags で作り、付与は PUT .../tags（全置換）と POST /files/tags/assign（追加）
#   - アップロードの後始末は /files/files/<id>（アップロード元 path からは組み立てられない）ため
#     専用ステップが自動で登録する

@files
Feature: ファイルの版・検索・タグ・アップロード・削除境界（S-FILE-02 / 03 / 04 / 05 / 06 / 07 / 08 / 09 / 10 / 12 / 13 / 14）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している
    And 固定値 "00000000-0000-4000-b000-000000000003" を "spaceId" に保存する

  # ------------------------------------------------------------------
  # S-FILE-03 版の追加と版指定取得
  # ------------------------------------------------------------------
  @S-FILE-03
  Scenario: 同じ名前で上げると版が増え、版を指定して取り出せる
    # e2e:verified AUTHZ pass "同じ名前で上げると版が増え、版を指定して取り出せる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    And 一意名 "e2e-file" を生成して "fileName" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.txt"・中身 "第1版" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And レスポンスの "data.versionNo" が数値 1 と一致する
    And 直前のレスポンスの id を "fileId" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.txt"・中身 "第2版" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And レスポンスの "data.versionNo" が数値 2 と一致する
    When GET "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.versionNo" が数値 2 と一致する
    When GET "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{fileId}}" と一致する要素が 1 件ある

  # ------------------------------------------------------------------
  # S-FILE-05 タグの単一付与（全置換）と一括付与（追加）
  # ------------------------------------------------------------------
  @S-FILE-05
  Scenario: タグを単一で置き換え、一括で追加し、タグで横断検索できる
    # e2e:verified AUTHZ pass "タグを単一で置き換え、一括で追加し、タグで横断検索できる"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-tag" を生成して "tagName" に保存する
    When POST "/api/v1/tags" を body "{\"name\":\"{{tagName}}\",\"icon\":\"Tag\",\"color\":\"blue\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "tagId" に保存する
    And 一意名 "e2e-tag2" を生成して "tagName2" に保存する
    When POST "/api/v1/tags" を body "{\"name\":\"{{tagName2}}\",\"icon\":\"Star\",\"color\":\"green\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "tagId2" に保存する
    And 一意名 "e2e-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    When PUT "/api/v1/files/folders/{{folderId}}/tags" を body "{\"tagIds\":[\"{{tagId}}\"]}" で叩く
    Then ステータスコード 200 が返る
    When POST "/api/v1/files/tags/assign" を body "{\"folderIds\":[\"{{folderId}}\"],\"addTagIds\":[\"{{tagId2}}\"]}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/files/tags/search?tagIds={{tagId2}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{folderId}}" と一致する要素が 1 件ある
    When PUT "/api/v1/files/folders/{{folderId}}/tags" を body "{\"tagIds\":[]}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/files/tags/search?tagIds={{tagId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{folderId}}" と一致する要素は 0 件

  # ------------------------------------------------------------------
  # S-FILE-06 名前の横断検索
  # ------------------------------------------------------------------
  @S-FILE-06
  Scenario: 深い階層のフォルダも名前で見つかる
    # e2e:verified AUTHZ pass "深い階層のフォルダも名前で見つかる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-parent" を生成して "parentName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{parentName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "parentId" に保存する
    And 一意名 "e2e-child" を生成して "childName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{childName}}\",\"parentFolderId\":\"{{parentId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "childId" に保存する
    When GET "/api/v1/files/search?q={{childName}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{childId}}" と一致する要素が 1 件ある
    When DELETE "/api/v1/files/folders/{{childId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{parentId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-FILE-09 中身のあるフォルダの削除拒否
  # ------------------------------------------------------------------
  @S-FILE-09
  Scenario: 中身のあるフォルダは消せず、空にすると消せる
    # e2e:verified AUTHZ pass "中身のあるフォルダは消せず、空にすると消せる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    And 一意名 "e2e-file" を生成して "fileName" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.txt"・中身 "中身あり" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "fileId" に保存する
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 409 が返る
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-FILE-10 設定変更の管理者境界（既存 feature の裏取り）
  # ------------------------------------------------------------------
  @S-FILE-10
  Scenario: アップロード設定の変更は管理者だけ
    # e2e:verified AUTHZ pass "アップロード設定の変更は管理者だけ"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When PATCH "/api/v1/files/settings" を空ボディで叩く
    Then ステータスコード 403 が返る
    Given システムADMIN "admin@rete.local" でログインする
    When GET "/api/v1/files/settings" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-FILE-04 移動
  #   画面はドラッグだが、退行ガードが見るのは所属の付け替えそのもの。
  #   移動先に出る／元の場所から消えるを、フォルダ内容の取得で確かめる。
  #   後始末は手順内の明示削除を先に済ませる（同名の二重登録はしない）。
  # ------------------------------------------------------------------
  @S-FILE-04
  Scenario: ファイルを別フォルダへ移すと移動先に出て元の場所から消える
    # e2e:verified AUTHZ pass "ファイルを別フォルダへ移すと移動先に出て元の場所から消える"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-move-a" を生成して "folderAName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderAName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderAId" に保存する
    And 一意名 "e2e-move-b" を生成して "folderBName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderBName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderBId" に保存する
    And 一意名 "e2e-move-file" を生成して "fileName" に保存する
    When POST "/api/v1/files/folders/{{folderAId}}/files" に名前 "{{fileName}}.txt"・中身 "移動する" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "fileId" に保存する
    When PATCH "/api/v1/files/files/{{fileId}}/move" を body "{\"folderId\":\"{{folderBId}}\"}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/files/folders/{{folderBId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{fileId}}" と一致する要素が 1 件ある
    When GET "/api/v1/files/folders/{{folderAId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{fileId}}" と一致する要素は 0 件
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderAId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderBId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-FILE-07 タグで横断検索
  #   複数のタグを指定した時は「どれかに一致」（OR）で返ることを確かめる。
  #   単一タグの絞り込みは S-FILE-05 が持つので、ここは OR の広がり方を見る。
  #   ユースケースの期待にある「そのタグが付いたものだけ」の"だけ"（余計が出ない）は、
  #   他のシナリオの残骸と混ざりうるため、このシナリオでは確かめていない（件数で絞る手順は未追加）。
  # ------------------------------------------------------------------
  @S-FILE-07
  Scenario: タグを 2 つ指定するとどちらかが付いたものが返る
    # e2e:verified AUTHZ pass "タグを 2 つ指定するとどちらかが付いたものが返る"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-tag-a" を生成して "tagNameA" に保存する
    When POST "/api/v1/tags" を body "{\"name\":\"{{tagNameA}}\",\"icon\":\"Tag\",\"color\":\"blue\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "tagIdA" に保存する
    And 一意名 "e2e-tag-b" を生成して "tagNameB" に保存する
    When POST "/api/v1/tags" を body "{\"name\":\"{{tagNameB}}\",\"icon\":\"Star\",\"color\":\"green\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "tagIdB" に保存する
    And 一意名 "e2e-or-a" を生成して "folderNameA" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderNameA}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderIdA" に保存する
    And 一意名 "e2e-or-b" を生成して "folderNameB" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderNameB}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderIdB" に保存する
    When PUT "/api/v1/files/folders/{{folderIdA}}/tags" を body "{\"tagIds\":[\"{{tagIdA}}\"]}" で叩く
    Then ステータスコード 200 が返る
    When PUT "/api/v1/files/folders/{{folderIdB}}/tags" を body "{\"tagIds\":[\"{{tagIdB}}\"]}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/files/tags/search?tagIds={{tagIdA}},{{tagIdB}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{folderIdA}}" と一致する要素が 1 件ある
    And レスポンス配列の "id" 一覧に "{{folderIdB}}" と一致する要素が 1 件ある
    When DELETE "/api/v1/files/folders/{{folderIdA}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderIdB}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-FILE-14 拒否拡張子
  #   画面は「設定したら弾かれる・外したら通る」を見せる。許可一覧は `.txt` 形式（小文字・ドット付き）で
  #   保存される（files.service.ts の normalizeExtensions は小文字化だけでドットを足さない。ドット無しで
  #   送ると判定に一致せず保存は通るが全件拒否になる）。許可一覧が空の間は全拡張子が通る（既定）。
  #   手順の最後で許可一覧を空へ戻す（元は空＝既定）。.exe は設定と無関係に常時拒否される層があるが、
  #   このシナリオが確かめるのは設定で外せる側。
  #   `=>` は設定を戻す行。メンバー操作の途中で落ちても、後始末で許可一覧が既定へ戻る。
  #   戻し行の直後の「設定を戻した」が、後始末でも流さないための印（二重に戻さない）。
  # ------------------------------------------------------------------
  @S-FILE-14
  Scenario: 許可一覧に無い拡張子は弾かれ、設定を外すと通る
    # e2e:verified AUTHZ pass "許可一覧に無い拡張子は弾かれ、設定を外すと通る"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-ext" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/files/settings" を body "{\"allowedExtensions\":[\".txt\"]}" で叩く
    Then ステータスコード 200 が返る
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-ext-file" を生成して "fileName" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.csv"・中身 "拒否される" のファイルを multipart で送り id を記録する
    Then ステータスコード 400 が返る
    When PATCH "/api/v1/files/settings" を body "{\"allowedExtensions\":[]}" で叩く => システムADMIN "admin@rete.local"
    Then ステータスコード 200 が返る
    And 設定を戻した
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.csv"・中身 "通る" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "fileId" に保存する
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-FILE-08 ダウンロード（最新版・版指定）
  #   画面は行のダウンロードだが、退行ガードが見るのは「返る中身が版と一致するか」。
  #   版 2 を上げた後に、最新版の口が 2 回目の中身を返し、版指定の口が 1 回目の中身を返すことを確かめる。
  # ------------------------------------------------------------------
  @S-FILE-08
  Scenario: 最新版は最新の版、版を指定するとその版の中身が返る
    # e2e:verified AUTHZ pass "最新版は最新の版、版を指定するとその版の中身が返る"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-dl-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    And 一意名 "e2e-dl" を生成して "fileName" に保存する
    And 固定値 "最初の版の中身" を "firstBody" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.txt"・中身 "{{firstBody}}" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "fileId" に保存する
    And 固定値 "二つ目の版の中身" を "secondBody" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.txt"・中身 "{{secondBody}}" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And レスポンスの "data.versionNo" が数値 2 と一致する
    When GET "/api/v1/files/files/{{fileId}}/download" を叩く
    Then ステータスコード 200 が返る
    And 取得した中身が保存値 "secondBody" と一致する
    When GET "/api/v1/files/files/{{fileId}}/versions/1/download" を叩く
    Then ステータスコード 200 が返る
    And 取得した中身が保存値 "firstBody" と一致する
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-FILE-02 アップロード（一覧への反映）
  #   期待のうち「大きさと更新時刻が入る」を、一覧の行から確かめる。
  #   上限超過・拒否拡張子の拒否は S-FILE-14 が受け持つ（こちらは幸せ道）。
  # ------------------------------------------------------------------
  @S-FILE-02
  Scenario: 上げたファイルが一覧に出て、大きさと更新時刻が入る
    # e2e:verified AUTHZ pass "上げたファイルが一覧に出て、大きさと更新時刻が入る"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-up-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    And 一意名 "e2e-up" を生成して "fileName" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.txt"・中身 "大きさを見る中身" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "fileId" に保存する
    When GET "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{fileId}}" と一致する要素が 1 件ある
    And レスポンス配列の "byteSize" 一覧に 0 より大きい値がある
    And レスポンス配列の "updatedAt" 一覧に空でない値がある
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-FILE-12 添付を外してもファイルは残る
  #   発話への添付を解除し、一覧から消えても、ファイル本体は取得できることを確かめる。
  # ------------------------------------------------------------------
  @S-FILE-12
  Scenario: 発話の添付を解除してもファイル本体は残る
    # e2e:verified AUTHZ pass "発話の添付を解除してもファイル本体は残る"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-detach-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    And 一意名 "e2e-detach" を生成して "fileName" に保存する
    And 固定値 "解除しても残る中身" を "fileBody" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.txt"・中身 "{{fileBody}}" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "fileId" に保存する
    And 一意名 "e2e-detach-theme" を生成して "themeTitle" に保存する
    When POST "/api/v1/chat/themes" を body "{\"title\":\"{{themeTitle}}\",\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    When POST "/api/v1/chat/themes/{{themeId}}/messages" を body "{\"body\":\"資料を付けます\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "messageId" に保存する
    When POST "/api/v1/attachments" を body "{\"targetType\":\"chatMessage\",\"targetId\":\"{{messageId}}\",\"fileId\":\"{{fileId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "attachmentId" に保存する
    When DELETE "/api/v1/attachments/{{attachmentId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/attachments?targetType=chatMessage&targetId={{messageId}}" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "attachmentId" の行が入っていない
    When GET "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/files/files/{{fileId}}/download" を叩く
    Then ステータスコード 200 が返る
    And 取得した中身が保存値 "fileBody" と一致する
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-FILE-13 同じものを 2 回消しても壊れない
  #   期待は「後の操作は既に無いとして扱われ、画面が壊れない」。実測では、ファイルも空フォルダも
  #   2 回目は 404（統一の文言「対象が見つかりません」）で断られ、500 で落ちない。
  #   409「空でないフォルダは削除できません」は中身が残る時だけ＝二重削除では出ない（実測 2026-10-26）。
  #   画面が壊れないことは API では判定できない（04-files.md の未確定事項に残す）。
  # ------------------------------------------------------------------
  @S-FILE-13
  Scenario: 同じファイルと同じ空フォルダを 2 回消しても、2 回目は既に無いとして断られる
    # e2e:verified AUTHZ pass "同じファイルと同じ空フォルダを 2 回消しても、2 回目は既に無いとして断られる"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-twice-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"name\":\"{{folderName}}\",\"parentFolderId\":null,\"spaceId\":\"{{spaceId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    And 一意名 "e2e-twice" を生成して "fileName" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}.txt"・中身 "二重に消す中身" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "fileId" に保存する
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 404 が返る
    # 空にしたフォルダも、2 人目が続けて消した時に同じ扱いになる。
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 404 が返る
