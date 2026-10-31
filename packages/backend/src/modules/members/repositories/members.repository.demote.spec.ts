import { Role } from '@rete/shared';
import { MembersRepository } from './members.repository';
import { runInSerializableTransaction } from '../../../common/database/serializable-tx';

/**
 * 最後のシステム管理者の降格禁止（cmn-0047 全消失ガード）を、repository 層で固定する。
 *
 * 決定 d822 / S-SET-12 の「逐次降格で管理者 0 人を作れるか」:
 *  - 1 回の降格は「ADMIN 総数を数える → 1 人なら止める」を直列化した取引の中で行う。
 *  - **逐次（1 回ずつ）の降格**は、2 人 → 1 人 までは通る。最後の 1 人を降格しようとすると、
 *    数えた総数が 1 なので止まる（0 人にならない）。
 *  - **同時（並行）の降格**は、ADMIN が 2 人でそれぞれ別の人を降格しようとする時に
 *    双方が「総数は 2」と読まないよう直列化している（SSI）。この試験では、直列化の入口
 *    （runInSerializableTransaction）を差し替えて、数えると降格が同じ取引で流れることを見る。
 *
 * **この試験が守らない範囲**（模擬の外に置いているもの）: 直列化の深さ（SSI の分離水準）、
 * 書き込み衝突の検出、取引のやり直し（P2034 のリトライ）、複数の接続が本当に直列化されるか。
 * ここで固定するのは「入口 1 回の中（同じ tx）で数えて降格する」「総数 1 なら降格しない」の 2 点で、
 * これが崩れたら赤くなることは、実装を 2 通りに壊して確かめてある（`adminCount <= 1` を `<= 0` に
 * 変えると 2 件赤、直列化の入口を外すと 3 件赤）。
 *
 * 実施の実測（実 DB の管理者を 1 人まで落として降格を試す）はしない。失敗すると業務の入口が
 * 閉じる（管理者が 0 人になり、復旧が DB の直接編集になる）ため、ここでは取引の中身で確かめる。
 */
jest.mock('../../../common/database/serializable-tx', () => ({
  runInSerializableTransaction: jest.fn(),
}));

const mockedRun = runInSerializableTransaction as jest.MockedFunction<
  typeof runInSerializableTransaction
>;

/** 取引の中で使う tx を組み立てる（ADMIN の総数を count が返し、update は降格を返す）。 */
function makeTx(adminCounts: number[]) {
  let call = 0;
  const count = jest.fn(() =>
    Promise.resolve(adminCounts[Math.min(call++, adminCounts.length - 1)]),
  );
  const update = jest.fn(({ where }: { where: { id: string } }) =>
    Promise.resolve({ id: where.id, role: Role.MEMBER }),
  );
  return { account: { count, update } };
}

describe('MembersRepository.demoteSystemRoleAtomic（最後の管理者の全消失ガード）', () => {
  beforeEach(() => {
    mockedRun.mockReset();
    // 取引の入口は「渡された処理をそのまま tx で流す」に差し替える（DB は使わない）。
    mockedRun.mockImplementation(async (_prisma, fn) => fn(makeTx([1]) as never));
  });

  it('ADMIN が 1 人だけなら降格せず blocked=true を返す（0 人にならない）', async () => {
    const tx = makeTx([1]);
    mockedRun.mockImplementation(async (_prisma, fn) => fn(tx as never));
    const repo = new MembersRepository({} as never);

    const result = await repo.demoteSystemRoleAtomic('only-admin');

    expect(result.blocked).toBe(true);
    // 数えただけで、降格の更新は 1 度も流れていない（最後の 1 人が残る）。
    expect(tx.account.update).not.toHaveBeenCalled();
  });

  it('逐次に降格しても、0 人にはならない（2 人→1 人は通り、最後の 1 人は止まる）', async () => {
    // 1 回目: ADMIN 2 人（1 人降格して 1 人になる）→ 通る。
    const first = makeTx([2]);
    mockedRun.mockImplementationOnce(async (_prisma, fn) => fn(first as never));
    const repo = new MembersRepository({} as never);
    const firstResult = await repo.demoteSystemRoleAtomic('admin-a');
    expect(firstResult.blocked).toBe(false);
    expect(firstResult.row?.role).toBe(Role.MEMBER);

    // 2 回目: 残った 1 人を降格しようとする → 総数 1 なので止まる。
    const second = makeTx([1]);
    mockedRun.mockImplementationOnce(async (_prisma, fn) => fn(second as never));
    const secondResult = await repo.demoteSystemRoleAtomic('admin-b');

    expect(secondResult.blocked).toBe(true);
    expect(second.account.update).not.toHaveBeenCalled();
  });

  it('直列化した取引（SSI）の中で数えて降格する（同時降格で双方が総数を読む穴を塞ぐ）', async () => {
    const tx = makeTx([3]);
    mockedRun.mockImplementation(async (_prisma, fn) => fn(tx as never));
    const repo = new MembersRepository({} as never);

    await repo.demoteSystemRoleAtomic('admin-c');

    // 直列化の入口を 1 回だけ通り、その中で「数える」「降格する」が同じ取引の tx で流れる。
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(tx.account.count).toHaveBeenCalledWith({ where: { role: Role.ADMIN } });
    expect(tx.account.update).toHaveBeenCalledWith({
      where: { id: 'admin-c' },
      data: { role: Role.MEMBER },
      select: { id: true, role: true },
    });
  });
});
