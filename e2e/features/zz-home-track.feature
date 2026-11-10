# rete ホームトラック（docs/scenarios/tracks/02-home.md）の未確認行 — 2026-10-25
#
# 対応:
#   S-HOME-03 お知らせを開くと既読になり未読が減る（二度開いても更に減らない＝冪等）
#   S-HOME-05 添付ファイルを開いて取得できる（中身が掲示時に添付したものと同じ）
#   S-HOME-06 掲示板の並び順を入れ替えられる（入れ替えが別の人にも一覧の並びとして見える）
#   S-HOME-13 祝日が予定と重なって表示される（祝日が予定を巻き込んで消さない）
#   S-HOME-14 FAQ を投稿して参照できる（FAQ の一覧・詳細・未読に載り、掲示板には混ざらない）
#   S-HOME-15 掲示板と FAQ のタグが混ざらない（件数・一覧・日本語名の付与の 3 面）
#   S-HOME-10 カレンダーに予定を作ると、作っていない人にも同じ日に見える（d820）
#   S-HOME-09 準備中の項目は押しても動かず、押せない理由が文字で出る（d820・画面の部品の試験）
#
# 実行の並び: ファイル名の辞書順で走るため、他の feature の後ろへ回す。「zz-」を先頭に置く。
# 作ったデータ（フォルダ・ファイル・掲示・FAQ・タグ・予定）は、シナリオ内で明示的に消す。
# 掲示の並び替えは全件を動かすため、必ず元の並びへ戻してから終わる。
#
# 状態（tracks の表）は、この feature が緑になった結果でだけ ✅ にする（README §5）。

