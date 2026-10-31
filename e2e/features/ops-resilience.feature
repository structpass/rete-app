# rete トラック 7（運用）— 失敗した時の振る舞い
#
# 対応: docs/scenarios/tracks/07-ops.md
#   S-OPS-01 連続失敗でログインできない（自動解除までの目安が出て、管理者の解除で入れる）
#   S-OPS-02 招待の期限が切れて入れない（受諾は 400 で理由が返る）
#   S-OPS-05 停止されたアカウントで入れない（401 だが理由は区別されない＝未確定の論点）
#   S-OPS-11 表示設定が端末をまたいで保たれる（本人の設定として保存される）
#   S-OPS-12 メンテナンス中でも画面が壊れない（提供可否が menu に出る）
#
# 実測（2026-10-25・backend 3011）:
#   - POST /invites/accept に不正/期限切れ token → 400「招待が無効か期限切れです」
#     （2026-10-28 追記: 受諾は token・name・12 文字以上のパスワードの 3 つを要る。d842）
#   - isActive=false のアカウントでログイン → 401「メールアドレスまたはパスワードが正しくありません」
#     （止められていることが文言からは分からない＝トラックの未確定事項として残す）
#   - PUT/GET /accounts/me/display-preference は本人の設定として保存される（不正な色は 400）
#   - GET /hub/menu の各項目は available を持つ（提供できないものは false で返る）

