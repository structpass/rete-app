// d668: 実際の移動（direction とカーソル）を順に渡し、頁の中身まで突き合わせて固定する。
// 総件数 41（頁件数の倍数でない）と 50（倍数）の両方を扱う。前へを押すたびに同じ頁が返る・
// 最終頁から前の頁へ戻れない、といった移動のずれを、行の並びまで比べて検出する。
// 実装は並びを (createdAt, id) の組で決めるので、模擬も同じ意味で読み（時刻も時計の値ではなく
// 日時の値として受け取る）、代役の答えが実表と食い違わないようにする。
import { AuditLogsRepository } from './audit-logs.repository';

type Row = { id: string; createdAt: Date };

const LIMIT = 20;

/** 古い順（最後の行が最新）。id は 3 桁の行番号から作る。 */
const makeRows = (total: number): Row[] =>
  Array.from({ length: total }, (_, i) => ({
    id: String(i + 1).padStart(3, '0'),
    createdAt: new Date(Date.UTC(2026, 4, 8, 0, 0, i + 1)),
  }));

/** 表示順（新しい順）の id。 */
const displayIds = (source: Row[]): string[] =>
  source
    .slice()
    .reverse()
    .map((r) => r.id);

type Span =
  | Date
  | string
  | { lt?: Date | string; lte?: Date | string; gt?: Date | string; gte?: Date | string };

/** createdAt の条件（等値 / 範囲）を実表の比較と同じ意味で読む。 */
function matchCreatedAt(row: Row, span: Span | undefined): boolean {
  if (span === undefined) return false;
  if (typeof span === 'string' || span instanceof Date) {
    return row.createdAt.getTime() === new Date(span).getTime();
  }
  const bound = span.lt ?? span.lte ?? span.gt ?? span.gte;
  if (bound === undefined) return false;
  const diff = row.createdAt.getTime() - new Date(bound).getTime();
  // 同じ時刻の行は id の枝で比べるので、時刻だけの枝では通さない。
  if (diff === 0) return false;
  if (span.lt === undefined && span.gt === undefined && span.lte !== undefined) return diff < 0;
  if (span.lt === undefined && span.gt === undefined && span.gte !== undefined) return diff > 0;
  if (span.lt !== undefined || span.lte !== undefined) return diff < 0;
  return diff > 0;
}

/** id の条件。境目の行は、含める向き（lte / gte）の時だけ通す（d701）。 */
function matchId(
  id: string,
  cond: { lt?: string; lte?: string; gt?: string; gte?: string } | undefined,
): boolean {
  if (cond === undefined) return false;
  if (cond.lt !== undefined) return id < cond.lt;
  if (cond.lte !== undefined) return id <= cond.lte;
  if (cond.gt !== undefined) return id > cond.gt;
  if (cond.gte !== undefined) return id >= cond.gte;
  return false;
}

/**
 * 1 つの条件を読む。実装はカーソル条件を次の形で組む。
 *  - `{ createdAt: <時刻の範囲> }` … 時刻だけで比べる枝
 *  - `{ createdAt: <等値>, id: <範囲> }` … 同じ時刻の行を id で比べる枝
 * OR の枝は上の 2 つで、同じ行に並ぶ条件は両方通すこと。
 */
function matchClause(row: Row, clause: Record<string, unknown>): boolean {
  const span = clause.createdAt as Span | undefined;
  const idCond = clause.id as { lt?: string; lte?: string; gt?: string; gte?: string } | undefined;
  if (span === undefined && idCond === undefined) return true;
  const timeOk = span === undefined ? true : matchCreatedAt(row, span);
  const idOk = idCond === undefined ? true : matchId(row.id, idCond);
  return timeOk && idOk;
}

type Where = { AND?: Where[]; OR?: Where[] } & Record<string, unknown>;

function matchWhere(row: Row, where: Where | undefined): boolean {
  if (where === undefined) return true;
  if (!matchClause(row, where as Record<string, unknown>)) return false;
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(value as Where[]).every((part) => matchWhere(row, part))) return false;
    } else if (key === 'OR') {
      const clauses = value as Array<Record<string, unknown>>;
      if (!clauses.some((c) => matchClause(row, c))) return false;
    }
  }
  return true;
}

