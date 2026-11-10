# rete 権限境界ジャーニー — 管理グループの実効 ADMIN 全消失ガードと回収経路（v2-231）
#
# set-0164 criteria 3 / set-0188: 管理グループが「そのスコープで唯一の ADMIN 源」で
# メンバーが残っている時、grant 降格・grant 剥奪・メンバー削除・グループ削除は 409 で拒否される
# （実効 ADMIN 全消失ガード＝管理者ゼロを作らない）。この状態からの回収は
# 「先に別の管理グループへメンバーを追加し、同じスコープの管理者を付ける」＝管理グループの新規作成／
# メンバー追加と所属管理のマトリクス（列＝全管理グループ・値＝管理者）から画面操作だけで到達できる。
# ここではその4経路が塞がれること、回収後に通ること、回収手順が実行可能であることを API で実測して
# 固定する（ガードが緩む退行と、回収経路が塞がる退行の両方を検出する）。
#
# 唯一の ADMIN 源を作るには「そのスコープの直接 ADMIN membership を外す」必要がある。
# 直接 membership を操作する UI は無い（所属管理のマトリクスは grant のみ）ため、ここでは API で作る。
#
# 3つの状態を分けて固定する:
#   1) 実在するスコープ … 4経路 409 → 別グループへメンバー追加＋ADMIN grant で回収できる
#   2) スコープが物理削除済み … grant 行は残るが実効権限を生まないため、剥奪・メンバー削除・
#      グループ削除が通る（塞がると「グループごと消す」しか逃げ道が無くなる）
#   3) スコープがアーカイブ済み … 付与・降格は 400、剥奪・削除は 409 のまま。回収は復元が先
#
# 組織と管理グループは、作成を記録する POST step で作る（e2e の共通作法。1 も同じ）。
# 2 だけはスコープの物理削除が検証内容そのものなので、記録しない POST step で作り、
# 組織 → グループの順に明示削除する。途中で失敗した場合は「グループが唯一の ADMIN 源」の間だけ
# teardown の DELETE が 409 になる（fixtures は失敗を握りつぶさない）。その時の片付けは
# 組織の物理削除 → グループ削除の順で行う。
# 接続先は step の引数ではなく e2e/support/auth.ts の BASE_URL（環境変数 E2E_BASE_URL）で決まる。
# 下の Background の URL は資料としての目安表記（既定の dev ポート）。

