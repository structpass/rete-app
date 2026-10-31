/**
 * InviteModule を本物の配線のまま組み立て、受諾の明示記録（d559）が DB の操作ログまで届くことを固定する（d612）。
 *
 * 既存の invite.csv-multipart.spec は provider を差し替えるため、InviteModule の imports から
 * AuditLogsModule が外れても緑のまま通る。その窟を塞ぐため、本 spec は差し替える範囲を
 * - 最深部の DB クライアント（PrismaService）＝記録の終点
 * - SMTP（MailService.send）＝外部送信
 * - 招待の受諾処理だけを行う InviteService.accept
 * に限り、InviteModule の配線・InviteController → AuditRecorderService → AuditLogsRepository →
 * PrismaService は本物を通す。imports 漏れ・exports 漏れ・注入の取り違えは、組立か下の記録で落ちる。
 */
import { Global, Injectable, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { PrismaService } from '../../database/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { InviteModule } from './invite.module';
import { InviteService } from './invite.service';

const ACCEPTED = { accountId: 'account-1', email: 'invitee@example.com' };
const RESPONSE = { success: true, data: { message: 'アカウントを作成しました' } };

const auditLogCreate = jest.fn();
const mailSend = jest.fn();
const accept = jest.fn();

/** 招待の受諾処理だけを置き換える（本 spec の関心は controller → 記録の配線）。 */
@Injectable()
class StubInviteService {
  accept = accept;
}

/** 本物の DB の代わりに差し込む最小の Prisma。AuditLogsRepository（本物）が auditLog.create を呼ぶ。 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useValue: {
        auditLog: { create: (...args: unknown[]) => auditLogCreate(...args) },
      },
    },
  ],
  exports: [PrismaService],
})
class FakeDatabaseModule {}

describe('InviteModule の実配線（受諾の記録が操作ログへ届く・d612）', () => {
  let app: INestApplication;
  let origin: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [InviteModule, FakeDatabaseModule],
    })
      .overrideProvider(InviteService)
      .useValue(new StubInviteService())
      // SMTP の実体はこの spec の対象外（外部へ送らない）。
      .overrideProvider(MailService)
      .useValue({ isConfigured: jest.fn(() => true), send: jest.fn() })
      .compile();

    app = moduleRef.createNestApplication();
    // localhost は ::1 へ解決される環境があるため IPv4 を明示して listen する。
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    accept.mockResolvedValue({ accepted: ACCEPTED, response: RESPONSE });
    auditLogCreate.mockResolvedValue(undefined);
    mailSend.mockResolvedValue(undefined);
  });

  const post = () =>
    fetch(`${origin}/invites/accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'wiring-spec/1.0',
      },
      body: JSON.stringify({ token: 'invite-token', name: 'Invitee', password: 'Whatever#1pass' }),
    });

  it('受諾で、作った当人を actor にした記録が 1 件 DB へ届く', async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESPONSE);

    // 記録は応答を待たせない（fire-and-forget）ため、届くまで待つ。
    const deadline = Date.now() + 2000;
    while (auditLogCreate.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const [{ data }] = auditLogCreate.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({
      actorAccountId: ACCEPTED.accountId,
      actorEmail: ACCEPTED.email,
      actorName: 'Invitee',
      actionType: 'create',
      feature: '招待',
      summary: '招待を受諾してアカウントを作成しました',
      userAgent: 'wiring-spec/1.0',
    });
    // 招待トークンは記録に載せない（§2）。
    expect(JSON.stringify(data)).not.toContain('invite-token');
    expect(mailSend).not.toHaveBeenCalled();
  });
});
