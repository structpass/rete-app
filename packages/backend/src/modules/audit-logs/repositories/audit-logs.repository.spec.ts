import { AUDIT_SYSTEM_COMMON } from '@rete/shared';
import {
  AuditLogsRepository,
  buildAuditLogWhere,
  decodeCursor,
  encodeCursor,
} from './audit-logs.repository';

describe('buildAuditLogWhere', () => {
  it('空フィルタは空 where（全件）', () => {
    expect(buildAuditLogWhere({})).toEqual({});
  });

  it('search はユーザー名 / メールの大文字小文字無視 OR 部分一致', () => {
    expect(buildAuditLogWhere({ search: '田中' })).toEqual({
      OR: [
        { actorName: { contains: '田中', mode: 'insensitive' } },
        { actorEmail: { contains: '田中', mode: 'insensitive' } },
      ],
    });
  });

  it('actionType は等価フィルタ', () => {
    expect(buildAuditLogWhere({ actionType: 'delete' })).toEqual({ actionType: 'delete' });
  });

  it('systemId 実値は等価、AUDIT_SYSTEM_COMMON は systemId IS NULL（横断操作）', () => {
    expect(buildAuditLogWhere({ systemId: 'SYS-001' })).toEqual({ systemId: 'SYS-001' });
    expect(buildAuditLogWhere({ systemId: AUDIT_SYSTEM_COMMON })).toEqual({ systemId: null });
  });

  it('from / to は createdAt の gte / lte に写す', () => {
    const from = new Date('2026-05-01T00:00:00.000Z');
    const to = new Date('2026-05-08T23:59:59.999Z');
    expect(buildAuditLogWhere({ from, to })).toEqual({ createdAt: { gte: from, lte: to } });
    expect(buildAuditLogWhere({ from })).toEqual({ createdAt: { gte: from } });
  });
});

describe('AuditLogsRepository.deleteOlderThan', () => {
  const cutoff = new Date('2025-06-13T00:00:00.000Z');
  let findMany: jest.Mock;
  let deleteMany: jest.Mock;
  let repo: AuditLogsRepository;

  beforeEach(() => {
    findMany = jest.fn();
    deleteMany = jest.fn();
    repo = new AuditLogsRepository({ auditLog: { findMany, deleteMany } } as never);
  });

  it('対象 0 件なら delete を呼ばず 0 を返す', async () => {
    findMany.mockResolvedValueOnce([]);
    const deleted = await repo.deleteOlderThan(cutoff, 1000);
    expect(deleted).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('batchSize 未満の 1 バッチで完了し、createdAt < cutoff の id を delete する', async () => {
    findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    deleteMany.mockResolvedValueOnce({ count: 2 });

    const deleted = await repo.deleteOlderThan(cutoff, 1000);

    expect(deleted).toBe(2);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { createdAt: { lt: cutoff } },
      take: 1000,
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b'] } } });
  });

  it('batchSize ちょうどなら次バッチを引き、空になるまでループして総件数を返す', async () => {
    findMany
      .mockResolvedValueOnce([{ id: '1' }, { id: '2' }]) // 1st batch == batchSize
      .mockResolvedValueOnce([{ id: '3' }]); // 2nd batch < batchSize → 終了
    deleteMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });

    const deleted = await repo.deleteOlderThan(cutoff, 2);

    expect(deleted).toBe(3);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(deleteMany).toHaveBeenCalledTimes(2);
  });
});

