/**
 * 「実施して挙動が決まったユースケース」の控え（2026-10-25 / d824）。
 *
 * トラック別シナリオ（docs/scenarios/tracks）の状態は**実行の結果でだけ**動かす（README §5）。
 * 判定の最後に置いた「確認済みにする」行が通過したユースケースだけをここへ控え、scenario の後始末で
 * 控えの内容を残す。途中で落ちたシナリオは控えに到達しないため、印は動かない。
 *
 * **控えは、その控えを要求したシナリオの最後が緑だった時だけ残す**（d824）。同じ feature の前の
 * シナリオが実行中に落ちた場合、Playwright は後続のシナリオも落とす。その時点で「確認済みにする」行は
 * 走り終えているので、控えだけを見ると通ったように見える（実測 2026-10-26: mfa-login.feature の
 * 2 番目が落ちると、1 番目の S-OPS の控えが残った）。要求した時点のシナリオ番号を覚え、後始末が
 * 「そのシナリオより後ろで落ちていないか」を見てから控えを返す。
 *
 * 番号は同じ worker（＝同じテストファイルの並び）の中でだけ通す。Playwright は 1 つのファイルを
 * 1 worker で最後まで走らせるため、番号の衝突は起きない。結果はフィクスチャが終わる時に
 * `endScenario` で積み、次のシナリオの後始末が `verifiedCasesFor` で読む。
 */

/** 控えを要求したシナリオ（番号は同じファイルの並びで振る）。 */
type Claim = { trackId: string; scenarioId: number };

let scenarioSeq = 0;
const claims: Claim[] = [];
/** 終わったシナリオの結果（番号の小さい順には積まない。読む時に番号で引く）。 */
const scenarioResults = new Map<number, 'passed' | 'failed' | 'skipped'>();

/** シナリオごとに番号を振り直す（フィクスチャの setup から呼ぶ）。 */
export function beginScenario(): number {
  scenarioSeq += 1;
  return scenarioSeq;
}

/** シナリオの最後に結果を残す（フィクスチャの後始末から呼ぶ）。 */
export function endScenario(scenarioId: number, status: 'passed' | 'failed' | 'skipped'): void {
  scenarioResults.set(scenarioId, status);
}

/** シナリオが最後まで通った時に「このユースケースは確認済み」と控える（同じ ID・同じ回は 1 回だけ）。 */
export function markVerifiedCase(trackId: string): void {
  if (claims.some((c) => c.trackId === trackId && c.scenarioId === scenarioSeq)) return;
  claims.push({ trackId, scenarioId: scenarioSeq });
}

/**
 * 後始末が読む「本当に確認済みになったユースケース」。
 *
 * 判定は 1 方向でだけ読む。落ちたシナリオ自身が控えた ID は採らない（要求した行は通っていても、
 * シナリオは最後まで緑になっていない）。一度落ちたら、それより後ろの要求は採らない（後続は確かめ直し）。
 * 前のシナリオの控えは、そのシナリオの後始末の時点でまだ緑だったので残す（後の失敗は後に外れる）。
 *
 * - 要求していない ID は採らない（要求した ID だけを返す挙動は変えない）
 * - 同じ ID を二重に数えない（d771）
 */
export function verifiedCasesFor(): string[] {
  const failedIds = [...scenarioResults].filter(([, s]) => s === 'failed').map(([n]) => n);
  if (failedIds.length > 0) return [];
  const passed: string[] = [];
  for (const claim of claims) {
    if (failedIds.includes(claim.scenarioId)) continue;
    if (failedIds.some((n) => claim.scenarioId > n)) continue;
    if (!passed.includes(claim.trackId)) passed.push(claim.trackId);
  }
  return passed;
}

/** 控えを空にする（同じプロセスで次を回す時）。 */
export function resetVerifiedCases(): void {
  claims.length = 0;
  scenarioResults.clear();
  scenarioSeq = 0;
}
