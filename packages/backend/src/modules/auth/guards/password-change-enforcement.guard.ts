import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedUser } from '../auth.service';
import { isExemptPath, isExternalIdpSession, rejectWithCode } from './enforcement-gate';

/**
 * 強制パスワード変更の遮断ガード（set-0035）。session の本人 account が mustChangePassword=true の間、
 * 保護ルートを 403 PASSWORD_CHANGE_REQUIRED で遮断する。MfaEnforcementGuard と同型の「ログイン後ゲート」で、
 * フロントの横断ゲート（AppShell）が UX 層、本ガードが真の保護境界（API 直叩きも遮断）。
 *
 * 判定は req.user（毎リクエスト deserialize で DB から再構築）の mustChangePassword を読むだけ＝追加クエリなし。
 * 適用は 'local' 認証経路のみ（SSO は IdP 認証でローカルパスワードを持たず、変更画面に誘導すると詰むため除外・R9 同旨）。
 * 例外（通す）を EXEMPT_BASES で持つ: 変更 API 本体 / パスワードポリシー取得（変更画面の inline 検証用）/ me / logout / login。
 * 未認証は AuthenticatedGuard 等に委ね、本ガードは認証済みのみ判定する（req.user 不在は素通し）。
 */
@Injectable()
export class PasswordChangeEnforcementGuard implements CanActivate {
  /**
   * 強制から除外する path（prefix 剥がし後・完全一致 or `base/...` のみ。部分文字列一致はしない）。
   * 判定そのものは enforcement-gate が持つ（MFA 強制と共通・d1016）。
   * - /auth/change-password = 変更を完了させる本線 API
   * - /settings/login/password-policy = 変更画面の inline ポリシー検証に必要（GET。PUT は別途 ADMIN ガードで保護）
   * - /auth/me（状態取得）/ /auth/logout（離脱）/ /auth/login（再ログイン経路）
   * - /auth/interaction = OIDC フェデレーションの handshake（:uid / :uid/login / :uid/session-login / :uid/confirm）。
   *   本ガードは authOrigin を session から読む。interaction の完了は出自を変えない（d955）が、
   *   handshake 自体は変更 API ではないため除外し、interaction controller が password / MFA / MFA 設定の
   *   各確定前に強制変更を検査する（authOrigin 未設定も local として 403 を保証する）。
   */
  private static readonly EXEMPT_BASES = [
    '/auth/change-password',
    '/settings/login/password-policy',
    '/auth/me',
    '/auth/logout',
    '/auth/login',
    '/auth/interaction',
  ];

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // 未認証は本ガードの対象外（認証境界は AuthenticatedGuard 等に委譲）。
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) return true;

    // 強制変更が立っていなければ素通し（大多数のケース）。
    if (!user.mustChangePassword) return true;

    // 素通しは「外部 IdP が認証した」と明示された時だけ（未知の値・空文字・未設定で fail-open しない）。
    // OIDC interaction の完了で出自は変わらない（d955）。MfaEnforcementGuard と同旨。
    if (isExternalIdpSession(req)) return true;

    // 除外 path（変更導線 / ポリシー取得 / me / logout / login）は常に通す。
    if (isExemptPath(req, PasswordChangeEnforcementGuard.EXEMPT_BASES)) return true;

    rejectWithCode('PASSWORD_CHANGE_REQUIRED', 'パスワードの変更が必要です');
  }
}
