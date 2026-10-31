import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_TIMEOUT_MS,
  INTERACTIVE_SAVE_TX_OPTIONS,
  MIN_ATTEMPT_WINDOW_MS,
  runInSerializableTransaction,
} from './serializable-tx';

/**
 * runInSerializableTransaction（reorder 系 / IP 許可リスト全置換が共有する直列化ヘルパ）の単体テスト。
 *
 * ここで検証すること:
 * - Serializable 分離レベル・timeout / maxWait を明示して $transaction が呼ばれること
 *   （呼び出し側で指定し忘れが起きない・Prisma 既定値への暗黙依存が残らない）。
 * - 競合 abort（P2034）は既定 3 回まで再試行し、上限到達時は最後の例外をそのまま投げ返すこと。
 * - 再試行の前にランダムな待機（full jitter）が入ること＝固定間隔で再突入しないこと。
 * - raw SQL の直列化失敗・deadlock も P2034 に正規化する。それ以外（P2028 / P2024 を含む）は即座に投げ返す。
 * - 成功時は 1 回で抜け、コールバックの戻り値をそのまま返すこと。
 *
 * E2E / 実 DB へ委譲すること:
 * - 実 PostgreSQL の SSI が実際に P2034 を返す条件、リトライで最終的に成功する実挙動。
 */

/** 指定コードの Prisma エラー。 */
function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`prisma ${code}`, {
    code,
    clientVersion: '6.2.0',
  });
}

/** P2034（write conflict / deadlock）相当の Prisma エラー。 */
function conflict(): Prisma.PrismaClientKnownRequestError {
  return prismaError('P2034');
}

/** リトライ待機は実タイマーで走る（最悪でも 25+50ms 程度）。呼び出し引数を見るため spy だけ張る。 */
function spyOnSleep() {
  return jest.spyOn(global, 'setTimeout');
}

