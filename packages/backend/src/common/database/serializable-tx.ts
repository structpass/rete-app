import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';

/** Serializable リトライの既定上限。Serializable(SSI) は並走更新で正常に abort（P2034）されうるため少数回まで再試行する。 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * interactive transaction の既定 timeout（ms）。
 *
 * 最長の呼び出しは reorder 系の 500 件（announcement.reorder / desk-groups.reorderGroups /
 * moveMemberAndReorder）で、いずれも 1 件ずつ update を投げる。DB が重い時の 1 往復 10ms を想定すると
 * 約 5 秒＝Prisma 既定（5s）とちょうど境界になり、混雑時に P2028 で打ち切られる。3 倍の余裕を取る。
 * 既定値をライブラリ任せにしない（Prisma 側の既定が変わっても挙動が動かない）こと自体も目的。
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** interactive transaction の既定 maxWait（ms・接続をプールから待つ上限）。Prisma 既定は 2s。 */
export const DEFAULT_MAX_WAIT_MS = 5_000;

/**
 * リトライを含めた「呼び出し全体」の時間予算（ms）。
 *
 * timeout は 1 回の試行にしか効かないため、これが無いと最悪 maxAttempts 分（15s+5s の待ちが 3 回＝
 * 60s 超）まで伸び、その間クライアントは待たされ接続スロットも保持され続ける（混雑時に増幅する）。
 * 予算 = maxAttempts 3 × (timeout 15s + maxWait 5s) には意図的に届かせず、
 * 「粘るのは 1 回目の試行が正常に終わる範囲まで」として 30s を既定にする。
 */
export const DEFAULT_DEADLINE_MS = 30_000;

/**
 * 対話保存（画面から 1 件を保存する操作）向けの上限セット。
 *
 * 既定値は reorder 系（500 件を 1 件ずつ update）に合わせてあるため、単票の保存に被せると
 * 「保存が詰まった時に 1 リクエストが接続を 15s×3 保持する」ことになり、プール枯渇を押す側へ回る
 * （移行前の直 $transaction は Prisma 既定 5s・リトライなしだった）。人が待っている操作は
 * 早く諦めて 409/503 を返すほうが体感も資源効率も良いので、短い上限を明示して使う（cmn-0251）。
 */
export const INTERACTIVE_SAVE_TX_OPTIONS = {
  timeout: 5_000,
  // 接続待ちも絞る（移行前の Prisma 既定と同じ 2s）。既定 5s のままだと
  // 「待ち 5s + 実行 5s」で 1 試行目が予算 10s を丸ごと食い、混雑時＝競合が起きる時ほど
  // P2034 リトライが 1 回も走らない（ヘルパへ寄せた目的が消える）。
  maxWait: 2_000,
  deadlineMs: 10_000,
} as const;

/**
 * 試行を始めるのに必要な最小の残時間（ms）。
 *
 * これを下回る残りで tx を開いても、接続を取って BEGIN した直後に実 P2028 で死ぬだけで、
 * 混んでいる時に最も無駄な接続取得を 1 回増やす。始めずに予算切れとして扱う。
 * 呼び出し側から下限が見えるよう export する（deadlineMs をこれ未満にすると 1 試行も走らない）。
 *
 * **根拠の明記（cmn-0347）**:
 * - この値は実測値ではなく「これ未満の残りで開いても無駄になる」という見込みの下限。
 * - 外れても影響は両方向とも度合いの差に留まる（窓を大きくすると無駄な接続取得が増え、
 *   小さくすると「試行できるはずのギリギリ」を諦める＝どちらも生死を分ける境界ではない）。
 * - 本番ログに `no attempt started` が現れたら再検討する（予算に比して窓が大きすぎる＝
 *   実際の負荷でこの警告が出るのは、予算が短い呼び出しで窓が足を引っ張っている証拠）。
 */
export const MIN_ATTEMPT_WINDOW_MS = 250;