interface FindManyArgs {
  where?: unknown;
  orderBy?: Array<Record<string, 'asc' | 'desc'>>;
  skip?: number;
  take?: number;
}

/** メモリ上の行を、実表と同じ並び・同じ読み飛ばしで返す Prisma の代役。 */
function fakePrisma(source: Row[]) {
  const filter = (where: unknown) =>
    source.filter((r) => matchWhere(r, where as Where | undefined));
  const findMany = ({ where, orderBy, skip = 0, take }: FindManyArgs) => {
    const order = orderBy ?? [{ createdAt: 'desc' }];
    const dir = (key: string) => (order.find((o) => key in o)?.[key] === 'asc' ? 1 : -1);
    const byTime = dir('createdAt');
    const byId = dir('id');
    const ordered = [...filter(where)].sort((a, b) => {
      const t = a.createdAt.getTime() - b.createdAt.getTime();
      const i = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return t !== 0 ? byTime * t : byId * i;
    });
    return take === undefined ? ordered.slice(skip) : ordered.slice(skip, skip + take);
  };
  return {
    auditLog: {
      aggregate: ({ where }: { where?: unknown } = {}) =>
        Promise.resolve({ _count: { _all: filter(where).length } }),
      count: ({ where }: { where?: unknown }) => Promise.resolve(filter(where).length),
      findMany: (args: FindManyArgs) => Promise.resolve(findMany(args)),
    },
  };
}

const at = (
  store: AuditLogsRepository,
  direction?: 'next' | 'prev' | 'last',
  cursor?: string | null,
) => store.search({}, { limit: LIMIT, direction, cursor: cursor ?? undefined });

describe('操作ログの前後移動（41 件・20 件表示・倍数でない・d668）', () => {
  const rows = makeRows(41);
  const repo = new AuditLogsRepository(fakePrisma(rows) as never);
  const ids = displayIds(rows);
  /** 先頭から「次へ」で辿った時の各頁（行の並びまで固定する）。 */
  const pageAt = (index: number): string[] => ids.slice(index * LIMIT, (index + 1) * LIMIT);

  it('先頭 → 次 → 前 で 1 頁目とまったく同じ行・同じ順に戻る', async () => {
    const first = await at(repo);
    const second = await at(repo, 'next', first.cursors.next);
    const back = await at(repo, 'prev', second.cursors.prev);
    expect(first.data.map((r) => r.id)).toEqual(pageAt(0));
    expect(second.data.map((r) => r.id)).toEqual(pageAt(1));
    expect(back.data.map((r) => r.id)).toEqual(pageAt(0));
  });

  it('次へ×2 → 前へ×2 で、3 頁目 → 2 頁目 → 1 頁目の順に戻る', async () => {
    const first = await at(repo);
    const second = await at(repo, 'next', first.cursors.next);
    const third = await at(repo, 'next', second.cursors.next);
    expect(third.data.map((r) => r.id)).toEqual(pageAt(2));
    const back1 = await at(repo, 'prev', third.cursors.prev);
    expect(back1.data.map((r) => r.id)).toEqual(pageAt(1));
    const back2 = await at(repo, 'prev', back1.cursors.prev);
    expect(back2.data.map((r) => r.id)).toEqual(pageAt(0));
    expect(back2.cursors.prev).toBeNull();
  });

  it('最後へ は最終頁（41 行目のみ）で、前へで 2 頁目 → 1 頁目へ戻り、次へで最終頁に戻る', async () => {
    const last = await at(repo, 'last');
    expect(last.data.map((r) => r.id)).toEqual(pageAt(2));
    const back1 = await at(repo, 'prev', last.cursors.prev);
    expect(back1.data.map((r) => r.id)).toEqual(pageAt(1));
    const back2 = await at(repo, 'prev', back1.cursors.prev);
    expect(back2.data.map((r) => r.id)).toEqual(pageAt(0));
    const forward = await at(repo, 'next', back1.cursors.next);
    expect(forward.data.map((r) => r.id)).toEqual(pageAt(2));
  });

  it('前へを繰り返しても、同じ行が二度出ず、飛ばさない', async () => {
    const last = await at(repo, 'last');
    const walked = last.data.map((r) => r.id);
    let cursor = last.cursors.prev;
    for (let guard = 0; guard < 50 && cursor; guard += 1) {
      const back = await at(repo, 'prev', cursor);
      walked.push(...back.data.map((r) => r.id));
      cursor = back.cursors.prev;
    }
    // 3 頁目 → 2 頁目 → 1 頁目の順に辿る（前へ 1 回ごとに前の頁が 1 つずつ、行の順まで揃って出る）。
    expect(walked).toEqual([...pageAt(2), ...pageAt(1), ...pageAt(0)]);
    expect(new Set(walked).size).toBe(walked.length);
  });
});

