import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { UploadErrorFilter } from './upload-error.filter';

/**
 * アップロード拒否の文言変換（v2-191）。FileInterceptor が投げる英語文言を、共通形状
 * （{ success:false, error:{ code, message } }）のまま日本語へ差し替えることを固定する。
 *
 * 受ける例外を HttpException に限っていることの実効（DB 例外がグローバルの PrismaExceptionFilter へ
 * 流れ、P2002 が 409 のままであること）は、グローバル filter を実際に登録した app を使う
 * files.upload-multipart.spec.ts 側で固定する。
 */
describe('UploadErrorFilter', () => {
  let filter: UploadErrorFilter;
  let mockResponse: { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    // 経路ごとの上限値を渡す（ファイルのアップロード=100 MiB・招待 CSV の取り込み=1 MB・v2-209）。
    filter = new UploadErrorFilter({ maxFileSizeBytes: 100 * 1024 * 1024 });
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => ({ method: 'POST', url: '/api/v2/files/folders/f1/files' }),
      }),
    } as unknown as ArgumentsHost;
  });

  const body = () => mockResponse.json.mock.calls[0][0];

  it('multer の英語 400 を日本語の案内文へ差し替える（code は status から導出）', () => {
    filter.catch(new BadRequestException('Too many files'), mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(body()).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: '1 回にアップロードできるファイルは 1 件です' },
    });
  });

  it('field 名が後置された文言も訳す', () => {
    filter.catch(new BadRequestException('Unexpected field - note'), mockHost);

    expect(body().error.message).toBe('想定していない項目が送信されました');
  });

  it('サイズ上限（413）は状態コードを変えず文言だけ訳す', () => {
    filter.catch(new PayloadTooLargeException('File too large'), mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(body().error.code).toBe('BAD_REQUEST');
    expect(body().error.message).toBe('ファイルサイズが上限（100 MB）を超えています');
  });

  it('対象外の 400（業務上の拒否）はそのまま通す', () => {
    filter.catch(
      new BadRequestException('実行形式（.exe や .dll など）のファイルはアップロードできません'),
      mockHost,
    );

    expect(body()).toEqual({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: '実行形式（.exe や .dll など）のファイルはアップロードできません',
      },
    });
  });

  it('回数制限（429）も日本語へ訳す（フレームワーク名を画面へ出さない）', () => {
    filter.catch(new ThrottlerException(), mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(body()).toEqual({
      success: false,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'アップロードの回数が多すぎます。少し待ってからお試しください',
      },
    });
  });

  it('400 / 413 / 429 以外の状態は触らない（対象の状態コードを広げない）', () => {
    // multer 文言と同じ文字列でも、状態コードが対象外なら変換しない（変換条件は status で閉じる）。
    filter.catch(new ConflictException('Too many files'), mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(body().error.message).toBe('Too many files');
  });

  it('非 HttpException は 500 の統一形状で返す（共通フィルタへ委譲）', () => {
    // @Catch(HttpException) のため本番の配線ではここへ来ない（DB 例外は PrismaExceptionFilter が受ける）。
    // フィルタ単体の委譲挙動としては 500 形状に倒れることを固定しておく。
    filter.catch(new Error('boom'), mockHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body().error.code).toBe('INTERNAL_ERROR');
  });
});