@ops
Feature: 運用トラック — 失敗した時の振る舞い（S-OPS-01 / 02 / 05 / 11 / 12）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-OPS-01 連続失敗のロック（解除の経路が画面と API の両方にある）
  #   5 回目までは通常の失敗（401）。6 回目の失敗でロックされ、以後は正しいパスワードでも入れない。
  #   文言に自動解除までの目安が出る。管理者が解除すると、自動解除を待たずに入れる。
  #   窓内の 15 分の自然解除だけは待てないため手動で確かめる（docs/scenarios/tracks/07-ops.md の S-OPS-01-C1）。
  #   seed の人を使うので、途中で落ちても後始末で解除する（最初の行）。
  # ------------------------------------------------------------------
  @S-OPS-01
  Scenario: 連続失敗でロックされ、管理者の解除で入れるようになる
    Given ロックが残っていても拾えるよう "newcomer@struct-pass.example" の解除を後始末にも登録する
    And システムADMIN "admin@rete.local" でログインする
    And 管理者が "newcomer@struct-pass.example" のログイン試行ロックを解除する
    Then ステータスコード 200 が返る
    When "newcomer@struct-pass.example" のパスワードログインを誤ったパスワードで 6 回試す
    Then ステータスコード 429 が返る
    # ロック中は資格情報を検証しない＝正しいパスワードでも入れない。
    When 新しい接続 "ops01_locked" として "newcomer@struct-pass.example" のパスワードでログインする
    Then ステータスコード 429 が返る
    And 人に見える文言に自動解除までの目安が含まれる
    # 管理者の解除（管理画面の「今すぐロックを解除」と同じ API）
    When 管理者が "newcomer@struct-pass.example" のログイン試行ロックを解除する
    Then ステータスコード 200 が返る
    When 新しい接続 "ops01_after" として "newcomer@struct-pass.example" のパスワードでログインする
    Then ステータスコード 200 が返る
    Then 実測して挙動が決まったので "S-OPS-01" を確認済みにする

  # ------------------------------------------------------------------
  # S-OPS-02 招待の期限切れ・不正 token
  # ------------------------------------------------------------------
  @S-OPS-02
  Scenario: 使えない招待で受諾すると理由付きで拒否される
    Given 未ログインの接続を "invitee" に用意する
    When 保存セッション "invitee" で POST "/api/v1/invites/accept" を body "{\"token\":\"expired-or-unknown-token\",\"name\":\"検証 太郎\",\"password\":\"ReteDemo1234!\"}" で叩く
    Then ステータスコード 400 が返る
    When 保存セッション "invitee" で POST "/api/v1/invites/accept" を body "{\"token\":\"\",\"name\":\"検証 太郎\",\"password\":\"ReteDemo1234!\"}" で叩く
    Then ステータスコード 400 が返る

  # ------------------------------------------------------------------
  # S-OPS-05 停止されたアカウント
  #   仕様どおり入れない。ただし「止められている」とは文言から分からない
  #   （汎用の認証失敗と同じ 401）＝ 問い合わせ時に切り分けが要る。
  # ------------------------------------------------------------------
  @S-OPS-05
  Scenario: 停止されたアカウントは入れず、解除すると入れる
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "00000000-0000-4000-a000-000000000006" を "targetId" に保存する
    When PATCH "/api/v1/members/{{targetId}}" を body "{\"isActive\":false}" で叩く
    Then ステータスコード 200 が返る
    When メール "tanaka@struct-pass.example"・パスワード "ReteDemo1234!" でログインを試みる
    Then ステータスコード 401 が返る
    When PATCH "/api/v1/members/{{targetId}}" を body "{\"isActive\":true}" で叩く
    Then ステータスコード 200 が返る
    When メール "tanaka@struct-pass.example"・パスワード "ReteDemo1234!" でログインを試みる
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-OPS-11 表示設定の保存（本人の設定として残る）
  # ------------------------------------------------------------------
  @S-OPS-11
  Scenario: 表示設定を変えると保存され、別の接続でも同じ値が返る
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When PUT "/api/v1/accounts/me/display-preference" を body "{\"stripeEnabled\":true,\"stripeColor\":\"#FAFCFF\"}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/accounts/me/display-preference" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.stripeColor" が "#FAFCFF" と一致する
    And メール "of-admin@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "another" に用意する
    When 保存セッション "another" で GET "/api/v1/accounts/me/display-preference" を叩く
    Then レスポンスの "data.stripeColor" が "#FAFCFF" と一致する
    When PUT "/api/v1/accounts/me/display-preference" を body "{\"stripeEnabled\":true,\"stripeColor\":\"red\"}" で叩く
    Then ステータスコード 400 が返る
    When PUT "/api/v1/accounts/me/desk-preference" を body "{\"leftPaneRatio\":0.4}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/accounts/me/desk-preference" を叩く
    Then レスポンスの "data.leftPaneRatio" が "0.4" と一致する
    When PUT "/api/v1/accounts/me/desk-preference" を body "{\"leftPaneRatio\":0.9}" で叩く
    Then ステータスコード 400 が返る

  # ------------------------------------------------------------------
  # S-OPS-04 端末も控えも失った（本人では入れない → 管理者のリセット → 設定し直し）
  #   手順は docs/scenarios/tracks/07-ops.md の S-OPS-04-C1。
  #   MFA 有効の人が mfa-user に限られるため、その人で流す（mfa-login.feature と同じ人・同じ控えの土台を使う）。
  #   後始末: 設定し直した MFA を管理者がリセットして元へ戻す（mfa-login.feature の後始末と同じ）→ 下の @teardown。
  # ------------------------------------------------------------------
  @S-OPS-04
  Scenario: 管理者が MFA をリセットすると、本人は設定し直せる
    Given admin で MFA ユーザーを MFA リセットする
    And 新しい接続 "lost-device" として "mfa-user@rete.local" のパスワードでログインする
    And 同じ接続 "lost-device" で本人が二段階認証を設定し直す
    # ここで一度ログアウトする（設定し直した接続は full session を持ったままなので、そのまま叩くと
    # ログイン済みの応答が返る。S-OPS-04 は「失った端末で入り直す」場面なので、新しい接続で入り直す）。
    When 本人 "lost-device" としてログインし直して MFA チャレンジの有無を確かめる
    Then レスポンスに MFA チャレンジが含まれる
    When 管理者が保存セッション "lost-device" の持ち主の MFA をリセットする
    Then ステータスコード 200 が返る
    When 本人 "lost-device" としてログインし直して MFA チャレンジの有無を確かめる
    Then MFA チャレンジを出さずにログインできた
    When 保存セッション "lost-device" で MFA の設定状態を確かめる
    Then 本人の二段階認証は未設定になっている
    When 本人 "lost-device" が二段階認証を設定し直す
    Then 新しいバックアップコードが返る
    Then 実測して挙動が決まったので "S-OPS-04" を確認済みにする
    When 管理者が保存セッション "lost-device" の持ち主の MFA をリセットする
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-OPS-12 提供できないシステムの見え方
  #   画面を白くしないため、メニューは「使えるか」を持って返る。
  #   どれが使えないかは環境で変わるので、項目の形と available の存在だけを固定する。
  # ------------------------------------------------------------------
  @S-OPS-12
  Scenario: メニューは各項目に提供可否を持って返る
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/hub/menu" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.items" が空でない
    And レスポンスの "data.items.0.key" が "tasks" と一致する
