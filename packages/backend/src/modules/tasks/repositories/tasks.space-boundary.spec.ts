import { NotFoundException } from '@nestjs/common';
import type { Prisma, Task } from '@prisma/client';
import { DEFAULT_CHANNEL_ID } from '@rete/shared';
import { makeTaskEntity } from '../../../__tests__/factories';
import type { PrismaService } from '../../../database/prisma.service';
import { TasksRepository } from './tasks.repository';

const A = DEFAULT_CHANNEL_ID;
const B = 'space-b';
const C = 'space-c';

/** Stateful persistence double: exercise resulting rows and rollback, not just query shapes. */
function fixture() {
  let rows = [
    makeTaskEntity({ id: 1, spaceId: A, categoryId: null, sortOrder: 0 }),
    makeTaskEntity({ id: 2, spaceId: A, categoryId: null, parentTaskId: 1 }),
    makeTaskEntity({ id: 3, spaceId: A, categoryId: null, parentTaskId: 2 }),
    makeTaskEntity({ id: 4, spaceId: A, categoryId: null, sortOrder: 1 }),
    makeTaskEntity({ id: 5, spaceId: B, categoryId: null, sortOrder: 0 }),
    makeTaskEntity({ id: 6, spaceId: C, categoryId: null, sortOrder: 8 }),
  ];
  let failUpdate = false;
  type Where = {
    id?: number | { in: number[] };
    spaceId?: string;
    categoryId?: number | null;
    parentTaskId?: number | null | { in: number[] };
    sortOrder?: { gt?: number; gte?: number };
  };
  const match = (row: Task, where: Where): boolean => {
    for (const key of ['id', 'spaceId', 'categoryId', 'parentTaskId'] as const) {
      const value = where[key];
      if (value === undefined) continue;
      if (value !== null && typeof value === 'object') {
        if (!value.in.includes(row[key] as number)) return false;
      } else if (row[key] !== value) return false;
    }
    return (
      !(where.sortOrder?.gt !== undefined && row.sortOrder <= where.sortOrder.gt) &&
      !(where.sortOrder?.gte !== undefined && row.sortOrder < where.sortOrder.gte)
    );
  };
  const task = {
    findUnique: async ({ where }: { where: Where }) =>
      rows.find((row) => match(row, where)) ?? null,
    findMany: async ({ where }: { where: Where }) => rows.filter((row) => match(row, where)),
    aggregate: async ({ where }: { where: Where }) => ({
      _max: {
        sortOrder: Math.max(
          -1,
          ...rows.filter((row) => match(row, where)).map((row) => row.sortOrder),
        ),
      },
    }),
    updateMany: async ({
      where,
      data,
    }: {
      where: Where;
      data: {
        categoryId?: number | null;
        spaceId?: string;
        sortOrder?: { increment?: number; decrement?: number };
      };
    }) => {
      for (const row of rows.filter((item) => match(item, where))) {
        if (data.categoryId !== undefined) row.categoryId = data.categoryId;
        if (data.spaceId !== undefined) row.spaceId = data.spaceId;
        if (data.sortOrder)
          row.sortOrder += data.sortOrder.increment ?? -(data.sortOrder.decrement ?? 0);
      }
      return { count: 0 };
    },
    update: async ({ where, data }: { where: Where; data: Partial<Task> }) => {
      if (failUpdate) throw new Error('injected final write failure');
      const row = rows.find((item) => match(item, where))!;
      Object.assign(row, data);
      return { ...row };
    },
    create: async ({ data }: { data: Prisma.TaskCreateInput & { sortOrder: number } }) => {
      const row = makeTaskEntity({
        id: 10,
        title: data.title,
        spaceId: data.space!.connect!.id!,
        categoryId: null,
        parentTaskId: null,
        sortOrder: data.sortOrder,
      });
      rows.push(row);
      return row;
    },
  };
  const transaction = jest.fn(async (fn: (tx: { task: typeof task }) => Promise<unknown>) => {
    const before = structuredClone(rows);
    try {
      return await fn({ task });
    } catch (error) {
      rows = before;
      throw error;
    }
  });
  const repo = new TasksRepository({ task, $transaction: transaction } as unknown as PrismaService);
  return {
    repo,
    rows: () => rows,
    transaction,
    fail: () => {
      failUpdate = true;
    },
  };
}

