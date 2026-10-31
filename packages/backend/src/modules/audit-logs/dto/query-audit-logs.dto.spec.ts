import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AUDIT_PAGE_SIZE } from '@rete/shared';
import { QueryAuditLogsDto } from './query-audit-logs.dto';

async function errorsFor(payload: Record<string, unknown>) {
  const dto = plainToInstance(QueryAuditLogsDto, payload);
  return { dto, errors: await validate(dto, { whitelist: true }) };
}

describe('QueryAuditLogsDto', () => {
  it('空クエリは既定 page=1 / limit=20 で受理する', async () => {
    const { dto, errors } = await errorsFor({});
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  // d756: 既定の件数は @rete/shared の 1 値を読む。DTO に写しを戻すと画面側の問い合わせと
  // 食い違っても気づけないため、既定値が共有定数そのものであることを縛る。
  it('limit の既定は共有定数 AUDIT_PAGE_SIZE と一致する', async () => {
    const { dto } = await errorsFor({});
    expect(dto.limit).toBe(AUDIT_PAGE_SIZE);
    expect(new QueryAuditLogsDto().limit).toBe(AUDIT_PAGE_SIZE);
  });

  it('page / limit を数値へ変換する（クエリ文字列由来）', async () => {
    const { dto, errors } = await errorsFor({ page: '3', limit: '50' });
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
  });

  it('limit が上限（100）を超えたら拒否する', async () => {
    const { errors } = await errorsFor({ limit: '101' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('正当な actionType / systemId / 期間を受理する', async () => {
    const { errors } = await errorsFor({
      actionType: 'login',
      systemId: 'SYS-001',
      from: '2026-05-01',
      to: '2026-05-08',
      search: '田中',
    });
    expect(errors).toHaveLength(0);
  });

  it('値域外の actionType を拒否する', async () => {
    const { errors } = await errorsFor({ actionType: 'destroy' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('日付形式でない from を拒否する', async () => {
    const { errors } = await errorsFor({ from: 'yesterday' });
    expect(errors.length).toBeGreaterThan(0);
  });
});
