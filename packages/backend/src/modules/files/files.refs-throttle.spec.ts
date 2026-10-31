import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Role } from '@rete/shared';
import { AllExceptionsFilter } from '../../common/filters';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

describe('ファイル参照の取得制限（d689）', () => {
  let app: INestApplication;
  let origin: string;
  const resolveRefs = jest.fn();

  beforeEach(async () => {
    resolveRefs.mockResolvedValue({ success: true, data: [] });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: 30 }],
        }),
      ],
      controllers: [FilesController],
      providers: [
        { provide: FilesService, useValue: { resolveRefs } },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    })
      .overrideGuard(AuthenticatedGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { id: 'account-1', role: Role.MEMBER };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('同じIPから60秒以内の20回は通し、21回目からは取得処理へ渡さず429を返す', async () => {
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`${origin}/files/refs?ids=file-${i}`);
      expect(response.status).toBe(200);
      await response.json();
      expect(resolveRefs).toHaveBeenNthCalledWith(i + 1, `file-${i}`, {
        id: 'account-1',
        role: Role.MEMBER,
      });
    }

    const blocked = await fetch(`${origin}/files/refs?ids=another-file`);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      success: false,
      error: { code: 'TOO_MANY_REQUESTS' },
    });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(resolveRefs).toHaveBeenCalledTimes(20);
  });
});
