import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../database';

/**
 * 期限切れ OIDC payload の定期 purge（operational-policy §6）。
 *
 * node-oidc-provider の adapter は `find` 時に expiresAt 超過を弾く（漏洩はしない）が、行は
 * 物理削除されず溜まり続けるため、本サービスが日次でまとめて削除しテーブル肥大化を防ぐ。
 *
 * §2 データアクセス境界: OIDC サブシステムは adapter が prisma を直接呼ぶ data-access 層であり
 * （汎用 Repository を介さない既存の文書化済み例外）、本 purge も同サブシステムのメンテナンス
 * 用 data-access として prisma を直接呼ぶ。ドメイン Service ではなく OIDC 専用の維持ジョブ。
 * 例外の範囲・代案・再検討条件: docs/decisions/0073-oidc-sso-decisions-consolidated.md 判断4。
 */
@Injectable()
export class OidcPurgeService {
  private readonly logger = new Logger(OidcPurgeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 日次で期限切れ payload を一括 purge する。
   * EVERY_DAY_AT_4AM は UTC 基準（= JST 13:00）。単一ユーザー MVP では実行時刻帯による実害はない。
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async handleScheduledPurge(): Promise<void> {
    await this.purgeExpired();
  }

  /**
   * expiresAt 超過の payload を物理削除し、削除件数を返す。
   *
   * - 無期限（expiresAt = null）の行は対象外（`not: null` で保護）。
   * - バックグラウンドジョブは HTTP 例外 filter の対象外のため、ここで try/catch する
   *   （operational-policy §3「止めない側」= 失敗してもアプリを止めず logger.error で痕跡を残す）。
   */
  async purgeExpired(): Promise<number> {
    try {
      const { count } = await this.prisma.oidcPayload.deleteMany({
        where: { expiresAt: { not: null, lt: new Date() } },
      });
      this.logger.log(`Purged ${count} expired OIDC payload(s)`);
      return count;
    } catch (err) {
      // message のみを文字列化して痕跡を残す。raw Error / stack を渡すと NestJS Logger が
      // stack として展開し、Prisma 接続エラーの host 情報が漏れる経路になりうる（§2）。
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to purge expired OIDC payloads: ${detail}`);
      return 0;
    }
  }
}
