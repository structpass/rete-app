# rete 組織変更 P4 — org-change（運用イベントの権限・認証退行ガード・cmn-0140）
#
# 検証対象（docs/scenarios/journeys/P4-org-change.md の採用5本・cmn-0055 の step に乗る）:
#   P4-01  退職ロック即時失効 — isActive=false で既存セッションが次リクエスト 401・再ログイン拒否・復元で復活
#   P4-03  部署移動           — membership 削除で一覧から消え、本人のスコープ直叩きは 403
#   P4-06  脱退→復帰          — membership の再追加は冪等 upsert（重複なし）で可視復活
#   P4-09  チャネル追加認可   — CHANNEL 作成は PJ ADMIN のみ（PJ MEMBER は 403・システム ADMIN バイパス無し）
#   P4-10/11 参加者増減の可視トグル — 担当者候補（GET /accounts/by-space）が membership 追加で出現・削除で消失＋削除済み本人のスコープ一覧は 403
#
# 実装上の前提（設計時から実体を照合して確定）:
#   - MembershipScopeType は ORGANIZATION / PROJECT / GROUP の3値（SPACE は無い）。CHANNEL の
#     メンバーシップは親 PROJECT スコープで表現する（accounts.service.findBySpace が
#     findProjectIdBySpace → findActiveByProject で親 PJ メンバーを引く実装）。よって
#     membership の add/remove・一覧・403 の検証はすべて PROJECT スコープで行う。
#   - ロック対象は e2e セッション事前生成の元4ユーザー（admin/member/whUser/newcomer）外である
#     seed ユーザー tanaka（tanaka@struct-pass.example・seed.ts 固定 UUID・システム ADMIN・
#     既定デモパスワード）を使用。既存テストのセッションを壊さない。前回実行がロック後に
#     中断していても、シナリオ冒頭で admin が復元してから専用セッションを確立する。
#   - ログイン throttle（/api/v1/auth/login = 5req/60s・IP 共有）を消費する経路は
#     「tanaka のセッション確立（事前生成キャッシュ再利用時は 0・fallback 時 1）」と
#     「ロック後の再ログイン試行（1）」のみ。P4-01 を1シナリオに集約して消費を抑える。
#     cmn-0395: 開発機は E2E_THROTTLE_BYPASS=true で素通しにできる（e2e/README.md §前提）。
#     この集約は素通しを入れていない機械でも落ちないための構造で、残す。
#     再ログイン試行は throttle 窓の状態次第で 429 も取りうるため「401 or 429」で
#     拒否を検証する（401=ロックによる認証拒否・429=レート制限。いずれもログイン不成立）。
#     主検証（既存セッションの次リクエスト 401 即時失効）は厳密に 401 を見る。
#   - GET /memberships?scopeType&scopeId は当該スコープの membership 保有者のみ（システム ADMIN
#     バイパス無し）→ 一覧アサートはスコープメンバーとして実行する。
#   - ロック（PATCH /members/:id の isActive）は自己ロックのみ禁止（members.service.ts:99）。
#     「最後のシステム管理者」ガードは system-role 降格专用のため、tanaka（ADMIN）を
#     bootstrap admin がロックしても管理者ゼロは起きない。
#
# seed 非破壊: 作成した org/PJ/channel は teardown で archive（common.steps.ts の id 記録経由）/
#   membership はシナリオ内で明示 DELETE / tanaka の isActive は復元（＋次回実行冒頭で冪等に事前復元）。
#   連続2回実行 green を満たす。
#
# 退避（本チケット対象外）:
#   - P4-07 招待→受諾フル（生 token 非返却で API テスト不能・partner-scope.feature と同じ退避）

