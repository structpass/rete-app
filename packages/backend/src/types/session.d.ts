import 'express-session';

/**
 * express-session の SessionData 拡張（認証境界の補助状態）。
 *
 * - authOrigin: 認証の出自（d955）。'local'=Rete 自身の資格情報でログインした / 'external-idp'=外部 IdP が
 *   認証した（現在は未実装の受け口）。MFA・パスワード変更の強制は 'local' にだけ掛ける。
 *   外部アプリへ認証を渡す（OIDC interaction の完了）ことは出自を変えない＝後から MFA 必須にしても
 *   同じセッションへ適用される。未設定（旧セッション）は 'local' 相当として強制対象に含める。
 * - authMethod: 旧来の「ログイン経路の印」。'sso' は OIDC interaction を完了した印として書かれていたが、
 *   その意味は oidcSsoAt が持つ。強制判定には使わない（互換のため残す・d955）。
 * - pendingMfa*: パスワード検証は通ったが TOTP 未確認の中間状態（R7・2 段階ログイン）。
 *   full passport login は行わず、accountとOIDC uidを退避し、通常またはOIDCのMFA endpointを待つ。
 *   route内上限に加え、失敗はAccount単位のDB lockoutにも加算する。
 */
declare module 'express-session' {
  interface SessionData {
    authOrigin?: 'local' | 'external-idp';
    /** @deprecated 出自は authOrigin で表す（d955）。強制判定に使わない。 */
    authMethod?: 'local' | 'sso';
    /** OIDC interaction を完了した時刻。Rete の認証出自は変えない（d955）。 */
    oidcSsoAt?: number;
    pendingMfaAccountId?: string;
    pendingMfaAttempts?: number;
    pendingMfaInteractionUid?: string;
    pendingOidcAuthTime?: number;
    pendingOidcCredentialVersion?: string;
    /** MFAを通過したローカル認証sessionの証跡。 */
    mfaVerifiedAt?: number;
  }
}
