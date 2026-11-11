---
id: 0033
title: ログイン試行ロックアウト（H6）を DB 保持 + 429 で実装し、lockout-as-DoS / 429 enumeration を許容する
date: 2026-06-13
status: active
category: 不完全さ許容
affected: rete auth モジュール（AuthService.validateCredentials / AccountRepository.registerFailedAttempt）/ Account スキーマ（failed_login_attempts・locked_until 列）/ AllExceptionsFilter（429 → TOO_MANY_REQUESTS）/ operational-policy.md §1（error 体系・429 追加）§4（env var MAX_LOGIN_ATTEMPTS・LOGIN_LOCKOUT_MINUTES）/ hardening H6
revisit: マルチユーザー本番運用へ移行する時（lockout-as-DoS の悪用面が顕在化したら CAPTCHA / IP throttle / 段階的 backoff を検討）。@nestjs/throttler の共有ストア化（現状 in-memory）を行う時
---

## Context（このとき）

hardening H6（brute-force 防御）として、ログイン連続失敗でアカウントを一時ロックする仕組みを実装した。論点は (1) 失敗カウント / ロック期限の保持先、(2) ロック中のレスポンス、(3) timing / enumeration 漏洩への対処、(4) increment と閾値ロックの原子性。@nestjs/throttler は既にグローバル 30/60s + login 5/60s で配線済（in-memory）だが、これは IP 単位・プロセス単位の即時レート制限であり、アカウント単位の永続ロックとは別レイヤ。

## Decision（こうした）

- **保持先 = DB（Account 行）**: `failed_login_attempts` / `locked_until` を Account に追加。IP・インスタンスを変えても回避できず、再起動を跨いで一貫する。throttler の in-memory レート制限はそのまま併存（別レイヤ）。開発統括承認済（複数インスタンス耐性を最初から持たせ技術負債を残さない）。
- **ロック中レスポンス = HTTP 429 / `code: TOO_MANY_REQUESTS`**: throttler 超過と同じ status を使い、operational-policy §1 の error 体系へ 429 を新規追加。
- **閾値 / ロック時間 = env 上書き可（既定 5 回 / 15 分）**: `MAX_LOGIN_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES`。未設定でも安全側の既定で動くため REQUIRED 化はせず optional（.env.example にコメントで明示）。正の整数のみ採用し不正値は既定へフォールバック。
- **timing 均一化**: 不在 / 無効 / ロック中の全経路で dummy argon2 verify を 1 回回し、応答時間で「アカウント存在 / ロック状態」が漏れないようにする。
- **increment + ロックの原子化**: `registerFailedAttempt` を単一 `UPDATE ... CASE WHEN ... RETURNING`（raw SQL・Prisma.sql でパラメータ化）で実装し、read-then-write の TOCTOU（並行失敗でロックがすり抜ける）を構造的に排除。Repository 層に閉じ込め（architecture-invariants §2）。

## 許容する不完全さ（こう割り切った）

- **lockout-as-DoS**: 攻撃者が標的の email で意図的に連続失敗させ、正規ユーザーをロックアウトできる。MVP・実質シングルユーザー運用では悪用面が小さく、ロック時間も有限（既定 15 分で自動解除）なので許容する。マルチユーザー本番化時に CAPTCHA / IP 段階 backoff を検討（revisit）。
- **429 vs 401 による user enumeration**: 非存在アカウントは常に 401、存在アカウントは閾値到達後 429 に変わるため、`maxAttempts` 回の失敗を払えば email 実在を確認できる（status code 由来の論理リーク・timing リークではない）。これはロックアウトを UX 良く伝える（「制限超過・時間をおいて」と返す）ことと operational-policy §1 が 429 を正規 error code に据える方針の直接の帰結。401 に畳んで retry-after だけで伝える案より、ユーザーへの説明性を優先して 429 を採用。enumeration コストは「maxAttempts 回の事前失敗」が必要で総当たり効率は上がらないため許容する。

## Reason（こういう理由で）

- **DB 保持**: in-memory ロックは再起動・複数インスタンスで失効/不一致になり、IP を変える総当たりに無力。アカウント単位の永続ロックは「誰のアカウントが攻撃されているか」を一貫して律速できる。後から共有ストア化する二重工事も避けられる。
- **原子化**: read（incrementFailedAttempts）→ 判定 → write（lockAccount）の 3 段は並行失敗でロック判定がすり抜ける TOCTOU を持つ。単一 UPDATE に畳めばロック発火が DB 制約と同じ強さで保証される。
- **timing 均一化**: argon2 は計算コストが大きく、verify を回す/回さないの差が応答時間に明確に出る。全失敗経路で dummy verify を回さないと「アカウント存在」「ロック中」が時間で漏れる。
- **捨てた案**:
  - in-memory（throttler の ThrottlerStorage 拡張のみ）でアカウントロックを表現する案 → 再起動・複数インスタンスで一貫せず、DoS 耐性が逆に弱い。却下。
  - ロック中も 401 を返し enumeration を完全に塞ぐ案 → ユーザーに「なぜ正しいパスワードでも入れないか」を伝えられず UX が悪化。operational-policy §1 の 429 方針とも不整合。論理リークのコスト（maxAttempts 回の事前失敗が必要）が小さいため 429 を採用。

## 関連

- operational-policy.md §1（429 / TOO_MANY_REQUESTS 追加）§4（H6 env var）
- ADR 0025（rbac-two-layer-coexistence）— 認証境界の別レイヤ（システム権限）。本決定は brute-force 防御レイヤ。
- @nestjs/throttler（in-memory レート制限）— 本決定の DB ロックと併存する別レイヤ。共有ストア化は将来課題（revisit）。