/** リトライ待機（full jitter）の基準値と上限（ms）。総試行 3 回なら最悪でも 25+50=75ms 程度で体感されない。 */
const RETRY_BACKOFF_BASE_MS = 25;
const RETRY_BACKOFF_CAP_MS = 200;

const logger = new Logger('runInSerializableTransaction');

export interface SerializableTransactionOptions {
  /** 総試行回数の上限（既定 {@link DEFAULT_MAX_ATTEMPTS}）。 */
  maxAttempts?: number;
  /** tx 全体の制限時間 ms（既定 {@link DEFAULT_TIMEOUT_MS}）。 */
  timeout?: number;
  /** 接続をプールから待つ上限 ms（既定 {@link DEFAULT_MAX_WAIT_MS}）。 */
  maxWait?: number;
  /**
   * リトライを含む呼び出し全体の時間予算 ms（既定 {@link DEFAULT_DEADLINE_MS}）。
   * {@link MIN_ATTEMPT_WINDOW_MS} 未満は「無制限」ではなく「1 試行もせず即時失敗」の意味になる。
   */
  deadlineMs?: number;
}

/**
 * 時間予算を使い切った時に投げるエラー。
 *
 * HTTP 例外は投げない（repository / common 層が HTTP 層の語彙を持たないため）。
 * P2028（tx timeout）として表現すれば PrismaExceptionFilter が既存の写像で 503 + Retry-After を返す
 * ＝「混んでいるので後で来てほしい」という意味が、混雑由来の実 P2028 と同じ経路で伝わる。
 */
