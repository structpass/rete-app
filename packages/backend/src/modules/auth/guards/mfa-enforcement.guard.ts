import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { LoginSettingsService } from '../../login-settings/login-settings.service';
import { MfaService } from '../../mfa/mfa.service';
import { AuthenticatedUser } from '../auth.service';
import { isExemptPath, isExternalIdpSession, rejectWithCode } from './enforcement-gate';

/**
 * 全体強制 MFA の遮断ガード（R8）。login-settings.mfaEnforced=true かつ session の出自が 'local' かつ
 * 当該 account が confirmed な MfaSetting を持たない場合、保護ルートを 403 MFA_SETUP_REQUIRED で遮断する。
 *
 * 適用は 'local' 出自のみ（外部 IdP 認証は IdP の MFA を尊重・R9）。外部アプリへ認証を渡す OIDC interaction の
 * 完了は出自を変えないため、後から MFA を必須にしても同じセッションへ効く（d955）。本ガードはグローバル登録し、
 * 例外（通す）を EXEMPT_PATHS で持つ: MFA セットアップ系・GET /auth/me・POST /auth/logout（設定画面へ到達させるため）。
 * 未認証リクエストは AuthenticatedGuard / 各所の認証境界に委ね、本ガードは認証済のみ判定する（req.user 不在は素通し）。
 */
@Injectable()
export class MfaEnforcementGuard implements CanActivate {
  /**
   * 強制から除外する path（prefix 剥がし後の厳密な前方一致）。部分文字列一致（includes）は使わない
   * （`/foo/settings/mfa-export` 等が誤って除外される穴を作らないため・完全な base または `base/...` のみ許可）。
   * 判定そのものは enforcement-gate が持つ（パスワード変更強制と共通・d1016）。
   * - /settings/mfa 配下 = MFA 設定を完了させるための導線
   * - /auth/me（状態取得）/ /auth/logout（離脱）/ /auth/login（+ /auth/login/mfa の 2 段階）
   * - /settings/login 配下 = MFA 制御盤自体（password-policy・ip-whitelist）。同配下は
   *   LoginSettingsController の @Roles(ADMIN) で ADMIN 限定に守られているため、ADMIN が元から持っていた
   *   権限（MFA 強制 OFF 時にこれらのエンドポイントへ完全アクセスできた状態）を超える新規の露出は生まれない。
   *   強制 ON 時に ADMIN が password-policy の PUT を通じて mfaEnforced を false へ戻す経路も通す。
   *   ※ mfaEnforced は password-policy DTO 内のフィールド（専用 endpoint は無い）で、同 PUT 内で
   *   まとめて更新する設計。本コメントだけを読んで「PUT /settings/login/mfa-enforced」の存在を
   *   想定しないこと（route 探索が空振りする）。
   *   この除外が無いと「ON にはできたのに OFF に戻せない one-way ロックアウト」になる
   *   （fil-0080 撮影中に 開発エージェントが発見・set-0134）。
   */
  private static readonly EXEMPT_BASES = [
    '/settings/mfa',
    '/settings/login',
    '/auth/me',
    '/auth/logout',
    '/auth/login',
  ];

  constructor(
    private readonly loginSettings: LoginSettingsService,
    private readonly mfaService: MfaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    // 未認証は本ガードの対象外（認証境界は AuthenticatedGuard 等に委譲）。
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) return true;

    // 出自は authOrigin で見る（d955）。素通しは「外部 IdP が認証した」と明示された時だけにして、
    // 未知の値・空文字・未設定では fail-open しない（Rete 自身の資格情報で入ったセッションは、
    // 外部アプリへ認証を渡した後でも強制の対象に残す）。判定は enforcement-gate（d1016）。
    if (isExternalIdpSession(req)) return true;

    // 除外 path（セットアップ導線 / me / logout / login）は常に通す。
    if (isExemptPath(req, MfaEnforcementGuard.EXEMPT_BASES)) return true;

    // 出口（強制を外す操作）は EXEMPT_BASES の /settings/login 配下で既に通している。
    // ここで先に通すための別リストは置かない（同じ判断を 2 箇所に書くと、片方だけを直す時に
    // 「出口を開けたつもりで塞がる」「塞いだつもりで開いている」のどちらかが静かに起きる・d849）。

    // 全体強制 OFF なら素通し。
    if (!(await this.loginSettings.isMfaEnforced())) return true;

    // confirmed MFA を持っていれば通す。未設定なら設定フローへ誘導するため 403 で遮断する。
    if (await this.mfaService.hasConfirmedMfa(user.id)) return true;

    rejectWithCode('MFA_SETUP_REQUIRED', 'MFA の設定が必要です');
  }
}
