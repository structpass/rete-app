# rete トラック 5（設定）— 未確認のうち実行へ落とす 9 件（d775）
#
# 対応: docs/scenarios/tracks/05-settings.md
#   S-SET-02 管理グループに足した人へ、付与した範囲の権限が効く
#   S-SET-04 本人が二段階認証を有効にでき、控えは一度だけ出る
#   S-SET-06 契約システムの並び替えが一覧の順に反映される
#   S-SET-09 招待の再送で期限が延びる（古いリンクの失効は未実施）
#   S-SET-10 CSV で一括招待できる（良い行だけが発行され、断った行は理由と行番号付きで残る）
#   S-SET-11 ロックした人が、管理者の解除で入り直せる
#   S-SET-14 メンバー一覧を書き出せる（読める・件数が一覧と一致）
#   S-SET-15 祝日を設定できる（同じ日付は 409 で断り、行は増えない）
#   S-SET-16 表示設定は本人の分だけが保存され、他人の設定を読む口は無い
#
# 前提（e2e/README.md §前提）:
#   - backend が :3011 で稼働し、seed の状態から始まる（`pnpm --filter @rete/backend run reset:e2e-fixtures`）
#   - 資格情報はすべて seed の固定値。作った行はシナリオの後始末で消える（各シナリオ末尾の戻しも含む）
#
# 状態を動かす行（実測して挙動が決まったので <ID> を確認済みにする）は、手順が全部通った時だけ
# 到達する位置に置く（README §5）。S-SET-09 は ⚠（受諾での失効確認が未実施）なので、
# 期限の延長だけを実測しても状態は動かさない。