@home-track
Feature: ホームトラックの未確認行（S-HOME-03 / 05 / 06 / 13 / 14 / 15）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # S-HOME-03 開くと既読になり、二度目で余分に減らない
  # ------------------------------------------------------------------
  @S-HOME-03
  Scenario: お知らせを開くと未読が1減り、二度目に開いても減らない
    # e2e:verified ZZ-HOME-TRACK pass "お知らせを開くと未読が1減り、二度目に開いても減らない"
    # 土台: 先に、一覧が出している未読の行をすべて開いて既読にする（未読が 0 から始まる）。
    # 未読の件数は「既読 0 の人が見た時の数」なので、これをしないと手前の試験の既読ぶんだけずれる。
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When 一覧の未読の行をすべて開いて既読にする
    When GET "/api/v1/announcements/unread-count" を叩く
    Then レスポンスの "data.count" を "unreadBefore" に保存する
    # 掲示はこのシナリオで作って消す。新しく積まれた 1 件が未読として数えられることを確かめてから、
    # 開いて 1 減ること・二度目は減らないこと（冪等）を確かめる。
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-ann" を生成して "annTitle" に保存する
    When POST "/api/v1/announcements" を body "{\"title\":\"{{annTitle}}\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "annId" に保存する
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements/unread-count" を叩く
    Then 未読の件数を比べる "data.count" が保存値 "unreadBefore" から一覧の差分で増える
    When GET "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/announcements/unread-count" を叩く
    Then 未読の件数を比べる "data.count" が保存値 "unreadBefore" から一覧の差分なし
    # 二度目の読み込み（再読込・別画面からの戻り）でも減らない。
    When GET "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/announcements/unread-count" を叩く
    Then 未読の件数を比べる "data.count" が保存値 "unreadBefore" から一覧の差分なし
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-HOME-05 添付を開いて取得できる（掲示した時の版・中身のまま）
  # ------------------------------------------------------------------
  @S-HOME-05
  Scenario: 掲示に添付したファイルを、掲示した時の中身のまま取得できる
    # e2e:verified ZZ-HOME-TRACK pass "掲示に添付したファイルを、掲示した時の中身のまま取得できる"
    Given システムADMIN "admin@rete.local" でログインする
    # 器は既定チャット（seed 済み）。「フォルダ → ファイル → 掲示 → 添付」の順で作る。
    # 作ったものは id を控えておき、このシナリオの終わりに必ず消す。
    And 一意名 "e2e-folder" を生成して "folderName" に保存する
    When POST "/api/v1/files/folders" を body "{\"parentFolderId\":null,\"name\":\"{{folderName}}\",\"spaceId\":\"00000000-0000-4000-b000-000000000003\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "folderId" に保存する
    And 一意名 "e2e-attach" を生成して "fileName" に保存する
    And 固定値 "掲示に添付した時の中身です" を "fileBody" に保存する
    When POST "/api/v1/files/folders/{{folderId}}/files" に名前 "{{fileName}}"・中身 "{{fileBody}}" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "fileId" に保存する
    And 一意名 "e2e-ann" を生成して "annTitle" に保存する
    When POST "/api/v1/announcements" を body "{\"title\":\"{{annTitle}}\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "annId" に保存する
    # 添付は `叩き id を記録する` を使わない（記録すると後始末が再来で掲示ごと消した後に
    # 添付を消しに行き、404 で赤になる）。添付は掲示の削除で連鎖して消える。
    When POST "/api/v1/announcements/{{annId}}/attachments" を body "{\"fileId\":\"{{fileId}}\"}" で叩く
    Then ステータスコード 201 が返る
    # 掲示した後に同じファイルへ新しい版を上げても、掲示の添付は掲示した時の版を指し続ける。
    When POST "/api/v1/files/files/{{fileId}}/versions" に名前 "{{fileName}}"・中身 "あとで上げた別の中身です" のファイルを multipart で送り id を記録する
    Then ステータスコード 201 が返る
    # 読み手（編集のフラグを持たない MEMBER）が掲示を開いて、添付を取得する。
    # この確認は、未読を数える試験（S-HOME-03）より後ろに置いてある（開くと既読になるため）。
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る
    When 保存値 "fileName" と同じ名称の添付を取得する
    Then ステータスコード 200 が返る
    And 取得した中身が保存値 "fileBody" と一致する
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/files/{{fileId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/files/folders/{{folderId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-HOME-06 並び順を入れ替えると、別の人の一覧の並びも変わる
  # ------------------------------------------------------------------
  @S-HOME-06
  Scenario: 掲示の並びを入れ替えると、読み手の一覧でも同じ順で見える
    # e2e:verified ZZ-HOME-TRACK pass "掲示の並びを入れ替えると、読み手の一覧でも同じ順で見える"
    Given システムADMIN "admin@rete.local" でログインする
    # 並び替えは「現存全件の id」を渡す形なので、元の並びを控えてから入れ替える。
    When GET "/api/v1/announcements" を叩く
    Then 直前の一覧の応答を "originalList" として控える
    And 一意名 "e2e-ann-first" を生成して "firstTitle" に保存する
    When POST "/api/v1/announcements" を body "{\"title\":\"{{firstTitle}}\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "firstId" に保存する
    And 一意名 "e2e-ann-second" を生成して "secondTitle" に保存する
    When POST "/api/v1/announcements" を body "{\"title\":\"{{secondTitle}}\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "secondId" に保存する
    # 2 件目を作った直後は、2 件目が先頭（新規は先頭に積まれる）。
    When GET "/api/v1/announcements" を叩く
    Then 一覧は全件がまとめて返っている
    And 一覧の "id" は保存値 "secondId" が保存値 "firstId" より先である
    When 掲示の並びを保存値 "firstId" が先頭に来るよう入れ替える
    Then ステータスコード 200 が返る
    # 読み手（別の人）の一覧でも、入れ替えた順で見える。
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements" を叩く
    Then 一覧の "id" は保存値 "firstId" が保存値 "secondId" より先である
    Given システムADMIN "admin@rete.local" でログインする
    When 掲示の並びを保存値 "originalList" の順へ戻す
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/announcements/{{firstId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/announcements/{{secondId}}" を叩く
    Then ステータスコード 200 が返る
    When GET "/api/v1/announcements" を叩く
    Then 一覧は全件がまとめて返っている

  # ------------------------------------------------------------------
  # S-HOME-13 祝日と予定が同じ日にあっても、両方取れる
  # ------------------------------------------------------------------
  @S-HOME-13
  Scenario: 祝日の日に予定を置いても、祝日と予定の両方が取れる
    # e2e:verified ZZ-HOME-TRACK pass "祝日の日に予定を置いても、祝日と予定の両方が取れる"
    Given システムADMIN "admin@rete.local" でログインする
    # 祝日は予定とは別の台帳（日付だけで持つ）。日付はその日が他の試験で使われていない日に置く。
    And 一意名 "e2e-holiday" を生成して "holidayName" に保存する
    When POST "/api/v1/calendar-holidays" を body "{\"date\":\"2027-07-21\",\"name\":\"{{holidayName}}\"}" で叩く
    Then ステータスコード 201 が返る
    # 同じ日に終日予定を 1 件置く（祝日と重ねる）。終日の予定は「日本時間の 0 時」で渡す決まりなので、
    # 前日 15:00Z（＝当日 0 時）から翌日 15:00Z までで 1 日ぶんにする。
    And 一意名 "e2e-event" を生成して "eventTitle" に保存する
    When POST "/api/v1/calendar-events" を body "{\"title\":\"{{eventTitle}}\",\"startAt\":\"2027-07-20T15:00:00.000Z\",\"endAt\":\"2027-07-21T15:00:00.000Z\",\"allDay\":true}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "eventId" に保存する
    And レスポンスの "data.revision" を "eventRev" に保存する
    # 同じ日に、祝日と予定が両方ある（どちらかが他方を消していない）。
    When GET "/api/v1/calendar-holidays" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "date" の値が "2027-07-21" の行で入っている
    When GET "/api/v1/calendar-events?from=2027-07-20T00:00:00.000Z&to=2027-07-22T00:00:00.000Z" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "eventId" の行で入っている
    When DELETE "/api/v1/calendar-events/{{eventId}}?revision={{eventRev}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/calendar-holidays/2027-07-21" を叩く
    Then ステータスコード 204 が返る

  # ------------------------------------------------------------------
  # S-HOME-10 予定を作ると、作っていない人のカレンダーにも出る
  #   手元（管理者の画面）にだけ出て、他の人には出ない、を起きにくくする行。
  #   管理者と MEMBER は別の接続でログインし、MEMBER のカレンダーが同じ日を返すかを見る。
  # ------------------------------------------------------------------
  @S-HOME-10
  Scenario: 管理者が入れた予定が、作っていない人のカレンダーにも同じ日に出る
    # e2e:verified ZZ-HOME-TRACK pass "管理者が入れた予定が、作っていない人のカレンダーにも同じ日に出る"
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    # 予定を作る前に、読み手の画面が持つ予定の件数を控える（増えた 1 件が手順 3 で作ったもの）。
    When GET "/api/v1/calendar-events?from=2027-08-09T00:00:00.000Z&to=2027-08-11T00:00:00.000Z" を叩く
    Then レスポンスの中の "data" を丸ごと "memberEventsBefore" に保存する
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-event" を生成して "eventTitle" に保存する
    # 予定の消し口は revision を要求する。`叩き id を記録する` は作った直後の応答の revision を
    # 添えて後始末へ渡す（support/teardown.ts・d793）。以下の明示の削除も、途中で落ちた場合の
    # 後始末と重ならないよう revision を添える。
    When POST "/api/v1/calendar-events" を body "{\"title\":\"{{eventTitle}}\",\"startAt\":\"2027-08-10T01:00:00.000Z\",\"endAt\":\"2027-08-10T02:00:00.000Z\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "eventId" に保存する
    And レスポンスの "data.revision" を "eventRev" に保存する
    # ここからは読み手（作っていない人）の接続で見る。
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/calendar-events?from=2027-08-09T00:00:00.000Z&to=2027-08-11T00:00:00.000Z" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "eventId" の行で入っている
    # その日に出ている（作った時刻に出ている・別の日に紛れていない）。
    And 一覧に "id" の値が "{{eventId}}" の行の開始時刻が "2027-08-10" の日である
    And 予定の件数は保存値 "memberEventsBefore" より 1 件だけ多い
    # 他の人の画面の見え方は、予定の詳細を読み手自身が開けることで確かめる（権限で読めないのは S-HOME-11）。
    When GET "/api/v1/calendar-events/{{eventId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.title" が "{{eventTitle}}" と一致する
    # 外すため、消し済みの予定を後始末がもう一度撃って 404 で落ちることはない。
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/calendar-events/{{eventId}}?revision={{eventRev}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-HOME-14 FAQ を投稿して参照できる
  # ------------------------------------------------------------------
  @S-HOME-14
  Scenario: FAQ を投稿するとFAQの一覧と未読に載り、掲示板には載らない
    # e2e:verified ZZ-HOME-TRACK pass "FAQ を投稿するとFAQの一覧と未読に載り、掲示板には載らない"
    # 既読になる操作（FAQ を開く）の前に数を取る。数は種別ごとに数えているので、
    # FAQ を作る前の「FAQ の未読」を基準にする。
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements/unread-count?kind=faq" を叩く
    Then レスポンスの "data.count" を "faqUnreadBefore" に保存する
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "e2e-faq" を生成して "faqTitle" に保存する
    When POST "/api/v1/announcements" を body "{\"title\":\"{{faqTitle}}\",\"kind\":\"faq\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "faqId" に保存する
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/announcements/unread-count?kind=faq" を叩く
    Then 未読の件数を比べる "data.count" が保存値 "faqUnreadBefore" から一覧の差分で増える
    # FAQ の一覧に載り、開くと答え（ここではタイトル）が読める。
    When GET "/api/v1/announcements?kind=faq" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "faqId" の行で入っている
    When GET "/api/v1/announcements/{{faqId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンスの "data.title" が "{{faqTitle}}" と一致する
    # 掲示板の一覧には混ざらない。
    When GET "/api/v1/announcements?kind=board" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{faqTitle}}" が含まれない
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/announcements/{{faqId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-HOME-15 掲示板と FAQ のタグが混ざらない
  # ------------------------------------------------------------------
  @S-HOME-15
  Scenario: 掲示板とFAQに同じ名前の日本語タグを作っても、互いの一覧と付与に混ざらない
    # e2e:verified ZZ-HOME-TRACK pass "掲示板とFAQに同じ名前の日本語タグを作っても、互いの一覧と付与に混ざらない"
    Given システムADMIN "admin@rete.local" でログインする
    # 同じ名前で 2 種類（日本語の名前が「大文字小文字を区別しない一意」に乗るか）。
    And 一意名 "既定" を生成して "tagName" に保存する
    When POST "/api/v1/announcement-tags" を body "{\"name\":\"{{tagName}}\",\"icon\":\"Tag\",\"color\":\"red\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "boardTagId" に保存する
    When POST "/api/v1/announcement-tags" を body "{\"name\":\"{{tagName}}\",\"icon\":\"Tag\",\"color\":\"blue\",\"kind\":\"faq\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "faqTagId" に保存する
    # 掲示板の一覧に FAQ のタグは出ず、FAQ の一覧に掲示板のタグは出ない。
    When GET "/api/v1/announcement-tags?kind=board" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "boardTagId" の行で入っている
    And レスポンス配列に "{{faqTagId}}" が含まれない
    When GET "/api/v1/announcement-tags?kind=faq" を叩く
    Then ステータスコード 200 が返る
    And 一覧に "id" が保存値 "faqTagId" の行で入っている
    And レスポンス配列に "{{boardTagId}}" が含まれない
    # 付与も種別を跨げない（掲示に FAQ のタグを付けようとすると断り、掲示板のタグなら通る）。
    And 一意名 "e2e-ann" を生成して "annTitle" に保存する
    When POST "/api/v1/announcements" を body "{\"title\":\"{{annTitle}}\",\"kind\":\"board\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "annId" に保存する
    When PUT "/api/v1/announcements/{{annId}}/tags" を body "{\"tagIds\":[\"{{faqTagId}}\"]}" で叩く
    Then ステータスコード 400 が返る
    When PUT "/api/v1/announcements/{{annId}}/tags" を body "{\"tagIds\":[\"{{boardTagId}}\"]}" で叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/announcements/{{annId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/announcement-tags/{{boardTagId}}" を叩く
    Then ステータスコード 200 が返る
    When DELETE "/api/v1/announcement-tags/{{faqTagId}}" を叩く
    Then ステータスコード 200 が返る

  # ------------------------------------------------------------------
  # S-HOME-09 準備中の項目を押した時の挙動（実測 2026-10-26 で確定）
  #   灰色の行はクリックを受け取らず画面は動かない。理由を文字で出す（無反応にしない）。
  #   サイドバーはログイン後に描かれるため、ブラウザ無しの通信では判定できない。画面の部品の試験で
  #   確かめ、その 3 件（押せない・理由が出る・準備中が無ければ出さない）が同じ回で緑の時だけ進む:
  #     packages/frontend/src/features/shell/components/__tests__/app-sidebar.test.tsx
  #   回す口: node e2e/scripts/fast-test.mjs --component-tests=packages/frontend/src/features/shell/
  #           components/__tests__/app-sidebar.test.tsx
  #   回していない回は控えが無く、このシナリオは赤で止まる（確かめないまま ✅ にしない）。
  # ------------------------------------------------------------------
  @S-HOME-09
  Scenario: 準備中の項目は押しても動かず、押せない理由が文字で出る
    Given 部品の試験 "packages/frontend/src/features/shell/components/__tests__/app-sidebar.test.tsx" の結果を "sidebarTest" に読む
    Then 部品の試験 "sidebarTest" で "遷移先が未接続の行は押せず、押しても遷移しない（何も起きない）" が通っている
    And 部品の試験 "sidebarTest" で "準備中の行がある時だけ、押せない理由を文字で出す（無反応にしない）" が通っている
    And 部品の試験 "sidebarTest" で "準備中の行が無ければ案内は出さない" が通っている
    And 実測して挙動が決まったので "S-HOME-09" を確認済みにする
