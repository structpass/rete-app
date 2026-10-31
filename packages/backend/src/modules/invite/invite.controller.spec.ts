import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { InviteController } from './invite.controller';
import type { InviteService } from './invite.service';
import type { AuditRecorderService } from '../audit-logs/audit-recorder.service';

/**
 * InviteController 最小ユニットテスト。
 * NestJS DI/HTTP を使わず controller インスタンスを直接呼ぶ（ガード/デコレーターはスキップ）。
 * 対象: コントローラー固有の早期バリデーション（file null チェック）のみ。
 * ルーティング/ガード/throttle の結合テストは E2E に委譲。
 */

const mockService = {
  issue: jest.fn(),
  findAll: jest.fn(),
  resend: jest.fn(),
  remove: jest.fn(),
  getTemplateCsv: jest.fn(),
  importCsv: jest.fn(),
  accept: jest.fn(),
  getMailStatus: jest.fn(),
} as unknown as InviteService;

describe('InviteController', () => {
  let controller: InviteController;
  // record は解決済みの Promise を返す（本 spec は記録の中身だけを見る。記録部品の挙動は別 spec）。
  const mockRecorder = { record: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    jest.clearAllMocks();
    (mockRecorder.record as jest.Mock).mockResolvedValue(undefined);
    controller = new InviteController(mockService, mockRecorder as unknown as AuditRecorderService);
  });

  // -----------------------------------------------------------------------
  // importCsv — file null チェック
  // -----------------------------------------------------------------------
  describe('importCsv', () => {
    const defaultBody = { spaceId: 'space-1' };

    it('file が undefined のとき BadRequestException を投げる', () => {
      expect(() =>
        controller.importCsv(undefined as unknown as Express.Multer.File, defaultBody, 'admin-1'),
      ).toThrow(BadRequestException);
    });

    it('file が undefined のとき「CSV ファイルを選択してください」メッセージで投げる', () => {
      expect(() =>
        controller.importCsv(undefined as unknown as Express.Multer.File, defaultBody, 'admin-1'),
      ).toThrow('CSV ファイルを選択してください');
    });

    it('file が undefined のときサービスを呼ばない', () => {
      try {
        controller.importCsv(undefined as unknown as Express.Multer.File, defaultBody, 'admin-1');
      } catch {
        // expected
      }
      expect(mockService.importCsv).not.toHaveBeenCalled();
    });

    it('file が存在するときサービスへ Space を渡す', () => {
      const fakeFile = { buffer: Buffer.from('test') } as Express.Multer.File;
      mockService.importCsv = jest.fn().mockResolvedValue({ success: true, data: {} });

      controller.importCsv(fakeFile, defaultBody, 'admin-1');

      expect(mockService.importCsv).toHaveBeenCalledWith(fakeFile.buffer, 'space-1', 'admin-1');
    });
  });

  it('issue は Space をサービスへ渡す', () => {
    mockService.issue = jest.fn().mockResolvedValue({ success: true, data: {} });

    controller.issue({ email: 'new@example.com', spaceId: 'space-1' } as never, 'admin-1');

    expect(mockService.issue).toHaveBeenCalledWith('new@example.com', 'space-1', 'admin-1');
  });

  // d559: 受諾は認証前の経路で横断の操作ログ interceptor の対象外。作成されたアカウントを actor に
  // 明示記録されること（誰がいつどの IP から作ったか）を、controller の境界で確かめる。
  describe('accept — 受諾成立の明示記録', () => {
    const request = {
      method: 'POST',
      path: '/api/v1/invites/accept',
      ip: '203.0.113.10',
      headers: { 'user-agent': 'jest-agent' },
    } as unknown as Request;

    it('受諾が成立したら、作った当人を actor にして記録する', async () => {
      mockService.accept = jest.fn().mockResolvedValue({
        accepted: { accountId: 'acc-1', email: 'new@example.com' },
        response: { success: true, data: { message: 'アカウントを作成しました' } },
      });

      const result = await controller.accept(
        { token: 'valid-token', name: '新メンバー', password: 'Password1!' } as never,
        request,
      );

      expect(mockService.accept).toHaveBeenCalledWith('valid-token', '新メンバー', 'Password1!');
      expect(result).toEqual({
        success: true,
        data: { message: 'アカウントを作成しました' },
      });
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorAccountId: 'acc-1',
          actorEmail: 'new@example.com',
          actionType: 'create',
          feature: '招待',
        }),
      );
      const input = mockRecorder.record.mock.calls[0][0] as Record<string, unknown>;
      expect(input.ipAddress).toBe('203.0.113.10');
      expect(input.userAgent).toBe('jest-agent');
      // トークンは記録に載せない（token は §2 で log に出さない）。
      expect(JSON.stringify(input)).not.toContain('valid-token');
    });

    it('受諾が失敗したら記録しない（4xx は監査に載せない）', async () => {
      mockService.accept = jest
        .fn()
        .mockRejectedValue(new BadRequestException('招待が無効か期限切れです'));

      await expect(
        controller.accept(
          { token: 'bad', name: '新メンバー', password: 'Password1!' } as never,
          request,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockRecorder.record).not.toHaveBeenCalled();
    });

    it('記録が失敗しても受諾の応答は返る（止めない側）', async () => {
      mockRecorder.record.mockRejectedValueOnce(new Error('db down'));
      mockService.accept = jest.fn().mockResolvedValue({
        accepted: { accountId: 'acc-2', email: 'other@example.com' },
        response: { success: true, data: { message: 'アカウントを作成しました' } },
      });

      const result = await controller.accept(
        { token: 'valid-token', name: '新メンバー', password: 'Password1!' } as never,
        request,
      );
      expect(result).toEqual({ success: true, data: { message: 'アカウントを作成しました' } });
    });
  });
});