describe('最後への頁（d653）', () => {
  // 最終頁は「総ページ数（切り上げ）から求めた頁の先頭」から並ぶ表示順（新しい順）の limit 件。
  // 末尾から固定件数を採る形（d668 当初の期待）は、総件数が頁件数の倍数でない時に「次」で辿った
  // 最終頁と行の境目が一致しないため、d653 でこの形に改めた。試験の期待も要求（d653）に合わせる。
  it.each([41, 50, 25, 40, 20])(
    '総件数 %i・20 件表示の最終頁を、行の並びまで一致して返す',
    async (total) => {
      const source = makeRows(total);
      const store = new AuditLogsRepository(fakePrisma(source) as never);
      const display = source
        .slice()
        .reverse()
        .map((r) => r.id);
      const pages = Math.max(1, Math.ceil(total / LIMIT));
      const expected = display.slice((pages - 1) * LIMIT, pages * LIMIT);
      const last = await at(store, 'last');
      expect(last.data.map((r) => r.id)).toEqual(expected);
      // 最終頁は末尾（古い側）が終端なので、「次」は常に無い（d653）。
      expect(last.cursors.next).toBeNull();
      // 前の頁があるのは、最終頁が先頭頁でない時だけ。その戻り先で採れるのは、頁の先頭から数えた
      // 位置の頁そのもの（行の境目が揃っている）。
      expect(last.cursors.prev === null).toBe(pages === 1);
      if (pages > 1) {
        const back = await at(store, 'prev', last.cursors.prev);
        const prevPage = display.slice((pages - 2) * LIMIT, (pages - 1) * LIMIT);
        expect(back.data.map((r) => r.id)).toEqual(prevPage);
        // 次へ で最終頁へ戻る形は、前へで戻った頁の 次へ が末尾行そのもの（含めない）を境目に
        // 持つことで揃った（d713。総件数 21・25・40 件でも 1 行もずれない）。この往復は下の
        // 「前へで戻った頁の 次へ が…（d713）」で固定する。ここでは、前へ の頁そのものだけを見る。
      }
    },
  );
});

describe('操作ログの前後移動（50 件・20 件表示・倍数・d668）', () => {
  const rows = makeRows(50);
  const repo = new AuditLogsRepository(fakePrisma(rows) as never);
  const ids = displayIds(rows);
  const pageAt = (index: number): string[] => ids.slice(index * LIMIT, (index + 1) * LIMIT);

  it('最後へ は末尾の 20 行（31〜50 行目）で、前へでその手前の頁へ戻る', async () => {
    const last = await at(repo, 'last');
    expect(last.data.map((r) => r.id)).toEqual(pageAt(2));
    const back = await at(repo, 'prev', last.cursors.prev);
    expect(back.data.map((r) => r.id)).toEqual(pageAt(1));
  });
});

