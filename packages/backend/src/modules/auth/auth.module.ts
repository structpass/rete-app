import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LocalStrategy } from './local.strategy';
import { SessionSerializer } from './session.serializer';
import { AccountRepository } from './repositories/account.repository';
import { InteractionController } from './oidc/interaction.controller';
import { OidcPurgeService } from './oidc/oidc-purge.service';
import { OidcSessionLogoutService } from './oidc/oidc-session-logout.service';
import { LOGIN_LOCKOUT_CONFIG, resolveLoginLockoutConfig } from './login-lockout.config';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { MfaModule } from '../mfa';
import { LoginSettingsModule } from '../login-settings';

@Module({
  // session: true で passport が serializeUser/deserializeUser を express-session に保存する。
  // AuditLogsModule: AuthController が login/logout の明示記録で AuditRecorderService を使う（H5）。
  // MfaModule / LoginSettingsModule: AuthController の 2 段階ログイン（R7）と MFA 全体強制判定（R8）で MfaService /
  // LoginSettingsService を使う（両 Module が export 済み）。
  imports: [
    PassportModule.register({ session: true }),
    AuditLogsModule,
    MfaModule,
    LoginSettingsModule,
  ],
  controllers: [AuthController, InteractionController],
  providers: [
    AuthService,
    AccountRepository,
    LocalStrategy,
    SessionSerializer,
    OidcPurgeService,
    // d1269: logout で oidc-provider の SSO セッションも終わらせる（署名検証つき）。
    OidcSessionLogoutService,
    // H6: ログイン試行ロックアウトの閾値（env 上書き可・既定 5 回 / 15 分）。
    { provide: LOGIN_LOCKOUT_CONFIG, useFactory: () => resolveLoginLockoutConfig() },
  ],
  exports: [AuthService],
})
export class AuthModule {}