@authz
Feature: P4 組織変更 運用イベント（org-change）

  Background:
    Given バックエンド "http://127.0.0.1:3011" が稼働している

  # ------------------------------------------------------------------
  # P4-01 退職ロック即時失効 — 1シナリオ集約（throttle 消費の最小化）
  # ------------------------------------------------------------------
  @P4-01
  Scenario: 退職ロックで既存セッションが次リクエスト 401 になり、復元で復活する
    # e2e:verified AUTHZ pass "退職ロックで既存セッションが次リクエスト 401 になり、復元で復活する"
    Given システムADMIN "admin@rete.local" でログインする
    # 事前復元: 前回実行がロック後にクラッシュしていても自己修復する（冪等・seed 非破壊担保）
    When PATCH "/api/v1/members/00000000-0000-4000-a000-000000000006" を body "{\"isActive\":true}" で叩く
    Then ステータスコード 200 が返る
    Given seed ユーザー "tanaka@struct-pass.example"（パスワード "ReteDemo1234!"）としてログインし、セッションと自分の id を "tanaka" に保存する
    # ロック前: 認証エンドポイントが通る
    When GET "/api/v1/accounts" を叩く
    Then ステータスコード 200 が返る
    # admin がロック（actor=bootstrap admin・対象=tanaka）
    Given システムADMIN "admin@rete.local" でログインする
    When PATCH "/api/v1/members/00000000-0000-4000-a000-000000000006" を body "{\"isActive\":false}" で叩く
    Then ステータスコード 200 が返る
    # 既存セッションは次リクエストで即 401（毎 deserialize で isActive を引き直す実装の退行ガード）
    When 保存セッション "tanaka" で GET "/api/v1/accounts" を叩く
    Then ステータスコード 401 が返る
    # 再ログインも拒否（401=ロック・429=throttle 窓。いずれもログイン不成立）
    When メール "tanaka@struct-pass.example"・パスワード "ReteDemo1234!" でログインを試みる
    Then ステータスコード 401 または 429 が返る
    # 復元
    When PATCH "/api/v1/members/00000000-0000-4000-a000-000000000006" を body "{\"isActive\":true}" で叩く
    Then ステータスコード 200 が返る
    # 復元成功は PATCH 200 で確認する。401 を受けた passport session は認証情報が除去されるため再利用しない。

  # ------------------------------------------------------------------
  # P4-03 部署移動 — membership 削除で一覧から消え、本人の直叩きは 403
  # ------------------------------------------------------------------
  @P4-03
  Scenario: membership を外されたメンバーはスコープ一覧から消え、本人の直叩きは 403 になる
    # e2e:verified AUTHZ pass "membership を外されたメンバーはスコープ一覧から消え、本人の直叩きは 403 になる"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "orgmove-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"{{orgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000005" を "memberId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000007" を "newcomerId" に保存する
    # member（一覧の観測者）と newcomer（異動対象）をプロジェクトへ追加
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{memberId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{newcomerId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "membershipId" に保存する
    # 異動前: member から見て newcomer が一覧にいる
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/memberships?scopeType=PROJECT&scopeId={{pjId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "accountId" 一覧に "{{newcomerId}}" が含まれる
    # admin が newcomer の membership を外す（部署移動）
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/memberships/{{membershipId}}" を叩く
    Then ステータスコード 204 が返る
    # 異動後: member から見て newcomer が一覧から消える
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When GET "/api/v1/memberships?scopeType=PROJECT&scopeId={{pjId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "accountId" 一覧に "{{newcomerId}}" が含まれない
    # 本人が旧スコープを直叩きすると 403（越境遮断）
    Given システムMEMBER "newcomer@struct-pass.example" でログインする
    When GET "/api/v1/memberships?scopeType=PROJECT&scopeId={{pjId}}" を叩く
    Then ステータスコード 403 が返る
    # teardown は作成者権限の admin context で実行する
    Given システムADMIN "admin@rete.local" でログインする

  # ------------------------------------------------------------------
  # P4-06 脱退→復帰 — 再追加は冪等 upsert（重複なし）で可視復活
  # ------------------------------------------------------------------
  @P4-06
  Scenario: 脱退後の再追加は重複なく可視性が復活する（membership upsert 冪等）
    # e2e:verified AUTHZ pass "脱退後の再追加は重複なく可視性が復活する（membership upsert 冪等）"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "rejoin-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"{{orgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000007" を "newcomerId" に保存する
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{newcomerId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "membershipId" に保存する
    # 脱退
    When DELETE "/api/v1/memberships/{{membershipId}}" を叩く
    Then ステータスコード 204 が返る
    # 復帰: 同キーで再追加（冪等 upsert）
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{newcomerId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "membershipId2" に保存する
    # 本人から見て可視復活・かつ重複は1件もない
    Given システムMEMBER "newcomer@struct-pass.example" でログインする
    When GET "/api/v1/memberships?scopeType=PROJECT&scopeId={{pjId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列の "accountId" 一覧に "{{newcomerId}}" が含まれる
    And レスポンス配列で "accountId" が "{{newcomerId}}" と一致する要素は 1 件
    Given システムADMIN "admin@rete.local" でログインする
    When DELETE "/api/v1/memberships/{{membershipId2}}" を叩く
    Then ステータスコード 204 が返る

  # ------------------------------------------------------------------
  # P4-09 チャネル追加の認可境界 — PJ ADMIN のみ作成可（PJ MEMBER は 403）
  # ------------------------------------------------------------------
  @P4-09
  Scenario: チャネル作成はプロジェクト ADMIN のみ（PJ MEMBER は 403）
    # e2e:verified AUTHZ pass "チャネル作成はプロジェクト ADMIN のみ（PJ MEMBER は 403）"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "chadd-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"{{orgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000005" を "memberId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000007" を "newcomerId" に保存する
    # member を PJ ADMIN・newcomer を PJ MEMBER に
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{memberId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 201 が返る
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{newcomerId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    # bootstrap system ADMIN の PROJECT membership を一時的に外し、system role だけではバイパスできないことを確認
    When GET "/api/v1/memberships?scopeType=PROJECT&scopeId={{pjId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列から "accountId" が "00000000-0000-4000-a000-000000000001" と一致する要素の id を "bootstrapMembershipId" に保存する
    When DELETE "/api/v1/memberships/{{bootstrapMembershipId}}" を叩く
    Then ステータスコード 204 が返る
    When POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\",\"name\":\"{{orgName}}-ch-by-system-admin\"}" で叩く
    Then ステータスコード 403 が返る
    # teardown 権限を戻すため bootstrap admin の PROJECT ADMIN membership を復元
    When POST "/api/v1/memberships" を body "{\"accountId\":\"00000000-0000-4000-a000-000000000001\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"ADMIN\"}" で叩く
    Then ステータスコード 201 が返る
    # PJ ADMIN（member）はチャネル作成成功
    Given システムMEMBER "of-admin@struct-pass.example" でログインする
    When POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\",\"name\":\"{{orgName}}-ch-by-admin\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    # PJ MEMBER（newcomer）は 403
    Given システムMEMBER "newcomer@struct-pass.example" でログインする
    When POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\",\"name\":\"{{orgName}}-ch-by-member\"}" で叩く
    Then ステータスコード 403 が返る
    # teardown は作成者権限の admin context で実行する
    Given システムADMIN "admin@rete.local" でログインする

  # ------------------------------------------------------------------
  # P4-10/11 参加者増減の可視トグル — 担当者候補（by-space）に出現/消失
  # by-space は CHANNEL の親 PROJECT メンバーを返す（accounts.service.findBySpace）。
  # ------------------------------------------------------------------
  @P4-10-11
  Scenario: チャネル参加者の追加で担当者候補に出現し、削除で消失してスコープ一覧は 403 になる
    # e2e:verified AUTHZ pass "チャネル参加者の追加で担当者候補に出現し、削除で消失してスコープ一覧は 403 になる"
    Given システムADMIN "admin@rete.local" でログインする
    And 一意名 "toggle-org" を生成して "orgName" に保存する
    When POST "/api/v1/organizations" を body "{\"name\":\"{{orgName}}\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "orgId" に保存する
    When POST "/api/v1/projects" を body "{\"organizationId\":\"{{orgId}}\",\"name\":\"{{orgName}}-pj\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "pjId" に保存する
    When POST "/api/v1/spaces" を body "{\"kind\":\"CHANNEL\",\"projectId\":\"{{pjId}}\",\"name\":\"{{orgName}}-ch\"}" で叩き id を記録する
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "channelId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000005" を "memberId" に保存する
    And 固定値 "00000000-0000-4000-a000-000000000007" を "newcomerId" に保存する
    # member を先に PJ へ追加（チャネルの親 PJ メンバーが1件以上いる状態を作る）
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{memberId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    # 追加前: newcomer は担当者候補にいない
    When GET "/api/v1/accounts/by-space?spaceId={{channelId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{newcomerId}}" が含まれない
    # 参加者追加（親 PJ membership）→ 候補に出現
    When POST "/api/v1/memberships" を body "{\"accountId\":\"{{newcomerId}}\",\"scopeType\":\"PROJECT\",\"scopeId\":\"{{pjId}}\",\"role\":\"MEMBER\"}" で叩く
    Then ステータスコード 201 が返る
    And 直前のレスポンスの id を "membershipId" に保存する
    When GET "/api/v1/accounts/by-space?spaceId={{channelId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{newcomerId}}" が含まれる
    # 参加者削除 → 候補から消失
    When DELETE "/api/v1/memberships/{{membershipId}}" を叩く
    Then ステータスコード 204 が返る
    When GET "/api/v1/accounts/by-space?spaceId={{channelId}}" を叩く
    Then ステータスコード 200 が返る
    And レスポンス配列に "{{newcomerId}}" が含まれない
    # 削除済み本人のスコープ一覧直叩きは 403（可視が切れる・P4-11 越境遮断）
    Given システムMEMBER "newcomer@struct-pass.example" でログインする
    When GET "/api/v1/memberships?scopeType=PROJECT&scopeId={{pjId}}" を叩く
    Then ステータスコード 403 が返る
