/**
 * dsk-0413: e2e 一意名組織のスイープ判定（純粋関数）。
 *
 * 役割:
 *   - E2E_ORG_NAME_PATTERNS: プロセス中断で残った e2e 組織を識別する正規表現配列
 *   - isE2EOrgName: 組織名 → スイープ対象判定
 *
 * これを単体テスト（__tests__/sweep-e2e-orgs.test.ts）から直接読み、
 * global-setup.ts からは fetch ループのターゲット抽出に利用する。
 * 名前は Lower-Kebab + 13 桁 timestamp + 6 文字 random のみ（大文字は不可）。
 */

export const E2E_ORG_NAME_PATTERNS: RegExp[] = [
  /^org-logistics-[0-9]{13}-[a-z0-9]{6}$/,
  /^org-refuse-[0-9]{13}-[a-z0-9]{6}$/,
  /^orgmove-org-[0-9]{13}-[a-z0-9]{6}$/,
  /^rejoin-org-[0-9]{13}-[a-z0-9]{6}$/,
  /^chadd-org-[0-9]{13}-[a-z0-9]{6}$/,
  /^toggle-org-[0-9]{13}-[a-z0-9]{6}$/,
  /^partner-org-[0-9]{13}-[a-z0-9]{6}$/,
  /^mgr-org-[0-9]{13}-[a-z0-9]{6}$/,
  /^del-org-[0-9]{13}-[a-z0-9]{6}$/,
  /^url-org-[0-9]{13}-[a-z0-9]{6}$/,
  // シナリオが「一意名 を生成して」作る組織（接頭辞 + 13 桁の時刻 + 6 文字の乱数）。
  /^e2e-[a-z0-9-]+-[0-9]{13}-[a-z0-9]{6}$/,
];

/** 組織名が e2e 一意名スイープ対象なら true。null/undefined は false。 */
export function isE2EOrgName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  return E2E_ORG_NAME_PATTERNS.some((re) => re.test(name));
}

/**
 * 組織名が e2e の試験の名札か（d969: 残骸の掃除で使う対象判定）。
 *
 * 試験が作る組織は、名前の後に「13 桁の時刻 + 6 文字の乱数」が付く（シナリオの一意名 e2e-org-… や
 * e2e-unseen-…-org はこの形、固定名の org-logistics-… 等は下の一覧）。
 * **接頭辞だけで判定しない**（d1023: 人が試しに付けた `e2e-try` のような名前を毎回アーカイブしてしまう）。
 */
export function isE2ENamedOrg(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  return isE2EOrgName(name);
}
