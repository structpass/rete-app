# rete 権限境界ジャーニー — S-FILE-10 ファイル設定の管理者境界
#
# S-FILE-10: 非ADMIN が PATCH /files/settings
#   → @Roles(Role.ADMIN) + RolesGuard → 403
#   松本由美 (事務管理者ロールだが system MEMBER) が全体設定を書き換えると
#   全ユーザーのアップロードを妨害できるため ADMIN 限定。
#
# S-FILE-11（業務ロールの file 権限による遮断）は set-0180 で業務ロール層ごと撤去した。
# フォルダ作成・ファイル操作の境界は Space の可視性（非メンバーは 404 存在秘匿）へ移っており、
# 越境の遮断は space-scope.feature（S-SPC-05）が検証する。

@authz
Feature: S-FILE-10 ファイル設定の管理者境界

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-FILE-10 管理者のみ設定変更
  # ------------------------------------------------------------------
  @S-FILE-10
  Scenario: 非ADMIN はファイル設定を変更できない
    # e2e:verified AUTHZ pass "非ADMIN はファイル設定を変更できない"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When PATCH "/api/v1/files/settings" を body "{\"maxSizeBytes\":1048576}" で叩く
    Then ステータスコード 403 が返る

  # ------------------------------------------------------------------
  # 正常系: ADMIN はファイル設定を取得できる
  # ------------------------------------------------------------------
  @S-FILE-10-positive
  Scenario: ADMIN はファイル設定を取得できる
    # e2e:verified AUTHZ pass "ADMIN はファイル設定を取得できる"
    Given システムADMIN "admin@rete.local" でログインする
    When GET "/api/v1/files/settings" を叩く
    Then ステータスコード 200 が返る