function deadlineExceededError(deadlineMs: number): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Serializable transaction deadline exceeded (${deadlineMs}ms budget)`,
    {
      code: 'P2028',
      clientVersion: Prisma.prismaVersion.client,
      // 実 P2028（1 回の tx が単体で遅い＝クエリ / index 側の問題）と、こちらの予算切れ
      // （競合リトライで時間を使い切った＝競合を減らす側の問題）は打ち手が正反対。
      // HTTP 応答は同じ 503 のままだが、機械で数え分けられる識別子を残す（meta は応答へ出ない）。
      meta: { reason: 'deadline_budget_exceeded', deadlineMs },
    },
  );
}

/**
 * full jitter のバックオフ。競合した 2 者が同じ間隔で再突入して再び衝突するのを防ぐため、
 * 待機時間を 0〜上限の一様乱数にする（固定間隔では競合が解けにくい）。
 */
function backoffDelayMs(attempt: number): number {
  const cap = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(Math.random() * cap);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** raw SQL の SSI / deadlock だけをモデル更新と同じ競合へ揃える。 */
function normalizeTransactionError(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010' &&
    (error.meta?.code === '40001' || error.meta?.code === '40P01')
  ) {
    return new Prisma.PrismaClientKnownRequestError('Serializable transaction write conflict', {
      code: 'P2034',
      clientVersion: error.clientVersion,
      meta: { sqlState: error.meta.code },
    });
  }
  return error;
}

/**
 * Serializable（SSI）トランザクションを、競合 abort（P2034）時に自動リトライしながら実行する共通ヘルパ。
 *
 * reorder 系（favorites / files / announcement）が「現存集合の読み取り → 集合検証 → 一括更新 → 再読込」を
 * 1 つの直列化 tx に閉じるために共通利用する（規約 §3: 同一パターンの逐語コピーを各 repository に持たない）。
 * fn には interactive transaction の TransactionClient が渡る。
 *
 * **$transaction の形式選択基準（cmn-0347）**: このヘルパ（interactive・callback 形式）を使うのは
 * 「同一 tx 内で前の結果を見て次のクエリを組み立てる／検証 → 更新 → 再読込を 1 本のスナップショットに
 * 閉じる」場合だけ。独立した複数クエリをただまとめて原子化するだけなら配列形式（prisma.$transaction([...]）を
 * 使い、timeout / maxWait は同じ値を渡す。なお P2034 の自動リトライと deadlineMs（時間予算）は
 * **interactive 側の専売**で、配列形式は競合があればそのまま P2034 を投げ返す（リトライしない）＝
 * 原子化のみが必要な箇所に使う（settings.repository の deleteSystem 等が前例）。基準の重複記載は
 * repository 側に置かない（更新漏れで食い違う温床になるため、各 repository はこの 1 箇所への pointer だけを残す）。
 *
 * raw SQL の P2010 + SQLSTATE 40001 / 40P01 も P2034（write conflict）へ正規化する。
 * リトライするのは P2034 だけ。P2028（tx timeout）/ P2024（接続待ち超過）は「遅い・混んでいる」
 * が原因で即やり直しても同じ結果になりやすく、待ち時間だけ倍増するため再試行せず投げ返す
 * （PrismaExceptionFilter が 503 + Retry-After へ写像する）。P2034 も上限到達後はそのまま投げる（→ 409）。
 *
 * 時間の上限は 2 段ある: timeout は 1 回の試行、deadlineMs はリトライを含む呼び出し全体。
 * 予算を使い切ったら試行回数が残っていても粘らず P2028 相当で抜ける（→ 503 + Retry-After）。
 * 既定値は reorder 系（500 件）向けなので、画面からの単票保存には
 * {@link INTERACTIVE_SAVE_TX_OPTIONS} を渡す（人が待つ操作は早く諦める）。
 *
 * なお同じ競合が、リトライで解ければ成功・上限で解けなければ 409（WRITE_CONFLICT）・
 * 予算切れなら 503 になる＝負荷次第で 409 と 503 に振れる。クライアントはどちらも「やり直し可」
 * として扱えばよい（待ち時間の目安が要るのが 503 側）。
 */
export async function runInSerializableTransaction<T>(
  prisma: PrismaService,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableTransactionOptions = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeout = DEFAULT_TIMEOUT_MS,
    maxWait = DEFAULT_MAX_WAIT_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
  } = options;

  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    // 残時間で判断する（試行回数が残っていても予算を超えたら粘らない）。
    // 残りが窓を下回る時も始めない＝確実に失敗する試行で接続を掴まない。
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining < MIN_ATTEMPT_WINDOW_MS) {
      // 「試行して尽きた」と「窓が足りず 1 度も始めなかった」を読み分けられるようにする。
      const reason =
        attempt === 1
          ? `no attempt started (remaining < ${MIN_ATTEMPT_WINDOW_MS}ms)`
          : `after ${attempt - 1}/${maxAttempts} attempts`;
      logger.warn(`Serializable transaction deadline exceeded ${reason} (budget ${deadlineMs}ms)`);
      throw deadlineExceededError(deadlineMs);
    }

    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // 1 回の試行が予算の残りをはみ出さないよう残時間へ縮退させる（縮退しないと
        // 最後の試行が予算を大幅に超えて走り切る）。接続待ち（maxWait）も同じ理由で縮退させる
        // ＝縮退させないと「予算切れ後にさらに maxWait 待つ」ことになり、最も混んでいる時に
        // 最も無駄な待ちが乗る。
        timeout: Math.min(timeout, remaining),
        maxWait: Math.min(maxWait, remaining),
      });
    } catch (e) {
      // Prisma の raw query は SSI / deadlock を P2010 に包む。通常のモデル更新と同じ
      // 再試行・上限到達時の 409 写像を維持する。SQL 構文エラー等は再試行しない。
      const error = normalizeTransactionError(e);
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034' &&
        attempt < maxAttempts
      ) {
        const delay = backoffDelayMs(attempt);
        // 競合頻度は事後に一切分からないため計測できる痕跡を残す（operational-policy §2: warn = リトライ可能失敗）。
        // 入力値・接続情報は載せない。
        logger.warn(
          `Serializable transaction conflict (P2034); retrying ${attempt + 1}/${maxAttempts} after ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
}