describe('runInSerializableTransaction', () => {
  let $transaction: jest.Mock;
  let prisma: PrismaService;

  let warn: jest.SpyInstance;

  beforeEach(() => {
    $transaction = jest.fn(async (cb: (tx: unknown) => unknown) => cb({ tx: true }));
    prisma = { $transaction } as unknown as PrismaService;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Serializable 分離レベル・timeout・maxWait を明示して $transaction を呼び、コールバックの戻り値をそのまま返す', async () => {
    const fn = jest.fn(async () => 'result');

    await expect(runInSerializableTransaction(prisma, fn)).resolves.toBe('result');

    expect($transaction).toHaveBeenCalledTimes(1);
    // 分離レベルの指定が落ちると lost update を防げない。timeout / maxWait は未指定だと Prisma 既定
    // （5s / 2s）へ暗黙依存し、500 件 reorder が混雑時に P2028 で落ちる。3 つとも完全一致で固定する。
    expect($transaction).toHaveBeenCalledWith(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: DEFAULT_TIMEOUT_MS,
      maxWait: DEFAULT_MAX_WAIT_MS,
    });
  });

  it('timeout / maxWait / maxAttempts は呼び出し元が上書きできる', async () => {
    const fn = jest.fn(async () => 'result');

    await runInSerializableTransaction(prisma, fn, { timeout: 1_000, maxWait: 100 });

    expect($transaction).toHaveBeenCalledWith(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 1_000,
      maxWait: 100,
    });
  });

  it('既定 timeout は 500 件 reorder（1 往復 10ms 想定＝約 5 秒）に対して余裕がある', () => {
    // 上限件数が最大の呼び出し（announcement.reorder / desk-groups の 500 件）が現実的な遅延下で
    // 完走できること。Prisma 既定の 5s はちょうど境界のため、余裕を持つことを定数として固定する。
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(500 * 10 * 3);
  });

  it('成功時は再試行しない（コールバックも 1 回だけ実行される）', async () => {
    const fn = jest.fn(async () => 1);

    await runInSerializableTransaction(prisma, fn);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('P2034 で弾かれても既定の上限まで粘り、途中で成功したらその値を返す', async () => {
    $transaction.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());

    await expect(runInSerializableTransaction(prisma, async () => 'ok')).resolves.toBe('ok');

    // 期待値は実装側の定数を参照する（spec 側にリテラル 3 を置くと定数を変えた時にズレる）。
    expect($transaction).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS);
  });

  it('再試行の前に待機が入り、待機時間は毎回同じ固定値ではない（full jitter）', async () => {
    const setTimeoutSpy = spyOnSleep();
    // 乱数を差し替え、同じ試行回数でも乱数次第で待機時間が変わる＝固定間隔でないことを示す。
    jest.spyOn(Math, 'random').mockReturnValueOnce(0.2).mockReturnValueOnce(0.9);
    $transaction.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());

    await runInSerializableTransaction(prisma, async () => 'ok');

    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(delays).toHaveLength(2);
    // 1 回目: 0.2 * 25 = 5ms / 2 回目: 0.9 * 50 = 45ms（指数的に上限が伸び、乱数で散る）。
    expect(delays).toEqual([5, 45]);
  });

  it.each(['40001', '40P01'])('raw SQL の %s も transaction 全体を再試行する', async (code) => {
    $transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('raw conflict', {
        code: 'P2010',
        clientVersion: '6.2.0',
        meta: { code },
      }),
    );
    await expect(runInSerializableTransaction(prisma, async () => 'ok')).resolves.toBe('ok');
    expect($transaction).toHaveBeenCalledTimes(2);
  });

  it('raw SQL の競合も上限到達時は P2034 にして既存の HTTP 409 写像へ渡す', async () => {
    $transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('raw conflict', {
        code: 'P2010',
        clientVersion: '6.2.0',
        meta: { code: '40001' },
      }),
    );
    await expect(runInSerializableTransaction(prisma, async () => 'ok')).rejects.toMatchObject({
      code: 'P2034',
      meta: { sqlState: '40001' },
    });
    expect($transaction).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS);
  });

  it('raw SQL の構文エラーは正規化も再試行もしない', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('syntax error', {
      code: 'P2010',
      clientVersion: '6.2.0',
      meta: { code: '42601' },
    });
    $transaction.mockRejectedValue(error);
    await expect(runInSerializableTransaction(prisma, async () => 'ok')).rejects.toBe(error);
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('再試行が発生したら回数の分かる warn ログを 1 回ずつ残す（機微情報は載せない）', async () => {
    $transaction.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());

    await runInSerializableTransaction(prisma, async () => 'ok');

    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages[0]).toContain('P2034');
    expect(messages[0]).toContain(`2/${DEFAULT_MAX_ATTEMPTS}`);
    expect(messages[1]).toContain(`3/${DEFAULT_MAX_ATTEMPTS}`);
    // 接続文字列・入力値の全量がログへ出ないこと（operational-policy §2）。
    for (const m of messages) {
      expect(m).not.toMatch(/postgres(ql)?:\/\//);
    }
  });

  it('やり直しはコールバックを最初から再実行する（tx 内の read が試行回数ぶん走り snapshot を取り直す）', async () => {
    // 実際の SSI はコールバックを実行し切った commit 時点で abort する。ここも「1 回目も cb を実行した上で
    // P2034」という経路にし、再試行が途中再開でなく先頭からのやり直しであることを read 回数で固定する。
    let attempt = 0;
    $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      attempt += 1;
      const result = await cb({ tx: true });
      if (attempt === 1) throw conflict();
      return result;
    });
    const read = jest.fn(async () => [{ id: 'f1' }]);
    const fn = jest.fn(async () => {
      await read();
      return 'ok';
    });

    await expect(runInSerializableTransaction(prisma, fn)).resolves.toBe('ok');

    expect($transaction).toHaveBeenCalledTimes(2);
    // 途中再開（古い read 結果の使い回し）だと read は 1 回で済んでしまう＝集合検証が stale snapshot で通る。
    expect(fn).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('既定回数すべて P2034 なら、それ以上は試さず最後の例外を投げ返す', async () => {
    const last = conflict();
    $transaction.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());
    $transaction.mockRejectedValueOnce(last);

    await expect(runInSerializableTransaction(prisma, async () => 'ok')).rejects.toBe(last);

    // 上限を外すと競合が続く間ループが終わらない。回数を完全一致で固定する。
    expect($transaction).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS);
  });

  it('maxAttempts で上限を変えられる（1 なら再試行なしで即 throw）', async () => {
    const error = conflict();
    $transaction.mockRejectedValueOnce(error);

    await expect(
      runInSerializableTransaction(prisma, async () => 'ok', { maxAttempts: 1 }),
    ).rejects.toBe(error);

    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['P2034 以外の Prisma エラー（P2002）', prismaError('P2002')],
    // P2028 / P2024 は「遅い・混んでいる」が原因。即やり直しても同じ結果になりやすく、待ち時間だけ
    // 倍増するため再試行しない（PrismaExceptionFilter が 503 + Retry-After へ写像する）。
    ['tx timeout（P2028）', prismaError('P2028')],
    ['接続プール待ち超過（P2024）', prismaError('P2024')],
    ['素の Error（業務ロジックの検証失敗など）', new Error('boom')],
  ])('%s は再試行せず即座に投げ返す', async (_label, error) => {
    $transaction.mockRejectedValueOnce(error);

    await expect(runInSerializableTransaction(prisma, async () => 'ok')).rejects.toBe(error);

    // 失敗した tx はロールバックされるので DB 側の副作用は残らないが、成功見込みの無い再試行は
    // 待ち時間と接続保持を倍増させるだけ（P2028 / P2024 は特に）。1 回で止めることを固定する。
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  describe('時間予算（deadline）', () => {
    it('既定予算は 1 回目の試行（timeout + maxWait）が収まり、全試行の合計には届かない', () => {
      // 「1 回は正常に終われる」かつ「最悪ケースまで粘らない」の両立が予算の設計意図。
      expect(DEFAULT_DEADLINE_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS + DEFAULT_MAX_WAIT_MS);
      expect(DEFAULT_DEADLINE_MS).toBeLessThan(
        DEFAULT_MAX_ATTEMPTS * (DEFAULT_TIMEOUT_MS + DEFAULT_MAX_WAIT_MS),
      );
    });

    it('残時間が短くなったら timeout と maxWait の両方が残時間へ縮退する', async () => {
      // 予算 1s・timeout 既定 15s / maxWait 既定 5s なら、どちらも残時間側が採用される。
      // maxWait を縮退し忘れると「予算切れ後にさらに接続待ちで 5s 待つ」ことになる。
      await runInSerializableTransaction(prisma, async () => 'ok', { deadlineMs: 1_000 });

      const [, txOptions] = $transaction.mock.calls[0] as [
        unknown,
        { timeout: number; maxWait: number },
      ];
      expect(txOptions.timeout).toBeLessThanOrEqual(1_000);
      expect(txOptions.timeout).toBeGreaterThan(0);
      expect(txOptions.maxWait).toBeLessThanOrEqual(1_000);
    });

    it('2 回目の試行は 1 回目で使った時間の分だけ timeout がさらに縮む', async () => {
      $transaction.mockRejectedValueOnce(conflict());
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(0); // 開始時刻
      nowSpy.mockReturnValueOnce(0); // 1 回目の残時間計算
      nowSpy.mockReturnValue(20_000); // 1 回目に 20s 使った状態で 2 回目の残時間を計算

      await runInSerializableTransaction(prisma, async () => 'ok');

      const first = ($transaction.mock.calls[0] as [unknown, { timeout: number }])[1];
      const second = ($transaction.mock.calls[1] as [unknown, { timeout: number }])[1];
      expect(first.timeout).toBe(DEFAULT_TIMEOUT_MS);
      // 残 10s なので 15s より短くなる＝リトライ経路でも縮退が効いている。
      expect(second.timeout).toBeLessThan(DEFAULT_TIMEOUT_MS);
    });

    it('残時間が僅かしかない時は試行を始めない（確実に失敗する tx で接続を掴まない）', async () => {
      $transaction.mockRejectedValueOnce(conflict());
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(0); // 開始時刻
      nowSpy.mockReturnValueOnce(0); // 1 回目の残時間計算
      nowSpy.mockReturnValue(DEFAULT_DEADLINE_MS - 1); // 残り 1ms

      await expect(runInSerializableTransaction(prisma, async () => 'ok')).rejects.toMatchObject({
        code: 'P2028',
      });

      // 1 回目だけ。残 1ms で 2 回目を開始していたら 2 になる。
      expect($transaction).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['窓を 1ms 下回る残時間では始めない', MIN_ATTEMPT_WINDOW_MS - 1, 0],
      ['窓を 1ms 上回る残時間なら始める', MIN_ATTEMPT_WINDOW_MS + 1, 1],
    ])('%s', async (_label, remaining, expectedCalls) => {
      // 境界を pin する＝窓の値を動かしたら「始める / 始めない」の線も一緒に動くことを明示する。
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(0); // 開始時刻
      nowSpy.mockReturnValue(DEFAULT_DEADLINE_MS - remaining);

      const call = runInSerializableTransaction(prisma, async () => 'ok');
      if (expectedCalls === 0) {
        await expect(call).rejects.toMatchObject({
          code: 'P2028',
          meta: { reason: 'deadline_budget_exceeded' },
        });
      } else {
        await expect(call).resolves.toBe('ok');
      }
      expect($transaction).toHaveBeenCalledTimes(expectedCalls);
    });

    it('1 度も始めなかった予算切れは、試行して尽きた場合とログで区別できる', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(0);
      nowSpy.mockReturnValue(DEFAULT_DEADLINE_MS);

      await expect(runInSerializableTransaction(prisma, async () => 'ok')).rejects.toMatchObject({
        code: 'P2028',
      });

      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('no attempt started'))).toBe(true);
    });

    it('予算切れの P2028 は実 P2028 と meta で区別できる（打ち手が正反対のため）', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(0);
      nowSpy.mockReturnValue(60_000);

      await expect(runInSerializableTransaction(prisma, async () => 'ok')).rejects.toMatchObject({
        code: 'P2028',
        meta: { reason: 'deadline_budget_exceeded' },
      });
      expect($transaction).not.toHaveBeenCalled();
    });

    it('予算を使い切ったら試行回数が残っていても即 P2028（→ 503 + Retry-After）で抜ける', async () => {
      // 1 回目で予算を食い潰す状況を作る（cb 内で経過時間が予算を超える）。
      $transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
        await cb({ tx: true });
        throw conflict();
      });
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(0); // 開始時刻
      nowSpy.mockReturnValueOnce(0); // 1 回目の残時間計算
      nowSpy.mockReturnValue(60_000); // 2 回目以降は予算超過

      await expect(runInSerializableTransaction(prisma, async () => 'ok')).rejects.toMatchObject({
        code: 'P2028',
      });

      // maxAttempts（3）に達する前に打ち切られること＝回数ではなく時間で止まっている。
      expect($transaction).toHaveBeenCalledTimes(1);
      expect($transaction.mock.calls.length).toBeLessThan(DEFAULT_MAX_ATTEMPTS);
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('deadline exceeded'))).toBe(true);
    });

    it('対話保存向けの上限セットは reorder 向け既定より短い（人が待つ操作は早く諦める）', () => {
      // 画面からの単票保存に reorder 500 件向けの 15s×3 を被せると、保存が詰まった時に
      // 1 接続を最長 45s 抱えてプール枯渇を押す（cmn-0251 の code-reviewer HIGH）。
      expect(INTERACTIVE_SAVE_TX_OPTIONS.timeout).toBeLessThan(DEFAULT_TIMEOUT_MS);
      expect(INTERACTIVE_SAVE_TX_OPTIONS.maxWait).toBeLessThan(DEFAULT_MAX_WAIT_MS);
      expect(INTERACTIVE_SAVE_TX_OPTIONS.deadlineMs).toBeLessThan(DEFAULT_DEADLINE_MS);
      // 1 試行ぶん（接続待ち＋実行）が収まり、なおリトライの余地が残ること。maxWait を絞らないと
      // 「待ち 5s + 実行 5s」で 1 試行目が予算 10s を丸ごと食い、競合が起きる時ほどリトライが 0 回になる。
      expect(INTERACTIVE_SAVE_TX_OPTIONS.deadlineMs).toBeGreaterThan(
        INTERACTIVE_SAVE_TX_OPTIONS.timeout + INTERACTIVE_SAVE_TX_OPTIONS.maxWait,
      );
    });
  });
});
