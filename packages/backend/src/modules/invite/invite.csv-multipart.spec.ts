/**
 * 招待 CSV 取り込み（POST /invites/csv/import）の multipart 制限と拒否文言（v2-209）。
 *
 * この経路は v2-191 の日本語化フィルタが未配線で、英語の 'File too large' がそのまま画面へ出ていた。
 * controller を実 Express へ載せて本物の multer / FileInterceptor を通す（メソッド直呼びでは multipart 層が
 * 素通りするため、配線の欠落を検出できない）。
 *
 * 固定する形:
 * - 1MB 超は 413 で、文言が『ファイルサイズが上限（1 MB）を超えています』（実値は招待経路の 1 MB）
 * - 回数制限（429）も日本語
 * - file が無い時は既存の日本語 400
 * - 成功は 200 で service の結果をそのまま返す
 * - DB 例外はグローバルの PrismaExceptionFilter が受けて 409（メソッド単位フィルタで影落ちしない）
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { Role } from '@rete/shared';
import { AllExceptionsFilter, PrismaExceptionFilter } from '../../common/filters';
import { InviteController } from './invite.controller';
import { InviteService } from './invite.service';
import { AuditRecorderService } from '../audit-logs/audit-recorder.service';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/auth.service';

const ACTOR = { id: 'account-1', role: Role.ADMIN } as unknown as AuthenticatedUser;
const IMPORTED = { success: true, data: { issued: 1, skipped: 0, skippedDetails: [] } };
/** 招待 CSV の上限（invite.controller.ts の INVITE_CSV_MAX_BYTES と同値）。 */
const INVITE_CSV_MAX_BYTES = 1024 * 1024;

const importCsv = jest.fn();

/** multipart のパート（filename があれば file パート・無ければ非ファイルフィールド）。 */
interface Part {
  name: string;
  value: string;
  filename?: string;
}

describe('InviteController CSV 取り込みの multipart 制限', () => {
  let app: INestApplication;
  let origin: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InviteController],
      providers: [
        { provide: InviteService, useValue: { importCsv } },
        // 受諾の明示記録（d559）は controller の依存。本 spec の対象外なので、記録しない置き換えを差す。
        {
          provide: AuditRecorderService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        // 本番（app.module）と同じ順序でグローバル filter を登録する。
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_FILTER, useClass: PrismaExceptionFilter },
      ],
    })
      // 認証は本 spec の対象外。passport を通さず req.user を直接与える。
      .overrideGuard(AuthenticatedGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = ACTOR;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    importCsv.mockReset();
    importCsv.mockResolvedValue(IMPORTED);
  });

  const post = (parts: Part[]) => {
    const form = new FormData();
    for (const part of parts) {
      if (part.filename) {
        form.append(part.name, new Blob([part.value], { type: 'text/csv' }), part.filename);
      } else {
        form.append(part.name, part.value);
      }
    }
    return fetch(`${origin}/invites/csv/import`, { method: 'POST', body: form });
  };

  it('1MB 超の CSV は 413 で、上限の実値（1 MB）を日本語で案内する（v2-209）', async () => {
    const res = await post([
      {
        name: 'file',
        value: 'x'.repeat(INVITE_CSV_MAX_BYTES + 1),
        filename: 'invites.csv',
      },
      { name: 'spaceId', value: 'space-1' },
    ]);

    expect(res.status).toBe(413);
    // 英語の 'File too large' がそのまま出ていた退行を、応答本文ごと固定して検出する。
    expect(await res.json()).toEqual({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'ファイルサイズが上限（1 MB）を超えています',
      },
    });
    expect(importCsv).not.toHaveBeenCalled();
  });

  it('回数制限（429）も日本語で案内する（フレームワーク名を画面へ出さない）', async () => {
    importCsv.mockRejectedValue(new ThrottlerException());

    const res = await post([
      { name: 'file', value: 'email\r\na@example.com\r\n', filename: 'invites.csv' },
      { name: 'spaceId', value: 'space-1' },
    ]);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      success: false,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'アップロードの回数が多すぎます。少し待ってからお試しください',
      },
    });
  });

  it('file が無い時は既存の日本語 400 のまま（業務エラーは訳の対象外）', async () => {
    const res = await post([{ name: 'spaceId', value: 'space-1' }]);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'CSV ファイルを選択してください' },
    });
    expect(importCsv).not.toHaveBeenCalled();
  });

  it('上限内の CSV は 200 で service の結果を返す（フィルタが成功経路を壊さない）', async () => {
    const res = await post([
      { name: 'file', value: 'email\r\na@example.com\r\n', filename: 'invites.csv' },
      { name: 'spaceId', value: 'space-1' },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(IMPORTED);
    expect(importCsv).toHaveBeenCalledTimes(1);
    expect(importCsv).toHaveBeenCalledWith(expect.any(Buffer), 'space-1', ACTOR.id);
  });

  it('DB の一意制約違反はグローバルの PrismaExceptionFilter が受けて 409 を返す（影落ちしない）', async () => {
    importCsv.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'spec',
        meta: { target: ['email'] },
      }),
    );

    const res = await post([
      { name: 'file', value: 'email\r\na@example.com\r\n', filename: 'invites.csv' },
      { name: 'spaceId', value: 'space-1' },
    ]);

    // UploadErrorFilter を @Catch()（全例外）にすると、この経路だけ 500 INTERNAL_ERROR へ化ける。
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: 'CONFLICT', message: '指定された値は既に使用されています' },
    });
  });
});
