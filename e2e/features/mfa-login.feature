# rete MFA ログイン幸せ道 e2e (cmn-0139)
#
# 検証対象:
#   P2-02  TOTP login challenge — password ログイン → mfaRequired:true（full session 未確立）→
#            誤コード 401・正 TOTP 200・/auth/me full session 確認
#   P2-03  バックアップコード — 1コード消費で full session 確立・同コード再投入で 401 (single-use)
#
# 1シナリオに結合している理由 = /auth/login スロットル 5req/60s を超えないため
# （setup=1 + challenge=3 = 4 /auth/login/シナリオ。2 分割だと別 run で 4+4=8 で超過）。
# cmn-0395: 開発機は E2E_THROTTLE_BYPASS=true で素通しできる（e2e/README.md §前提参照）。
# この結合は素通しを入れていない機械（既定 .env）でも落ちないための構造で、残す。
#
# design からの前提:
#   - seed.ts に MFA 専用アカウント 1 件（mfa-user@rete.local / MFA_DEMO_SUB UUID / MEMBER）
#     を MFA 無効で焼き込み。MFA 有効化はシナリオ内 API で回す。
#   - backend MFA 実装（setup/confirm/disable/mfa-reset・otplib v13）完備。
#     TOTP secret は otpauth URI から parse・backupCodes は confirm レスポンスで平文入手。
#   - TOTP replay 防御（lastUsedCounter / cmn-0094 H10a）は epoch+30s の future step で待ちゼロ回避。
#
# 退行ガード目的: 2 段階認証のセッション昇格・backup code の single-use が継続することを保証。
# 連続2回実行 green = 末尾 admin mfa-reset で MFA 有効残留を掃き出し。
#
# 除外:
#   - MFA 強制トグル（enforced 設定）/ admin 強制フロー / OTP URI 改ざん耐性
#     → 別 ticket で扱う（cmn-0139 スコープ外）

@authz
Feature: MFA ログイン幸せ道（P2-02 TOTP / P2-03 バックアップコード）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している
    And admin で MFA ユーザーを MFA リセットする
    And MFA ユーザー "mfa-user@rete.local" で MFA を有効化する

  # ------------------------------------------------------------------
  # P2-02 TOTP login challenge
  # ------------------------------------------------------------------
  @P2-02
  Scenario: TOTP login challenge（誤コード 401 / 正 TOTP 200）
    When パスワードでログインし MFA チャレンジを受ける "mfa-user@rete.local"
    Then レスポンスに MFA チャレンジが含まれる
    And full session が未確立
    When 誤コードで MFA ログインを叩く
    Then ステータスコード 401 が返る
    When 正 TOTP コードで MFA ログインを叩く
    Then ステータスコード 200 が返る
    And full session が確立している

  # ------------------------------------------------------------------
  # P2-03 backup code login challenge + single-use
  # ------------------------------------------------------------------
  @P2-03
  Scenario: バックアップコードで MFA 完了・再投入は 401
    When パスワードでログインし MFA チャレンジを受ける "mfa-user@rete.local"
    Then レスポンスに MFA チャレンジが含まれる
    When 未使用バックアップコードで MFA ログインを叩く
    Then ステータスコード 200 が返る
    And full session が確立している
    When ログアウトする
    When パスワードでログインし MFA チャレンジを受ける "mfa-user@rete.local"
    Then レスポンスに MFA チャレンジが含まれる
    When 同じバックアップコードで MFA ログインを叩く
    Then ステータスコード 401 が返る

  # ------------------------------------------------------------------
  # 再設定で古い控えが使えなくなる（S-OPS-03 端末を失ったが控えで復旧できる）
  #   Background で有効化した控え（confirm が返した 10 個）を持つ状態から、
  #   本人が控えを作り直すと、作り直す前に持っていた控えは通らないことを確かめる。
  #   作り直しは本人確認が要る（POST /settings/mfa/backup-codes/regenerate が code を受ける）ため、
  #   3 つ目の控えで本人確認し、5 つ目の控え（未使用）が作り直し後に通らないことを見る。
  # ------------------------------------------------------------------
  @S-OPS-03
  Scenario: バックアップコードを作り直すと古い控えでは入れない
    When パスワードでログインし MFA チャレンジを受ける "mfa-user@rete.local"
    Then レスポンスに MFA チャレンジが含まれる
    When 未使用バックアップコードで MFA ログインを叩く
    Then ステータスコード 200 が返る
    When 控えの 1 つで本人確認してバックアップコードを作り直す
    Then ステータスコード 200 が返る
    And レスポンスの "data.backupCodes" が空でない
    When ログアウトする
    When パスワードでログインし MFA チャレンジを受ける "mfa-user@rete.local"
    Then レスポンスに MFA チャレンジが含まれる
    When 未使用の作り直し前のバックアップコードで MFA ログインを叩く
    Then ステータスコード 401 が返る

  # ------------------------------------------------------------------
  # teardown（最終シナリオ末尾で admin リセットして MFA 状態を掃き出す）
  # ------------------------------------------------------------------
  @teardown
  Scenario: テスト後の状態を admin リセット
    When admin で MFA ユーザーを MFA リセットする
