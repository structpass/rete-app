import { PrismaExceptionFilter } from './prisma-exception.filter';
import type { ArgumentsHost } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { withUniqueConflictMessage } from './unique-conflict-context';

describe('PrismaExceptionFilter', () => {
  let filter: PrismaExceptionFilter;
  let mockResponse: { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new PrismaExceptionFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      // 503（P2028 / P2024）で Retry-After を載せるため、委譲先が setHeader を呼ぶ。
      setHeader: jest.fn(),
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => ({}),
      }),
    } as unknown as ArgumentsHost;
  });

  it.each([
    'メールアドレス「taken@rete.local」は既に使用されています',
    'この相手との DM は既に存在します',
  ])('サーバー指定の案内文を409の統一応答へ載せる: %s', async (message) => {
    const error = new Prisma.PrismaClientKnownRequestError('private database details', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['private_constraint'] },
    });
    await withUniqueConflictMessage(() => Promise.reject(error), message).catch(
      (caught: unknown) => {
        expect(caught).toBe(error);
        filter.catch(error, mockHost);
      },
    );
    expect(mockResponse.status).toHaveBeenCalledWith(409);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'CONFLICT', message },
    });
  });

  it('他のエラーを同一のまま通し、P2002以外の写像を上書きしない', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('foreign key', {
      code: 'P2003',
      clientVersion: 'test',
    });
    await expect(withUniqueConflictMessage(() => Promise.reject(error), '使わない文')).rejects.toBe(
      error,
    );
    filter.catch(error, mockHost);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'CONFLICT', message: '関連データが存在するため削除できません' },
    });
    const unknown = new Error('unexpected');
    await expect(
      withUniqueConflictMessage(() => Promise.reject(unknown), '使わない文'),
    ).rejects.toBe(unknown);
  });

  it('成功値はそのまま返し、案内文は別の例外に漏れない', async () => {
    const value = { id: 'created' };
    await expect(withUniqueConflictMessage(() => Promise.resolve(value), '案内文')).resolves.toBe(
      value,
    );
    const error = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    await expect(withUniqueConflictMessage(() => Promise.reject(error), '個別の文')).rejects.toBe(
      error,
    );
    filter.catch(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
      mockHost,
    );
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'CONFLICT', message: '指定された値は既に使用されています' },
    });
  });

  it('P2002（一意制約違反, target あり）を汎用メッセージで409 CONFLICT に変換し、target をレスポンスに含めないこと', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.2.0',
      meta: { target: ['title'] },
    });

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'CONFLICT',
        // 内部名（target='title'）漏洩防止のため汎用メッセージ。target はサーバーログのみ。
        message: '指定された値は既に使用されています',
      },
    });
    // クライアントレスポンスに DB カラム/制約名が漏れていないこと
    const payload = mockResponse.json.mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain('title');
  });

  it('P2002（target なし）を汎用メッセージで409 CONFLICT に変換すること', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.2.0',
    });

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'CONFLICT',
        message: '指定された値は既に使用されています',
      },
    });
  });

  it('P2003（外部キー制約違反）を409 CONFLICT に変換すること', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
      code: 'P2003',
      clientVersion: '6.2.0',
    });

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'CONFLICT',
        message: '関連データが存在するため削除できません',
      },
    });
  });

  it('P2025（レコード未検出）を404 NOT_FOUND に変換すること', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: '6.2.0',
    });

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: '対象のレコードが見つかりません',
      },
    });
  });

  it('P2034（リトライ上限まで解けなかった write conflict）を 409 WRITE_CONFLICT に変換すること', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034',
      clientVersion: '6.2.0',
    });

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    // 一意制約違反由来の 409（CONFLICT）と code で区別できること＝画面がメッセージを出し分けられる。
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'WRITE_CONFLICT',
        message: '他の操作と競合しました。もう一度お試しください',
      },
    });
    expect(mockResponse.setHeader).not.toHaveBeenCalled();
  });

  it.each([
    ['P2028（トランザクション timeout 超過）', 'P2028'],
    ['P2024（接続プール待ち超過）', 'P2024'],
  ])('%s を 503 SERVICE_UNAVAILABLE + Retry-After に変換すること', (_label, code) => {
    const exception = new Prisma.PrismaClientKnownRequestError('timeout', {
      code,
      clientVersion: '6.2.0',
    });

    filter.catch(exception, mockHost);

    // 汎用の INTERNAL_ERROR へ落ちず、一時的な混雑として識別できること。
    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: '現在混み合っています。しばらくしてからもう一度お試しください',
      },
    });
    expect(mockResponse.setHeader).toHaveBeenCalledWith('Retry-After', '5');
  });

  it('未対応の Prisma コードは AllExceptionsFilter の汎用処理に委譲されること', () => {
    const exception = new Prisma.PrismaClientKnownRequestError('Unknown Prisma error', {
      code: 'P2016',
      clientVersion: '6.2.0',
    });

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  });
});
