import { Module } from '@nestjs/common';
import { InviteController } from './invite.controller';
import { InviteService } from './invite.service';
import { InviteRepository } from './repositories/invite.repository';
import { MailModule } from '../../common/mail/mail.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

/**
 * 招待管理（Settings ST-5）。
 * - 管理系: ADMIN による発行・一覧・再送・削除・CSV インポート。
 * - 公開: 受諾エンドポイント（throttle 付き・guard 無し）。
 * - メール送信は MailModule 経由（SMTP 未設定なら graceful degradation で 503）。
 * - AuditLogsModule: 受諾（認証前で横断記録の対象外）の明示記録で AuditRecorderService を使う（d559）。
 */
@Module({
  // この 2 つを外すと受諾の記録（AuditRecorderService）か招待メール（MailService）が解決できず起動時に落ちる。
  // 配線そのものは invite.module.wiring.spec（本物の配線で組む結合試験）が守る（d612）。
  imports: [MailModule, AuditLogsModule],
  controllers: [InviteController],
  providers: [InviteService, InviteRepository],
})
export class InviteModule {}