@authz @v2-231
Feature: v2-231 管理グループの実効 ADMIN 全消失ガードと回収経路

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  Scenario: 唯一の ADMIN 源グループは4経路とも 409 になり、別の管理グループへ管理者を付けると回収できる
    # e2e:verified AUTHZ pass "唯一の ADMIN 源グループは4経路とも 409 になり、別の管理グループへ管理者を付けると回収できる"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "v2-231-org" を生成して "orgName" に保存する
    And 一意名 "v2-231-retire" を生成して "retireName" に保存する
    And 一意名 "v2-231-helper" を生成して "helperName" に保存する

    # scratch 組織（作成者が自動で ORGANIZATION ADMIN の直接 membership を持つ）
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する

    # 退役させたい管理グループ G（メンバーは実行者自身＝システム ADMIN）
    When POST "/api/v1/user-groups" を body "{\"name\":\"{{retireName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "retireId" に保存する
    When GET "/api/v1/auth/me" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.id" を "adminId" に保存する
    When POST "/api/v1/user-groups/{{retireId}}/members" を body "{\"accountId\":\"{{adminId}}\"}" で叩く
    Then ステータスコード 201 が返る

    # G を組織の唯一の ADMIN 源にする（grant 付与 → 作成者の直接 membership を外す）
    When POST "/api/v1/user-groups/{{retireId}}/grants" を body "{\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 201 が返る
    When GET "/api/v1/memberships?scopeType=ORGANIZATION&scopeId={{orgId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.0.id" を "creatorMembershipId" に保存する
    When DELETE "/api/v1/memberships/{{creatorMembershipId}}" を叩く
    Then ステータスコード 204 が返る

    # 詰みの実測: 4経路すべて 409（降格・剥奪・メンバー削除・グループ削除）
    When POST "/api/v1/user-groups/{{retireId}}/grants" を body "{\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 409 が返る
    When DELETE "/api/v1/user-groups/{{retireId}}/grants/ORGANIZATION/{{orgId}}" を叩く
    Then ステータスコード 409 が返る
    When DELETE "/api/v1/user-groups/{{retireId}}/members/{{adminId}}" を叩く
    Then ステータスコード 409 が返る
    When DELETE "/api/v1/user-groups/{{retireId}}" を叩く
    Then ステータスコード 409 が返る

    # 回収経路: 別の管理グループ H を作り、メンバーを追加してから同じ組織の管理者にする
    # （メンバー追加が先。grant だけでは実効 ADMIN 源にならない＝文言が示す順序そのもの）
    When POST "/api/v1/user-groups" を body "{\"name\":\"{{helperName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "helperId" に保存する
    When POST "/api/v1/user-groups/{{helperId}}/members" を body "{\"accountId\":\"{{adminId}}\"}" で叩く
    Then ステータスコード 201 が返る
    When POST "/api/v1/user-groups/{{helperId}}/grants" を body "{\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 201 が返る

    # 回収: 降格（201）・剥奪（204）・グループ削除（204）が通り、管理者は H に残る
    When POST "/api/v1/user-groups/{{retireId}}/grants" を body "{\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    When DELETE "/api/v1/user-groups/{{retireId}}/grants/ORGANIZATION/{{orgId}}" を叩く
    Then ステータスコード 204 が返る
    When DELETE "/api/v1/user-groups/{{retireId}}" を叩く
    Then ステータスコード 204 が返る
    When GET "/api/v1/user-groups" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{retireId}}" が含まれない
    And レスポンス配列に "{{helperId}}" が含まれる

    # 組織は残し、teardown の PATCH archive に任せる（scratch を可視の一覧へ残さない）。
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{adminId}}\",\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 201 が返る
    When DELETE "/api/v1/user-groups/{{helperId}}" を叩く
    Then ステータスコード 204 が返る
    When GET "/api/v1/user-groups" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{helperId}}" が含まれない

  Scenario: スコープが物理削除された後の grant は剥奪もメンバー削除も塞がない
    # e2e:verified AUTHZ pass "スコープが物理削除された後の grant は剥奪もメンバー削除も塞がない"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "v2-231-dangling" を生成して "orgName" に保存する
    And 一意名 "v2-231-dangle" を生成して "groupName" に保存する

    # スコープごと消す検証なので、組織は記録しない POST step で作り、明示削除する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/user-groups" を body "{\"name\":\"{{groupName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "groupId" に保存する
    When GET "/api/v1/auth/me" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.id" を "adminId" に保存する
    When POST "/api/v1/user-groups/{{groupId}}/members" を body "{\"accountId\":\"{{adminId}}\"}" で叩く
    Then ステータスコード 201 が返る
    When POST "/api/v1/user-groups/{{groupId}}/grants" を body "{\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 201 が返る
    When GET "/api/v1/memberships?scopeType=ORGANIZATION&scopeId={{orgId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.0.id" を "creatorMembershipId" に保存する
    When DELETE "/api/v1/memberships/{{creatorMembershipId}}" を叩く
    Then ステータスコード 204 が返る

    # 唯一の ADMIN 源になっていることを先に確認する（この状態からの剥奪は 409）
    When DELETE "/api/v1/user-groups/{{groupId}}/grants/ORGANIZATION/{{orgId}}" を叩く
    Then ステータスコード 409 が返る

    # スコープを物理削除すると grant 行だけが残る（user_group_scope_grants は外部キーを持たない）。
    # 実体の無い grant は実効権限を生まないので、剥奪・メンバー削除・グループ削除が通る。
    When DELETE "/api/v1/organizations/admin/{{orgId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/user-groups/{{groupId}}/grants/ORGANIZATION/{{orgId}}" を叩く
    Then ステータスコード 204 が返る
    When DELETE "/api/v1/user-groups/{{groupId}}/members/{{adminId}}" を叩く
    Then ステータスコード 204 が返る
    When DELETE "/api/v1/user-groups/{{groupId}}" を叩く
    Then ステータスコード 204 が返る

  Scenario: アーカイブ済みスコープでは回収手順の前に復元が要る
    # e2e:verified AUTHZ pass "アーカイブ済みスコープでは回収手順の前に復元が要る"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "v2-231-archived" を生成して "orgName" に保存する
    And 一意名 "v2-231-archretire" を生成して "retireName" に保存する
    And 一意名 "v2-231-archhelper" を生成して "helperName" に保存する

    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/user-groups" を body "{\"name\":\"{{retireName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "retireId" に保存する
    When GET "/api/v1/auth/me" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.id" を "adminId" に保存する
    When POST "/api/v1/user-groups/{{retireId}}/members" を body "{\"accountId\":\"{{adminId}}\"}" で叩く
    Then ステータスコード 201 が返る
    When POST "/api/v1/user-groups/{{retireId}}/grants" を body "{\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 201 が返る
    When GET "/api/v1/memberships?scopeType=ORGANIZATION&scopeId={{orgId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.0.id" を "creatorMembershipId" に保存する
    When DELETE "/api/v1/memberships/{{creatorMembershipId}}" を叩く
    Then ステータスコード 204 が返る

    # 組織をアーカイブすると、grant の付与・降格は 400（先に復元が要る）、剥奪・削除は 409 のまま
    When PATCH "/api/v1/organizations/admin/{{orgId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When POST "/api/v1/user-groups/{{retireId}}/grants" を body "{\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 400 が返る
    When DELETE "/api/v1/user-groups/{{retireId}}/grants/ORGANIZATION/{{orgId}}" を叩く
    Then ステータスコード 409 が返る

    # 復元してから、メンバーを追加した別の管理グループを管理者にする（文言が示す順序）
    When PATCH "/api/v1/organizations/admin/{{orgId}}" を body "{\"archived\":false}" で叩く
    Then ステータスコード 200 が返る
    When POST "/api/v1/user-groups" を body "{\"name\":\"{{helperName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "helperId" に保存する
    When POST "/api/v1/user-groups/{{helperId}}/members" を body "{\"accountId\":\"{{adminId}}\"}" で叩く
    Then ステータスコード 201 が返る
    When POST "/api/v1/user-groups/{{helperId}}/grants" を body "{\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 201 が返る
    When DELETE "/api/v1/user-groups/{{retireId}}/grants/ORGANIZATION/{{orgId}}" を叩く
    Then ステータスコード 204 が返る
    When DELETE "/api/v1/user-groups/{{retireId}}" を叩く
    Then ステータスコード 204 が返る

    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{adminId}}\",\"scopeType\":\"ORGANIZATION\",\"scopeId\":\"{{orgId}}\",\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 201 が返る
    When DELETE "/api/v1/user-groups/{{helperId}}" を叩く
    Then ステータスコード 204 が返る