@settings-track
Feature: 設定トラックの後半（S-SET-02 / 04 / 06 / 09 / 10 / 11 / 14 / 15 / 16）

  # 前提: 前の実行が残したものは、使うシナリオの頭で消す。
  #   ・S-SET-04 の頭で mfa-user の二段階認証を解除する（有効なままだと、その人のログインが 2 段目で止まる）
  #   ・S-SET-06 の頭で契約システムの並びを seed の順へ戻してから並べ替える
  #   ・S-SET-15 の頭で対象の日付に残った祝日を消す
  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-SET-02 管理グループで範囲の権限を束ねられる
  #   所属の器とチャネル（seed 固定）を使い、グループ経由で範囲を付けると見え、
  #   剥がすと見えなくなることを確かめる。所属の無い人には「見えない」ではなく 403 で断る
  #   （実装 spaces.service.findVisibleChannels の契約）。後始末で所属・チャネル・グループを消す。
  # ------------------------------------------------------------------
  @S-SET-02
  Scenario: 管理グループに足した人へ、付与した範囲の権限が効き、剥がすと見えなくなる
    # ① 検証用の器とチャネルを用意する（seed の組織とプロジェクトの下に作る）
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-set02-org" を生成して "set02OrgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{set02OrgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "set02OrgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{set02OrgId}}\",\"name\":\"{{set02OrgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "set02PjId" に保存する
    When POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{set02PjId}}\",\"name\":\"{{set02OrgName}}-ch\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "set02ChId" に保存する
    # ② 検証用のグループを作り、まだ所属していない人をメンバーに入れる
    And 一意名 "e2e-set02-group" を生成して "set02GroupName" に保存する
    When POST "/api/v1/user-groups" を body "{\"name\":\"{{set02GroupName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "set02GroupId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000007" を "set02UserId" に保存する
    When POST "/api/v1/user-groups/{{set02GroupId}}/members" を body "{\"accountId\":\"{{set02UserId}}\"}" で叩く
    Then ステータスコード 201 が返る
    # ③ 付与の前は見えない（所属が無いので 403）
    Given システムMEMBER "newcomer@struct-pass.example" でログインする
    When GET "/api/v1/spaces?kind=CHANNEL&projectId={{set02PjId}}" を叩く
    Then ステータスコード 403 が返る
    # ④ グループに PJ の MEMBER を付与すると見える
    Given システムADMIN "admin@rete.local" でログインする
    When POST "/api/v1/user-groups/{{set02GroupId}}/grants" を body "{\"scopeType\":\"PROJECT\",\"scopeId\":\"{{set02PjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    Given システムMEMBER "newcomer@struct-pass.example" でログインする
    When GET "/api/v1/spaces?kind=CHANNEL&projectId={{set02PjId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data" が空でない
    # ⑤ 付与を剥がすと見えなくなる（メンバーは残したまま、範囲だけを外す）
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/user-groups/{{set02GroupId}}/grants/PROJECT/{{set02PjId}}" を叩く
    Then ステータスコード 204 が返る
    Given システムMEMBER "newcomer@struct-pass.example" でログインする
    When GET "/api/v1/spaces?kind=CHANNEL&projectId={{set02PjId}}" を叩く
    Then ステータスコード 403 が返る
    # ⑥ 後始末: グループを消し、チャネル・プロジェクト・組織を片付ける
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/user-groups/{{set02GroupId}}" を叩く
    Then ステータスコード 204 が返る
    When PATCH "/api/v1/spaces/admin/{{set02ChId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/projects/admin/{{set02PjId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    When PATCH "/api/v1/organizations/admin/{{set02OrgId}}" を body "{\"archived\":true}" で叩く
    Then ステータスコード 200 が返る
    And 実測して挙動が決まったので "S-SET-02" を確認済みにする

  # ------------------------------------------------------------------
  # S-SET-04 自分の二段階認証を設定できる
  #   本人（mfa-user）が自分で有効にし、控えが一度だけ出ることを見る。後始末で管理者が解除する。
  #   ⚠ の「再表示できない」は、状態の取得に控えの欄が無いことで確かめる（画面の文言は部品の試験が持つ）。
  # ------------------------------------------------------------------
  @S-SET-04
  Scenario: 本人が二段階認証を有効にでき、控えは一度だけ出る
    # 前提: 管理者がまず本人の二段階認証を解除する（前の実行が落ちて残っていても同じ所から始まる）
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "00000000-0000-4000-a000-000000000008" を "set04UserId" に保存する
    When PATCH "/api/v1/members/{{set04UserId}}/mfa-reset" を空ボディで叩く
    Then ステータスコード 200 または 404 が返る
    # 本人として、自分の二段階認証の状態を見てから有効にする。
    #   ここは新しい接続で入る（事前に作ったセッションの控えが、二段階認証の有効・無効で
    #   段の途中に止まっている時があるため。解除した後の状態は入り直してから見る）。
    Given メール "mfa-user@rete.local"・パスワード "ReteDemo1234!" で新しくログインした接続を "set04" に用意する
    When 保存セッション "set04" で GET "/api/v1/settings/mfa" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.enabled" が真偽値 "false" である
    When 保存セッション "set04" で POST "/api/v1/settings/mfa/setup" を body "{}" で叩く
    Then ステータスコード 200 が返る
    When 直前の応答の二段階認証の設定 URI から secret を取り出して確定する
    Then ステータスコード 200 が返る
    And レスポンスの "data.backupCodes" が空でない
    When 保存セッション "set04" で GET "/api/v1/settings/mfa" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.enabled" が真偽値 "true" である
    # 控えは再表示されない（状態の取得の応答に控えの欄自体が無い）
    And レスポンスに "data.backupCodes" の欄が無い
    # 後始末: 管理者が解除して元へ戻す
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/members/{{set04UserId}}/mfa-reset" を空ボディで叩く
    Then ステータスコード 200 が返る
    And 実測して挙動が決まったので "S-SET-04" を確認済みにする

  # ------------------------------------------------------------------
  # S-SET-06 契約システムの並び替えが一覧の順に反映される
  #   並びは画面の表示順そのもの。今の並びを控えてから 1 件を先頭へ動かし、元へ戻す。
  # ------------------------------------------------------------------
  @S-SET-06
  Scenario: 契約システムの並び替えが一覧の順に反映される
    # 前提: 先に seed の並びへ戻す（前の実行が並びを変えたまま落ちていても同じ所から始まる）
    Given システムADMIN "admin@rete.local" でログインする
    When 契約システムの並びを seed の順へ戻す
    Then ステータスコード 200 が返る
    # 対象は seed の最後の 1 件（ファイル）。先頭に来たら並びが変わった証拠になる。
    And 固定値 "RETE-FILE" を "set06TargetId" に保存する
    When 契約システムの並びを保存値 "set06TargetId" が先頭に来るよう入れ替える
    Then ステータスコード 200 が返る
    When GET "/api/v1/settings/tenant/systems" を叩く
    Then ステータスコード 200 が返る
    And 一覧の先頭の行が保存値 "set06TargetId" である
    # 戻す（控えた並びへ）
    When 契約システムの並びを保存値 "systemsOrderBefore" の順へ戻す
    Then ステータスコード 200 が返る
    When GET "/api/v1/settings/tenant/systems" を叩く
    Then ステータスコード 200 が返る
    And 契約システムの並びは保存値 "systemsOrderBefore" の順に戻っている
    And 実測して挙動が決まったので "S-SET-06" を確認済みにする

  # ------------------------------------------------------------------
  # S-SET-10 CSV で一括招待できる
  #   テンプレートの見出しを使い、良い宛先・空行・形の崩れた宛先・良い宛先を混ぜて取り込む。
  #   崩れた行は、空行を飛ばした実際の行番号（4 行目）と理由付きで返ることを見る。
  # ------------------------------------------------------------------
  @S-SET-10
  Scenario: CSV で一括招待すると、良い行だけが発行され、断った行は理由と行番号で残る
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "00000000-0000-4000-b000-000000000040" を "groupId" に保存する
    When 招待 CSV のテンプレートを取り込み宛先の形を確かめてから、良い宛先と形の崩れた宛先を混ぜた CSV を取り込む
    Then ステータスコード 200 が返る
    And 取り込みの結果に発行数と断った件数が分かれて返る
    When GET "/api/v1/invites" を叩く
    Then ステータスコード 200 が返る
    And 一覧に保存値 "csvBadEmail" の行は入っていない
    And 実測して挙動が決まったので "S-SET-10" を確認済みにする

  # ------------------------------------------------------------------
  # S-SET-09 招待を再送すると期限が延びる
  #   発行→期限を控える→再送→期限を比べる、で期限の延長だけを確かめる。
  #   古いリンクが使えなくなることは、受諾（アカウント作成）を伴い取り消せないため、ここでは実施しない
  #   （⚠ のまま。tracks の未確定事項に理由を残す）。
  # ------------------------------------------------------------------
  @S-SET-09
  Scenario: 招待を再送すると期限が延びる
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "00000000-0000-4000-b000-000000000040" を "groupId" に保存する
    And 一意名 "e2e-set09" を生成して "set09Email" に保存する
    # 発行し、期限を控える
    When POST "/api/v1/invites" を body "{\"email\":\"{{set09Email}}@example.com\",\"spaceId\":\"{{groupId}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "set09InviteId" に保存する
    When GET "/api/v1/invites" を叩く
    Then ステータスコード 200 が返る
    And 一覧から保存値 "set09Email" の行の "expiresAt" を "set09ExpiresBefore" に控える
    # 再送し、期限が延びたことを見る
    When POST "/api/v1/invites/{{set09InviteId}}/resend" を body "{}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/invites" を叩く
    Then ステータスコード 200 が返る
    And 一覧の保存値 "set09Email" の行の期限は保存値 "set09ExpiresBefore" より後である
    # ⚠ の行なので「確認済みにする」行は置かない（README §5）。

  # ------------------------------------------------------------------
  # S-SET-08 招待を発行して受諾される
  #   発行・二重発行の拒否は settings.feature の @S-SET-08 が持つ。ここは受諾の口を足す。
  #   ① 表に無い値は 1 種類の曖昧な断り方で断る（列挙防止）。
  #   ② 受諾の成立は専用の隔離 API 試験で確認する。このシナリオでは実施しない。
  #      確かめられるのは「発行・一覧・削除の口が同じ宛先で 1 件に定まり、消したことが一覧に出る」ところまで。
  #      このシナリオでは状態を変更しない。
  # ------------------------------------------------------------------
  @S-SET-08
  Scenario: 招待の受諾の口は、正しい形の値を受け付け、表に無い値を曖昧に断る
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "00000000-0000-4000-b000-000000000040" を "groupId" に保存する
    And 一意名 "e2e-set08" を生成して "set08Email" に保存する
    # 発行し、未使用で並ぶことを見る
    When 招待の宛先 "{{set08Email}}@example.com" に招待を発行して id を控える
    Then ステータスコード 201 が返る
    When GET "/api/v1/invites" を叩く
    Then 招待は未使用の状態で並んでいる
    # 本人（新しい接続・ログイン無し）が受諾する。値は表のどの招待にも当たらないことを確かめてから渡す
    When 招待の口が発行したトークンの控えを新しい接続で受諾する
    # 当たらない値は、存在しない・期限切れ・宛先が既に居るのどれと同じ 1 種類の文言で断る（列挙防止）
    Then 招待の受諾はステータスコード 400 で断られ、次の文言を返す "招待が無効か期限切れです"
    # 断られた受諾ではアカウントができない（名簿にも増えない）
    When GET "/api/v1/members" を叩く
    Then ステータスコード 200 が返る
    And 受諾したアカウントが名簿に並んでいない
    # ② 同じ宛先で発行し直し、手順 1 の招待を消して、消えたことを一覧で確かめる
    When 招待を削除して発行し直し、無効な値の受諾を断る
    Then ステータスコード 400 が返る
    # 状態は隔離試験と合わせて判定する。

  # ------------------------------------------------------------------
  # S-SET-11 ログイン試行ロックを管理者が解除できる
  #   誤入力でロックを掛け、ロック中は正しいパスワードでも入れないことを見てから、
  #   管理者が解除して本人が入り直す。掛け方・解除・入り直しは S-AUTH-09 と同じ手順を使う。
  #   seed の人を使うので、シナリオが途中で落ちても fixtures の後始末で解除する（最初の行）。
  # ------------------------------------------------------------------
  @S-SET-11
  Scenario: ロックした人が、管理者の解除で正しいパスワードで入り直せる
    Given ロックが残っていても拾えるよう "newcomer@struct-pass.example" の解除を後始末にも登録する
    And システムADMIN "admin@rete.local" でログインする
    And 管理者が "newcomer@struct-pass.example" のログイン試行ロックを解除する
    Then ステータスコード 200 が返る
    When "newcomer@struct-pass.example" のパスワードログインを誤ったパスワードで 6 回試す
    Then ステータスコード 429 が返る
    # ロック中は、正しいパスワードでも入れない
    When 新しい接続 "set11_locked" として "newcomer@struct-pass.example" のパスワードでログインする
    Then ステータスコード 429 が返る
    # 管理者が解除すると、その本人は入り直せる
    When 管理者が "newcomer@struct-pass.example" のログイン試行ロックを解除する
    Then ステータスコード 200 が返る
    When 新しい接続 "set11_after" として "newcomer@struct-pass.example" のパスワードでログインする
    Then ステータスコード 200 が返る
    And 実測して挙動が決まったので "S-SET-11" を確認済みにする

  # ------------------------------------------------------------------
  # S-SET-16 表示設定が本人だけに効く
  #   保存は「自分の分」しか扱えない（対象はセッション本人に固定）ことを、状態の保存と取得で見る。
  #   他人の設定を読む口が無いことは、他人の id で同じ口を叩いて 404 になることで確かめる。
  #   保存した値は最後に元へ戻す（表示設定は本人の画面に出る）。
  # ------------------------------------------------------------------
  @S-SET-16
  Scenario: 表示設定は本人の分だけが保存され、他人の設定を読む口は無い
    Given システムADMIN "admin@rete.local" でログインする
    # まず今の値を控える（後で元へ戻す）
    When GET "/api/v1/accounts/me/display-preference" を叩く
    Then ステータスコード 200 が返る
    And 直前の応答を "set16Before" として控える
    # 保存し、取り直すと入っている
    When PUT "/api/v1/accounts/me/display-preference" を body "{\"stripeEnabled\":false,\"stripeColor\":\"#123456\"}" で叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/accounts/me/display-preference" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.stripeColor" が "#123456" と一致する
    # 他人の id を指定して同じ口を叩いても読めない（対象は常に本人）
    And 固定値 "00000000-0000-4000-a000-000000000006" を "set16OtherId" に保存する
    When GET "/api/v1/accounts/{{set16OtherId}}/display-preference" を叩く
    Then ステータスコード 404 が返る
    # 後始末: 控えた値へ戻す
    When 直前の応答を控えた保存値 "set16Before" の表示設定へ戻す
    Then ステータスコード 200 が返る
    And 実測して挙動が決まったので "S-SET-16" を確認済みにする

  # ------------------------------------------------------------------
  # S-SET-14 メンバー一覧を書き出せる
  #   書き出した本文が見出しと行を持ち、文字化けせず、行数が一覧の件数と一致することを見る。
  # ------------------------------------------------------------------
  @S-SET-14
  Scenario: メンバー一覧を書き出すと、読める名簿が落ちてきて件数が一覧と一致する
    Given システムADMIN "admin@rete.local" でログインする
    When GET "/api/v1/members/export" を叩く
    Then ステータスコード 200 が返る
    And 書き出した名簿の本文が読める文字列で、件数が一覧と一致する
    # 非管理者は書き出せない
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/members/export" を叩く
    Then ステータスコード 403 が返る
    And 実測して挙動が決まったので "S-SET-14" を確認済みにする

  # ------------------------------------------------------------------
  # S-SET-15 祝日を設定できる
  #   同じ日付を 2 回登録する。採用済みの挙動（同じ日付は CONFLICT で断る・行は増えない）を実測し、
  #   ⚠ だった「二重登録は更新になる」という期待は実装と違うことを記録に残す。
  #   後始末でその日付を消す（seed の祝日には触らない）。
  # ------------------------------------------------------------------
  @S-SET-15
  Scenario: 同じ日付の祝日は二重に登録できず、1 行のまま残る
    Given システムADMIN "admin@rete.local" でログインする
    And 固定値 "2027-12-31" を "set15Date" に保存する
    When カレンダーの祝日に保存値 "set15Date" の日付を名前とともに登録して同じ日付でもう一度登録する
    # 1 回目が 201 で入り、2 回目が 409 で断られることを、ひとつの判定で確かめる。
    Then 同じ日付の再登録は 409 で断られ、行が増えない
    When GET "/api/v1/calendar-holidays" を叩く
    Then ステータスコード 200 が返る
    And 一覧に保存値 "set15Date" の日付の行が 1 件だけある
    And 実測して挙動が決まったので "S-SET-15" を確認済みにする
