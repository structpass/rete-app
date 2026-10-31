import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { OidcModule } from 'nest-oidc-provider';
import { CalendarEventsModule } from './modules/calendar-events/calendar-events.module';
import { CalendarHolidaysModule } from './modules/calendar-holidays/calendar-holidays.module';
import { HomePermissionsModule } from './modules/home-permissions/home-permissions.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule, PrismaService } from './database';
import { throttleBypassEnabled } from './common/security/throttle-skip';
import { TasksModule } from './modules/tasks';
import { TaskCommentsModule } from './modules/task-comments/task-comments.module';
import { TaskActivitiesModule } from './modules/task-activities/task-activities.module';
import { CategoriesModule } from './modules/categories';
import { buildOidcConfiguration } from './modules/auth/oidc/oidc-config.factory';
import { AuthModule } from './modules/auth';
import { HubModule } from './modules/hub';
import { ChatModule } from './modules/chat/chat.module';
import { FilesModule } from './modules/files';
import { TagsModule } from './modules/tags/tags.module';
import { AttachmentsModule } from './modules/attachments';
import { SettingsModule } from './modules/settings';
import { AnnouncementModule } from './modules/announcement';
import { AnnouncementTagsModule } from './modules/announcement-tags/announcement-tags.module';
import { AccountsModule } from './modules/accounts';
import { MembersModule } from './modules/members';
import { LoginSettingsModule } from './modules/login-settings';
import { AuditLogsModule } from './modules/audit-logs';
import { FavoritesModule } from './modules/favorites';
import { ReferenceIntegrationModule } from './modules/reference-integration';
import { DeskGroupsModule } from './modules/desk-groups';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { UserGroupsModule } from './modules/user-groups/user-groups.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SpacesModule } from './modules/spaces/spaces.module';
import { InviteModule } from './modules/invite/invite.module';
import { MfaModule } from './modules/mfa';
import { MfaEnforcementGuard } from './modules/auth/guards/mfa-enforcement.guard';
import { PasswordChangeEnforcementGuard } from './modules/auth/guards/password-change-enforcement.guard';
import { IpAllowlistGuard } from './modules/auth/guards/ip-allowlist.guard';
import { UserTableColumnWidthsModule } from './modules/user-table-column-widths';
import { AllExceptionsFilter, PrismaExceptionFilter } from './common/filters';
import { AuditLogInterceptor, RequestCacheInterceptor } from './common/interceptors';
import { RequestCacheModule } from './common/request-cache.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // @Cron 駆動のバックグラウンドジョブ（OIDC payload の定期 purge 等）を有効化する。
    ScheduleModule.forRoot(),
    // グローバル: 30 req / 60s で scrape / brute-force 抑制。
    // 高リスク endpoint は後フェーズで controller 側の @Throttle により個別に絞る。
    // この throttle（IP/endpoint burst 防御）は Account 単位の lockout（login-lockout.config）と
    // 独立評価で併走する二層防御の片側。役割分担・「先に当たった方で拒否」は operational-policy §10。
    // cmn-0395: トップレベルの skipIf を読ませるため `{ throttlers: [...], skipIf }` 形式へ変更した
    // （配列形式のままだと throttler.guard が commonOptions = {} にし、トップレベルの skipIf が
    // 読まれない・grounding 8）。skipIf は個別 @Throttle より先に評価されるため、login の 5/60s 等も
    // 素通しできる。判定式は src/common/security/throttle-skip.ts（単体試験で固定）。
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: 60000,
          limit: 30,
        },
      ],
      skipIf: () => throttleBypassEnabled(),
    }),
    DatabaseModule,
    // cmn-0051: リクエストスコープのメモ化キャッシュ（RequestCacheService）をグローバル公開。
    RequestCacheModule,
    // Rete=OIDC IdP。mount path 'oidc' は global prefix 'api/v1' 配下に乗り /api/v1/oidc/* となる。
    // issuer も同 path に揃え discovery（/.well-known/openid-configuration）が一致するよう factory 側で構成。
    OidcModule.forRootAsync({
      imports: [DatabaseModule],
      inject: [PrismaService],
      useFactory: async (prisma: PrismaService) => {
        const { issuer, oidc, proxy } = await buildOidcConfiguration(prisma);
        return { issuer, oidc, path: 'oidc', proxy };
      },
    }),
    AuthModule,
    HubModule,
    ChatModule,
    TasksModule,
    TaskCommentsModule,
    TaskActivitiesModule,
    CategoriesModule,
    FilesModule,
    TagsModule,
    AttachmentsModule,
    SettingsModule,
    AnnouncementModule,
    CalendarEventsModule,
    CalendarHolidaysModule,
    HomePermissionsModule,
    AnnouncementTagsModule,
    AccountsModule,
    MembersModule,
    LoginSettingsModule,
    AuditLogsModule,
    FavoritesModule,
    // hom-0067: reference（struct-pass-reference）の ObjectType 種別一覧の proxy API。
    ReferenceIntegrationModule,
    DeskGroupsModule,
    // CM-2: 組織モデル（依存順: Memberships → Organizations → Projects → Spaces）
    MembershipsModule,
    UserGroupsModule,
    OrganizationsModule,
    ProjectsModule,
    SpacesModule,
    // ST-5: 招待管理（発行/受諾/CSV インポート）
    InviteModule,
    // ST-2-2: MFA/TOTP（設定・有効化・バックアップコード）
    MfaModule,
    // fil-0047: 列幅永続化（テーブル単位・ユーザー毎）
    UserTableColumnWidthsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // set-0025 P1: IP 許可リスト遮断（最前段）。リスト外 IP を認証境界より前で 403 拒否する。
    // ThrottlerGuard より前に置き、許可外アクセスは rate limit カウントを消費させず即遮断する。
    // LoginSettingsService は LoginSettingsModule（imports 済み）が export。
    {
      provide: APP_GUARD,
      useClass: IpAllowlistGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // R8: 全体強制 MFA の遮断ガード（グローバル）。認証の出自が 'local'（未設定を含む）かつ enforced かつ未設定の
    // 認証済リクエストを 403 MFA_SETUP_REQUIRED で遮断する（d955）。MFA セットアップ系 / me / logout / login は内部 EXEMPT で素通し。
    // LoginSettingsService / MfaService は各 Module が export 済み（imports に LoginSettingsModule / MfaModule）。
    {
      provide: APP_GUARD,
      useClass: MfaEnforcementGuard,
    },
    // set-0035: 強制パスワード変更の遮断ガード（グローバル）。mustChangePassword=true かつ出自が 'local'（未設定を含む）の
    // 認証済リクエストを 403 PASSWORD_CHANGE_REQUIRED で遮断する（d955）。変更 API / ポリシー取得 / me / logout / login は
    // 内部 EXEMPT で素通し。req.user の mustChangePassword を読むだけで追加 DB クエリは無い（依存サービス無し）。
    {
      provide: APP_GUARD,
      useClass: PasswordChangeEnforcementGuard,
    },
    // §4 エラー一元化: Prisma エラーは PrismaExceptionFilter で HttpException へ変換し、
    // 最終的に AllExceptionsFilter が統一レスポンス形状に整える。モジュール内 try/catch は書かない。
    // 登録順序に注意: Nest は global filter 配列を reverse してから最初に一致した filter を採用する
    // (selectExceptionFilterMetadata の find) ため、catch-all（AllExceptionsFilter）を先に登録し、
    // 具体的な PrismaExceptionFilter を後に登録することで reverse 後に Prisma 側が先に評価される
    // （逆順にすると catch-all が全例外を先取りし PrismaExceptionFilter が絶対に発火しない・dsk-0304/dsk-0305 UI Gate 実機検証で発見）。
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
    // cmn-0051: リクエストスコープのメモ化キャッシュ用 interceptor。以降の interceptor / Controller /
    // Service 実行全体を包むよう最初に登録する（先頭登録＝最も外側で pre-controller が走る）。
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestCacheInterceptor,
    },
    // H5: 横断 interceptor。認証済みの mutating request（POST/PATCH/PUT/DELETE）を 2xx 完了時に記録。
    // auth login/logout route は AuthController で明示記録するため除外済み（二重記録なし）。
    // AuditRecorderService は AuditLogsModule（imports 済み）経由で注入可能。
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
  ],
})
export class AppModule {}
