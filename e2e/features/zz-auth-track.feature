# rete トラック 1（認証）— 未確認だった行を実行へ落とす（2026-10-25・2026-10-26 に残りを追加）
#
# 対応: docs/scenarios/tracks/01-auth.md
#   S-AUTH-03 バックアップコードで入場し、使い捨てになる
#   S-AUTH-09 連続失敗が throttle とロックで止まる
#   S-AUTH-11 パスワードポリシー違反が弾かれる／期限切れの招待は案内を出さない
#   S-AUTH-13 セッションが再読込・再訪で維持される
#   S-AUTH-12 パスワード変更後に新しいパスワードで入れる（seed を一時的に変え、最後に元へ戻す）
#   S-AUTH-14 停止されたアカウントは即座に締め出される（判定は業務 API で見る）
#   S-AUTH-15 管理者が MFA を強制リセットできる
#
# 期待が未確定だった 2 件（S-AUTH-08 / 10）のうち 08 は実装で決まった（⚠ を外した）。
# ここでは「ログインは通る・設定を促す印が立つ・業務 API は 403 で塞がる」の 3 点を実行で確かめる。
#
# 前提（S-AUTH-03）: MFA を使うため、mfa-login.feature の後片付けより後へ回す必要がある。
# 実行の並びはファイル名の辞書順なので、名前の先頭に「zz-」を置いて最後尾にしている。
# 控え（バックアップコード）は試験の外へ出せないため、2 段目の成立は mfa-login.feature（@P2-03）が持ち、
# このファイルは「パスワード段では確定しない・控えの段へ進む合図が返る」までを実行で確かめる。
#
# 前提（S-AUTH-09）: 開発機の素通し（E2E_THROTTLE_BYPASS）はログイン試行のロックには効かない。
# ロックはアカウントに残るため、このシナリオは必ず解除で終わり、シナリオが途中で落ちても
# fixtures の後始末で解除する（support/fixtures.ts の unlockAccountIds）。

