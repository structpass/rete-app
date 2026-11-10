export const VALID_NODE_ENVS = ['production', 'development', 'test'] as const;
export type NodeEnv = (typeof VALID_NODE_ENVS)[number];

/**
 * NODE_ENV の存在 + 既知値を起動時に強制する。
 *
 * 本番ハードニング（`validateProductionSecrets` の secret 検証 / secure cookie /
 * connect-pg-simple の pg session ストア）は全て `NODE_ENV === 'production'` を発火条件に持つため、
 * 本番デプロイで NODE_ENV を設定し忘れる／typo すると、insecure secret・MemoryStore・非 secure cookie の
 * まま「黙って」起動してしまう（fail-open）。これを防ぐべく未設定・未知値を fail-fast で弾く
 * （operational-policy §4）。
 */
export function assertValidNodeEnv(nodeEnv: string | undefined): asserts nodeEnv is NodeEnv {
  if (!nodeEnv) {
    throw new Error(`NODE_ENV is required. Set it to one of: ${VALID_NODE_ENVS.join(', ')}.`);
  }
  if (!(VALID_NODE_ENVS as readonly string[]).includes(nodeEnv)) {
    throw new Error(`NODE_ENV must be one of ${VALID_NODE_ENVS.join(', ')} (got "${nodeEnv}").`);
  }
}

/** DATABASE_URL に必須の接続プール指定（cmn-0251）。 */
export const REQUIRED_DB_POOL_PARAMS = ['connection_limit', 'pool_timeout'] as const;

/**
 * 各パラメータの妥当域（cmn-0251）。存在するだけでは目的を満たさないため値まで見る。
 * - connection_limit: 0 は「上限なし」ではなく異常値。単一インスタンスで 20 を超える指定は
 *   DB の max_connections を食い潰す側なので弾く（増やすなら policy の勘定を先に更新する）。
 * - pool_timeout: 0 は「無限待ち」＝ P2024 → 503 に落ちず待ち続ける状態そのもの。
 *   最長のトランザクション上限（reorder 系 15 秒）より長く取る。
 */
const DB_POOL_PARAM_RANGE: Record<
  (typeof REQUIRED_DB_POOL_PARAMS)[number],
  { min: number; max: number }
> = {
  connection_limit: { min: 1, max: 20 },
  pool_timeout: { min: 15, max: 120 },
};

/**
 * DATABASE_URL に接続プールの上限指定があるかを検査する（cmn-0251・cmn-0347）。
 *
 * 上限が無いと Prisma 既定へ暗黙依存し、Serializable tx の同時実行が DB の max_connections を
 * 食い潰す経路が残る（枯渇は認証系まで巻き込む＝IpAllowlistGuard の cache miss が DB を引く）。
 * .env.example と operational-policy に書いただけでは既存の .env へ伝播しないため、
 * 実際の接続文字列を見る。
 *
 * **呼び出し面（適用範囲・cmn-0347）**:
 * - アプリ本体（main.ts）の起動時: 本番は fail-fast / dev・test は warn（開発を止めない）
 * - seed（prisma/seed.ts）: warn のみ・完走を止めない（環境構築の順序＝DB 作成 → seed → アプリ配備で
 *   プール指定なしのまま進むのを防ぐ。本番同様の起動拒否をすると順序が壊れるため警告に留める）
 * - migrate（prisma migrate）: CLI の別プロセスで検査の hook 点が無いため**適用範囲外**
 *
 * @returns null = OK / string = 欠けている旨のメッセージ（本番は起動を止める理由になる）
 */
export function validateDatabasePoolLimits(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null; // DATABASE_URL 自体の必須検査は main.ts の REQUIRED_ENV_VARS が担う。

  let query: URLSearchParams;
  try {
    query = new URL(databaseUrl).searchParams;
  } catch {
    // URL として読めない接続文字列は本検査の対象外（形式不正は Prisma 側が起動時に落とす）。
    return null;
  }

  const problems: string[] = [];
  for (const param of REQUIRED_DB_POOL_PARAMS) {
    const raw = query.get(param);
    if (!raw) {
      problems.push(`${param} が未指定`);
      continue;
    }
    // 「存在するだけ」では目的を満たさない（pool_timeout=0 は無限待ち＝防ぎたい状態そのもの）。
    if (!/^\d+$/.test(raw)) {
      problems.push(`${param} が整数ではない（got "${raw}"）`);
      continue;
    }
    const { min, max } = DB_POOL_PARAM_RANGE[param];
    const value = Number(raw);
    if (value < min || value > max) {
      problems.push(`${param} が想定域 ${min}〜${max} の外（got ${value}）`);
    }
  }
  if (problems.length === 0) return null;

  return (
    `DATABASE_URL の接続プール指定に問題があります（${problems.join(' / ')}）。` +
    '.env の DATABASE_URL へ ?connection_limit=5&pool_timeout=20 相当を設定してください' +
    '（上限が無い／緩すぎると同時実行が DB の max_connections を食い潰し、認証系まで巻き込みます・cmn-0251）。'
  );
}

/**
 * first-party RP（Rete=IdP へ静的登録する OIDC client）の env 定義。
 *
 * 3 つ目の RP を足す時はこの表へ 1 件追加する。登録側（oidc-config.factory.ts）も本表を読むため、
 * env 名を登録側と検査側で二重に書かずに済む（検査-実施ドリフト防止・cmn-0249）。
 */
