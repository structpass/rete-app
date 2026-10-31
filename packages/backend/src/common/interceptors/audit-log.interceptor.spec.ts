import type { ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AuditLogInterceptor } from './audit-log.interceptor';

// ---- モック ----------------------------------------------------------------

const mockRecorder = { record: jest.fn() };

/** テスト用 ExecutionContext を生成する。 */
function makeContext(
  method: string,
  path: string,
  user?: Record<string, unknown> | null,
): ExecutionContext {
  const req = {
    method,
    path,
    user: user !== undefined ? user : { id: 'acc-1', name: '山田太郎', email: 'y@example.com' },
    headers: { 'user-agent': 'jest-test' },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };

  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
    // Reflector は interceptor 内で直接使われるため context に注入済みのものを使う。
    // ここではモックの reflector を interceptor コンストラクタで渡す。
  } as unknown as ExecutionContext;
}

/** テスト用 CallHandler を生成する。 */
function makeHandler(value: unknown = { success: true }) {
  return { handle: () => of(value) };
}

function makeErrorHandler(err = new Error('Not Found')) {
  return { handle: () => throwError(() => err) };
}

// ---- テスト ----------------------------------------------------------------

describe('AuditLogInterceptor', () => {
  let interceptor: AuditLogInterceptor;

  beforeEach(() => {
    mockRecorder.record.mockResolvedValue(undefined);
    interceptor = new AuditLogInterceptor(mockRecorder as never);
  });

  describe('記録スキップ条件', () => {
    it('GET は記録しない', async () => {
      const ctx = makeContext('GET', '/api/v1/chat/messages');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).not.toHaveBeenCalled();
    });

    it('GET でも持ち出し（/members/export）だけは read として記録する（d534）', async () => {
      const ctx = makeContext('GET', '/api/v1/members/export');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'read',
          feature: 'メンバー',
          summary: 'メンバー を出力',
          actorAccountId: 'acc-1',
          ipAddress: '127.0.0.1',
          userAgent: 'jest-test',
        }),
      );
    });

    it('持ち出しの記録は CSV の中身を渡さない（一覧の export は元々本文を持たない）', async () => {
      const ctx = makeContext('GET', '/api/v1/members/export');
      await lastValueFrom(
        interceptor.intercept(
          ctx,
          makeHandler('表示名,メールアドレス\r\n山田,taro@rete.local\r\n'),
        ),
      );
      const input = mockRecorder.record.mock.calls[0][0];
      expect(JSON.stringify(input)).not.toContain('taro@rete.local');
    });

    it('GET の export でも未認証なら記録しない', async () => {
      const ctx = makeContext('GET', '/api/v1/members/export', null);
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).not.toHaveBeenCalled();
    });

    it('GET の export でもハンドラが例外を throw したら記録しない', async () => {
      const ctx = makeContext('GET', '/api/v1/members/export');
      await expect(lastValueFrom(interceptor.intercept(ctx, makeErrorHandler()))).rejects.toThrow(
        'Not Found',
      );
      expect(mockRecorder.record).not.toHaveBeenCalled();
    });

    it('req.user が存在しない（未認証）は記録しない', async () => {
      const ctx = makeContext('POST', '/api/v1/chat/messages', null);
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).not.toHaveBeenCalled();
    });

    it('POST /auth/login は記録しない（二重記録回避）', async () => {
      const ctx = makeContext('POST', '/api/v1/auth/login');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).not.toHaveBeenCalled();
    });

    it('POST /auth/logout は記録しない（二重記録回避）', async () => {
      const ctx = makeContext('POST', '/api/v1/auth/logout');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).not.toHaveBeenCalled();
    });

    it('ハンドラが例外を throw した場合（4xx/5xx）は記録しない', async () => {
      const ctx = makeContext('POST', '/api/v1/chat/messages');
      // observable が error すると tap は発火しない。
      await expect(lastValueFrom(interceptor.intercept(ctx, makeErrorHandler()))).rejects.toThrow(
        'Not Found',
      );
      expect(mockRecorder.record).not.toHaveBeenCalled();
    });
  });

  describe('記録実施条件', () => {
    it('POST → actionType=create で recorder.record を呼ぶこと', async () => {
      const ctx = makeContext('POST', '/api/v1/chat/messages');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'create' }),
      );
    });

    it('PATCH → actionType=update で recorder.record を呼ぶこと', async () => {
      const ctx = makeContext('PATCH', '/api/v1/tasks/123');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'update' }),
      );
    });

    it('PUT → actionType=update で recorder.record を呼ぶこと', async () => {
      const ctx = makeContext('PUT', '/api/v1/tasks/123');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'update' }),
      );
    });

    it('DELETE → actionType=delete で recorder.record を呼ぶこと', async () => {
      const ctx = makeContext('DELETE', '/api/v1/tasks/123');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'delete' }),
      );
    });

    it('path から機能を導出し日本語ラベルへ変換する（/api/v1/chat/… → チャット）', async () => {
      const ctx = makeContext('POST', '/api/v1/chat/messages');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ feature: 'チャット' }),
      );
    });

    it('path 導出時に日本語化する（/api/v1/tasks/… → タスク）', async () => {
      const ctx = makeContext('POST', '/api/v1/tasks/123');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ feature: 'タスク' }),
      );
    });

    it('path セグメント invites は「招待」になる', async () => {
      const ctx = makeContext('POST', '/api/v1/invites');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ feature: '招待' }),
      );
    });

    // v2-232: 管理グループの grant 操作は横断行も日本語で残す。英語キーのままだと一覧の機能名が
    // user-groups と出て、内容も「user-groups を作成」となり何の操作か読めない。
    it('path セグメント user-groups は「管理グループ」になる', async () => {
      const ctx = makeContext(
        'POST',
        '/api/v1/user-groups/8fabe047-ef19-491c-b9b3-e03f95820d06/grants',
      );
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ feature: '管理グループ', summary: '管理グループ を作成' }),
      );
    });

    it('actor スナップショット（id/name/email）を渡すこと', async () => {
      const ctx = makeContext('POST', '/api/v1/chat', {
        id: 'acc-x',
        name: '田中',
        email: 'tanaka@example.com',
      });
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorAccountId: 'acc-x',
          actorName: '田中',
          actorEmail: 'tanaka@example.com',
        }),
      );
    });

    it('systemId=null / systemName=AUDIT_RETE_SYSTEM_NAME をセットすること', async () => {
      const ctx = makeContext('POST', '/api/v1/chat');
      await lastValueFrom(interceptor.intercept(ctx, makeHandler()));
      expect(mockRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({ systemId: null, systemName: '共通操作' }),
      );
    });
  });

  describe('best-effort（記録失敗がリクエストを壊さない）', () => {
    it('recorder.record が reject しても intercept は例外を投げない', async () => {
      mockRecorder.record.mockRejectedValue(new Error('DB failed'));
      const ctx = makeContext('POST', '/api/v1/chat');
      // observable は正常に値を emit する（記録失敗は fire-and-forget で吸収）。
      await expect(lastValueFrom(interceptor.intercept(ctx, makeHandler()))).resolves.toEqual({
        success: true,
      });
    });
  });
});