describe('前へに渡す境目の行そのものの扱い（d701）', () => {
  // 同じ時刻の行が並ぶ時、境目を id の合成値（`011+\\uFFFF`）で表すと、実表の照合順序では最大に
  // ならず境目が崩れる。境目は「行そのもの」と「その行を含めるか」で持つので、含める向きの時だけ
  // 同じ時刻の片側の行が通る。ここではその 1 点だけを固定する（組み立ては実装に任せ、結果で見る）。
  const sameTime = new Date(Date.UTC(2026, 4, 8, 0, 0, 0));
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: String(i + 1).padStart(3, '0'),
    createdAt: sameTime,
  }));
  const repo = new AuditLogsRepository(fakePrisma(rows) as never);
  const pageAt = (cursor: string | null) => at(repo, 'prev', cursor);

  it.each([[true], [false]])('境目の行を含める向き %s が結果に効く', async (include) => {
    const includes = include as boolean;
    // 境目は 011。同点で id を比べる枝（lt / lte）を落とすと、境目より新しい側も古い側も空になり
    // 境目が崩れる。ここでは両向きの結果をそれぞれ固定する。
    // 24 行のうち境目を 011 に置く。前へは「境目より新しい側」を昇順に採って反転するので、含める
    // 向きなら 011〜024、含めない向きなら 012〜024（新しい順）。どちらも limit 20 件に収まる
    // （溢れると、採り先の端を落とす段で境目の行が消え、向きの違いが見えなくなる）。
    const back = await pageAt(encodeCursorWith(rows[10], includes));
    const returned = back.data.map((r) => r.id);
    // 境目より新しい側は 12〜30 の 19 行。前へは limit 20 件まで採るので、含める向きは 011 が
    // 加わった 20 件、含めない向きは 19 件になる。
    const newestFirst = (from: number) =>
      Array.from({ length: 31 - from }, (_, i) => String(30 - i).padStart(3, '0'));
    expect(returned).toEqual(newestFirst(includes ? 11 : 12));
  });
});

/** 決定のカーソル文字列を試験側で作る（含める向きを明示する）。 */
function encodeCursorWith(row: Row, include: boolean): string {
  return Buffer.from(
    JSON.stringify({ c: row.createdAt.toISOString(), id: row.id, x: include ? 1 : 0 }),
    'utf8',
  ).toString('base64url');
}

describe('同じ時刻の行が頁いっぱいに並ぶ時の前後移動（d701・41 行すべて同じ時刻）', () => {
  // 実測した再現条件: 41 行すべてが同じ時刻。境目を id の合成値（末尾に \uFFFF を足す）で作ると、
  // 前後の移動が 1 行ずれる・同じ頁が返る。行そのもの＋含める向きで持てば並びが決まる。
  const sameTime = new Date(Date.UTC(2026, 4, 8, 0, 0, 0));
  const rows = Array.from({ length: 41 }, (_, i) => ({
    id: String(i + 1).padStart(3, '0'),
    createdAt: sameTime,
  }));
  const repo = new AuditLogsRepository(fakePrisma(rows) as never);
  // 同じ時刻は id の降順（新しい順）。
  const ids = rows.map((r) => r.id).reverse();
  const pageAt = (index: number): string[] => ids.slice(index * LIMIT, (index + 1) * LIMIT);

  it('先頭 → 次 → 前 で 1 頁目とまったく同じ行・同じ順に戻る', async () => {
    const first = await at(repo);
    expect(first.data.map((r) => r.id)).toEqual(pageAt(0));
    const second = await at(repo, 'next', first.cursors.next);
    expect(second.data.map((r) => r.id)).toEqual(pageAt(1));
    const back = await at(repo, 'prev', second.cursors.prev);
    expect(back.data.map((r) => r.id)).toEqual(pageAt(0));
  });

  it('次へ×2 → 前へ×2 で、3 頁目 → 2 頁目 → 1 頁目の順に戻り、重複も飛ばしもない', async () => {
    const first = await at(repo);
    const second = await at(repo, 'next', first.cursors.next);
    const third = await at(repo, 'next', second.cursors.next);
    expect(third.data.map((r) => r.id)).toEqual(pageAt(2));
    const back1 = await at(repo, 'prev', third.cursors.prev);
    expect(back1.data.map((r) => r.id)).toEqual(pageAt(1));
    const back2 = await at(repo, 'prev', back1.cursors.prev);
    expect(back2.data.map((r) => r.id)).toEqual(pageAt(0));
    expect(back2.cursors.prev).toBeNull();
  });

  it('前へを繰り返しても、同じ行が二度出ず、飛ばさない（最後へ から 1 頁目まで）', async () => {
    const last = await at(repo, 'last');
    const walked = last.data.map((r) => r.id);
    let cursor = last.cursors.prev;
    for (let guard = 0; guard < 50 && cursor; guard += 1) {
      const back = await at(repo, 'prev', cursor);
      walked.push(...back.data.map((r) => r.id));
      cursor = back.cursors.prev;
    }
    expect(walked).toEqual([...pageAt(2), ...pageAt(1), ...pageAt(0)]);
    expect(new Set(walked).size).toBe(walked.length);
  });
});

