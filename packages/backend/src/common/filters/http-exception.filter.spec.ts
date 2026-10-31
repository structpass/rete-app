import { AllExceptionsFilter } from './http-exception.filter';
import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let mockResponse: { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
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
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [405, 'BAD_REQUEST'],
    [408, 'BAD_REQUEST'],
    [409, 'CONFLICT'],
    [410, 'BAD_REQUEST'],
    [413, 'BAD_REQUEST'],
    [415, 'BAD_REQUEST'],
    [422, 'VALIDATION_ERROR'],
    [429, 'TOO_MANY_REQUESTS'],
    [451, 'BAD_REQUEST'],
    [499, 'BAD_REQUEST'],
  ])('code 指定のない %i は %s を返し、status と message を保つ', (status, code) => {
    for (const response of ['入力を確認してください', { message: '入力を確認してください' }]) {
      filter.catch(new HttpException(response, status), mockHost);

      expect(mockResponse.status).toHaveBeenLastCalledWith(status);
      expect(mockResponse.json).toHaveBeenLastCalledWith({
        success: false,
        error: { code, message: '入力を確認してください' },
      });
    }
  });

  it('パスワードポリシー違反の 422 は検証エラーとして返す', () => {
    filter.catch(new UnprocessableEntityException('パスワードが短すぎます'), mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(422);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'パスワードが短すぎます' },
    });
  });

  it('400 の配列 message は既存の検証エラーと details を保つ', () => {
    filter.catch(new BadRequestException(['email must be an email']), mockHost);

    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: { validationErrors: ['email must be an email'] },
      },
    });
  });

  it('明示 code は検証形式や既定値と同じ文字列でも優先する', () => {
    filter.catch(
      new HttpException({ code: 'INTERNAL_ERROR', message: ['x'] }, HttpStatus.BAD_REQUEST),
      mockHost,
    );

    expect(mockResponse.json.mock.calls[0][0].error.code).toBe('INTERNAL_ERROR');
  });

  it('429 を TOO_MANY_REQUESTS に変換する（throttler 由来のように code 指定が無くても）', () => {
    const exception = new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(mockResponse.json.mock.calls[0][0].error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('429 で code を明示した HttpException はその code とメッセージを保つ（ロックアウト）', () => {
    const exception = new HttpException(
      {
        code: 'TOO_MANY_REQUESTS',
        message: 'ログイン試行が制限を超えました。しばらく経ってから再度お試しください',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );

    filter.catch(exception, mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'ログイン試行が制限を超えました。しばらく経ってから再度お試しください',
      },
    });
  });

  it('明示 code は status 由来の導出に上書きされない（409 の CONFLICT / WRITE_CONFLICT を出し分けられる）', () => {
    const exception = new HttpException(
      { code: 'WRITE_CONFLICT', message: '他の操作と競合しました。もう一度お試しください' },
      HttpStatus.CONFLICT,
    );

    filter.catch(exception, mockHost);

    expect(mockResponse.json.mock.calls[0][0].error.code).toBe('WRITE_CONFLICT');
  });

  it('code 指定が無い 409 は従来どおり CONFLICT に導出される', () => {
    filter.catch(new HttpException('conflict', HttpStatus.CONFLICT), mockHost);

    expect(mockResponse.json.mock.calls[0][0].error.code).toBe('CONFLICT');
  });

  // 明示 code 優先化（cmn-0235）で最も影響が広いのがこの 2 経路。従来は status 由来の
  // UNAUTHORIZED / FORBIDDEN に上書きされていた。導出ブロックを触った時に気付けるよう応答 code を固定する
  // （guard / service 側 spec は throw された例外の shape しか見ておらず、filter 通過後は誰も見ていなかった）。
  it.each([
    ['MFA_REQUIRED', HttpStatus.UNAUTHORIZED],
    ['MFA_INVALID_CODE', HttpStatus.UNAUTHORIZED],
    ['MFA_SETUP_REQUIRED', HttpStatus.FORBIDDEN],
    ['PASSWORD_CHANGE_REQUIRED', HttpStatus.FORBIDDEN],
    ['IP_NOT_ALLOWED', HttpStatus.FORBIDDEN],
  ])('%s は status 由来の導出に潰されず応答 code として残る', (code, status) => {
    filter.catch(new HttpException({ code, message: 'x' }, status), mockHost);

    expect(mockResponse.json.mock.calls[0][0].error.code).toBe(code);
  });

  it('code 指定が無い 503（MFA 暗号鍵未設定 / SMTP 未設定）も SERVICE_UNAVAILABLE に導出される', () => {
    filter.catch(new HttpException('unavailable', HttpStatus.SERVICE_UNAVAILABLE), mockHost);

    // INTERNAL_ERROR へ落ちると operational-policy §1 の code 体系表と実体がずれる。
    expect(mockResponse.json.mock.calls[0][0].error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('retryAfter を持つ例外は Retry-After ヘッダを載せ、body には出さない', () => {
    const exception = new HttpException(
      { code: 'SERVICE_UNAVAILABLE', message: '現在混み合っています', retryAfter: 5 },
      HttpStatus.SERVICE_UNAVAILABLE,
    );

    filter.catch(exception, mockHost);

    expect(mockResponse.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: '現在混み合っています' },
    });
  });

  it('retryAfter を持たない例外では Retry-After を載せない', () => {
    filter.catch(new HttpException('boom', HttpStatus.BAD_REQUEST), mockHost);

    expect(mockResponse.setHeader).not.toHaveBeenCalled();
  });

  it('503 以外の例外が retryAfter を持っていても Retry-After は載せない（4xx への漏れ止め）', () => {
    filter.catch(
      new HttpException(
        { code: 'TOO_MANY_REQUESTS', message: 'x', retryAfter: 600 },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
      mockHost,
    );

    expect(mockResponse.setHeader).not.toHaveBeenCalled();
  });

  describe('観測性（H9 / 5xx の構造化 error ログ）', () => {
    const hostWith = (method: string, url: string): ArgumentsHost =>
      ({
        switchToHttp: () => ({
          getResponse: () => mockResponse,
          getRequest: () => ({ method, url }),
        }),
      }) as unknown as ArgumentsHost;

    const spyLoggerError = () =>
      jest
        .spyOn((filter as unknown as { logger: { error: jest.Mock } }).logger, 'error')
        .mockImplementation(() => undefined);

    it('5xx（INTERNAL_ERROR）は method / path / status 付きで error ログを出す', () => {
      const errorSpy = spyLoggerError();

      filter.catch(
        new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR),
        hostWith('POST', '/api/v1/things'),
      );

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const msg = errorSpy.mock.calls[0][0] as string;
      expect(msg).toContain('POST /api/v1/things');
      expect(msg).toContain('500');
    });

    it('非 HttpException（未処理例外）も 500 として error ログを出す', () => {
      const errorSpy = spyLoggerError();

      filter.catch(new Error('unexpected'), hostWith('GET', '/api/v1/boom'));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    });

    it('request.url の CR/LF を除去してログ行偽装を防ぐ（log injection / CWE-117）', () => {
      const errorSpy = spyLoggerError();

      filter.catch(
        new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR),
        hostWith('GET', '/api/v1/x\r\nFAKE injected log line'),
      );

      const msg = errorSpy.mock.calls[0][0] as string;
      expect(msg).not.toContain('\n');
      expect(msg).not.toContain('\r');
    });

    it('4xx（UNAUTHORIZED）は想定内のため error ログを出さない（ノイズ回避）', () => {
      const errorSpy = spyLoggerError();

      filter.catch(
        new HttpException('no', HttpStatus.UNAUTHORIZED),
        hostWith('GET', '/api/v1/secret'),
      );

      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('404 は 1 行 warn で残す（method / path / code のみ・fil-0157）', () => {
      const warnSpy = jest
        .spyOn((filter as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = spyLoggerError();

      filter.catch(
        new NotFoundException('対象が見つかりません'),
        hostWith('GET', '/api/v1/files/abc'),
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).toContain('GET /api/v1/files/abc');
      expect(msg).toContain('404');
      expect(msg).toContain('NOT_FOUND');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('404 warn は query 文字列を落として残す（存在探索の対象 id を出さない）', () => {
      const warnSpy = jest
        .spyOn((filter as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);

      filter.catch(
        new NotFoundException('対象が見つかりません'),
        hostWith('GET', '/api/v1/folders/abc/tree?spaceId=secret-id'),
      );

      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).toContain('GET /api/v1/folders/abc/tree');
      expect(msg).not.toContain('secret-id');
      expect(msg).not.toContain('?');
    });

    it('404 の request.url も CR/LF を除去してログ行偽装を防ぐ', () => {
      const warnSpy = jest
        .spyOn((filter as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);

      filter.catch(
        new NotFoundException('対象が見つかりません'),
        hostWith('GET', '/api/v1/x\r\nFAKE injected log line'),
      );

      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).not.toContain('\n');
      expect(msg).not.toContain('\r');
    });

    it('400 は 4xx 想定内のため warn も error も出さない（fil-0157 の範囲は 404 のみ）', () => {
      const warnSpy = jest
        .spyOn((filter as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = spyLoggerError();

      filter.catch(
        new BadRequestException('ファイルが指定されていません'),
        hostWith('POST', '/api/v1/files'),
      );

      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