export interface OidcRpDefinition {
  /** 警告ログ・識別用の名前。 */
  label: string;
  clientIdEnvKey: string;
  clientSecretEnvKey: string;
  redirectUrisEnvKey: string;
  /** client_id env が未設定の時の既定値。 */
  defaultClientId: string;
  /** 起動エラー文言に添える根拠（チケット / ADR）。 */
  ticketRef: string;
}

/** RP: struct-pass-reference（d1167 以前からの first-party RP）。 */
export const OIDC_REFERENCE_RP: OidcRpDefinition = {
  label: 'reference',
  clientIdEnvKey: 'OIDC_REFERENCE_CLIENT_ID',
  clientSecretEnvKey: 'OIDC_REFERENCE_CLIENT_SECRET',
  redirectUrisEnvKey: 'OIDC_REFERENCE_REDIRECT_URIS',
  defaultClientId: 'struct-pass-reference',
  ticketRef: 'cmn-0230・cmn-0249',
};

/** RP: 報告管理 gmis（d1167 で追加した 2 つ目の first-party RP）。 */
export const OIDC_GMIS_RP: OidcRpDefinition = {
  label: 'gmis',
  clientIdEnvKey: 'OIDC_GMIS_CLIENT_ID',
  clientSecretEnvKey: 'OIDC_GMIS_CLIENT_SECRET',
  redirectUrisEnvKey: 'OIDC_GMIS_REDIRECT_URIS',
  defaultClientId: 'gmis',
  ticketRef: 'd1167・ADR 0096',
};

/** 静的登録する first-party RP の一覧。追加はここへ 1 件。 */
export const OIDC_RP_DEFINITIONS: readonly OidcRpDefinition[] = [OIDC_REFERENCE_RP, OIDC_GMIS_RP];

/**
 * OIDC RP の redirect_uris env を「登録対象の形」に正規化する（cmn-0249）。
 *
 * 起動チェック側と実登録側それぞれに split → trim → filter(Boolean) のロジックが
 * 独立して書かれていたため、片方だけ直すと「起動は通るが client が登録されない／その逆」
 * の検査-実施ドリフトが生じる。本関数を 1 本の正本とし、両側から必ず同じ結果を返す。
 *
 * - 空文字 / undefined / 空要素のみ / 空白のみ / カンマのみのいずれも空配列
 * - 重複する値は先勝ちで除去
 */
export function parseOidcRedirectUris(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * 本番で「合言葉（RP の client secret）設定あり＋戻り先未設定」だけを起動エラーに
 * する条件付きバリデータ（cmn-0230 / cmn-0249 と同型・d1167）。
 *
 * 未設定の本番はその RP 連携を使わないので従来どおり起動できる。
 * 設定済の本番では redirect URI の「有効値が1件以上あること」と「全件が http(s) で localhost
 * 宛でないこと」を検査する。1件でも条件を満たさない URI があると起動エラー。
 *
 * 形式検査は `new URL()` のパース失敗＝URI 形式不正／`protocol` が `http:` または `https:` 以外
 * ／本番では `hostname` が `localhost` / `127.0.0.1` / `::1` のいずれかに該当＝NG。
 *
 * @returns null = OK / string = 起動を止めるべき理由
 */
function validateRedirectUriRequiredInProduction(rp: OidcRpDefinition): string | null {
  if (process.env.NODE_ENV !== 'production') return null;
  if (!process.env[rp.clientSecretEnvKey]) return null;
  const parsed = parseOidcRedirectUris(process.env[rp.redirectUrisEnvKey]);
  if (parsed.length === 0) {
    return (
      `${rp.redirectUrisEnvKey} に有効な値が1件も設定されていません（未設定 / 空要素のみ / 空白のみ / カンマのみ）。` +
      `${rp.clientSecretEnvKey} を使うなら redirect URI を1件以上設定してください（${rp.ticketRef}）。`
    );
  }
  for (const uri of parsed) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return `${rp.redirectUrisEnvKey} の値 "${uri}" は有効な URL 形式ではありません（${rp.ticketRef}）。`;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `${rp.redirectUrisEnvKey} の値 "${uri}" の scheme は http/https のみ許容です（got "${url.protocol}"・${rp.ticketRef}）。`;
    }
    // new URL('https://[::1]:3000/cb').hostname はブラケット付き '[::1]' を返すため、生の '::1' との
    // 比較は永久に不一致で IPv6 ループバックが検査を素通りする（rev-quality 2026-07-31 是正）。
    // ブラケットを剥いでから判定する。127.0.0.0/8 は全域がループバック、0.0.0.0 もローカル宛のため
    // 個別 IP だけ列挙せず網を掛ける。
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (
      hostname === 'localhost' ||
      /^127\./.test(hostname) ||
      hostname === '::1' ||
      hostname === '0.0.0.0'
    ) {
      return `${rp.redirectUrisEnvKey} の値 "${uri}" は localhost 宛のため本番では使用できません（${rp.ticketRef}）。`;
    }
  }
  return null;
}

/** reference（struct-pass-reference）の redirect URI 検査。 */
export function validateReferenceRedirectUriRequiredInProduction(): string | null {
  return validateRedirectUriRequiredInProduction(OIDC_REFERENCE_RP);
}

/** gmis（報告管理）の redirect URI 検査（d1167・reference と同型）。 */
export function validateGmisRedirectUriRequiredInProduction(): string | null {
  return validateRedirectUriRequiredInProduction(OIDC_GMIS_RP);
}