describe('前へで戻った頁の 次へ が、次へで辿った頁と同じ境目に戻る（d713）', () => {
  // 実測した不具合: 総件数 21・25・40 件（頁件数の倍数でない）で、最後へ → 前へ → 次へ の 1 手が、
  // 次へで辿った最終頁と行の境目が揃わなかった。20・41・50 件など、最終頁が満杯か倍数の時は揃っていた。
  // 総件数を広く取り、前へで戻った頁の 次へ が必ず「次へで辿った頁」と同じ行から始まることを固定する。
  it.each([20, 21, 25, 26, 40, 41, 50, 60])(
    '総件数 %i・20 件表示で、最後へ → 前へ → 次へ が、次へで辿った最終頁と 1 行もずれない',
    async (total) => {
      const rows = makeRows(total);
      const repo = new AuditLogsRepository(fakePrisma(rows) as never);
      const ids = displayIds(rows);
      const pages = Math.max(1, Math.ceil(total / LIMIT));
      const pageAt = (index: number): string[] => ids.slice(index * LIMIT, (index + 1) * LIMIT);

      // 次へ で辿った全頁の並びが、頁割りの正解と一致する（この走査が基準）。
      const walked: string[] = (await at(repo)).data.map((r) => r.id);
      let cursor: string | null | undefined = (await at(repo)).cursors.next;
      for (let guard = 0; guard < 20 && cursor; guard += 1) {
        const page: Awaited<ReturnType<typeof at>> = await at(repo, 'next', cursor);
        walked.push(...page.data.map((r) => r.id));
        cursor = page.cursors.next;
      }
      expect(walked).toEqual(ids);

      // 最後へ の頁は正解どおり。前の頁が無ければ（総件数が頁件数以内）ここで終わり。
      const last = await at(repo, 'last');
      expect(last.data.map((r) => r.id)).toEqual(pageAt(pages - 1));
      if (last.cursors.prev === null) return;

      // 前へ で戻った頁も正解どおり。その 次へ が最終頁と 1 行もずれない。
      const back = await at(repo, 'prev', last.cursors.prev);
      expect(back.data.map((r) => r.id)).toEqual(pageAt(pages - 2));
      const forward = await at(repo, 'next', back.cursors.next);
      expect(forward.data.map((r) => r.id)).toEqual(pageAt(pages - 1));
    },
  );

  it.each([21, 25, 40, 41, 50])(
    '総件数 %i・20 件表示で、全頁を 前へ→次へ の往復しても行の境目が揃う',
    async (total) => {
      const rows = makeRows(total);
      const repo = new AuditLogsRepository(fakePrisma(rows) as never);
      const ids = displayIds(rows);
      const pages = Math.max(1, Math.ceil(total / LIMIT));
      const pageAt = (index: number): string[] => ids.slice(index * LIMIT, (index + 1) * LIMIT);

      // 先頭頁から次へで 1 頁ずつ辿り、各頁で「前へ → 次へ」の往復が元の頁に戻ることを確かめる。
      let cursor: string | null | undefined = (await at(repo)).cursors.next;
      for (let index = 1; index < pages && cursor; index += 1) {
        const page: Awaited<ReturnType<typeof at>> = await at(repo, 'next', cursor);
        const back = await at(repo, 'prev', page.cursors.prev);
        expect(back.data.map((r) => r.id)).toEqual(pageAt(index - 1));
        const again = await at(repo, 'next', back.cursors.next);
        expect(again.data.map((r) => r.id)).toEqual(pageAt(index));
        cursor = page.cursors.next;
      }
    },
  );
});
