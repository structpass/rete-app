# rete トラック 6（スコープ）— 組織・プロジェクト・チャネルの境界
#
# 対応: docs/scenarios/tracks/06-scope.md
#   S-SPC-01 組織を作ると作成者が管理者になる
#   S-SPC-02 プロジェクトは組織の管理者だけが作れる
#   S-SPC-03 チャネルを作れるのはプロジェクトの管理者だけ
#   S-SPC-04 チャネルに人を招くと見えるようになる
#   S-SPC-05 所属外のデータは見えず、直叩きも通らない
#   S-SPC-07 中身のある組織は消せない
#
# 実測（2026-10-25・backend 3011）:
#   - 組織の作成は MEMBER でも可（201）で作成者が ORG ADMIN になる
#   - 配下の PJ 作成・チャネル作成は非所属で 403
#   - 非所属の一覧取得は「スコープつき一覧（spaces）」が 403、実データ（tasks/tree・files/tree）は 404
#     ＝ 見せる・隠すの返し方が経路で違う（この差自体を記録に残す）
#   - 中身のある組織の削除は 409。片付けるときは archived=true

@scope
Feature: 組織・プロジェクト・チャネルの境界（S-SPC-01 / 02 / 03 / 04 / 05 / 07）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-SPC-01 組織作成と管理者就任
  # ------------------------------------------------------------------
  @S-SPC-01
  Scenario: 組織を作ると作成者がその組織の管理者になる
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When GET "/api/v1/organizations" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{orgId}}" と一致する要素が 1 件ある
    When GET "/api/v1/memberships?scopeType=ORGANIZATION&scopeId={{orgId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.0.role" が "ADMIN" と一致する

  # ------------------------------------------------------------------
  # S-SPC-02 / 03 作成権限
  # ------------------------------------------------------------------
  @S-SPC-02
  Scenario: 配下のプロジェクトとチャネルは上位の管理者だけが作れる
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
    # 非所属のユーザーは同じ組織に作れない
    And メール "wh-user@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "outsider" に用意する
    When 保存セッション "outsider" で GET "/api/v1/spaces?kind=CHANNEL&projectId={{pjId}}" を叩く
    Then ステータスコード 403 が返る
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/spaces/admin/{{chId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/projects/admin/{{pjId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/organizations/admin/{{orgId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る

  @S-SPC-03
  Scenario: プロジェクトの一般メンバーは配下にチャネルを作れない
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    And 一意名 "e2e-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    And 一意名 "e2e-pj" を生成して "pjName" に保存する
    When POST "/api/v1/projects" を body "{\"name\":\"{{pjName}}\",\"organizationId\":\"{{orgId}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000002" を "whId" に保存する
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{whId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    And メール "wh-user@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "member" に用意する
    When 保存セッション "member" で POST "/api/v1/spaces" を body "{\"name\":\"e2e-denied\",\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\"}" で叩く
    Then ステータスコード 403 が返る
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/projects/admin/{{pjId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/organizations/admin/{{orgId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-SPC-04 / 05 招いて見える、外して見えなくなる
  # ------------------------------------------------------------------
  @S-SPC-04
  Scenario: 招かれた人だけがデータに届き、外すと 404 に戻る
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
    And メール "wh-user@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "guest" に用意する
    When 保存セッション "guest" で GET "/api/v1/files/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 404 が返る
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{whId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "membershipId" に保存する
    When 保存セッション "guest" で GET "/api/v1/files/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/memberships/{{membershipId}}" を叩く
    Then ステータスコード 204 が返る
    When 保存セッション "guest" で GET "/api/v1/files/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 404 が返る
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/spaces/admin/{{chId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/projects/admin/{{pjId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/organizations/admin/{{orgId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-SPC-05 越境の遮断（seed の固定構造で確かめる）
  # ------------------------------------------------------------------
  @S-SPC-05
  Scenario: 所属しないプロジェクトのチャネルは一覧に出ず直叩きも 404
    Given システムMEMBER "wh-user@struct-pass.example" でログインする
    When GET "/api/v1/spaces?kind=CHANNEL&projectId=00000000-0000-4000-b000-000000000022" を叩く
    Then ステータスコード 403 が返る
    When GET "/api/v1/files/tree?spaceId=00000000-0000-4000-b000-000000000035" を叩く
    Then ステータスコード 404 が返る
    When GET "/api/v1/tasks/tree?spaceId=00000000-0000-4000-b000-000000000035" を叩く
    Then ステータスコード 404 が返る

  # ------------------------------------------------------------------
  # S-SPC-07 中身のある組織は消せない
  # ------------------------------------------------------------------
  @S-SPC-07
  Scenario: 配下にプロジェクトがある組織は削除できず、片付けは archive で行う
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    And 一意名 "e2e-pj" を生成して "pjName" に保存する
    When POST "/api/v1/projects/admin" を body "{\"name\":\"{{pjName}}\",\"organizationId\":\"{{orgId}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    When DELETE "/api/v1/organizations/admin/{{orgId}}" を叩く
    Then ステータスコード 409 が返る
    When PATCH "/api/v1/projects/admin/{{pjId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/organizations/admin/{{orgId}}" を叩く
    Then ステータスコード 409 が返る
    When PATCH "/api/v1/organizations/admin/{{orgId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-SPC-10 異動した人の見え方が切り替わる（d776・実測 2026-10-25）
  #   異動を「アカウントの所属の切り替え」で表す: 旧所属を外し、新しい所属を足す。
  #   seed の newcomer は最初どのプロジェクトにも所属していないため、前提は「新所属を
  #   足す前は見えない・足した後は見える」で組み、最後に足した所属を外して戻す。
  # ------------------------------------------------------------------
  @S-SPC-10
  Scenario: 所属を切り替えると旧チャネルは見えず、新チャネルが見える
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "00000000-0000-4000-a000-000000000007" を "ncId" に保存する
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
    And メール "newcomer@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "nc" に用意する
    When 保存セッション "nc" で GET "/api/v1/files/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 404 が返る
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{ncId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "mid" に保存する
    When 保存セッション "nc" で GET "/api/v1/files/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 200 が返る
    When 保存セッション "nc" で GET "/api/v1/memberships?scopeType=PROJECT&scopeId={{pjId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列で "accountId" が "{{ncId}}" と一致する要素は 1 件
    When 保存セッション "nc" で GET "/api/v1/spaces?kind=CHANNEL&projectId={{pjId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "id" 一覧に "{{chId}}" と一致する要素が 1 件ある
    When DELETE "/api/v1/memberships/{{mid}}" を叩く
    Then ステータスコード 204 が返る
    When 保存セッション "nc" で GET "/api/v1/files/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 404 が返る
    When 保存セッション "nc" で GET "/api/v1/spaces?kind=CHANNEL&projectId={{pjId}}" を叩く
    Then ステータスコード 403 が返る
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/spaces/admin/{{chId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/projects/admin/{{pjId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/organizations/admin/{{orgId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    Then 実測して挙動が決まったので "S-SPC-10" を確認済みにする

  # ------------------------------------------------------------------
  # S-SPC-11 脱退した人を戻すと重複なく復帰する（d776・実測 2026-10-25）
  # ------------------------------------------------------------------
  @S-SPC-11
  Scenario: 一度抜けた人を戻すと、所属が重複せず見え方も元に戻る
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "00000000-0000-4000-a000-000000000002" を "whId" に保存する
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
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{whId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "mid1" に保存する
    And メール "wh-user@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "wh" に用意する
    When 保存セッション "wh" で GET "/api/v1/files/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/memberships/{{mid1}}" を叩く
    Then ステータスコード 204 が返る
    When 保存セッション "wh" で GET "/api/v1/files/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 404 が返る
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{whId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    When GET "/api/v1/memberships?scopeType=PROJECT&scopeId={{pjId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列で "accountId" が "{{whId}}" と一致する要素は 1 件
    When 保存セッション "wh" で GET "/api/v1/files/tree?spaceId={{chId}}" を叩く
    Then ステータスコード 200 が返る
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/spaces/admin/{{chId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/projects/admin/{{pjId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/organizations/admin/{{orgId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    Then 実測して挙動が決まったので "S-SPC-11" を確認済みにする

  # ------------------------------------------------------------------
  # S-SPC-08 個人メモと DM は管理者にも見えない（d776・d823）
  #   本命は「**他人の個人メモ**を直に叩いても読めない」こと。他人の個人メモは、叩く人から見て
  #   「存在しない器」と区別できない応答になっていなければならない。
  #   実測（2026-10-25・2026-10-27）: files/tree は 404（本文 `対象が見つかりません`）。chat/themes は
  #   可視集合へ絞る一覧の型（ADR 0082 の線引き）なので、存在しない器でも他人の個人メモでも 200 空。
  #   話の詳細（chat/themes/{id}）も存在しない話と同じ 404・同じ本文。
  #
  #   **依頼で出た「未所属の器はファイル一覧で箱の存在が分かる」は誤りだった**（独立の目で判明）。
  #   未所属の器は、未所属の人が叩けば存在しない器と同じ 404 になる。200 空になるのは、管理者が
  #   **自分で作った器**（管理経路の作成でその器の管理者になった）を開く時だけで、これは正しい振る舞い。
  #   上の 200 空の比較が「漏れなく通ってしまう」のを防ぐため、同じ人が自分の器を叩くと 200 空に
  #   なることも確かめる（比べる道具が両方の形を見分けられることの対照）。
  # ------------------------------------------------------------------
  @S-SPC-08
  Scenario: 管理者が他人の個人メモを直に叩いても、存在しない器と見分けられない
    Given seed ユーザー "wh-user@struct-pass.example"（パスワード "ReteDemo1234!"）としてログインし、セッションと自分の id を "memoOwner" に保存する
    And seed ユーザー "admin@rete.local"（パスワード "ReteAdmin1234!"）としてログインし、セッションと自分の id を "admin" に保存する
    And 一意名 "e2e-memo" を生成して "memoName" に保存する
    And 一意名 "e2e-memo-theme" を生成して "themeTitle" に保存する
    When 保存セッション "memoOwner" で POST "/api/v1/spaces" を body "{\"kind\":\"PERSONAL_MEMO\",\"name\":\"{{memoName}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "memoId" に保存する
    When 保存セッション "memoOwner" で GET "/api/v1/files/tree?spaceId={{memoId}}" を叩く
    Then ステータスコード 200 が返る

    # 存在しない器（見比べる基準）。**UUID の形で作る**: 形の違う id を渡すと、器の可否を見る前の
    # 入力検査で 400 に止まり、存在しない器の応答そのものにならない（実測 2026-10-27）。
    And 新しい UUID を "missingTapId" に保存する
    And 新しい UUID を "missingListId" に保存する
    When 保存セッション "admin" で GET "/api/v1/files/tree?spaceId={{missingTapId}}" を叩く
    Then 直前の応答の状態と本文を "tapMissing" に控える
    When 保存セッション "admin" で GET "/api/v1/chat/themes?spaceId={{missingListId}}" を叩く
    Then 直前の応答の状態と本文を "listMissing" に控える

    # 他人（wh-user）の個人メモと、読み分けられないこと
    When 保存セッション "admin" で GET "/api/v1/files/tree?spaceId={{memoId}}" を叩く
    Then 直前の応答の状態と本文を "tapMemo" に控える
    And 控えた "tapMemo" は "tapMissing" と応答の形が同じである
    When 保存セッション "admin" で GET "/api/v1/chat/themes?spaceId={{memoId}}" を叩く
    Then 直前の応答の状態と本文を "listMemo" に控える
    And 控えた "listMemo" は "listMissing" と応答の形が同じである

    # 他人の話（個人メモの中の話）の詳細も、存在しない話と同じ応答になる
    When 保存セッション "memoOwner" で POST "/api/v1/chat/themes" を body "{\"title\":\"{{themeTitle}}\",\"spaceId\":\"{{memoId}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "themeId" に保存する
    And 新しい UUID を "missingThemeId" に保存する
    When 保存セッション "admin" で GET "/api/v1/chat/themes/{{missingThemeId}}" を叩く
    Then 直前の応答の状態と本文を "detailMissing" に控える
    When 保存セッション "admin" で GET "/api/v1/chat/themes/{{themeId}}" を叩く
    Then 直前の応答の状態と本文を "detailMemo" に控える
    And 控えた "detailMemo" は "detailMissing" と応答の形が同じである

    # 固定しているのは、コードと message の文言を除いた本文まで（`support/response-fingerprint.ts`）。
    # 文言は画面がそのまま出す入力の案内（`desk-0321`）であり、存在の有無を読み分けさせる情報ではない。
    # どうしても文言をそろえたい時は、AppExceptionFilter の応答の形をそろえる決定を立てる。

    # 対照: 同じ人が**自分の器**（管理者の個人メモ）を叩くと、404 ではなく 200 空になる。
    # 他人の個人メモが 404 なのは「見ていない」からで、必ず 404 になる作りだからではない。
    When 保存セッション "admin" で 管理者の個人メモを一意名 "ownMemoName" で作り id を "ownMemoId" に保存する
    When 保存セッション "admin" で GET "/api/v1/files/tree?spaceId={{ownMemoId}}" を叩く
    Then 直前の応答の状態と本文を "tapOwnMemo" に控える
    And 控えた "tapOwnMemo" は "tapMissing" と応答の形が違う

    # 未所属の器（誰も所属していない組織の下のチャネル）も、未所属の人が叩けば存在しない器と同じ。
    # 管理者が自分で作った器だから 200 空になるだけ（他人の個人メモと同じ扱いであることの確認）。
    When 保存セッション "memoOwner" で GET "/api/v1/files/tree?spaceId={{missingTapId}}" を叩く
    Then 直前の応答の状態と本文を "tapMissingAsMember" に控える
    And 控えた "tapMissingAsMember" は "tapMissing" と応答の形が同じである
    When 保存セッション "memoOwner" で GET "/api/v1/chat/themes?spaceId={{missingListId}}" を叩く
    Then 直前の応答の状態と本文を "listMissingAsMember" に控える
    And 控えた "listMissingAsMember" は "listMissing" と応答の形が同じである

    When 保存セッション "admin" で 管理者が新しい組織からチャネルを 1 つ作って id を "unseenId" に保存する
    When 保存セッション "memoOwner" で GET "/api/v1/files/tree?spaceId={{unseenId}}" を叩く
    Then 直前の応答の状態と本文を "tapUnseenAsMember" に控える
    And 控えた "tapUnseenAsMember" は "tapMissingAsMember" と応答の形が同じである
    When 保存セッション "memoOwner" で GET "/api/v1/chat/themes?spaceId={{unseenId}}" を叩く
    Then 直前の応答の状態と本文を "listUnseenAsMember" に控える
    And 控えた "listUnseenAsMember" は "listMissingAsMember" と応答の形が同じである

    # 話の詳細は、存在しない話・他人の個人メモの話のどちらでも同じ 404・同じ本文（中身の有無を読み分けられない）。
    When 保存セッション "memoOwner" で GET "/api/v1/chat/themes/{{missingThemeId}}" を叩く
    Then ステータスコード 404 が返る
    And 直前の応答の状態と本文を "ownReadMissingTheme" に控える
    And 控えた "ownReadMissingTheme" は "detailMissing" と応答の形が同じである
    When 保存セッション "memoOwner" で GET "/api/v1/chat/themes/{{themeId}}" を叩く
    Then ステータスコード 200 が返る

    # 断る向き: 管理者が他人の話を書き換・書き込みしようとしても、存在しない話と同じ 404 で断られる
    When 保存セッション "admin" で PATCH "/api/v1/chat/themes/{{themeId}}" を body "{\"title\":\"e2e-denied\"}" で叩く
    Then 直前の応答の状態と本文を "patchMemo" に控える
    When 保存セッション "admin" で PATCH "/api/v1/chat/themes/{{missingThemeId}}" を body "{\"title\":\"e2e-denied\"}" で叩く
    Then 直前の応答の状態と本文を "patchMissing" に控える
    And 控えた "patchMemo" は "patchMissing" と応答の形が同じである

    # 叩く人の向き（システム管理者／一般ユーザー）を替えても、存在しない器への応答は同じ。
    # 入力検査の拒否（UUID でない id）は、形の比べ方が「どの 404 も同じ」に潰れていないことの対照。
    When 保存セッション "admin" で GET "/api/v1/files/tree?spaceId={{missingTapId}}&projectId={{missingTapId}}" を叩く
    Then 直前の応答の状態と本文を "tapMissingWithOtherKey" に控える
    And 控えた "tapMissingWithOtherKey" は "tapMissing" と応答の形が同じである
    When GET "/api/v1/files/tree?spaceId=not-a-uuid" を叩く
    Then 直前の応答の状態と本文を "tapInvalidInput" に控える
    And 控えた "tapInvalidInput" は "tapMissing" と応答の形が違う

    Then 実測して挙動が決まったので "S-SPC-08" を確認済みにする

