import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../database/prisma.service';
import { isCurrentOidcCredentialState } from './oidc-credential-state';

/**
 * node-oidc-provider の Adapter を Prisma(PostgreSQL) で実装する。
 *
 * provider は `new Adapter(modelName)` で各 model（Session / AccessToken / AuthorizationCode /
 * RefreshToken / Grant / Interaction 等）ごとにインスタンス化するため、NestJS DI の外で生成される。
 * そこで PrismaService を閉じ込めたファクトリで Adapter class を返す。
 *
 * これは OIDC 専用の data-access 層（architecture-invariants §2）であり、汎用 Repository は介さず
 * prisma を直接呼ぶ（adapter 自体が data-access の責務を担う）。全 model を oidc_payloads 1 テーブルに
 * type 別で保存する（公式 example の Redis/Mongo adapter と同じ単一ストア方式）。
 * 例外の範囲・代案・再検討条件: docs/decisions/0073-oidc-sso-decisions-consolidated.md 判断4。
 */
export function createOidcPrismaAdapter(prisma: PrismaService): new (name: string) => Adapter {
  return class PrismaAdapter implements Adapter {
    constructor(private readonly name: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      if (!(await isCurrentOidcCredentialState(prisma, this.name, payload))) {
        throw new Error('OIDC authentication expired; authenticate again');
      }
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
      const data = {
        payload: payload as unknown as Prisma.InputJsonValue,
        grantId: payload.grantId ?? null,
        userCode: payload.userCode ?? null,
        uid: payload.uid ?? null,
        expiresAt,
      };
      await prisma.oidcPayload.upsert({
        where: { type_modelId: { type: this.name, modelId: id } },
        update: data,
        create: { type: this.name, modelId: id, ...data },
      });
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      const row = await prisma.oidcPayload.findUnique({
        where: { type_modelId: { type: this.name, modelId: id } },
      });
      return this.toPayload(row);
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      const row = await prisma.oidcPayload.findFirst({
        where: { type: this.name, userCode },
      });
      return this.toPayload(row);
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      const row = await prisma.oidcPayload.findFirst({
        where: { type: this.name, uid },
      });
      return this.toPayload(row);
    }

    async consume(id: string): Promise<void> {
      await prisma.oidcPayload.update({
        where: { type_modelId: { type: this.name, modelId: id } },
        data: { consumedAt: new Date() },
      });
    }

    async destroy(id: string): Promise<void> {
      // delete は不在時に throw するため deleteMany（冪等）を使う。
      await prisma.oidcPayload.deleteMany({
        where: { type: this.name, modelId: id },
      });
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await prisma.oidcPayload.deleteMany({ where: { grantId } });
    }

    /** DB 行を oidc-provider が期待する payload に変換。期限切れは undefined、消費済みは `consumed` を埋める。 */
    private async toPayload(
      row: { payload: Prisma.JsonValue; expiresAt: Date | null; consumedAt: Date | null } | null,
    ): Promise<AdapterPayload | undefined> {
      if (!row) return undefined;
      if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return undefined;
      const payload = row.payload as unknown as AdapterPayload;
      if (!(await isCurrentOidcCredentialState(prisma, this.name, payload))) return undefined;
      if (row.consumedAt) {
        payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
      }
      return payload;
    }
  };
}
