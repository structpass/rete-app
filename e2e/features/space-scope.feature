# rete 権限境界ジャーニー — S-SPC-05 スコープ越境の遮断
#
# SpacesService.findAll は PROJECT membership を確認し、
# 非メンバーには ForbiddenException（403）を返す（ADR 0037 §4.2 存在ごと隠蔽）。
#
# seed の組織構造（固定 UUID）:
#   プロジェクト cmId(20) = 入出荷オペレーション
#     id = 00000000-0000-4000-b000-000000000020
#     チャネル: 入荷（cmId 30）/ 出荷（cmId 31）
#   プロジェクト cmId(22) = 経理・受発注
#     id = 00000000-0000-4000-b000-000000000022
#     チャネル: 経理連携（cmId 34）/ 受発注（cmId 35）
#
# wh-user@struct-pass.example の membership:
#   ✅ cmId(20) 入出荷オペレーション MEMBER
#   ✅ cmId(21) 在庫・棚卸 MEMBER
#   ❌ cmId(22) 経理・受発注 — membership なし → 403

@authz
Feature: S-SPC-05 スコープ越境の遮断

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-SPC-05 非メンバーが他プロジェクトのチャネル一覧を取得 → 403
  # ------------------------------------------------------------------
  @S-SPC-05
  Scenario: membership なしプロジェクトのチャネルは閲覧できない
    # e2e:verified AUTHZ pass "membership なしプロジェクトのチャネルは閲覧できない"
    Given システムMEMBER "wh-user@struct-pass.example" でログインする
    When GET "/api/v1/spaces?kind=CHANNEL&projectId=00000000-0000-4000-b000-000000000022" を叩く
    Then ステータスコード 403 が返る

  # ------------------------------------------------------------------
  # 正常系: membership ありプロジェクトのチャネルは閲覧できる
  # ------------------------------------------------------------------
  @S-SPC-05-positive
  Scenario: membership ありプロジェクトのチャネルは閲覧できる
    # e2e:verified AUTHZ pass "membership ありプロジェクトのチャネルは閲覧できる"
    Given システムMEMBER "wh-user@struct-pass.example" でログインする
    When GET "/api/v1/spaces?kind=CHANNEL&projectId=00000000-0000-4000-b000-000000000020" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-SPC-05 チャネル一覧の内容確認（存在ごと隠蔽の反証）
  # ------------------------------------------------------------------
  @S-SPC-05-positive
  Scenario: membership ありプロジェクトのチャネル一覧に入荷・出荷が含まれる
    # e2e:verified AUTHZ pass "membership ありプロジェクトのチャネル一覧に入荷・出荷が含まれる"
    Given システムMEMBER "wh-user@struct-pass.example" でログインする
    When GET "/api/v1/spaces?kind=CHANNEL&projectId=00000000-0000-4000-b000-000000000020" を叩く
    Then ステータスコード 200 が返る
    And レスポンスに "入荷" チャネルが含まれる
    And レスポンスに "出荷" チャネルが含まれる