@auth
Feature: 認証トラックの未確認行（S-AUTH-03 / 08 / 09 / 11 / 12 / 13 / 14 / 15）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している
    # 管理者の接続はセッションの事前生成を再利用する。管理者がロックされると全シナリオが巻き添えになるため、
    # ここで確実に解除しておく（冪等）。id はメンバー表を引かずに seed の固定値を使う。
    And メール "admin@rete.local"・パスワード "ReteAdmin1234!" で新しくログインした接続を "boot" に用意する
    And 固定値 "00000000-0000-4000-a000-000000000001" を "adminId" に保存する
    And 保存セッション "boot" で PATCH "/api/v1/members/{{adminId}}/unlock" を空ボディで叩く

  # ------------------------------------------------------------------
  # S-AUTH-08 MFA 強制下の未設定者（⚠ を外した・実装で決まった挙動を実測）
  # ------------------------------------------------------------------
  @S-AUTH-08
  Scenario: MFA を強制すると未設定者はログインできても業務画面は塞がる
    # 行の先頭の `強制 MFA を` は「後始末でも流し直す」手順（02 §途中でも戻す設定）。設定を戻す行を
    # 先頭に置くのは、後の行で落ちても戻しが登録に残っているようにするため（02 §1 の順番の規則）。
    Given 強制 MFA を body "{\"requireLowercase\":true,\"requireUppercase\":true,\"requireNumber\":true,\"requireSymbol\":true,\"minLength\":12,\"mfaEnforced\":false}" で戻す => システムADMIN "admin@rete.local"
    And システムADMIN "admin@rete.local" でログインする
    When PUT "/api/v1/settings/login/password-policy" を body "{\"requireLowercase\":true,\"requireUppercase\":true,\"requireNumber\":true,\"requireSymbol\":true,\"minLength\":12,\"mfaEnforced\":true}" で叩く => システムADMIN "admin@rete.local"
    Then ステータスコード 200 が返る
    # 未設定者はログイン自体は通り、応答に「設定が必要」の印が付く（R8）。
    When 新しい接続 "unset" として "of-admin@struct-pass.example" のパスワードでログインする
    Then ステータスコード 200 が返る
    And レスポンスの "data.mfaSetupRequired" が真偽値 "true" である
    When 保存セッション "unset" で自分の情報を確かめる
    Then ステータスコード 200 が返る
    And レスポンスの "data.mfaSetupRequired" が真偽値 "true" である
    # 業務 API は 403 で塞がる（画面は設定へ誘導される）。
    When 保存セッション "unset" で器の一覧を開く
    Then ステータスコード 403 が返る
    And 実測して挙動が決まったので "S-AUTH-08" を確認済みにする

  # ------------------------------------------------------------------
  # S-AUTH-13 セッションの維持（再読込・別タブ）
  # ------------------------------------------------------------------
  @S-AUTH-13
  Scenario: 同じ人が画面を開き直しても入り直せる
    Given メール "of-admin@struct-pass.example"・パスワード "ReteDemo1234!" で新しくログインした接続を "first" に用意する
    When 保存セッション "first" で自分の情報を確かめる
    Then ステータスコード 200 が返る
    And レスポンスの "data.email" が "of-admin@struct-pass.example" と一致する
    When 保存セッション "first" で器の一覧を開く
    Then ステータスコード 200 が返る
    When 新しい接続 "second" として "of-admin@struct-pass.example" のパスワードでログインする
    Then ステータスコード 200 が返る
    When 保存セッション "second" で自分の情報を確かめる
    Then ステータスコード 200 が返る
    And レスポンスの "data.email" が "of-admin@struct-pass.example" と一致する
    When 保存セッション "second" で器の一覧を開く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-AUTH-03 バックアップコードの使い捨て
  #   mfa-login.feature が有効化した控え（confirm が返した 10 個）を引き継ぐ
  # ------------------------------------------------------------------
  @S-AUTH-03
  Scenario: 控えで入場でき、同じ控えは二度目から通らない
    Given admin で MFA ユーザーを MFA リセットする
    And MFA ユーザー "mfa-user@rete.local" で MFA を有効化する
    # パスワード段 → 控え 1 本で 2 段目（MFA 有効者なので必ず 2 段になる）。
    # 控えはアプリを入れて回す人だけが持つ手元の控えで、試験の外には出せない。ここでは「パスワード段では
    # セッションが確定しない」ことと「控えを使う段への合図（mfaRequired）が返る」ことまでを実行で確かめ、
    # 2 段目の成立は mfa-login.feature（@P2-03・同じ mfa-user で控えを 1 本ずつ実際に消費）が担保する。
    When パスワードでログインし MFA チャレンジを受ける "mfa-user@rete.local"
    Then レスポンスに MFA チャレンジが含まれる
    And full session が未確立
    # 後片付け: MFA を外して、次の試験に控え不要の状態を渡す。
    When admin で MFA ユーザーを MFA リセットする
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-AUTH-09 連続失敗（ロックはアカウント単位で残り、解除で戻る）
  # ------------------------------------------------------------------
  @S-AUTH-09
  Scenario: 連続失敗でロックされ、管理者の解除で入れるようになる
    Given ロックが残っていても拾えるよう "newcomer@struct-pass.example" の解除を後始末にも登録する
    And システムADMIN "admin@rete.local" でログインする
    And 管理者が "newcomer@struct-pass.example" のログイン試行ロックを解除する
    Then ステータスコード 200 が返る
    When "newcomer@struct-pass.example" のパスワードログインを誤ったパスワードで 6 回試す
    # 5 回目でロックが掛かるため、6 回目は「ロック中」の 429 になる（ロックは試行を重ねても延びない）。
    Then ステータスコード 429 が返る
    # 次の 1 回は、正しいパスワードでも通らない。ロック中の 429 と、人が読める解除までの目安が返る。
    When 新しい接続 "while_locked" として "newcomer@struct-pass.example" のパスワードでログインする
    Then ステータスコード 429 が返る
    And 人に見える文言に自動解除までの目安が含まれる
    When 管理者が "newcomer@struct-pass.example" のログイン試行ロックを解除する
    Then ステータスコード 200 が返る
    When 新しい接続 "after_unlock" として "newcomer@struct-pass.example" のパスワードでログインする
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-AUTH-11 パスワードポリシー違反（招待の受諾の入口で弾く）
  #   失効した招待は「無効か期限切れ」の 1 つの案内に揃える（どちらか判別させない）
  # ------------------------------------------------------------------
  @S-AUTH-11
  Scenario: 短すぎるパスワードは理由つきで断る
    # 先頭の行は「後始末でも流し直す」手順（02 §途中でも戻す設定）。本体の行と別に書くのは、
    # 本体の設定値が後で変わっても、戻す値を既定のまま据え置くため。
    Given パスワードポリシーを body "{\"requireLowercase\":true,\"requireUppercase\":true,\"requireNumber\":true,\"requireSymbol\":true,\"minLength\":12,\"mfaEnforced\":false}" で戻す => システムADMIN "admin@rete.local"
    And システムADMIN "admin@rete.local" でログインする
    When PUT "/api/v1/settings/login/password-policy" を body "{\"requireLowercase\":true,\"requireUppercase\":true,\"requireNumber\":true,\"requireSymbol\":true,\"minLength\":12,\"mfaEnforced\":false}" で叩く => システムADMIN "admin@rete.local"
    Then ステータスコード 200 が返る
    # 短すぎるパスワード（8 文字・記号つき）は、何文字以上かを添えて断る。
    When 招待の受諾をパスワード "Ab1!Abcd" で試す
    Then ステータスコード 422 が返る
    And パスワードの不足を理由つきで断った

  # ------------------------------------------------------------------
  # S-AUTH-14 停止の即時反映（本人がログイン中でも、止めた次の通信から締め出される）
  #   P4-01 は org-change 側で同じ挙動を持っている（退職の運用の物語から書いたもの）。
  #   ここでは認証の観点（本人の画面がログインへ戻る条件）で同じ実体を確かめる。
  # ------------------------------------------------------------------
  @S-AUTH-14
  Scenario: 停止されたアカウントは次の通信から締め出され、戻すと復帰する
    Given システムADMIN "admin@rete.local" でログインする
    # 前の実行が止まった場合に備えて、まず止める前の状態（動いている）へ戻す（冪等）。
    When PATCH "/api/v1/members/00000000-0000-4000-a000-000000000006" を body "{\"isActive\":true}" で叩く
    Then ステータスコード 200 が返る
    # 本人がログインし、止める前に自分の情報が取れることを確かめる。
    And seed ユーザー "tanaka@struct-pass.example"（パスワード "ReteDemo1234!"）としてログインし、セッションと自分の id を "tanaka" に保存する
    When 保存セッション "tanaka" で自分の情報を確かめる
    Then ステータスコード 200 が返る
    And レスポンスの "data.email" が "tanaka@struct-pass.example" と一致する
    # 管理者が止める。以後の通信は既存のログイン状態に関わらず 401。
    # 判定は業務 API（器の一覧）で見る。/auth/me は「未ログインでも 200 で data:null」の契約
    # （S-AUTH-06 と同じ）なので、締め出しの判定には使えない。
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/members/00000000-0000-4000-a000-000000000006" を body "{\"isActive\":false}" で叩く
    Then ステータスコード 200 が返る
    When 保存セッション "tanaka" で器の一覧を開く
    Then ステータスコード 401 が返る
    When 保存セッション "tanaka" で自分の情報を確かめる
    Then レスポンスの "data" が空である
    And 実測して挙動が決まったので "S-AUTH-14" を確認済みにする
    # 戻すと、同じ接続で入り直せる（締め出しが「止めている間だけ」であること）。
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/members/00000000-0000-4000-a000-000000000006" を body "{\"isActive\":true}" で叩く
    Then ステータスコード 200 が返る
    When 新しい接続 "tanaka_back" として "tanaka@struct-pass.example" のパスワードでログインする
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-AUTH-15 管理者が MFA を強制リセットできる
  #   端末も控えも失った人は、自分では入り直せない。管理者が 1 手で未設定へ戻せることを確かめる。
  # ------------------------------------------------------------------
  @S-AUTH-15
  Scenario: 端末も控えも失った人は、管理者のリセットで MFA 未設定に戻る
    # 前提: 対象者は MFA を有効にしている（端末に認証アプリを登録した状態）。
    # 後始末でも未設定へ戻す（応答は mfaEnabled を返すため、設定の確認に使える）。
    And MFA ユーザー "mfa-user@rete.local" で MFA を有効化する
    # MFA 有効者のパスワード段は、控えかコードが無いと通らない（= 失った人は入れない）。
    When パスワードでログインし MFA チャレンジを受ける "mfa-user@rete.local"
    Then レスポンスに MFA チャレンジが含まれる
    And full session が未確立
    # 管理者がリセットすると、未設定に戻る（応答の mfaEnabled が false）。
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/members/00000000-0000-4000-a000-000000000008/mfa-reset" を空ボディで叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.mfaEnabled" が真偽値 "false" である
    # 次のログインではチャレンジが出ず、設定からやり直せる状態で入れる。
    # （ログインの応答は mfaRequired を「出す時だけ」載せる＝無いことがチャレンジ無しを意味する。
    #   再確認は本人の設定画面の MFA 状態で行う。）
    When 新しい接続 "after_reset" として "mfa-user@rete.local" のパスワードでログインする
    Then ステータスコード 200 が返る
    When 保存セッション "after_reset" で MFA の設定状態を確かめる
    Then ステータスコード 200 が返る
    And レスポンスの "data.enabled" が真偽値 "false" である
    And 実測して挙動が決まったので "S-AUTH-15" を確認済みにする

  # ------------------------------------------------------------------
  # S-AUTH-12 パスワード変更後に新しいパスワードで入れる
  #   seed の資格情報を一時的に変えて確かめ、最後に元へ戻す（戻しは後始末でも流し直す）。
  # ------------------------------------------------------------------
  @S-AUTH-12
  Scenario: パスワードを変えると旧パスワードでは入れず、新しいパスワードで入れる
    # 変更前の控えを後始末に登録する（この行が無いと、途中で落ちた時に初期パスワードが変わったまま残る）。
    # 合わせてロックの解除も後始末に登録する（誤ったパスワードの試行はロックの回数に数えられるため）。
    Given パスワード変更の控えを用意する "mfa-user@rete.local" を "ReteDemo1234!" で
    And ロックが残っていても拾えるよう "mfa-user@rete.local" の解除を後始末にも登録する
    # 正しく変える。
    When アカウント "mfa-user@rete.local" で自己変更する 現在 "ReteDemo1234!" 新 "Changed1234!x"
    Then ステータスコード 200 が返る
    # 旧パスワードでは入れない。
    When 新しい接続 "old_pw" として "mfa-user@rete.local" の旧いパスワードでログインする
    Then ステータスコード 401 が返る
    # 新しいパスワードでは入れる。
    When 新しい接続 "new_pw" として "mfa-user@rete.local" のパスワードでログインする
    Then ステータスコード 200 が返る
    # 後始末: 元のパスワードへ戻し、ロックも解除する（次のシナリオの前提を崩さない）。
    When アカウント "mfa-user@rete.local" で自己変更する 現在 "Changed1234!x" 新 "ReteDemo1234!"
    Then ステータスコード 200 が返る
    When 管理者が "mfa-user@rete.local" のログイン試行ロックを解除する
    Then ステータスコード 200 が返る
    And 実測して挙動が決まったので "S-AUTH-12" を確認済みにする