describe('AuditLogsRepository.search（keyset ページング）', () => {
  const rowA = { id: 'a', createdAt: new Date('2026-05-08T00:00:00.000Z') };
  const rowB = { id: 'b', createdAt: new Date('2026-05-07T00:00:00.000Z') };

  let findMany: jest.Mock;
  let count: jest.Mock;
  let aggregate: jest.Mock;
  let repo: AuditLogsRepository;

  beforeEach(() => {
    findMany = jest.fn();
    count = jest.fn().mockResolvedValue(5);
    aggregate = jest.fn().mockResolvedValue({ _count: { _all: 0 } });
    repo = new AuditLogsRepository({
      auditLog: { findMany, count, aggregate },
    } as never);
  });

  it('encodeCursor/decodeCursor は (createdAt, id) を可逆に符号化する', () => {
    const token = encodeCursor(rowA);
    expect(decodeCursor(token)).toEqual({ createdAt: rowA.createdAt, id: rowA.id, include: false });
    // 行そのものを含める向きも往復する（d701）。
    const inclusive = encodeCursor(rowA, true);
    expect(decodeCursor(inclusive)).toEqual({
      createdAt: rowA.createdAt,
      id: rowA.id,
      include: true,
    });
  });

  it('direction 省略（First）は createdAt/id 降順・cursor 境界なしで取得する', async () => {
    findMany.mockResolvedValue([rowA, rowB]);
    // 次へ進めるかの判定（末尾行より古い側）: 1 行も残っていない。
    findMany.mockResolvedValueOnce([rowA, rowB]).mockResolvedValueOnce([]);
    const res = await repo.search({}, { limit: 20 });

    expect(findMany.mock.calls[0][0]).toMatchObject({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
    expect(res.data).toEqual([rowA, rowB]);
    expect(res.total).toBe(5);
    // limit+1 の先読みに引っかからず、末尾行より古い側にも行が無いため、続きなし = 両方 null。
    expect(res.cursors.next).toBeNull();
    expect(res.cursors.prev).toBeNull();
  });

  it('direction=next は cursor より古い行を降順で取得する（OFFSET を使わない前進）', async () => {
    findMany.mockResolvedValue([rowB]);
    const cursor = encodeCursor(rowA);
    await repo.search({}, { limit: 20, direction: 'next', cursor });

    const args = findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.where).toEqual({
      AND: [
        {},
        {
          OR: [
            { createdAt: { lt: rowA.createdAt } },
            { createdAt: rowA.createdAt, id: { lt: rowA.id } },
          ],
        },
      ],
    });
  });

  it('direction=prev は cursor より新しい行を昇順で取得し、表示順（降順）へ反転して返す', async () => {
    // DB からは昇順（古い→新しい）で返るため rowB→rowA の順で来る想定。
    findMany.mockResolvedValue([rowB, rowA]);
    const cursor = encodeCursor(rowA);
    const res = await repo.search({}, { limit: 20, direction: 'prev', cursor });

    const args = findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(args.where).toEqual({
      AND: [
        {},
        {
          OR: [
            { createdAt: { gt: rowA.createdAt } },
            { createdAt: rowA.createdAt, id: { gt: rowA.id } },
          ],
        },
      ],
    });
    // 反転済みで表示順（新しい→古い）= [rowA, rowB]
    expect(res.data).toEqual([rowA, rowB]);
  });

  it('direction=last は先頭頁なら降順で limit 件採り、戻り先は付けない（offset 0）', async () => {
    // 総件数 2（limit 20 未満）は最終頁＝先頭頁なので、offset 0 のまま降順で採る（d668）。
    findMany.mockResolvedValue([rowA, rowB]);
    const res = await repo.search({}, { limit: 20, direction: 'last' });

    expect(findMany.mock.calls[0][0]).toMatchObject({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
    expect(findMany.mock.calls[0][0].where).toEqual({});
    expect(res.data).toEqual([rowA, rowB]);
    expect(res.cursors.prev).toBeNull(); // 先頭頁の前は無い
  });

  it('direction=last: 総件数を limit で割った端数の位置から、降順で limit 件採る（d653）', async () => {
    // 総件数 25・limit 20 → 最終頁は 21 行目〜25 行目（末尾の 5 行）。読み飛ばしは 20 行。
    const rowsNewestFirst = Array.from({ length: 25 }, (_, i) => ({
      id: `r${25 - i}`,
      createdAt: new Date(Date.UTC(2026, 4, 8, 0, 0, 25 - i)),
    }));
    const page21to25 = rowsNewestFirst.slice(20); // 21〜25 行目（新しい順）
    aggregate.mockResolvedValue({ _count: { _all: 25 } });
    findMany.mockResolvedValueOnce(page21to25);

    const res = await repo.search({}, { limit: 20, direction: 'last' });

    expect(findMany.mock.calls[0][0]).toMatchObject({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 20,
      take: 20,
    });
    expect(findMany.mock.calls[0][0].where).toEqual({});
    expect(res.total).toBe(25);
    expect(res.data).toEqual(page21to25);
    // 最終頁の末尾（25 行目）より古い側は無いので「次」は無い。境目は末尾行そのもの、
    // 戻り先（前）は先頭行そのものを行そのものとして指す（d701）。
    expect(res.cursors.next).toBeNull();
    expect(decodeCursor(res.cursors.prev as string)).toEqual({
      createdAt: page21to25[0].createdAt,
      id: page21to25[0].id,
      include: false,
    });
  });

  it('has-more peek: limit+1 件目が無ければ First の next は null（続きなし）', async () => {
    findMany.mockResolvedValueOnce([rowA, rowB]).mockResolvedValueOnce([]); // limit=2 ちょうど → 続きなし
    const res = await repo.search({}, { limit: 2 });

    expect(findMany.mock.calls[0][0].take).toBe(3);
    expect(res.data).toEqual([rowA, rowB]);
    expect(res.cursors.next).toBeNull();
    expect(res.cursors.prev).toBeNull();
  });

  it('has-more peek: limit+1 件目があれば First の next は non-null（続きあり）で余分な1件は捨てる', async () => {
    const rowC = { id: 'c', createdAt: new Date('2026-05-06T00:00:00.000Z') };
    findMany.mockResolvedValue([rowA, rowB, rowC]); // limit=2 に対し 3 件 = 続きあり
    const res = await repo.search({}, { limit: 2 });

    expect(res.data).toEqual([rowA, rowB]);
    expect(res.cursors.prev).toBeNull();
    expect(decodeCursor(res.cursors.next as string)).toEqual({
      createdAt: rowB.createdAt,
      id: rowB.id,
      include: false,
    });
  });

  it('direction=next: next は has-more peek 次第、prev は外側（新しい側）に続きがあれば non-null（d653）', async () => {
    // 呼ばれる順: 頁の取得 → 次の頁があるか（末尾行より古い側）→ 前の頁があるか（先頭行より新しい側）。
    findMany
      .mockResolvedValueOnce([rowB])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: rowA.id }]); // 1 件・外側に 1 件残る
    const cursor = encodeCursor(rowA);
    const res = await repo.search({}, { limit: 2, direction: 'next', cursor });

    // 戻り先は頁の先頭行のすぐ新しい側（同じ時刻なら id の大きい側）。前へはその外側を採るので、
    // 先頭行そのものを指すとその行が外れて 1 行ずれる（d668）。
    // 境目は行そのもの（含めない）で持ち、前後を決める向きは cursor の向きで決める（d701。
    // id に接尾辞 `\uFFFF` を足す形は、実表の照合順序で最大にならず同じ時刻の行で崩れた）。
    expect(decodeCursor(res.cursors.prev as string)).toEqual({
      createdAt: rowB.createdAt,
      id: rowB.id,
      include: false,
    });
    expect(res.cursors.next).toBeNull();
  });

  it('direction=last: next は常に null（終端）、prev は先頭頁なら null・最終頁なら返る', async () => {
    findMany.mockResolvedValueOnce([rowB, rowA]); // 総件数 2・limit 2 → 先頭頁＝最終頁
    const res = await repo.search({}, { limit: 2, direction: 'last' });

    expect(res.cursors.next).toBeNull();
    expect(res.cursors.prev).toBeNull();
  });

  it('direction=prev: 戻り先（さらに前）は採った先頭行より新しい側に残りがあれば返す（d653・d668）', async () => {
    // limit=2・3 行目以降（rowB, rowC）を採る。前の頁に 2 行残るが、採った頁は limit ちょうどなので
    // 来た側の実データは hasExtra=false。戻り先の判定は外側（新しい側）の残りで決める。
    const rowC = { id: 'c', createdAt: new Date('2026-05-05T00:00:00.000Z') };
    findMany.mockResolvedValue([rowC, rowB]); // 昇順で返る
    count.mockResolvedValue(2); // 先頭行（rowB）より新しい側に 2 件残っている
    const res = await repo.search({}, { limit: 2, direction: 'prev', cursor: encodeCursor(rowA) });

    expect(res.cursors.prev).not.toBeNull();
  });

  it('direction=prev: 新しい側に行が残っていなければ prev は null（先頭頁）', async () => {
    // 呼ばれる順: 頁の取得 → 次の頁があるか（末尾行より古い側）→ 前の頁があるか。
    findMany.mockResolvedValueOnce([rowB]).mockResolvedValueOnce([]).mockResolvedValueOnce([]); // 1 件だけの頁・その前は無い
    const res = await repo.search({}, { limit: 2, direction: 'prev', cursor: encodeCursor(rowA) });

    expect(res.cursors.prev).toBeNull();
  });

  it('direction=next: 戻り先は頁の先頭行の外側を指し、前の頁が残る時だけ返す（d668・d653）', async () => {
    // 2 頁目（[rowA, rowB]）を next で採る。戻り先は先頭行そのもの（含めない）。
    // 呼ばれる順: 頁の取得 → 次の頁があるか → 前の頁があるか。
    findMany
      .mockResolvedValueOnce([rowA, rowB])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'newer' }]);
    const res = await repo.search({}, { limit: 2, direction: 'next', cursor: encodeCursor(rowB) });

    expect(decodeCursor(res.cursors.prev as string)).toEqual({
      createdAt: rowA.createdAt,
      id: rowA.id,
      include: false,
    });
  });

  it('direction=next: 先頭行より新しい側に前の頁が残らなければ prev は null（d668）', async () => {
    findMany
      .mockResolvedValueOnce([rowA, rowB])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await repo.search({}, { limit: 2, direction: 'next', cursor: encodeCursor(rowB) });

    expect(res.cursors.prev).toBeNull();
  });
});