describe('Task Space persistence boundaries', () => {
  it('moves an uncategorized three-level subtree together and leaves the third Space untouched', async () => {
    const f = fixture();
    const untouched = structuredClone(f.rows().find((row) => row.id === 6));
    await f.repo.moveTask(1, {
      parentTaskId: null,
      categoryId: null,
      afterTaskId: null,
      spaceId: B,
      expectedSpaceId: A,
    });
    expect(
      f
        .rows()
        .filter((row) => [1, 2, 3].includes(row.id))
        .map((row) => row.spaceId),
    ).toEqual([B, B, B]);
    expect(f.rows().find((row) => row.id === 2)?.parentTaskId).toBe(1);
    expect(f.rows().find((row) => row.id === 3)?.parentTaskId).toBe(2);
    expect(f.rows().find((row) => row.id === 4)?.sortOrder).toBe(0);
    expect(f.rows().find((row) => row.id === 5)?.sortOrder).toBe(1);
    expect(f.rows().find((row) => row.id === 6)).toEqual(untouched);
    expect(f.transaction.mock.calls[0]).toHaveLength(2);
  });

  it.each([undefined, 1])(
    'creates at append/insert position %s without changing other Spaces',
    async (afterTaskId) => {
      const f = fixture();
      const untouched = structuredClone(f.rows().filter((row) => row.spaceId !== A));
      const created = await f.repo.createWithSortOrder(
        { title: 'new', space: { connect: { id: A } } },
        { spaceId: A, categoryId: null, parentTaskId: null, afterTaskId },
      );
      expect(created.sortOrder).toBe(afterTaskId === undefined ? 2 : 1);
      expect(f.rows().filter((row) => row.spaceId !== A)).toEqual(untouched);
    },
  );

  it.each(['parent', 'sibling', 'source'] as const)(
    'rejects a changed or foreign %s and restores all rows',
    async (kind) => {
      const f = fixture();
      const before = structuredClone(f.rows());
      await expect(
        f.repo.moveTask(1, {
          parentTaskId: kind === 'parent' ? 5 : null,
          categoryId: null,
          afterTaskId: kind === 'sibling' ? 5 : null,
          expectedSpaceId: kind === 'source' ? B : A,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(f.rows()).toEqual(before);
    },
  );

  it('rejects foreign sibling creation without shifting or creating anything', async () => {
    const f = fixture();
    const before = structuredClone(f.rows());
    await expect(
      f.repo.createWithSortOrder(
        { title: 'new', space: { connect: { id: A } } },
        { spaceId: A, categoryId: null, parentTaskId: null, afterTaskId: 5 },
      ),
    ).rejects.toThrow('Sibling task not found');
    expect(f.rows()).toEqual(before);
  });

  it('rolls back subtree and sibling changes when the final write fails', async () => {
    const f = fixture();
    const before = structuredClone(f.rows());
    f.fail();
    await expect(
      f.repo.moveTask(1, { parentTaskId: null, categoryId: null, afterTaskId: null, spaceId: B }),
    ).rejects.toThrow('injected final write failure');
    expect(f.rows()).toEqual(before);
  });

  it('refuses to transfer descendants already belonging to another Space', async () => {
    const f = fixture();
    f.rows().find((row) => row.id === 3)!.spaceId = C;
    const before = structuredClone(f.rows());
    await expect(
      f.repo.moveTask(1, { parentTaskId: null, categoryId: null, afterTaskId: null, spaceId: B }),
    ).rejects.toThrow('Task not found');
    expect(f.rows()).toEqual(before);
  });
});
