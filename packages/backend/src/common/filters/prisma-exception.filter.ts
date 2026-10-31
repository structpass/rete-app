import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './http-exception.filter';
import { getUniqueConflictMessage } from './unique-conflict-context';

/** 503 応答へ載せる再送目安（秒）。混雑の解消待ちなので短く、クライアントが即座に再突入しない程度。 */
const RETRY_AFTER_SECONDS = 5;

/**
 * Prisma のクエリエラーを HttpException に変換し、AllExceptionsFilter に委譲して
 * 統一レスポンス形状を保つ。サービス層の try/catch 重複を排除するための共通 filter（§4）。
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly delegate = new AllExceptionsFilter();
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const mapped = this.toHttpException(exception);
    return this.delegate.catch(mapped ?? exception, host);
  }

  private toHttpException(e: Prisma.PrismaClientKnownRequestError): HttpException | null {
    switch (e.code) {
      case 'P2002': {
        // 一意制約に違反したカラム/制約名（meta.target）は DB スキーマの内部名であり、
        // クライアントへ返すと内部構造が漏洩する。サーバーログにのみ出力し、
        // レスポンスはサーバー指定の案内文か汎用文のみ（reference との意図的な分岐）。
        const target = Array.isArray(e.meta?.target)
          ? (e.meta?.target as string[]).join(', ')
          : typeof e.meta?.target === 'string'
            ? (e.meta.target as string)
            : '';
        this.logger.warn(`Unique constraint violation (P2002)${target ? ` on: ${target}` : ''}`);
        return new ConflictException(getUniqueConflictMessage(e));
      }
      case 'P2003':
        return new ConflictException('関連データが存在するため削除できません');
      case 'P2025':
        return new NotFoundException('対象のレコードが見つかりません');
      case 'P2034':
        // Serializable(SSI) の write conflict。直列化 tx は全経路が runInSerializableTransaction 経由に
        // 統一済み（cmn-0251）なので、ここへ来るのはリトライ上限でも解けなかった場合。
        // 利用者の操作自体は正しく、押し直せば通る性質なので 409。P2002 由来の 409 と区別できるよう
        // code を明示する（AllExceptionsFilter は明示 code を status 由来の導出より優先する）。
        return new ConflictException({
          code: 'WRITE_CONFLICT',
          message: '他の操作と競合しました。もう一度お試しください',
        });
      case 'P2024':
      case 'P2028':
        // 写像後は ServiceUnavailableException になり元の code / meta が消えるため、ここで残す。
        // 打ち手が分かれる 3 種を運用ログで区別できるようにする:
        //   P2024 = 接続プール待ちの超過（プール上限 / 同時実行の問題）
        //   P2028 + reason=deadline_budget_exceeded = 競合リトライで時間予算を使い切った（競合削減の問題）
        //   P2028（reason なし）= 1 回の tx が単体で遅い（クエリ / index の問題）
        this.logger.warn(
          `Transient DB failure (${e.code})${
            typeof e.meta?.reason === 'string' ? ` reason=${e.meta.reason}` : ''
          } -> 503`,
        );
        // P2028 = interactive transaction の timeout 超過 / P2024 = 接続プール待ちの超過。どちらも
        // 「遅い・混んでいる」という一時的な状態で、恒久障害ではなく再送で解けるため 503 + Retry-After。
        return new ServiceUnavailableException({
          code: 'SERVICE_UNAVAILABLE',
          message: '現在混み合っています。しばらくしてからもう一度お試しください',
          retryAfter: RETRY_AFTER_SECONDS,
        });
      default:
        return null;
    }
  }
}
