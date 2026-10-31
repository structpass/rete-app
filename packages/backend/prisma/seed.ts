import {
  PrismaClient,
  Prisma,
  ChatThemeStatus,
  TaskStatus,
  Role,
  MembershipScopeType,
} from '@prisma/client';
import {
  DEFAULT_ORG_ID,
  DEFAULT_PROJECT_ID,
  DEFAULT_CHANNEL_ID,
  REACTION_EMOJIS,
} from '@rete/shared';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
// set-0096: 姓・名分割は backend common の SSOT を使う（invite / migration と同型）。
import { splitDisplayName } from '../src/common/display-name';
import { validateDatabasePoolLimits } from '../src/common/config/env-validation';

const prisma = new PrismaClient();

// シード実行時刻の基準。チャットの createdAt / lastMessageAt をこの時点からの相対で配置する。
const NOW = new Date();

// dev 用ログインアカウント。譲渡先・本番では SEED_ADMIN_PASSWORD を必ず変更する。
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@rete.local';
// 既定（= 公開リポジトリに平文で存在する）パスワード。強制パスワード変更フローを撤去したため、
// この値のまま admin が OIDC ログインできてしまう。production では未設定を main() 冒頭で fail-fast 禁止する。
const DEFAULT_ADMIN_PASSWORD = 'ReteAdmin1234!';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;
// デモ連携アカウント共通パスワード（dev のみ）。SSO 動作確認用に frictionless にしておく。
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'ReteDemo1234!';

// 初期管理者の OIDC sub（= rete Account.id）。struct-pass-reference 側 seed の User.oidcSub と
// 同じ値で揃えることで、初回 SSO ログインを sub 直接ヒットさせる（decision 0007: bootstrap=sub 直接指定）。
// 譲渡先・本番では両リポの BOOTSTRAP_ADMIN_SUB を同一の新規 uuid に差し替える（鍵の引き渡し）。
const BOOTSTRAP_ADMIN_SUB =
  process.env.BOOTSTRAP_ADMIN_SUB ?? '00000000-0000-4000-a000-000000000001';

// デモユーザーの固定 sub。**struct-pass-reference 側 seed（prisma/seed/users.ts の DEMO_SUBS）と
// 必ず同一値に保つこと**。不一致だと SSO ログイン時に sub がヒットせず JIT が別ユーザーを作る。
// 両リポは別 repo のため、この対応表は手動で同期する（single source は spec §8）。
const DEMO_SUBS = {
  whUser: '00000000-0000-4000-a000-000000000002',
  whAdmin: '00000000-0000-4000-a000-000000000003',
  ofUser: '00000000-0000-4000-a000-000000000004',
  ofAdmin: '00000000-0000-4000-a000-000000000005',
  tanaka: '00000000-0000-4000-a000-000000000006',
} as const;

// reference 側に**ミラーされていない** sub。初回 SSO ログインで reference が sub ヒットせず
// pending（role=null / isActive=false）ユーザーを JIT 生成 → 管理者承認フローを実演するためのデモ用。
const PENDING_DEMO_SUB = '00000000-0000-4000-a000-000000000007';

// cmn-0139: MFA ログイン e2e（mfa-login.feature）の専用アカウント。MEMBER・MFA 無効で seed 焼き込み、
// MFA 有効化はシナリオ内 API で回す（暗号鍵依存と replay counter 衝突を避けるため seed では有効化しない）。
// global-setup のセッションキャッシュには載せない（scenario 内ログインのため）。
const MFA_DEMO_SUB = '00000000-0000-4000-a000-000000000008';

// タスクの機能領域分類マスタは rete-desk-0158 で **Space 単位スコープ** へ移行した。
// 各 Space（チャネル/グループ/個人）が独自の分類セットを持ち、name は @@unique([spaceId, name])
// で Space 内一意（別 Space は同名可）。分類定義は seedCategories（spaceId を解決して per-space に upsert）が
// 担い、ここでは「どの Space にどの分類を作るか」のデータ表だけを宣言する。
//
// SPACE_CATEGORY_DEFS のキーは EXT_CHANNELS / EXT_GROUPS 等の固定 ID（cmId）または DEFAULT_CHANNEL_ID。
// 値は (name, sortOrder) の配列。**意図的に分類ゼロの Space を残す**（GROUP / 個人メモ / DM の一部）ことで
// 「新規 Space は分類未作成で OK（空 Space）」のデモ状態を再現する（rete-desk-0158 D2）。
// なお spaceId は seedCategories 実行時に下の cmId(...) ヘルパで解決するため、本表はここでは ID を持たず
// seedCategories 内で組み立てる（cmId は EXT_* 定義より後ろで宣言されるため）。

// テナント設定（ST-1）の singleton + 契約システム（外部 2 + isRete 内部 2: デスク/ファイル）。
// 外部契約は実運用名「Rete」「リファレンス」（set-0064。ダミー system-A/B/C は廃止）。
// isRete 内部: RETE-CHAT/RETE-TASK を RETE-DESK に統合、RETE-FILE を「ファイル」に短縮（set-0104）。
// 細粒度（チャット/タスク/ファイル）は rete_feature 権限層側。旧 id は seedTenant の notIn 掃除で削除。
// id は安定コード（既存 FK・割当 seed を壊さないよう SYS-001/SYS-002 を再利用。旧 SYS-003 は seedTenant で削除）。
// Tenant は単一テナント前提（ADR 0017）のため固定 id 'singleton'。
// ※ TENANT_SINGLETON_ID は settings.constants.ts の同名定数と同値を維持すること（seed は backend module
//   に依存させないため再宣言。値が乖離すると seed と app で別行を指す）。
const TENANT_SINGLETON_ID = 'singleton';
const TENANT_SEED = { name: '開発法人', badgeColor: 'none' } as const;
const TENANT_SYSTEM_DEFS = [
  { id: 'SYS-001', name: 'Rete', isRete: false, sortOrder: 1 },
  { id: 'SYS-002', name: 'リファレンス', isRete: false, sortOrder: 2 },
  { id: 'RETE-DESK', name: 'デスク', isRete: true, sortOrder: 3 },
  { id: 'RETE-FILE', name: 'ファイル', isRete: true, sortOrder: 4 },
] as const;

// reference 側 demo users とメール/表示名を一致させ、初回 SSO ログイン後も email 上書き churn を起こさない。
const DEMO_ACCOUNT_DEFS = [
  { id: DEMO_SUBS.whUser, email: 'wh-user@struct-pass.example', name: '倉庫 一郎' },
  { id: DEMO_SUBS.whAdmin, email: 'wh-admin@struct-pass.example', name: '倉庫 管理太郎' },
  { id: DEMO_SUBS.ofUser, email: 'of-user@struct-pass.example', name: '事務 花子' },
  { id: DEMO_SUBS.ofAdmin, email: 'of-admin@struct-pass.example', name: '事務 管理子' },
  { id: DEMO_SUBS.tanaka, email: 'tanaka@struct-pass.example', name: '田中 太郎' },
  // reference 未ミラー → 初回 SSO で pending 承認待ちを実演。E2E の招待の受諾（S-SET-08）は、
  // この人を**招待の宛先に使わない**（受諾の成立を試すとこの行が後始末で消えるため・d834）
  { id: PENDING_DEMO_SUB, email: 'newcomer@struct-pass.example', name: '新人 太郎' },
  // cmn-0139: mfa-login.feature 専用。MFA 無効で seed 固定、シナリオ内で setup→confirm→teardown disable。
  { id: MFA_DEMO_SUB, email: 'mfa-user@rete.local', name: 'MFA 検証子' },
] as const;

interface AccountSeed {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  mustChangePassword: boolean;
  // テナント内ロール（RBAC 最小核）。掲示板の変更系は ADMIN のみ。
  role: Role;
}

/**
 * id（=sub）キーで冪等に Account を upsert する。再実行で既存の password は変えないが、
 * mustChangePassword（管理用フラグ）は定義値に揃える（@updatedAt が連動して更新日も現在時刻になる）。
 * 旧 seed（auto-uuid）の同 email アカウントが別 id で残っていれば、sub に id を揃えるため作り直す。
 * rete Account は他テーブルから FK 参照されていないため dev での削除は安全。password は log に出さない。
 */
async function upsertAccount(def: AccountSeed) {
  const existing = await prisma.account.findUnique({ where: { email: def.email } });
  if (existing && existing.id !== def.id) {
    await prisma.account.delete({ where: { id: existing.id } });
    console.log(`Removed stale account (id=${existing.id}) to align with sub ${def.id}`);
  }
  const { familyName, givenName } = splitDisplayName(def.name);
  await prisma.account.upsert({
    where: { id: def.id },
    // role は再実行でも定義値へ揃える（権限の SoT を seed 側に保つ）。
    // name / 姓・名も seed 定義へ揃える（set-0096）。
    update: {
      mustChangePassword: def.mustChangePassword,
      role: def.role,
      name: def.name,
      familyName,
      givenName,
    },
    create: {
      id: def.id,
      email: def.email,
      passwordHash: def.passwordHash,
      name: def.name,
      familyName,
      givenName,
      mustChangePassword: def.mustChangePassword,
      role: def.role,
    },
  });
}

async function main() {
  // cmn-0347: 接続プール上限の検査はアプリ本体（main.ts）の起動時が本線で、seed は独立プロセス
  // （PrismaClient 直生成）のため素通りする。環境構築の順序（DB 作成 → seed → アプリ配備）で
  // プール指定なしのまま進み、後でアプリだけ起動失敗するのを防ぐため、seed でも同じ検査を走らせ
  // 問題があれば警告を出して続行する（throw しない＝seed の完走を止めない。NODE_ENV 検査は下の fail-closed が担う）。
  const seedPoolProblem = validateDatabasePoolLimits(process.env.DATABASE_URL);
  if (seedPoolProblem) {
    console.warn(`[seed] ${seedPoolProblem}`);
    console.warn(
      '[seed] このまま続行しますが、アプリ本体（main.ts）は本番で起動を拒否します（dev は警告のみ）。' +
        ' .env の DATABASE_URL へ ?connection_limit=5&pool_timeout=20 相当を設定してください。',
    );
  }

  // fail-closed ガード（rete-hardening-0004）。seed は dev/test 専用の破壊的スクリプト（全件 createMany 等）。
  // NODE_ENV が development/test 以外（production・未設定・想定外値）では、明示 opt-in（ALLOW_SEED=1）が無い限り
  // 実行そのものを拒否する。**未設定も拒否**するのが肝＝NODE_ENV 設定を忘れた本番環境への seed 混入を技術的に防ぐ
  // （fail-open=「未設定なら走る」を排除）。dev は .env の NODE_ENV=development（または `pnpm prisma:seed` の cross-env
  // 注入）で素通りする。opt-in は厳密に `=== '1'` で判定（`ALLOW_SEED=0`/`false` を「無効化」と誤信したまま走らせない）。
  // 本番リストア等で意図的に seed したい時のみ ALLOW_SEED=1 を付ける。
  const seedEnv = process.env.NODE_ENV;
  if (seedEnv !== 'development' && seedEnv !== 'test' && process.env.ALLOW_SEED !== '1') {
    throw new Error(
      `Refusing to seed: NODE_ENV is "${seedEnv ?? '(unset)'}" (expected development/test). ` +
        'Set ALLOW_SEED=1 to seed explicitly (e.g. production restore).',
    );
  }
  // 強制パスワード変更フロー撤去に伴う安全弁。production で SEED_ADMIN_PASSWORD 未設定（= 既定の公開
  // パスワードのまま）の seed を拒否する。既知パスワードで IdP admin が奪取され全 RP へ SSO 横展開
  // されるのを技術的に防ぐ（operational-policy §4: env 必須値は起動時 fail-fast）。
  if (process.env.NODE_ENV === 'production' && !process.env.SEED_ADMIN_PASSWORD) {
    throw new Error(
      'SEED_ADMIN_PASSWORD must be set in production. Refusing to seed bootstrap admin with the public default password.',
    );
  }
  // 同じ安全弁をデモアカウント共通パスワードにも適用する。production で SEED_DEMO_PASSWORD 未設定
  // （= 公開リポ掲載の既定パスワード）の seed を拒否し、既知パスワードでのデモアカウント奪取を防ぐ。
  if (process.env.NODE_ENV === 'production' && !process.env.SEED_DEMO_PASSWORD) {
    throw new Error(
      'SEED_DEMO_PASSWORD must be set in production. Refusing to seed demo accounts with the public default password.',
    );
  }

  // identity SoT の初期管理者（bootstrap）。id を BOOTSTRAP_ADMIN_SUB に固定。
  // 強制パスワード変更フローは撤去済みのため「パスワード変更済み」状態（mustChangePassword=false）で配布し、
  // 初回から無入力でシームレス SSO が通るようにする。譲渡先・本番は SEED_ADMIN_PASSWORD を必ず変更する運用。
  console.log('Seeding bootstrap admin account...');
  const adminPasswordHash = await hash(ADMIN_PASSWORD);
  await upsertAccount({
    id: BOOTSTRAP_ADMIN_SUB,
    email: ADMIN_EMAIL,
    name: 'Rete 管理者',
    passwordHash: adminPasswordHash,
    mustChangePassword: false,
    role: Role.ADMIN,
  });
  console.log(`Bootstrap admin seeded: ${ADMIN_EMAIL} (sub=${BOOTSTRAP_ADMIN_SUB})`);

  // SSO デモ連携アカウント。reference 側 seed と sub / email / name を揃えてある。
  // mustChangePassword=false で frictionless にログイン → reference で role 別の権限を体験できる。
  console.log('Seeding SSO demo accounts...');
  const demoPasswordHash = await hash(DEMO_PASSWORD);
  for (const def of DEMO_ACCOUNT_DEFS) {
    // 田中 太郎 はテナント管理者（掲示板の発信者）。他のデモアカウントは MEMBER（閲覧のみ）。
    const role = def.id === DEMO_SUBS.tanaka ? Role.ADMIN : Role.MEMBER;
    await upsertAccount({
      ...def,
      passwordHash: demoPasswordHash,
      mustChangePassword: false,
      role,
    });
  }
  console.log(
    `SSO demo accounts seeded: ${DEMO_ACCOUNT_DEFS.length} (incl. 1 unmirrored pending demo)`,
  );

  await seedCM2();
  await seedCategories();
  await seedChat();
  await seedChatMentions();
  await seedChatEngagement();
  await seedTasks();
  await seedFiles();
  await seedTags();
  await seedTenant();
  await seedAnnouncements();
  await seedAuditLogs();
}

// CM-2 拡張器の固定 ID 生成（DEFAULT は b000-…001/002/003 を消費済みのため新規は 010 以降を使う）。
// 全エンティティを安定 ID で upsert することで seed 再実行が完全冪等になり、既存 dev DB にも追加投入できる。
const cmId = (n: number) => `00000000-0000-4000-b000-${n.toString().padStart(12, '0')}`;

// 追加組織構造（多層 CM-2）。チャットの題材（倉庫/在庫業務）と地続きの組織を作り、テーマ/タスクの
// 器分散が業務的にも自然に見えるようにする。
const EXT_ORGS = [
  { id: cmId(10), name: '中央倉庫センター', sortOrder: 1 },
  { id: cmId(11), name: '管理本部', sortOrder: 2 },
] as const;
const EXT_PROJECTS = [
  { id: cmId(20), organizationId: cmId(10), name: '入出荷オペレーション', sortOrder: 1 },
  { id: cmId(21), organizationId: cmId(10), name: '在庫・棚卸', sortOrder: 2 },
  { id: cmId(22), organizationId: cmId(11), name: '経理・受発注', sortOrder: 1 },
] as const;
const EXT_CHANNELS = [
  { id: cmId(30), projectId: cmId(20), name: '入荷', sortOrder: 1 },
  { id: cmId(31), projectId: cmId(20), name: '出荷', sortOrder: 2 },
  { id: cmId(32), projectId: cmId(21), name: '在庫管理', sortOrder: 1 },
  { id: cmId(33), projectId: cmId(21), name: '棚卸', sortOrder: 2 },
  { id: cmId(34), projectId: cmId(22), name: '経理連携', sortOrder: 1 },
  { id: cmId(35), projectId: cmId(22), name: '受発注', sortOrder: 2 },
] as const;
// GROUP 器（メンバーは Membership scopeType=GROUP / 列は全 null）。
const EXT_GROUPS = [
  { id: cmId(40), name: '改善横断PJ' },
  { id: cmId(41), name: '新人オンボーディング' },
] as const;
// 個人メモ（PERSONAL_MEMO / ownerId のみ）。
const EXT_MEMOS = [
  { id: cmId(50), ownerId: DEMO_SUBS.tanaka, name: '田中 太郎 のメモ' },
  { id: cmId(51), ownerId: DEMO_SUBS.whAdmin, name: '倉庫 管理太郎 のメモ' },
] as const;
// 1:1 DM（PERSONAL_DM / ownerId + peerAccountId）。
const EXT_DMS = [
  {
    id: cmId(60),
    ownerId: DEMO_SUBS.tanaka,
    peerAccountId: DEMO_SUBS.whAdmin,
    name: '田中 ↔ 倉庫管理',
  },
  {
    id: cmId(61),
    ownerId: DEMO_SUBS.ofAdmin,
    peerAccountId: DEMO_SUBS.ofUser,
    name: '事務管理 ↔ 事務',
  },
] as const;
// 拡張スコープのメンバーシップ（ORG/PROJECT/GROUP × ADMIN/MEMBER を混在させる）。
const EXT_MEMBERSHIPS: {
  scopeType: MembershipScopeType;
  scopeId: string;
  accountId: string;
  role: Role;
}[] = [
  // 中央倉庫センター（組織）
  // set-0159: 開発統括（bootstrap admin）も可視化する（可視＝membership 原則・ADR 0037）。
  {
    scopeType: MembershipScopeType.ORGANIZATION,
    scopeId: cmId(10),
    accountId: BOOTSTRAP_ADMIN_SUB,
    role: Role.ADMIN,
  },
  {
    scopeType: MembershipScopeType.ORGANIZATION,
    scopeId: cmId(10),
    accountId: DEMO_SUBS.whAdmin,
    role: Role.ADMIN,
  },
  {
    scopeType: MembershipScopeType.ORGANIZATION,
    scopeId: cmId(10),
    accountId: DEMO_SUBS.whUser,
    role: Role.MEMBER,
  },
  {
    scopeType: MembershipScopeType.ORGANIZATION,
    scopeId: cmId(10),
    accountId: DEMO_SUBS.tanaka,
    role: Role.MEMBER,
  },
  // 管理本部（組織）
  // set-0159: 開発統括（bootstrap admin）も可視化する（可視＝membership 原則・ADR 0037）。
  {
    scopeType: MembershipScopeType.ORGANIZATION,
    scopeId: cmId(11),
    accountId: BOOTSTRAP_ADMIN_SUB,
    role: Role.ADMIN,
  },
  {
    scopeType: MembershipScopeType.ORGANIZATION,
    scopeId: cmId(11),
    accountId: DEMO_SUBS.ofAdmin,
    role: Role.ADMIN,
  },
  {
    scopeType: MembershipScopeType.ORGANIZATION,
    scopeId: cmId(11),
    accountId: DEMO_SUBS.ofUser,
    role: Role.MEMBER,
  },
  {
    scopeType: MembershipScopeType.ORGANIZATION,
    scopeId: cmId(11),
    accountId: DEMO_SUBS.tanaka,
    role: Role.ADMIN,
  },
  // プロジェクト
  {
    scopeType: MembershipScopeType.PROJECT,
    scopeId: cmId(20),
    accountId: DEMO_SUBS.whAdmin,
    role: Role.ADMIN,
  },
  {
    scopeType: MembershipScopeType.PROJECT,
    scopeId: cmId(20),
    accountId: DEMO_SUBS.whUser,
    role: Role.MEMBER,
  },
  {
    scopeType: MembershipScopeType.PROJECT,
    scopeId: cmId(21),
    accountId: DEMO_SUBS.whUser,
    role: Role.MEMBER,
  },
  {
    scopeType: MembershipScopeType.PROJECT,
    scopeId: cmId(22),
    accountId: DEMO_SUBS.ofAdmin,
    role: Role.ADMIN,
  },
  {
    scopeType: MembershipScopeType.PROJECT,
    scopeId: cmId(22),
    accountId: DEMO_SUBS.ofUser,
    role: Role.MEMBER,
  },
  // グループ
  {
    scopeType: MembershipScopeType.GROUP,
    scopeId: cmId(40),
    accountId: DEMO_SUBS.tanaka,
    role: Role.ADMIN,
  },
  {
    scopeType: MembershipScopeType.GROUP,
    scopeId: cmId(40),
    accountId: DEMO_SUBS.whAdmin,
    role: Role.MEMBER,
  },
  {
    scopeType: MembershipScopeType.GROUP,
    scopeId: cmId(40),
    accountId: DEMO_SUBS.ofAdmin,
    role: Role.MEMBER,
  },
  {
    scopeType: MembershipScopeType.GROUP,
    scopeId: cmId(41),
    accountId: DEMO_SUBS.whUser,
    role: Role.MEMBER,
  },
  {
    scopeType: MembershipScopeType.GROUP,
    scopeId: cmId(41),
    accountId: BOOTSTRAP_ADMIN_SUB,
    role: Role.ADMIN,
  },
];

/**
 * CM-2 器の seed（ADR 0037）。DEFAULT org/project/channel に加え、多層構造（複数 org/project/channel）と
 * GROUP / 個人メモ / 1:1 DM、複数スコープ membership を投入する。
 * 全エンティティを固定 ID の upsert で入れるため**完全冪等**（既存 dev DB に再実行しても追加・重複なし）。
 * 最後に spaceId null の chatTheme / task を DEFAULT_CHANNEL へ収容する（移行②相当・既存行のみ）。
 */
async function seedCM2() {
  console.log('Seeding CM-2 organizations / projects / spaces / memberships...');

  // 1. デフォルト org/project/channel（ADR 0037 §8 移行②の固定 ID）。
  await prisma.organization.upsert({
    where: { id: DEFAULT_ORG_ID },
    update: {},
    create: { id: DEFAULT_ORG_ID, name: '株式会社 Struct Pass', sortOrder: 0 },
  });
  await prisma.project.upsert({
    where: { id: DEFAULT_PROJECT_ID },
    update: {},
    create: {
      id: DEFAULT_PROJECT_ID,
      organizationId: DEFAULT_ORG_ID,
      name: 'General',
      sortOrder: 0,
    },
  });
  await prisma.space.upsert({
    where: { id: DEFAULT_CHANNEL_ID },
    update: {},
    create: {
      id: DEFAULT_CHANNEL_ID,
      kind: 'CHANNEL',
      projectId: DEFAULT_PROJECT_ID,
      name: '全体共通',
      sortOrder: 0,
    },
  });

  // 2. 追加組織 / プロジェクト / チャネル。
  for (const o of EXT_ORGS) {
    await prisma.organization.upsert({ where: { id: o.id }, update: {}, create: { ...o } });
  }
  for (const p of EXT_PROJECTS) {
    await prisma.project.upsert({ where: { id: p.id }, update: {}, create: { ...p } });
  }
  for (const c of EXT_CHANNELS) {
    await prisma.space.upsert({
      where: { id: c.id },
      update: {},
      create: {
        id: c.id,
        kind: 'CHANNEL',
        projectId: c.projectId,
        name: c.name,
        sortOrder: c.sortOrder,
      },
    });
  }

  // 3. GROUP / 個人メモ / 1:1 DM 器（kind ごとの列形状は CHECK 制約 space_kind_shape に従う）。
  for (const [idx, g] of EXT_GROUPS.entries()) {
    await prisma.space.upsert({
      where: { id: g.id },
      update: {},
      create: { id: g.id, kind: 'GROUP', name: g.name, sortOrder: idx + 1 },
    });
  }
  for (const [idx, m] of EXT_MEMOS.entries()) {
    await prisma.space.upsert({
      where: { id: m.id },
      update: {},
      create: {
        id: m.id,
        kind: 'PERSONAL_MEMO',
        ownerId: m.ownerId,
        name: m.name,
        sortOrder: idx + 1,
      },
    });
  }
  for (const [idx, d] of EXT_DMS.entries()) {
    await prisma.space.upsert({
      where: { id: d.id },
      update: {},
      create: {
        id: d.id,
        kind: 'PERSONAL_DM',
        ownerId: d.ownerId,
        peerAccountId: d.peerAccountId,
        name: d.name,
        sortOrder: idx + 1,
      },
    });
  }

  // 4. デフォルト org/project への membership（bootstrap admin + 田中 太郎 = ADMIN / 他 = MEMBER）。
  const defaultAdminIds = [BOOTSTRAP_ADMIN_SUB, DEMO_SUBS.tanaka];
  const defaultMemberIds = [
    BOOTSTRAP_ADMIN_SUB,
    DEMO_SUBS.whUser,
    DEMO_SUBS.whAdmin,
    DEMO_SUBS.ofUser,
    DEMO_SUBS.ofAdmin,
    DEMO_SUBS.tanaka,
    // PENDING_DEMO_SUB は参加待ちを実演するため意図的に除外
  ];
  const allMemberships: {
    scopeType: MembershipScopeType;
    scopeId: string;
    accountId: string;
    role: Role;
  }[] = [
    ...defaultMemberIds.flatMap((accountId) => {
      const role = defaultAdminIds.includes(accountId) ? Role.ADMIN : Role.MEMBER;
      return [
        { scopeType: MembershipScopeType.ORGANIZATION, scopeId: DEFAULT_ORG_ID, accountId, role },
        { scopeType: MembershipScopeType.PROJECT, scopeId: DEFAULT_PROJECT_ID, accountId, role },
      ];
    }),
    ...EXT_MEMBERSHIPS,
  ];
  for (const m of allMemberships) {
    await prisma.membership.upsert({
      where: {
        accountId_scopeType_scopeId: {
          accountId: m.accountId,
          scopeType: m.scopeType,
          scopeId: m.scopeId,
        },
      },
      create: m,
      update: {},
    });
  }

  // 5. 移行②: spaceId null の既存 chatTheme / task を DEFAULT_CHANNEL へ収容（新規 seed 行は各 seeder が器を直接指定）。
  const [chatUpdated, taskUpdated] = await Promise.all([
    prisma.chatTheme.updateMany({
      where: { spaceId: null },
      data: { spaceId: DEFAULT_CHANNEL_ID },
    }),
    prisma.task.updateMany({ where: { spaceId: null }, data: { spaceId: DEFAULT_CHANNEL_ID } }),
  ]);

  console.log(
    `CM-2 seeded: ${EXT_ORGS.length + 1} orgs / ${EXT_PROJECTS.length + 1} projects / ` +
      `${EXT_CHANNELS.length + 1} channels / ${EXT_GROUPS.length} groups / ${EXT_MEMOS.length} memos / ` +
      `${EXT_DMS.length} DMs / ${allMemberships.length} memberships. ` +
      `Migrated null spaceId: chatThemes=${chatUpdated.count}, tasks=${taskUpdated.count}.`,
  );
}

/**
 * 分類（Category）の per-space seed（rete-desk-0158）。seedCM2（Space 作成）後に実行する。
 * 各 Space に業務に沿った分類を upsert する（@@unique([spaceId, name]) で Space 内一意・冪等）。
 * **意図的に分類ゼロの Space を残す**（GROUP/個人メモ/DM の一部）ことで「新規 Space は分類未作成で OK
 * （空 Space）」のデモ状態を再現する（D2）。タスクは seedTasks が同一 Space 内の分類へ紐付ける（整合性ルール）。
 *
 * SPACE_CATEGORIES のキー＝Space の固定 ID。チャネルは EXT_CHANNELS の業務名に沿った分類を、
 * DEFAULT_CHANNEL_ID には汎用分類を数件持たせる。値は (name, sortOrder) のタプル配列。
 */
async function seedCategories() {
  console.log('Seeding per-space categories...');

  const SPACE_CATEGORIES: { spaceId: string; cats: { name: string; sortOrder: number }[] }[] = [
    // 全体共通（DEFAULT_CHANNEL）: 汎用分類。マスタ管理 / その他系タスクの収容先（seedTasks のフォールバック先）。
    {
      spaceId: DEFAULT_CHANNEL_ID,
      cats: [
        { name: 'マスタ管理', sortOrder: 1 },
        { name: 'その他', sortOrder: 2 },
        { name: '全社連絡', sortOrder: 3 },
      ],
    },
    // #入荷 チャネル: 入荷オペレーションの工程分類。
    {
      spaceId: cmId(30),
      cats: [
        { name: '受入待ち', sortOrder: 1 },
        { name: '検品', sortOrder: 2 },
        { name: '入庫処理', sortOrder: 3 },
        { name: '完了', sortOrder: 4 },
      ],
    },
    // #出荷 チャネル: 出荷工程の分類。
    {
      spaceId: cmId(31),
      cats: [
        { name: 'ピッキング', sortOrder: 1 },
        { name: '梱包', sortOrder: 2 },
        { name: '配送手配', sortOrder: 3 },
      ],
    },
    // #在庫管理 チャネル: 在庫まわりの分類。
    {
      spaceId: cmId(32),
      cats: [
        { name: '在庫アラート', sortOrder: 1 },
        { name: '引当調整', sortOrder: 2 },
        { name: '滞留品', sortOrder: 3 },
      ],
    },
    // #棚卸 チャネル: 棚卸プロセスの分類。
    {
      spaceId: cmId(33),
      cats: [
        { name: '差異分析', sortOrder: 1 },
        { name: '循環棚卸', sortOrder: 2 },
      ],
    },
    // #受発注 チャネル: 発注業務の分類。
    {
      spaceId: cmId(35),
      cats: [
        { name: '発注計画', sortOrder: 1 },
        { name: '承認フロー', sortOrder: 2 },
        { name: '実績管理', sortOrder: 3 },
      ],
    },
    // 改善横断PJ（GROUP）: グループにも独自分類を持たせ「グループでも分類は変わる」を実演（D1）。
    {
      spaceId: cmId(40),
      cats: [
        { name: '課題', sortOrder: 1 },
        { name: '検討中', sortOrder: 2 },
        { name: '対応済', sortOrder: 3 },
      ],
    },
    // 田中 太郎 のメモ（PERSONAL_MEMO）: 個人スコープにも独自分類（D1）。
    {
      spaceId: cmId(50),
      cats: [
        { name: 'アイデア', sortOrder: 1 },
        { name: 'TODO', sortOrder: 2 },
      ],
    },
    // 意図的に分類ゼロのまま残す Space（空 Space のデモ / D2）:
    //   - cmId(34) #経理連携 チャネル
    //   - cmId(41) 新人オンボーディング（GROUP）
    //   - cmId(51) 倉庫 管理太郎 のメモ（PERSONAL_MEMO）
    //   - cmId(60)/cmId(61) DM（PERSONAL_DM）
    // これらは SPACE_CATEGORIES に載せない＝分類未作成のまま残る。
  ];

  let total = 0;
  for (const { spaceId, cats } of SPACE_CATEGORIES) {
    for (const c of cats) {
      await prisma.category.upsert({
        where: { spaceId_name: { spaceId, name: c.name } },
        update: { sortOrder: c.sortOrder },
        create: { spaceId, name: c.name, sortOrder: c.sortOrder },
      });
      total += 1;
    }
  }
  console.log(`Per-space categories seeded: ${total} across ${SPACE_CATEGORIES.length} spaces.`);
}

// HOME サイドバーの横断お気に入り（HM-1）のサンプル。お気に入りが 1 件でも在れば skip し冪等にする。
// 旧 nav-config.ts の静的 SIDEBAR_FAVORITES（7 件）を、ログイン実体のある管理者（bootstrap admin + 田中 太郎）に
// アカウント別データとして投入し、サイドバーが実データで「これまでと同じ見た目」を描けるようにする。
// kind は @rete/shared FAVORITE_KINDS の値域（system/chat/task/file）。targetRef は安定した意味キー
// （MVP の deep link は kind ごとにサブシステムのルートへ遷移するため、個別リソース id への精密化は後続）。
async function seedFavorites() {
  const existing = await prisma.userFavorite.count();
  if (existing > 0) {
    console.log(`User favorites already present (${existing}), skipping favorites seed.`);
    return;
  }

  console.log('Seeding user favorites (HOME sidebar)...');

  type FavoriteSeed = {
    kind: 'system' | 'chat' | 'task' | 'file';
    targetRef: string;
    label: string;
  };
  const FAVORITES: FavoriteSeed[] = [
    { kind: 'system', targetRef: 'products', label: '商品' },
    { kind: 'system', targetRef: 'warehouses', label: '倉庫' },
    { kind: 'system', targetRef: 'receivings', label: '入荷入力' },
    { kind: 'system', targetRef: 'stocks', label: '倉庫別在庫一覧' },
    { kind: 'chat', targetRef: 'chat-central', label: '中央倉庫PJ / general' },
    { kind: 'task', targetRef: 'task-mine', label: 'マイタスク（受入）' },
    { kind: 'file', targetRef: 'file-contract', label: '契約書 / 2026' },
  ];

  // 起点ページにログインする管理者 2 アカウントへ投入（per-user データであることを実演する）。
  const targetAccountIds = [BOOTSTRAP_ADMIN_SUB, DEMO_SUBS.tanaka];
  let count = 0;
  for (const accountId of targetAccountIds) {
    await prisma.userFavorite.createMany({
      data: FAVORITES.map((f, index) => ({
        accountId,
        kind: f.kind,
        targetRef: f.targetRef,
        label: f.label,
        sortOrder: index,
      })),
      skipDuplicates: true,
    });
    count += FAVORITES.length;
  }
  console.log(
    `User favorites seeded: ${count} (${targetAccountIds.length} accounts × ${FAVORITES.length}).`,
  );
}

/**
 * テナント設定（ST-1）の seed。Tenant singleton + 契約システム（外部 2 + isRete 内部 2）を冪等に upsert する。
 * 並び替え（sortOrder）はユーザー操作で変わりうるが、seed は create 時のみ初期順を入れ、
 * 既存行の sortOrder は update で上書きしない（運用中の並びを seed 再実行で巻き戻さない）。
 * 定義から外れた行（旧ダミー SYS-003 等）は削除する（UserSystemAccess は Cascade）。
 */
async function seedTenant() {
  console.log('Seeding tenant settings...');
  await prisma.tenant.upsert({
    where: { id: TENANT_SINGLETON_ID },
    update: {},
    create: { id: TENANT_SINGLETON_ID, name: TENANT_SEED.name, badgeColor: TENANT_SEED.badgeColor },
  });
  for (const sys of TENANT_SYSTEM_DEFS) {
    await prisma.tenantSystem.upsert({
      where: { id: sys.id },
      update: { name: sys.name, isRete: sys.isRete },
      create: { id: sys.id, name: sys.name, isRete: sys.isRete, sortOrder: sys.sortOrder },
    });
  }
  // 定義外 id（旧 system-C 等）を掃除。RolePermission.resourceKey は FK ではないため直後に掃除（set-0098）。
  const keepIds = TENANT_SYSTEM_DEFS.map((s) => s.id);
  const removed = await prisma.tenantSystem.deleteMany({
    where: { id: { notIn: [...keepIds] } },
  });
  if (removed.count > 0) {
    console.log(`Tenant systems removed (not in defs): ${removed.count}`);
  }
  console.log(`Tenant settings seeded: 1 tenant / ${TENANT_SYSTEM_DEFS.length} systems.`);
}
// Home 掲示板（通知）のサンプル。通知が 1 件でも在れば skip し冪等にする。
// 発信者は全件 田中 太郎（テナント管理者 = ADMIN）。本文は RichTextEditor が吐く HTML 相当を直接入れ、
// 取り込み時に sanitizeRichText を通さない seed 経路でも RichTextView 側の dompurify で安全に描画される
// （RICH_TEXT_ALLOWED_TAGS の範囲内タグのみ使用）。ageHours = いま時点から何時間前に発行したか
// （小さいほど新しい）。一覧は publishedAt 降順で並ぶ。
async function seedAnnouncements() {
  const existing = await prisma.announcement.count();
  if (existing > 0) {
    console.log(`Announcements already present (${existing}), skipping announcement seed.`);
    return;
  }

  console.log('Seeding announcements...');
  const authorId = DEMO_SUBS.tanaka;

  type AnnouncementSeed = { title: string; body: string; ageHours: number };
  const ANNOUNCEMENTS: AnnouncementSeed[] = [
    {
      title: 'Struct Rete へようこそ — Home 掲示板の使い方',
      ageHours: 1,
      body: '<p>この掲示板では、テナント全体への<strong>お知らせ</strong>を配信します。重要な連絡はピン留め表示されます。</p><ul><li>左の一覧から各通知を選ぶと本文が読めます。</li><li>管理者は右上の編集ボタンから新規作成・編集ができます。</li></ul>',
    },
    {
      title: '6 月リリース予定の機能について',
      ageHours: 30,
      body: '<p>6 月のリリースでは以下を予定しています。</p><ul><li>入荷予定 CSV の文字コード自動判定</li><li>在庫アラート閾値の ABC 区分対応</li></ul><p>詳細は Desk のタスクツリーをご確認ください。</p>',
    },
    {
      title: '棚卸期間中の入出庫凍結ルール',
      ageHours: 120,
      body: '<p>棚卸期間中は、対象エリアの入出庫を<strong>部分凍結</strong>します。エリア単位で順次解除しますので、作業前に対象エリアの状態を必ず確認してください。</p>',
    },
    {
      title: '月次レポートの自動配信を開始しました',
      ageHours: 300,
      body: '<p>月初の在庫評価額レポートを、締め処理後に自動生成・配信する運用を開始しました。手集計は不要になります。</p>',
    },
    {
      title: 'システムメンテナンスのお知らせ（完了）',
      ageHours: 720,
      body: '<p>先日のメンテナンスは予定どおり完了しました。ご協力ありがとうございました。引き続きよろしくお願いいたします。</p>',
    },
  ];

  let count = 0;
  for (const a of ANNOUNCEMENTS) {
    const publishedAt = new Date(NOW.getTime() - a.ageHours * 3600 * 1000);
    await prisma.announcement.create({
      data: {
        title: a.title,
        body: a.body,
        authorId,
        publishedAt,
        createdAt: publishedAt,
      },
    });
    count += 1;
  }
  console.log(`Announcements seeded: ${count} (author=田中 太郎).`);
}

// 担当者表示名（Task.assigneeName は Account 非連動の自由文字列。モック desk/index.html の担当名を踏襲し、
// チャット投稿者の Account（倉庫一郎 等）とは別人物体系で持つ。将来 Phase C で Account FK 化する際に整理）。
const ASSIGNEES = {
  sakuma: '佐久間 健',
  hayashi: '林 拓也',
  nakajima: '中島 友梨',
} as const;

// チャットテーマのタイトル定数。タスクの src（昇格元）参照と THEMES のタイトル定義の両方で同じ値を使い、
// id 解決（sourceThemeId）の鍵にする。実際に昇格 src として張るのは OPEN の 3 件
// （alertThreshold / stocktakeDiff / reorderPoint）のみ。残りは通常テーマとしてチャット明細に表示される
// ——昇格リンクを持つテーマは chat.repository の `promotedTasks: { none: {} }` で明細から非表示になるため、
// CLOSED テーマ等を明細に残す目的で意図的に src を張らない。
const PROMOTE_SRC = {
  inboundCsv: '入荷予定インポートの CSV 仕様、文字コード問題',
  alertThreshold: '在庫アラートの閾値をどう決めるか',
  stocktakeDiff: '棚卸差異の原因分析と再発防止',
  reorderPoint: '発注点の自動計算ロジックをどう組むか',
  masterDup: '商品マスタの重複登録チェック',
  monthlyReport: '月次レポート PDF 出力 — 経理連携',
  shipLabel: '出荷ラベルの PDF レイアウト崩れ',
} as const;

// ISO 文字列（JST）→ Date。seed は通常の node 実行のため new Date(string) は安全。
function jst(s: string): Date {
  return new Date(`${s}+09:00`);
}

// Desk チャットのサンプル（テーマ＝タイトル付きスレッド）。テーマが 1 件でも在れば skip し冪等にする。
// 投稿者は bootstrap admin + デモアカウント（FK 正規化済の Account.id 参照）。
// CLOSED テーマは収束発話（合意・リリース報告）まで含めて読み物として厚くする。OPEN は進行中の議論。
// ageHours = いま時点から何時間前に開始したか。古いテーマほど大きく、lastMessageAt 降順一覧で下に並ぶ。
async function seedChat() {
  const existing = await prisma.chatTheme.count();
  if (existing > 0) {
    console.log(`Chat themes already present (${existing}), skipping chat seed.`);
    return;
  }

  console.log('Seeding chat themes & messages...');
  const A = DEMO_SUBS;
  const admin = BOOTSTRAP_ADMIN_SUB;

  // 在庫管理 PJ を題材にした相談スレッド群。status / 発話数 / タイトル長を意図的にばらけさせ、
  // パターン網羅（OPEN/CLOSED・無返信〜多発話・長文タイトル）とリアリティの両面を満たす。
  // afterMin = 直前発話からの経過分（テーマ開始からの 1 発話目もこの分だけ後ろにずらす）。
  type ThemeSeed = {
    title: string;
    description: string;
    // 顛末（CLOSED テーマの結論メモ）。OPEN は省略（null）。
    tenmatsu?: string;
    status: ChatThemeStatus;
    ageHours: number;
    authorId: string;
    messages: { authorId: string; body: string; afterMin: number }[];
  };

  const THEMES: ThemeSeed[] = [
    {
      title: PROMOTE_SRC.inboundCsv,
      description:
        '取引先から届く入荷予定 CSV の文字コードが Shift_JIS / UTF-8 混在で文字化けする。受け側で自動判定したい。',
      status: 'CLOSED',
      ageHours: 720,
      authorId: A.whAdmin,
      messages: [
        {
          authorId: A.whAdmin,
          body: 'A 社の入荷予定 CSV を取り込むと商品名が全部文字化けします。Shift_JIS で来てるみたいです。',
          afterMin: 0,
        },
        {
          authorId: A.ofUser,
          body: '別の B 社は UTF-8 でした。取引先ごとに固定するのも限界がありますね…',
          afterMin: 35,
        },
        {
          authorId: admin,
          body: 'BOM とバイト分布で自動判定する方式にしましょう。誤判定時は手動で文字コードを選べる導線も用意。',
          afterMin: 90,
        },
        {
          authorId: A.whUser,
          body: '判定ロジックをタスク化しました。BOM 検出 → 統計判定 → 手動フォールバックの 3 段で進めます。',
          afterMin: 240,
        },
        {
          authorId: A.whAdmin,
          body: '5/20 のリリースで取り込めるようになりました。A 社・B 社とも文字化けゼロを確認済みです。クローズします。',
          afterMin: 4320,
        },
      ],
    },
    {
      title: PROMOTE_SRC.monthlyReport,
      description:
        '月次レポート PDF の経理連携で、勘定科目マッピング表をフロントから設定できるようにする要望。',
      status: 'CLOSED',
      ageHours: 480,
      authorId: A.ofAdmin,
      messages: [
        {
          authorId: A.ofAdmin,
          body: '科目マッピングを毎月手で直すのが負担です。画面から保存しておけると助かります。',
          afterMin: 0,
        },
        {
          authorId: admin,
          body: 'マッピングをマスタ化して、月次バッチがそれを参照する形にします。',
          afterMin: 120,
        },
        {
          authorId: A.ofAdmin,
          body: '5/10 リリースで設定画面が入りました。今月分から手直しゼロでいけました。ありがとうございます。',
          afterMin: 7200,
        },
      ],
    },
    {
      title: PROMOTE_SRC.masterDup,
      description: '商品マスタに型番違いの重複登録が散見される。登録時に類似チェックをかけたい。',
      status: 'CLOSED',
      ageHours: 360,
      authorId: A.ofUser,
      messages: [
        {
          authorId: A.ofUser,
          body: '同じ商品が型番の半角全角違いで二重登録されてました。発注が分散して在庫が読めません。',
          afterMin: 0,
        },
        {
          authorId: A.whAdmin,
          body: '正規化（全角→半角・大文字化）してから既存と突合する形でどうでしょう。',
          afterMin: 45,
        },
        {
          authorId: admin,
          body: '登録時に類似候補を出して「別商品として登録」を明示クリックさせる UX にします。',
          afterMin: 150,
        },
        {
          authorId: A.ofUser,
          body: 'リリース後、重複の新規発生は止まりました。既存分のクレンジングは別タスクで。クローズします。',
          afterMin: 5760,
        },
      ],
    },
    {
      title: PROMOTE_SRC.alertThreshold,
      description:
        '商品ごとに発注点が違うので、一律閾値だと過剰/欠品が出る。区分ごとに持たせたい。',
      status: 'OPEN',
      ageHours: 240,
      authorId: A.whAdmin,
      messages: [
        {
          authorId: A.whAdmin,
          body: '現状は全商品一律 10 個で警告を出してます。A ランク品はこれだと遅いです。',
          afterMin: 0,
        },
        {
          authorId: A.ofUser,
          body: 'ABC 区分で閾値を変える案はどうでしょう。マスタに列を足す形で。',
          afterMin: 60,
        },
        {
          authorId: admin,
          body: 'まず区分 3 段階で試して、運用で詰めましょう。次フェーズで対応します。',
          afterMin: 180,
        },
      ],
    },
    {
      title: 'CSV 取込フォーマットの統一',
      description: '取引先ごとに列順・文字コードがバラバラ。受け側で吸収するかテンプレ配布するか。',
      status: 'OPEN',
      ageHours: 200,
      authorId: A.ofAdmin,
      messages: [
        {
          authorId: A.ofAdmin,
          body: '取引先 5 社ぶんの CSV、列順が全部違って毎回手直ししてます…',
          afterMin: 0,
        },
        {
          authorId: A.whUser,
          body: 'こちらでマッピング定義を持てば、先方に作業負担かけずに済みますね。',
          afterMin: 50,
        },
      ],
    },
    {
      title: PROMOTE_SRC.stocktakeDiff,
      description: '今期の棚卸で差異が想定より大きい。原因を分類して再発防止策まで落とし込みたい。',
      status: 'OPEN',
      ageHours: 120,
      authorId: A.whAdmin,
      messages: [
        {
          authorId: A.whAdmin,
          body: '棚卸差異が前期比 1.8 倍でした。まず差異の大きい品目を洗い出します。',
          afterMin: 0,
        },
        {
          authorId: A.whUser,
          body: '上位 20 品で差異の 7 割を占めてます。共通点はピッキング頻度が高いロケーションでした。',
          afterMin: 90,
        },
        {
          authorId: A.ofUser,
          body: '出庫ログと現物のタイムラグが効いてそうです。突合してみます。',
          afterMin: 160,
        },
        {
          authorId: A.whAdmin,
          body: 'ログ突合の結果、計上漏れと二重計上が半々でした。入力タイミングのルール化が要りそうです。',
          afterMin: 300,
        },
        {
          authorId: admin,
          body: '原因分析タスクに上げました。再発防止は入出庫の即時計上＋循環棚卸の導入で詰めましょう。',
          afterMin: 600,
        },
        {
          authorId: A.whUser,
          body: '了解です。差異上位 20 品の棚番再確認から着手します。',
          afterMin: 720,
        },
      ],
    },
    {
      title: PROMOTE_SRC.reorderPoint,
      description: '発注点を勘で決めているので、リードタイムと出荷波動から自動計算したい。',
      status: 'OPEN',
      ageHours: 96,
      authorId: A.ofUser,
      messages: [
        {
          authorId: A.ofUser,
          body: '発注点が担当者の勘頼みで、欠品と過剰が両方出てます。',
          afterMin: 0,
        },
        {
          authorId: A.whAdmin,
          body: '平均出荷 × リードタイム + 安全在庫の式が基本ですね。安全在庫の係数をどう置くか。',
          afterMin: 70,
        },
        {
          authorId: admin,
          body: '直近 90 日の出荷標準偏差ベースで安全在庫を出す案で試算してみましょう。',
          afterMin: 200,
        },
        {
          authorId: A.ofUser,
          body: '試算用のロジックをタスク化しました。まず A ランク品で検証します。',
          afterMin: 480,
        },
      ],
    },
    {
      title:
        'ピッキングリストのソート順、棚番優先で固定するか出荷便ごとに変えるか、現場ヒアリングを踏まえて要件を整理したい（緊急度低・5 月末まで）',
      description:
        '棚番順だと歩行は最短だが便ごとの締めに間に合わないケースがある。現場の意見が割れている。',
      status: 'OPEN',
      ageHours: 72,
      authorId: A.whUser,
      messages: [
        {
          authorId: A.whUser,
          body: '現場だと「棚番順が歩きやすい」「いや便優先じゃないと締めに遅れる」で意見が割れてます。',
          afterMin: 0,
        },
        {
          authorId: A.whAdmin,
          body: '午前便は便優先、午後は棚番優先、みたいに時間帯で切り替える折衷案はどうでしょう。',
          afterMin: 110,
        },
        {
          authorId: A.ofUser,
          body: '切り替えルールが複雑だと現場が混乱しそうです。設定で選べる形が無難かと。',
          afterMin: 240,
        },
        {
          authorId: A.whUser,
          body: 'いったん現場 3 名にヒアリングして、5 月末までに要件をまとめます。',
          afterMin: 400,
        },
        {
          authorId: admin,
          body: '了解です。緊急度は低めなので、棚卸対応が一段落してからで大丈夫です。',
          afterMin: 520,
        },
      ],
    },
    {
      title: '返品処理のステータス遷移',
      description:
        '検品中 → 不良判定 → 取引先返送 → 完了 の中間ステータスをどこまで細かく持つか、運用負荷とのバランスを再検討。',
      status: 'OPEN',
      ageHours: 48,
      authorId: A.ofAdmin,
      messages: [
        {
          authorId: A.ofAdmin,
          body: '今は「返品受付」「完了」の 2 状態だけで、途中経過が追えません。',
          afterMin: 0,
        },
        {
          authorId: A.whUser,
          body: '検品中・不良判定・返送待ちは分けたいです。現物がどこにあるか分かるので。',
          afterMin: 60,
        },
        {
          authorId: A.ofUser,
          body: '細かすぎると入力負荷が上がります。4 段階くらいが落としどころでは。',
          afterMin: 130,
        },
        {
          authorId: A.ofAdmin,
          body: '検品中／不良判定／取引先返送／完了 の 4 段で一度モックを作ってみます。',
          afterMin: 220,
        },
      ],
    },
    {
      title: 'ロケーション再編成の段取り',
      description:
        '出荷頻度に対して棚配置が最適化されておらず、歩行距離が長い。連休中に再編成したい。',
      status: 'OPEN',
      ageHours: 30,
      authorId: A.whAdmin,
      messages: [
        {
          authorId: A.whAdmin,
          body: '出荷頻度の高い品を入口近くに寄せたいです。連休中に一気にやれないか検討中。',
          afterMin: 0,
        },
        {
          authorId: A.whUser,
          body: 'ABC 分析の結果を棚番に落とした図を作ります。移動対象は 200 ロケーションくらいになりそう。',
          afterMin: 80,
        },
        {
          authorId: admin,
          body: '移動中の在庫ロケーションのズレが怖いので、システム反映の手順も一緒に決めましょう。',
          afterMin: 180,
        },
      ],
    },
    {
      title: PROMOTE_SRC.shipLabel,
      description: '長い商品名で枠からはみ出る。フォントサイズ自動調整 or 二段表示で対応したい。',
      status: 'OPEN',
      ageHours: 12,
      authorId: A.whUser,
      messages: [
        {
          authorId: A.whUser,
          body: '商品名が 30 文字超えるとラベル枠を突き抜けます。実物の写真あとで貼ります。',
          afterMin: 0,
        },
      ],
    },
    {
      title: '出荷波動への対応方針（午前/午後の人員配分）',
      description:
        '午前に出荷が集中して残業が発生している。波動を平準化する計画機能が欲しい。まだ議論前の論点メモ。',
      status: 'OPEN',
      ageHours: 3,
      authorId: A.ofAdmin,
      messages: [],
    },

    // --- 一覧ボリューム用の追加テーマ（チャット明細にスクロールを出す）。すべて昇格リンク無し＝明細に表示。
    //     在庫業務ドメインで status / 発話数 / タイトル長をばらけさせ、リアリティとパターン網羅を両立する。
    {
      title: '入荷時の検品基準を写真付きで標準化したい',
      description: '担当者ごとに検品の見方が違う。良品/不良の判定例を写真付きで残したい。',
      status: 'OPEN',
      ageHours: 24,
      authorId: A.whUser,
      messages: [
        {
          authorId: A.whUser,
          body: '人によって不良の判定がぶれます。代表例を写真で共有できると揃いそうです。',
          afterMin: 0,
        },
        {
          authorId: A.whAdmin,
          body: '入荷区分ごとに 3 例ずつ集めましょう。まずは破損・汚損・数量違いから。',
          afterMin: 40,
        },
      ],
    },
    {
      title: 'ハンディ端末のバーコード読取エラーが頻発',
      description:
        '特定ロットのラベルが読み取れず手入力になっている。印字品質かラベル仕様か切り分けたい。',
      status: 'OPEN',
      ageHours: 6,
      authorId: A.whUser,
      messages: [
        {
          authorId: A.whUser,
          body: 'C 社のラベルだけ読取率が悪いです。印字が薄い気がします。',
          afterMin: 0,
        },
        {
          authorId: A.whAdmin,
          body: '端末側か媒体側か切り分けたいので、サンプルを 10 枚集めてもらえますか。',
          afterMin: 25,
        },
      ],
    },
    {
      title: '仕入先からの納期回答フォーマットを統一したい',
      description: '電話・メール・FAX が混在して転記ミスが出る。回答テンプレを配布できないか。',
      status: 'OPEN',
      ageHours: 36,
      authorId: A.ofUser,
      messages: [
        {
          authorId: A.ofUser,
          body: '納期回答が口頭やメールでバラバラで、転記ミスが起きてます。',
          afterMin: 0,
        },
      ],
    },
    {
      title: '賞味期限管理（FEFO）の運用ルール',
      description:
        '先入れ先出しではなく期限の近い順に出したい。ロケーション運用とシステム表示をどう合わせるか。',
      status: 'OPEN',
      ageHours: 54,
      authorId: A.whAdmin,
      messages: [
        {
          authorId: A.whAdmin,
          body: '食品系は FIFO だと期限切れが出ます。FEFO に切り替えたいです。',
          afterMin: 0,
        },
        {
          authorId: A.ofUser,
          body: 'ピッキング指示に期限を出せば現場で迷わないですね。',
          afterMin: 50,
        },
        {
          authorId: admin,
          body: '期限列の表示と、期限近接のアラートをセットで検討しましょう。',
          afterMin: 140,
        },
      ],
    },
    {
      title: '棚番ラベルの貼り替え運用',
      description: 'ロケーション変更時のラベル貼り替えが追いつかず現物とズレる。',
      status: 'CLOSED',
      ageHours: 600,
      authorId: A.whUser,
      messages: [
        {
          authorId: A.whUser,
          body: '棚番変更のたびにラベル貼り替えが漏れてズレます。',
          afterMin: 0,
        },
        {
          authorId: A.whAdmin,
          body: '変更申請とラベル発行を 1 フローに束ねる運用にしました。運用開始後ズレは解消。クローズします。',
          afterMin: 2880,
        },
      ],
    },
    {
      title: '在庫照会画面のレスポンスが遅い',
      description: '全倉庫横断で検索すると 10 秒近くかかる。インデックスかページングか。',
      status: 'OPEN',
      ageHours: 8,
      authorId: A.ofUser,
      messages: [
        {
          authorId: A.ofUser,
          body: '在庫照会、全倉庫だと体感 10 秒くらい待たされます。',
          afterMin: 0,
        },
        {
          authorId: admin,
          body: '検索条件と件数を教えてください。インデックスかページングで効きそうです。',
          afterMin: 30,
        },
      ],
    },
    {
      title: '出荷検品のダブルチェック省略の可否',
      description: '少量出荷でもダブルチェック必須で時間がかかる。リスクに応じて簡略化できないか。',
      status: 'OPEN',
      ageHours: 60,
      authorId: A.whAdmin,
      messages: [
        {
          authorId: A.whAdmin,
          body: '1 個出荷でもダブルチェック必須で、繁忙期に詰まります。',
          afterMin: 0,
        },
        {
          authorId: A.ofAdmin,
          body: '金額・取引先のリスク区分で要否を分ける案はどうでしょう。',
          afterMin: 70,
        },
      ],
    },
    {
      title: '緊急出荷（当日便）の割り込み運用',
      description: '当日便の割り込みでピッキング順が崩れる。優先フラグと再ソートの運用を決めたい。',
      status: 'OPEN',
      ageHours: 18,
      authorId: A.whUser,
      messages: [
        {
          authorId: A.whUser,
          body: '当日便の割り込みが入ると、組んだピッキング順が崩れて混乱します。',
          afterMin: 0,
        },
        {
          authorId: A.whAdmin,
          body: '優先フラグを立てたら現場端末で先頭に出る、くらいの単純さが良さそうです。',
          afterMin: 45,
        },
      ],
    },
    {
      title: '返品在庫の良品/不良品の置き場分離',
      description: '返品が良品棚に紛れて誤出荷リスクがある。一時保管ロケーションを設けたい。',
      status: 'OPEN',
      ageHours: 84,
      authorId: A.ofUser,
      messages: [
        {
          authorId: A.ofUser,
          body: '返品が良品棚に戻されて、不良品が再出荷されかけました。置き場を分けたいです。',
          afterMin: 0,
        },
      ],
    },
    {
      title: '月初の在庫評価額レポートの自動化',
      description: '月初に手作業で評価額を集計している。締め処理後に自動生成したい。',
      status: 'CLOSED',
      ageHours: 540,
      authorId: A.ofAdmin,
      messages: [
        {
          authorId: A.ofAdmin,
          body: '評価額の集計を毎月手で組んでいて、半日かかります。',
          afterMin: 0,
        },
        {
          authorId: admin,
          body: '締め後バッチで自動出力する形にしました。今月から手集計ゼロです。クローズします。',
          afterMin: 4320,
        },
      ],
    },
    {
      title:
        'ピッキングミスの再発防止策、ダブルピック検知や数量読み上げなど現場でできる対策を一通り洗い出したい',
      description:
        'ピッキング誤り（品違い・数量違い）が月数件発生。システム・運用の両面で対策を検討。',
      status: 'OPEN',
      ageHours: 108,
      authorId: A.whAdmin,
      messages: [
        {
          authorId: A.whAdmin,
          body: '今月もピッキング誤りが 3 件。品違いと数量違いが半々です。',
          afterMin: 0,
        },
        {
          authorId: A.whUser,
          body: '端末で数量を読み上げ確認させると、数量違いは減ると思います。',
          afterMin: 60,
        },
        {
          authorId: A.ofUser,
          body: '品違いはロケーション隣接の似た商品で起きがちなので、棚配置の見直しも要りそうです。',
          afterMin: 130,
        },
      ],
    },
    {
      title: '取引先別の出荷リードタイム見直し',
      description: '一律翌日出荷を掲げているが実態と乖離。取引先ごとに現実的なリードタイムへ。',
      status: 'OPEN',
      ageHours: 150,
      authorId: A.ofAdmin,
      messages: [
        {
          authorId: A.ofAdmin,
          body: '全社一律「翌日出荷」だと遠方便が間に合わず、結局謝ってます。',
          afterMin: 0,
        },
      ],
    },
    {
      title: '入庫予定と実績の差異アラート',
      description: '予定数と実入庫の差異が大きい時に気づけず、後工程で発覚する。',
      status: 'OPEN',
      ageHours: 15,
      authorId: A.whUser,
      messages: [
        {
          authorId: A.whUser,
          body: '予定 100 に対して入庫 60、みたいな差異が翌日まで気づけません。',
          afterMin: 0,
        },
        {
          authorId: admin,
          body: '入庫確定時に予定との差異率でアラートを出すのが良さそうです。閾値は要相談。',
          afterMin: 35,
        },
      ],
    },
    {
      title: '倉庫内の温湿度ログの記録方法',
      description: '一部商品は温湿度管理が必要。手書き記録をやめてデータ化したい。',
      status: 'OPEN',
      ageHours: 280,
      authorId: A.whAdmin,
      messages: [
        {
          authorId: A.whAdmin,
          body: '温湿度を 1 日 3 回手書きで記録してます。データで残せると監査も楽です。',
          afterMin: 0,
        },
      ],
    },
    {
      title: '過剰在庫の処分・値引き販売のルール化',
      description: '滞留在庫の処分基準が属人的。滞留日数と評価額で機械的に候補を出したい。',
      status: 'OPEN',
      ageHours: 220,
      authorId: A.ofUser,
      messages: [
        {
          authorId: A.ofUser,
          body: '滞留在庫の処分が担当者の判断頼みで、棚を圧迫してます。',
          afterMin: 0,
        },
        {
          authorId: A.ofAdmin,
          body: '滞留日数 ×評価額で候補リストを自動で出して、会議にかける形が良いかと。',
          afterMin: 80,
        },
      ],
    },
    {
      title: '棚卸時の入出庫凍結タイミング',
      description: '棚卸中の入出庫をどこで止めるか。完全凍結か部分凍結かで現場負荷が変わる。',
      status: 'CLOSED',
      ageHours: 440,
      authorId: A.whAdmin,
      messages: [
        {
          authorId: A.whAdmin,
          body: '棚卸中に入出庫が動くと差異の原因になります。どこで凍結するか決めたいです。',
          afterMin: 0,
        },
        {
          authorId: admin,
          body: 'エリア単位の部分凍結で運用すると決まりました。手順書に反映済み。クローズします。',
          afterMin: 2160,
        },
      ],
    },
    {
      title: '商品画像のマスタ一括登録',
      description: '商品マスタに画像が無く、検品時の照合に使えない。一括取込の仕組みが欲しい。',
      status: 'OPEN',
      ageHours: 168,
      authorId: A.ofUser,
      messages: [
        {
          authorId: A.ofUser,
          body: 'マスタに画像が無いので、検品時に現物と突き合わせできません。',
          afterMin: 0,
        },
      ],
    },
    {
      title: '送り状の控え保管期間と電子化',
      description: '紙の送り状控えが場所を取る。保管期間のルールと電子化の可否を整理したい。',
      status: 'OPEN',
      ageHours: 300,
      authorId: A.ofAdmin,
      messages: [
        {
          authorId: A.ofAdmin,
          body: '送り状控えの紙が年々増えて、保管場所が限界です。',
          afterMin: 0,
        },
        {
          authorId: admin,
          body: '法定保管期間を確認してから、電子化と原本廃棄の線引きを決めましょう。',
          afterMin: 90,
        },
      ],
    },
    {
      title: '新人向けの入荷作業マニュアル整備',
      description:
        '繁忙期の応援・新人が入るたびに口頭説明している。標準手順を文書化したい。まずは論点メモ。',
      status: 'OPEN',
      ageHours: 400,
      authorId: A.whAdmin,
      messages: [],
    },
    {
      title: '繁忙期のシフト・応援要員の調整',
      description: '出荷波動の大きい月末に人手が足りない。応援要員の手配ルールを決めたい。',
      status: 'OPEN',
      ageHours: 840,
      authorId: A.ofAdmin,
      messages: [
        {
          authorId: A.ofAdmin,
          body: '月末の 3 日間だけ人手が全然足りません。毎回その場しのぎです。',
          afterMin: 0,
        },
        {
          authorId: A.whAdmin,
          body: '過去の出荷量から繁忙日を予測して、早めに応援を確保する形にしたいですね。',
          afterMin: 120,
        },
      ],
    },

    // --- 長スレッド（厚い議論）。チャット詳細のスクロール・未読集約・ページングを実データで検証するための
    //     20+ 発話テーマ。複数アカウントが交互に発言し、論点が枝分かれしながら収束/継続する。
    {
      title: 'WMS リプレイスの要件すり合わせ（現行運用の棚卸しから）',
      description:
        '現行の自作 WMS が限界。リプレイスに向けて現場運用を棚卸しし、必須要件と捨てる要件を仕分けたい。長期スレッド。',
      status: 'OPEN',
      ageHours: 504,
      authorId: admin,
      messages: [
        {
          authorId: admin,
          body: '現行 WMS の改修が追いつかなくなってきたので、リプレイスを本格検討します。まず現場で「これが無いと回らない」機能を洗い出したいです。',
          afterMin: 0,
        },
        {
          authorId: A.whAdmin,
          body: 'ロケーション管理とハンディでの入出庫スキャンは絶対必要です。ここが止まると現場が完全に手作業に戻ります。',
          afterMin: 45,
        },
        {
          authorId: A.whUser,
          body: 'ピッキングリストの並び順（棚番/便）の切り替えも外せないです。前のスレッドで議論したやつです。',
          afterMin: 80,
        },
        {
          authorId: A.ofUser,
          body: '入荷予定 CSV の取込と文字コード自動判定も必須でお願いします。取引先ごとにバラバラなので。',
          afterMin: 130,
        },
        {
          authorId: admin,
          body: 'ありがとうございます。逆に「あると嬉しいが無くても回る」ものはありますか？優先度を分けたいです。',
          afterMin: 200,
        },
        {
          authorId: A.whAdmin,
          body: '温湿度ログの自動取込は、あると嬉しい寄りですね。今も手書きで回ってはいます。',
          afterMin: 260,
        },
        {
          authorId: A.ofAdmin,
          body: '経理連携（科目マッピング）は管理側としては必須に近いです。月次がここで詰まるので。',
          afterMin: 320,
        },
        {
          authorId: A.whUser,
          body: '商品画像のマスタ表示は「あると嬉しい」です。検品が楽になりますが無くても作業はできます。',
          afterMin: 400,
        },
        {
          authorId: admin,
          body: 'なるほど。必須=ロケーション/スキャン/ピッキング順/CSV取込/経理連携、準必須=温湿度・画像、で一旦整理します。',
          afterMin: 480,
        },
        {
          authorId: A.ofUser,
          body: '権限まわりはどうしますか？今は全員が全部見えてしまっていて、取引先情報の閲覧が気になります。',
          afterMin: 600,
        },
        {
          authorId: admin,
          body: '良い指摘です。器（チャネル/プロジェクト）単位の可視範囲は新基盤の前提に入れます。組織をまたいだ閲覧は塞ぐ方針で。',
          afterMin: 660,
        },
        {
          authorId: A.whAdmin,
          body: '現場端末はオフラインになることがあります。スキャンの一時保持→復帰時同期は要件に入れてほしいです。',
          afterMin: 740,
        },
        {
          authorId: admin,
          body: 'オフライン耐性は重いテーマですね…。初期スコープに入れるか別フェーズか、影響を見て判断します。',
          afterMin: 820,
        },
        {
          authorId: A.whUser,
          body: 'せめて「同期失敗が分かる」表示だけでもあると、二重スキャンの事故が減ります。',
          afterMin: 900,
        },
        {
          authorId: A.ofAdmin,
          body: 'データ移行の段取りも論点ですね。現行のロケーションマスタはかなり汚れています。',
          afterMin: 1020,
        },
        {
          authorId: admin,
          body: '移行は「クレンジング前提」で工数を積んでおきます。汚れたまま移すと新基盤でも同じ問題が再発するので。',
          afterMin: 1100,
        },
        {
          authorId: A.whAdmin,
          body: '棚番ラベルの貼り替え運用ともセットですね。マスタとラベルがズレている棚が今も残っています。',
          afterMin: 1260,
        },
        {
          authorId: A.ofUser,
          body: '導入時期はいつ頃を見ていますか？棚卸とぶつかると現場が死にます。',
          afterMin: 1400,
        },
        {
          authorId: admin,
          body: '棚卸期間は完全に外します。閑散期に段階移行が現実的かと。まず要件定義を今月中に固めましょう。',
          afterMin: 1500,
        },
        {
          authorId: A.whAdmin,
          body: '了解です。現場側の必須要件は私の方で 1 枚にまとめて、次回のレビューに持っていきます。',
          afterMin: 1640,
        },
        {
          authorId: A.ofAdmin,
          body: '管理側の要件（経理連携・権限・監査ログ）は私がまとめます。',
          afterMin: 1720,
        },
        {
          authorId: admin,
          body: '助かります。要件票が揃ったらタスクツリーに落として、フェーズ分けの議論に移りましょう。継続します。',
          afterMin: 1840,
        },
      ],
    },
    {
      title: '年末繁忙期に向けた在庫圧縮プロジェクト（滞留在庫の棚卸しと処分）',
      description:
        '年末に向けて保管スペースを空けるため、滞留在庫を洗い出して処分・値引き・返品の方針を決める長期プロジェクト。完了済みの記録として残す。',
      status: 'CLOSED',
      tenmatsu:
        '滞留 90 日超を機械抽出 → 値引き/返品/廃棄に三分類。保管棚を 18% 圧縮し繁忙期のピッキング動線を確保。来期から月次で自動抽出を継続。',
      ageHours: 1200,
      authorId: A.ofAdmin,
      messages: [
        {
          authorId: A.ofAdmin,
          body: '年末の入荷ピークに備えて、滞留在庫を片付けて棚を空けたいです。まず現状を可視化します。',
          afterMin: 0,
        },
        {
          authorId: A.ofUser,
          body: '滞留日数のデータは出せます。何日以上を「滞留」と定義しますか？',
          afterMin: 60,
        },
        {
          authorId: A.ofAdmin,
          body: 'まず 90 日超で切ってみましょう。多すぎたら絞ります。',
          afterMin: 120,
        },
        {
          authorId: A.ofUser,
          body: '90 日超で 420 SKU、評価額で約 1,800 万でした。想像より多いです。',
          afterMin: 260,
        },
        {
          authorId: admin,
          body: 'これは効果が大きそうですね。値引き販売・取引先返品・廃棄の三択でざっくり仕分けできますか。',
          afterMin: 340,
        },
        {
          authorId: A.whAdmin,
          body: '現物の状態も見ないと廃棄判断はできないです。倉庫側で上位 SKU から実査します。',
          afterMin: 420,
        },
        {
          authorId: A.ofUser,
          body: '評価額上位 50 SKU で全体の 7 割を占めてます。ここから着手すれば効率的です。',
          afterMin: 560,
        },
        {
          authorId: A.ofAdmin,
          body: '上位 50 を私と倉庫で分担して、来週中に一次仕分けを終えましょう。',
          afterMin: 640,
        },
        {
          authorId: A.whAdmin,
          body: '実査の結果、上位 50 のうち 12 SKU は外装破損で値引きも難しいです。廃棄候補に回します。',
          afterMin: 1500,
        },
        {
          authorId: A.ofUser,
          body: '返品可能な取引先に確認したところ、8 SKU は引き取り可でした。残りは値引き販売に。',
          afterMin: 1800,
        },
        {
          authorId: admin,
          body: '良い進捗です。廃棄分は経理処理が要りますね。評価損の計上タイミングを確認してください。',
          afterMin: 2000,
        },
        {
          authorId: A.ofAdmin,
          body: '経理に確認し、今期内計上で進めます。値引き分は営業に販促をかけてもらいます。',
          afterMin: 2200,
        },
        {
          authorId: A.whUser,
          body: '空いた棚から順に、繁忙期によく出る SKU を入口近くへ寄せ始めました。動線がだいぶ良くなります。',
          afterMin: 2600,
        },
        {
          authorId: A.ofUser,
          body: '最終集計です。処分・返品・値引きで滞留 SKU を 420→150 まで圧縮、保管棚は 18% 空きました。',
          afterMin: 3200,
        },
        {
          authorId: A.whAdmin,
          body: '繁忙期前にこれだけ空けば、入荷ピークも捌けそうです。お疲れさまでした。',
          afterMin: 3400,
        },
        {
          authorId: admin,
          body: '素晴らしい成果です。問題は「また溜まる」ことなので、滞留 90 日超を月次で自動抽出して会議にかける運用にしましょう。',
          afterMin: 3600,
        },
        {
          authorId: A.ofAdmin,
          body: '了解です。月次自動抽出をタスク化しました。今回の三分類フローもそのまま手順書に残します。クローズします。',
          afterMin: 3800,
        },
      ],
    },
  ];

  // 器分散: 作成済みチャネル（kind=CHANNEL）へテーマを round-robin で割り当て、spaceId が複数値に散らばる
  // ようにする（CM-2 器スコープ絞り込み・可視範囲制御を実データで検証可能にする）。チャネル未作成時は null
  // （seedCM2 の移行②が DEFAULT_CHANNEL へ収容する）。id 昇順で決定的に並べる。
  const channelIds = (
    await prisma.space.findMany({
      where: { kind: 'CHANNEL' },
      orderBy: { id: 'asc' },
      select: { id: true },
    })
  ).map((c) => c.id);

  let themeCount = 0;
  let messageCount = 0;
  for (const [idx, t] of THEMES.entries()) {
    const base = new Date(NOW.getTime() - t.ageHours * 3600 * 1000);
    const spaceId = channelIds.length > 0 ? channelIds[idx % channelIds.length] : null;
    const theme = await prisma.chatTheme.create({
      data: {
        title: t.title,
        description: t.description,
        tenmatsu: t.tenmatsu ?? null,
        status: t.status,
        authorId: t.authorId,
        spaceId,
        createdAt: base,
        lastMessageAt: base,
      },
    });
    themeCount += 1;
    let cursor = base;
    for (const m of t.messages) {
      cursor = new Date(cursor.getTime() + m.afterMin * 60 * 1000);
      await prisma.chatMessage.create({
        data: { themeId: theme.id, authorId: m.authorId, body: m.body, createdAt: cursor },
      });
      messageCount += 1;
    }
    // 最後の発話時刻（無返信テーマは開始時刻）を一覧ソート用 lastMessageAt に反映。
    await prisma.chatTheme.update({ where: { id: theme.id }, data: { lastMessageAt: cursor } });
  }
  console.log(`Chat seeded: ${themeCount} themes / ${messageCount} messages.`);
}

// メンション先 account を本文 HTML 上の青ラベル（.desk-mention）span へ畳む。本番の RTE（@tiptap/extension-mention）
// 出力と同形式にし、sanitize 許可属性（span / class / data-type / data-id / data-label）で round-trip する。
// extractMentionAccountIds は data-type="mention" + data-id を解析するため、フィルタの join 行と本文表示が一致する。
// name は DB 由来（プロフィール編集で `"`/`<`/`>`/`&` を含みうる）ため属性値・要素テキストへ展開前にエスケープする
// （現状の seed 名称は安全だが将来の構造崩壊を予防）。accountId は UUID 固定なのでエスケープ不要。
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function mentionSpan(accountId: string, name: string): string {
  const safe = escapeHtml(name);
  return `<span class="desk-mention" data-type="mention" data-id="${accountId}" data-label="${safe}">@${safe}</span>`;
}

// チャットメンションのサンプル（rete-desk-0049 / 整合修復 rete-desk-0117）。From/To メンションフィルタを実データで
// 動かすための最小データ。chat_message_mentions の join 行と「本文 HTML の @ span」を**必ず一致**させる。
//
// 【rete-desk-0117 で判明した不整合と修復】本関数は当初、join 行を作るだけで本文に @ span を入れていなかった。
// その結果「本文上は誰もメンションしていないのに mention 行だけ在る」状態になり、From/To フィルタ（join 行を引く）が
// 本文と矛盾するヒットを返した（管理者が本文では非メンションのテーマが From=管理者 で出る）。本番の投稿経路は
// 本文 @ span から join 行を導出するため必ず一致する。seed もこの不変条件（join 行 ⇔ 本文 @ span）へ揃える。
//
// 冪等性: (1) mention 0 件の DB は付与ルールで join 行を作る、(2) join 行が在る DB（旧 seed 適用済み含む）は
// 本文に span が無い行だけ後追いで span を注入して修復する。両経路を毎回通すため、再実行は完全一致後 no-op になる。
//
// 付与ルール（決定的・乱数なし）: 既存メッセージを作成時刻昇順に並べ、2 件に 1 件へ「投稿者とは別アカウント」宛の
// メンションを 1 件付ける。宛先はアカウント配列の round-robin（投稿者と被ったら次の候補へ）で分散させ、
// From（発信者）も To（宛先）も複数ユーザーに散らばるようにする。承認待ち/未ミラーのデモアカウント宛は避ける。
async function seedChatMentions() {
  // 宛先候補は「ログイン実体のある実アカウント」に限定（pending/未ミラーのデモは宛先にしない）。
  const recipientIds = [
    BOOTSTRAP_ADMIN_SUB,
    DEMO_SUBS.whUser,
    DEMO_SUBS.whAdmin,
    DEMO_SUBS.ofUser,
    DEMO_SUBS.ofAdmin,
    DEMO_SUBS.tanaka,
  ];
  const candidates = (
    await prisma.account.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true },
    })
  ).map((a) => a.id);

  const messages = await prisma.chatMessage.findMany({
    select: { id: true, authorId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (candidates.length < 2 || messages.length === 0) {
    console.log('Chat mentions: insufficient accounts/messages, skipping.');
    return;
  }

  // (1) join 行が 0 件なら付与ルールで作る（既存 DB に join 行が在れば作成は skip し、(2) の修復のみ行う）。
  //     create を逐次ループせず単一 createMany でアトミックに入れる（途中失敗で join 行が部分的に残ると、
  //     次回 existing>0 で (1) を skip して欠落が回復不能になるため。全成功か全ロールバックへ揃える）。
  const existing = await prisma.chatMessageMention.count();
  let created = 0;
  if (existing === 0) {
    // 宛先はメンション付与カウンタ k で round-robin する（メッセージ index ではなく付与回数で回すことで、
    // 全候補アカウントが満遍なく宛先になる。i で回すと偶奇に偏り一部アカウントが永遠に宛先にならない）。
    const rows: { messageId: string; accountId: string }[] = [];
    let k = 0;
    for (let i = 0; i < messages.length; i += 2) {
      const m = messages[i];
      let r = candidates[k % candidates.length];
      if (r === m.authorId) r = candidates[(k + 1) % candidates.length]; // 自己メンション回避
      if (r === m.authorId) {
        k += 1;
        continue;
      }
      rows.push({ messageId: m.id, accountId: r });
      k += 1;
    }
    if (rows.length > 0) {
      await prisma.chatMessageMention.createMany({ data: rows, skipDuplicates: true });
    }
    created = rows.length;
  }

  // (2) 全 join 行について、対応するメッセージ本文に @ span（data-id 一致）が無ければ注入して整合させる。
  //     旧 seed で本文 @ 無しのまま入った行も、本経路で毎回修復される（rete-desk-0117）。
  const mentions = await prisma.chatMessageMention.findMany({
    select: { messageId: true, accountId: true },
  });
  const bodyById = new Map(
    (
      await prisma.chatMessage.findMany({
        // 修復対象は mention を持つメッセージのみ。全件ロードせず必要 id へ絞る。
        where: { id: { in: [...new Set(mentions.map((x) => x.messageId))] } },
        select: { id: true, body: true },
      })
    ).map((m) => [m.id, m.body]),
  );
  const nameById = new Map(
    (
      await prisma.account.findMany({
        where: { id: { in: [...new Set(mentions.map((x) => x.accountId))] } },
        select: { id: true, name: true },
      })
    ).map((a) => [a.id, a.name]),
  );
  let repaired = 0;
  for (const { messageId, accountId } of mentions) {
    const body = bodyById.get(messageId);
    const name = nameById.get(accountId);
    if (body === undefined || name === undefined) continue;
    if (body.includes(`data-id="${accountId}"`)) continue; // 既に span 在り＝整合済み
    const next = `${body} ${mentionSpan(accountId, name)}`;
    await prisma.chatMessage.update({ where: { id: messageId }, data: { body: next } });
    bodyById.set(messageId, next); // 同一メッセージへの複数宛先を連続注入できるよう更新
    repaired += 1;
  }
  console.log(`Chat mentions: ${created} join 行作成 / ${repaired} 本文 @ span 修復`);
}

// チャットのエンゲージメント実データ（リアクション / 既読状態 / テーマ宛先メンション）。各サブパートは
// 独立した count ガードで冪等にする（開発統括が手で付けたリアクション等を壊さない）。
// - リアクション: messageId / themeId の XOR を守り、二重付与 unique を skipDuplicates で吸収。emoji は SSOT 値域。
// - 既読状態: 一部テーマだけ既読行を作る（全件作ると未読バッジが死ぬ）。最終発話の前後で既読/未読を混在させる。
// - テーマメンション: 説明文（DESCRIPTION）の宛先。join 行 ⇔ 本文 @ span の不変条件（rete-desk-0117）を守るため
//   description に span を注入する。
async function seedChatEngagement() {
  // ログイン実体のあるアカウント（pending/未ミラーは除外）。
  const actors = [
    BOOTSTRAP_ADMIN_SUB,
    DEMO_SUBS.whUser,
    DEMO_SUBS.whAdmin,
    DEMO_SUBS.ofUser,
    DEMO_SUBS.ofAdmin,
    DEMO_SUBS.tanaka,
  ];

  // --- (A) リアクション ---
  if ((await prisma.reaction.count()) === 0) {
    const messages = await prisma.chatMessage.findMany({
      select: { id: true, authorId: true },
      orderBy: { createdAt: 'asc' },
    });
    const themes = await prisma.chatTheme.findMany({
      select: { id: true, authorId: true },
      orderBy: { lastMessageAt: 'desc' },
    });
    const rows: {
      messageId: string | null;
      themeId: string | null;
      authorId: string;
      emoji: string;
    }[] = [];

    // メッセージリアクション: 3 件に 1 件へ 1〜3 個のリアクションを「別アカウント × 別 emoji」で付ける。
    let k = 0;
    for (let i = 0; i < messages.length; i += 3) {
      const m = messages[i];
      const n = (k % 3) + 1; // 1..3 個（群ごとに 1→2→3 で巡回。i は +=3 で進むため i%3 は常に 0 になる点に注意）
      for (let j = 0; j < n; j++) {
        const author = actors[(k + j) % actors.length];
        if (author === m.authorId) continue; // 自分の発話への自己リアクションは避ける（任意の運用方針）
        const emoji = REACTION_EMOJIS[(k + j) % REACTION_EMOJIS.length];
        rows.push({ messageId: m.id, themeId: null, authorId: author, emoji });
      }
      k += 1;
    }
    // テーマ（起点カード）リアクション: 新しい順 8 テーマへ 1 個ずつ（XOR の themeId 側を検証）。
    themes.slice(0, 8).forEach((t, idx) => {
      // 起点カードの投稿者自身による自己リアクションは避ける（メッセージ側と同方針）。
      let author = actors[idx % actors.length];
      if (author === t.authorId) author = actors[(idx + 1) % actors.length];
      rows.push({
        messageId: null,
        themeId: t.id,
        authorId: author,
        emoji: REACTION_EMOJIS[idx % REACTION_EMOJIS.length],
      });
    });

    if (rows.length > 0) {
      await prisma.reaction.createMany({ data: rows, skipDuplicates: true });
    }
    console.log(`Chat reactions seeded: ${rows.length} (message + theme targets).`);
  } else {
    console.log('Reactions already present, skipping reaction seed.');
  }

  // --- (B) 既読状態（未読集約の実データ） ---
  if ((await prisma.chatReadState.count()) === 0) {
    const themes = await prisma.chatTheme.findMany({
      select: { id: true, lastMessageAt: true },
      orderBy: { lastMessageAt: 'desc' },
    });
    const readers = [BOOTSTRAP_ADMIN_SUB, DEMO_SUBS.tanaka, DEMO_SUBS.whAdmin];
    const rows: { accountId: string; themeId: string; lastReadAt: Date }[] = [];
    themes.forEach((t, idx) => {
      readers.forEach((accountId, rIdx) => {
        // 一部の (テーマ×読者) は既読行を作らない＝「一度も開いていない」未読を残す。
        if ((idx + rIdx) % 3 === 0) return;
        // 既読/未読を混在: idx 偶数=最終発話より後（既読）/ 奇数=最終発話より前（未読が残る）。
        const readAfter = idx % 2 === 0;
        const lastReadAt = readAfter
          ? new Date(t.lastMessageAt.getTime() + 60 * 1000)
          : new Date(t.lastMessageAt.getTime() - 60 * 60 * 1000);
        rows.push({ accountId, themeId: t.id, lastReadAt });
      });
    });
    if (rows.length > 0) {
      await prisma.chatReadState.createMany({ data: rows, skipDuplicates: true });
    }
    console.log(`Chat read states seeded: ${rows.length} (mixed read/unread).`);
  } else {
    console.log('Chat read states already present, skipping.');
  }

  // --- (C) テーマ宛先メンション（説明文 DESCRIPTION） ---
  if ((await prisma.chatThemeMention.count()) === 0) {
    const themes = await prisma.chatTheme.findMany({
      select: { id: true, description: true, authorId: true },
      where: { description: { not: null } },
      orderBy: { lastMessageAt: 'desc' },
      take: 8,
    });
    const nameById = new Map(
      (
        await prisma.account.findMany({
          where: { id: { in: actors } },
          select: { id: true, name: true },
        })
      ).map((a) => [a.id, a.name]),
    );
    let k = 0;
    let mentionCount = 0;
    for (const t of themes) {
      if (!t.description) continue;
      let r = actors[k % actors.length];
      if (r === t.authorId) r = actors[(k + 1) % actors.length];
      if (r === t.authorId) {
        k += 1;
        continue;
      }
      // join 行作成と本文 @ span 注入を 1 トランザクションで原子化する。途中失敗で
      // 「join 行はあるが本文に @ span が無い」不整合（rete-desk-0117 の不変条件破り）を残さない。
      const ops: Prisma.PrismaPromise<unknown>[] = [
        prisma.chatThemeMention.create({
          data: { themeId: t.id, accountId: r, field: 'DESCRIPTION' },
        }),
      ];
      if (!t.description.includes(`data-id="${r}"`)) {
        ops.push(
          prisma.chatTheme.update({
            where: { id: t.id },
            data: { description: `${t.description} ${mentionSpan(r, nameById.get(r) ?? '')}` },
          }),
        );
      }
      await prisma.$transaction(ops);
      mentionCount += 1;
      k += 1;
    }
    console.log(`Chat theme mentions seeded: ${mentionCount} (DESCRIPTION).`);
  } else {
    console.log('Chat theme mentions already present, skipping.');
  }
}

// Desk タスクツリーのサンプル（カテゴリ別グルーピング + 最大 4 階層の親子）。タスクが 1 件でも在れば skip。
// モック desk/index.html のタスク行を題材に、全 4 ステータス・4 階層・担当/期日の有無・昇格リンク（sourceThemeId）を
// 網羅する。assigneeName は自由文字列、categoryId は seed 済マスタを name 解決、sortOrder は兄弟内連番。
async function seedTasks() {
  // skip ガードは seedChat（chatTheme.count）と意図的に独立（別テーブル基準）。
  // sourceThemeId は下で chatTheme を引き直して解決するため、chat skip 時もタスク投入は整合する。
  const existing = await prisma.task.count();
  if (existing > 0) {
    console.log(`Tasks already present (${existing}), skipping task seed.`);
    return;
  }

  console.log('Seeding task tree...');

  // 昇格元テーマの id 解決表。seedChat が skip された場合（既存テーマあり）でも title で引き直して整合させる。
  const themes = await prisma.chatTheme.findMany({ select: { id: true, title: true } });
  const themeIdByTitle = new Map(themes.map((t) => [t.title, t.id] as const));

  // 分類は rete-desk-0158 で Space 単位スコープ。`(spaceId, name)` → id で引く（@@unique([spaceId,name]) と対応）。
  // タスクは「自分の所属 Space に属す分類」のみを持てる（整合性ルール）。未分類（categoryId=null）も許可。
  const categories = await prisma.category.findMany({
    select: { id: true, name: true, spaceId: true },
  });
  const categoryIdBySpaceName = new Map(
    categories.map((c) => [`${c.spaceId}::${c.name}`, c.id] as const),
  );
  const resolveCategoryId = (spaceId: string, name: string | null): number | null => {
    if (name === null) return null; // 未分類（D3）
    const id = categoryIdBySpaceName.get(`${spaceId}::${name}`);
    if (id === undefined) {
      console.warn(`Category "${name}" not found in space ${spaceId}, falling back to 未分類.`);
      return null;
    }
    return id;
  };
  // 所有者（作成者）プール。トップレベルタスクへ round-robin で割り当て、H4 所有者 enforcement を実データで
  // 検証可能にする。ログイン実体のある実アカウントに限定。
  const OWNER_POOL = [DEMO_SUBS.whAdmin, DEMO_SUBS.ofAdmin, DEMO_SUBS.whUser, DEMO_SUBS.tanaka];

  type TaskNode = {
    title: string;
    description?: string;
    status?: TaskStatus; // 省略時 TODO
    tenmatsu?: string; // 顛末（status=DONE の結論メモ。完了タスクのみ）
    assignee?: string; // 省略時 null（未割当）
    start?: string; // JST date 文字列、省略可
    due?: string;
    src?: string; // 昇格元テーマ title（PROMOTE_SRC 値）
    children?: TaskNode[];
  };

  // 各グループは「どの Space に属し、その Space のどの分類（null=未分類）か」を宣言する（rete-desk-0158）。
  // spaceId はチャネルの固定 ID（cmId）/ DEFAULT_CHANNEL_ID。category は seedCategories が作った Space 内分類名、
  // または null（未分類バケットのデモ用）。タスクの spaceId と categoryId が同一 Space に属すよう整合させる。
  const TREE: { spaceId: string; category: string | null; tasks: TaskNode[] }[] = [
    {
      spaceId: cmId(30), // #入荷
      category: '検品',
      tasks: [
        {
          title: '入荷予定インポートの CSV 仕様策定',
          description: '取引先ごとにバラバラな入荷予定 CSV を統一的に取り込む仕様を固める。',
          status: 'IN_PROGRESS',
          assignee: ASSIGNEES.sakuma,
          start: '2026-05-10T09:00:00',
          due: '2026-06-15T18:00:00',
          children: [
            {
              title: '文字コード判定の自動化',
              status: 'IN_PROGRESS',
              assignee: ASSIGNEES.hayashi,
              due: '2026-06-05T18:00:00',
              children: [
                {
                  title: 'BOM 検出ロジックの実装',
                  status: 'IN_PROGRESS',
                  assignee: ASSIGNEES.hayashi,
                  due: '2026-06-12T18:00:00',
                  children: [
                    // 4 階層目（app 制約の最大深度）。担当未割当・期日先のパターン。
                    { title: '単体テストの追加', status: 'TODO', due: '2026-07-20T18:00:00' },
                  ],
                },
              ],
            },
            {
              title: 'エラー行の表示形式',
              status: 'IN_REVIEW',
              assignee: ASSIGNEES.sakuma,
              due: '2026-05-22T18:00:00',
            },
          ],
        },
        {
          title: '取引先別 CSV テンプレート管理',
          status: 'IN_REVIEW',
          assignee: ASSIGNEES.sakuma,
          due: '2026-05-25T18:00:00',
        },
        {
          title: 'ロット番号の自動採番',
          status: 'IN_PROGRESS',
          assignee: ASSIGNEES.nakajima,
          due: '2026-06-08T18:00:00',
        },
        {
          title: '入荷検品時の写真添付（破損確認用）',
          status: 'TODO',
          assignee: ASSIGNEES.hayashi,
          due: '2026-06-30T18:00:00',
        },
      ],
    },
    {
      spaceId: cmId(31), // #出荷
      category: '配送手配',
      tasks: [
        {
          title: '出荷指示書 PDF 生成のレイアウト改善',
          status: 'TODO',
          assignee: ASSIGNEES.hayashi,
          due: '2026-07-10T18:00:00',
        },
        {
          title: '出荷予定一覧の絞り込み（複数取引先対応）',
          status: 'DONE',
          assignee: ASSIGNEES.nakajima,
          start: '2026-04-01T09:00:00',
          due: '2026-04-30T18:00:00',
          tenmatsu:
            '取引先の複数選択フィルタを実装。AND/OR 切替も追加し、4/28 リリース。現場の手作業突合がゼロになった。',
        },
        {
          title: '配送業者連携 API（伝票番号 webhook）',
          status: 'TODO',
          assignee: ASSIGNEES.hayashi,
          due: '2026-06-25T18:00:00',
        },
        {
          title: '出荷波動の半自動計画（午前/午後分担）',
          status: 'TODO',
          assignee: ASSIGNEES.nakajima,
          due: '2026-07-05T18:00:00',
          children: [
            {
              title: '波動計画パラメータの設定 UI',
              status: 'IN_PROGRESS',
              assignee: ASSIGNEES.sakuma,
              due: '2026-06-18T18:00:00',
            },
          ],
        },
        { title: '出荷ラベルのフォント自動調整', status: 'TODO', due: '2026-06-28T18:00:00' },
      ],
    },
    {
      spaceId: cmId(32), // #在庫管理
      category: '在庫アラート',
      tasks: [
        {
          title: '在庫アラート閾値の ABC 区分対応',
          description: '一律閾値をやめ、ABC 区分ごとに発注点を持たせる。',
          status: 'TODO',
          assignee: ASSIGNEES.sakuma,
          due: '2026-06-20T18:00:00',
          src: PROMOTE_SRC.alertThreshold,
          children: [
            {
              title: '商品マスタへ ABC 区分列を追加',
              status: 'TODO',
              assignee: ASSIGNEES.nakajima,
              due: '2026-06-13T18:00:00',
            },
          ],
        },
        {
          title: '引当ロジックの見直し（予約在庫考慮）',
          status: 'IN_PROGRESS',
          assignee: ASSIGNEES.hayashi,
          due: '2026-06-22T18:00:00',
        },
      ],
    },
    {
      spaceId: cmId(33), // #棚卸
      category: '差異分析',
      tasks: [
        {
          title: '棚卸差異の原因分析',
          status: 'IN_PROGRESS',
          assignee: ASSIGNEES.sakuma,
          start: '2026-05-20T09:00:00',
          due: '2026-06-10T18:00:00',
          src: PROMOTE_SRC.stocktakeDiff,
          children: [
            {
              title: '差異上位 20 品の棚番再確認',
              status: 'TODO',
              assignee: ASSIGNEES.nakajima,
              due: '2026-06-03T18:00:00',
            },
            {
              title: '入出庫ログとの突合',
              status: 'IN_REVIEW',
              assignee: ASSIGNEES.hayashi,
              due: '2026-06-06T18:00:00',
            },
          ],
        },
        { title: '循環棚卸スケジュールの策定', status: 'TODO', due: '2026-07-15T18:00:00' },
      ],
    },
    {
      spaceId: cmId(35), // #受発注
      category: '発注計画',
      tasks: [
        {
          title: '発注点の自動計算ロジック実装',
          status: 'TODO',
          assignee: ASSIGNEES.sakuma,
          due: '2026-07-01T18:00:00',
          src: PROMOTE_SRC.reorderPoint,
        },
        {
          title: '発注承認フローの追加',
          status: 'DONE',
          assignee: ASSIGNEES.nakajima,
          start: '2026-04-20T09:00:00',
          due: '2026-05-15T18:00:00',
          tenmatsu:
            '金額閾値で承認段階を分岐（10万未満=自動 / 以上=管理者承認）。誤発注の事前差し戻しが月3件発生し効果を確認。',
        },
      ],
    },
    {
      spaceId: DEFAULT_CHANNEL_ID, // 全体共通: マスタ管理（汎用分類）
      category: 'マスタ管理',
      tasks: [
        {
          title: '商品マスタ重複登録チェック',
          status: 'DONE',
          assignee: ASSIGNEES.hayashi,
          start: '2026-04-15T09:00:00',
          due: '2026-05-10T18:00:00',
          tenmatsu:
            '型番を正規化（全角→半角・大文字化）して既存突合し、登録時に類似候補を警告する UX を実装。重複の新規発生が停止。',
        },
        {
          title: '取引先マスタの項目追加（締日・支払サイト）',
          status: 'TODO',
          due: '2026-06-26T18:00:00',
        },
      ],
    },
    {
      spaceId: DEFAULT_CHANNEL_ID, // 全体共通: その他（汎用分類）
      category: 'その他',
      tasks: [
        {
          title: '月次レポートの自動配信',
          status: 'DONE',
          assignee: ASSIGNEES.nakajima,
          start: '2026-04-25T09:00:00',
          due: '2026-05-10T18:00:00',
          tenmatsu:
            '締め処理後バッチで在庫評価額レポートを自動生成・配信。月初の手集計（半日工数）が不要になった。',
        },
        {
          title: '棚卸用ハンディ端末の選定',
          status: 'TODO',
          assignee: ASSIGNEES.sakuma,
          due: '2026-08-01T18:00:00',
        },
      ],
    },
    {
      // 未分類（categoryId=null）デモ（D3）: 全体共通チャネルに分類を持たないタスクを置き、
      // ツリーの「未分類」バケット表示を実データで検証可能にする。
      spaceId: DEFAULT_CHANNEL_ID,
      category: null,
      tasks: [
        {
          title: '分類未設定の連絡メモ（議事録の整理）',
          status: 'TODO',
          assignee: ASSIGNEES.sakuma,
          due: '2026-07-12T18:00:00',
        },
        { title: '備品の棚卸（分類未定）', status: 'TODO', due: '2026-07-18T18:00:00' },
      ],
    },
    {
      // 未分類デモ（D3）: #入荷 チャネルにも分類なしタスクを置き、Space ごとの未分類バケットを検証する。
      spaceId: cmId(30),
      category: null,
      tasks: [
        {
          title: '入荷ヤードのレイアウト見直し（分類未定）',
          status: 'TODO',
          assignee: ASSIGNEES.nakajima,
          due: '2026-07-25T18:00:00',
        },
      ],
    },
  ];

  let taskCount = 0;
  async function createNode(
    node: TaskNode,
    categoryId: number | null,
    parentTaskId: number | null,
    sortOrder: number,
    spaceId: string | null,
    ownerId: string | null,
  ) {
    const sourceThemeId = node.src ? (themeIdByTitle.get(node.src) ?? null) : null;
    const created = await prisma.task.create({
      data: {
        title: node.title,
        description: node.description ?? null,
        status: node.status ?? 'TODO',
        // 顛末は DONE のみ保持（完了ゲートの実データ）。未完了で tenmatsu が来ても null に倒す。
        tenmatsu: node.status === 'DONE' ? (node.tenmatsu ?? null) : null,
        categoryId,
        parentTaskId,
        sortOrder,
        assigneeName: node.assignee ?? null,
        startDate: node.start ? jst(node.start) : null,
        dueDate: node.due ? jst(node.due) : null,
        sourceThemeId,
        spaceId,
        ownerId,
      },
    });
    taskCount += 1;
    let childOrder = 1;
    for (const child of node.children ?? []) {
      // 子は親の器・所有者を継承（同一ツリーは同じ器/オーナーに属す）。
      await createNode(child, categoryId, created.id, childOrder, spaceId, ownerId);
      childOrder += 1;
    }
  }

  // owner を割り当てた回数のグローバルカーソル。カテゴリ境界をまたいで連番化し、OWNER_POOL 全 4 アカウントを
  // 確実に巡回させる（カテゴリ内 index だと小カテゴリで先頭オーナーに偏り、後方の owner が死蔵されるため）。
  let ownerCursor = 0;
  for (const group of TREE) {
    // 分類を Space スコープで解決（未分類 null も許可）。spaceId と categoryId は同一 Space に属す（整合性ルール）。
    const categoryId = resolveCategoryId(group.spaceId, group.category);
    const spaceId = group.spaceId;
    let order = 1;
    for (const [topIdx, node] of group.tasks.entries()) {
      // 偶数 index のトップレベルにのみ所有者を割り当て、奇数は null owner（ADMIN のみ変更可）として残す
      // ことで、H4 所有者 enforcement の「所有者あり/なし」両パスを実データで検証可能にする。
      const ownerId = topIdx % 2 === 0 ? OWNER_POOL[ownerCursor++ % OWNER_POOL.length] : null;
      await createNode(node, categoryId, null, order, spaceId, ownerId);
      order += 1;
    }
  }
  console.log(`Tasks seeded: ${taskCount}`);
}

// Desk File タブのサンプル（フォルダツリー + ファイル + 版）。フォルダが 1 件でも在れば skip し冪等にする。
// メタ（folders / files / file_versions）に加えて実体も書き出し、ダウンロード（GET /files/files/:id/download）
// まで動く状態にする。storageKey は app（FilesService.uploadFile）と同形 `<fileId>/<versionId>`、保存ルートは
// LocalFsStorageService と同じ解決式（FILE_STORAGE_ROOT ?? ./storage/files）で揃え、dev サーバーが同 cwd で
// 参照できるようにする。dev 専用のデモデータで、譲渡先・本番では投入されない（フォルダ存在で skip）。
const FILE_STORAGE_ROOT = resolve(process.env.FILE_STORAGE_ROOT ?? './storage/files');

type FileVersionSeed = { mimeType: string; ageHours: number; body: string };
type FileSeed = { name: string; uploaderId: string; versions: FileVersionSeed[] };
type FolderSeed = { name: string; files?: FileSeed[]; children?: FolderSeed[] };

/** storageKey 配下へ実体を書き出す（LocalFsStorageService.write と同手順）。 */
async function writeStorageObject(storageKey: string, data: Buffer) {
  const full = resolve(FILE_STORAGE_ROOT, storageKey);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
}

async function seedFiles() {
  const existing = await prisma.folder.count();
  if (existing > 0) {
    console.log(`Folders already present (${existing}), skipping files seed.`);
    return;
  }

  console.log('Seeding folder tree, files & versions...');
  const admin = BOOTSTRAP_ADMIN_SUB;
  const A = DEMO_SUBS;

  // 在庫業務ドメイン（chat / task と地続き）のフォルダツリー。版数・アップロード者・サイズ・更新日・
  // ファイル種別・空フォルダ（棚卸/過去棚卸）を意図的にばらけさせ、一覧/ツリー/空状態を網羅表示する。
  // ageHours = いま時点から何時間前の版か（小さいほど新しい）。最新版が一覧の更新日/版数/サイズに出る。
  const TREE: FolderSeed[] = [
    {
      name: '入荷',
      files: [
        {
          name: '入荷予定_A社_20260520.csv',
          uploaderId: A.whAdmin,
          versions: [
            {
              mimeType: 'text/csv',
              ageHours: 360,
              body: '商品コード,商品名,予定数,入荷予定日\nA-1001,スチールラック,120,2026-05-20\nA-1002,コンテナ大,80,2026-05-20\n',
            },
          ],
        },
        {
          name: '入荷検品マニュアル.md',
          uploaderId: A.whUser,
          versions: [
            {
              mimeType: 'text/markdown',
              ageHours: 600,
              body: '# 入荷検品マニュアル（初版）\n\n- 数量確認\n- 破損確認\n',
            },
            {
              mimeType: 'text/markdown',
              ageHours: 120,
              body: '# 入荷検品マニュアル（改訂）\n\n- 数量確認\n- 破損・汚損確認（写真添付）\n- ロット番号照合\n',
            },
          ],
        },
      ],
      children: [
        {
          name: 'CSV仕様書',
          files: [
            {
              name: '文字コード判定仕様.md',
              uploaderId: admin,
              versions: [
                {
                  mimeType: 'text/markdown',
                  ageHours: 300,
                  body: '# 文字コード自動判定\n\nBOM 検出 → 統計判定 → 手動フォールバックの 3 段。\n',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: '出荷',
      files: [
        {
          name: '出荷ラベルレイアウト.pdf',
          uploaderId: A.whUser,
          versions: [
            {
              mimeType: 'application/pdf',
              ageHours: 200,
              body: '%PDF-1.4 デモ用プレースホルダ\n出荷ラベルレイアウト案\n',
            },
          ],
        },
        {
          name: '配送業者連携API仕様.md',
          uploaderId: admin,
          versions: [
            {
              mimeType: 'text/markdown',
              ageHours: 90,
              body: '# 配送業者連携 API\n\n伝票番号 webhook の受信仕様。\n',
            },
          ],
        },
      ],
    },
    {
      name: '在庫',
      files: [
        {
          name: 'ABC区分マスタ.xlsx',
          uploaderId: A.ofUser,
          versions: [
            {
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              ageHours: 480,
              body: 'ABC区分マスタ v1（デモ用プレースホルダ）\n',
            },
            {
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              ageHours: 240,
              body: 'ABC区分マスタ v2（デモ用プレースホルダ）\n',
            },
            {
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              ageHours: 24,
              body: 'ABC区分マスタ v3（デモ用プレースホルダ）\n',
            },
          ],
        },
      ],
    },
    {
      name: '棚卸',
      files: [
        {
          name: '棚卸差異分析_2026Q1.md',
          uploaderId: A.whAdmin,
          versions: [
            {
              mimeType: 'text/markdown',
              ageHours: 300,
              body: '# 棚卸差異分析 2026Q1（ドラフト）\n',
            },
            {
              mimeType: 'text/markdown',
              ageHours: 48,
              body: '# 棚卸差異分析 2026Q1\n\n上位 20 品で差異の 7 割。計上漏れと二重計上が半々。\n',
            },
          ],
        },
      ],
      // 空フォルダ（一覧の空状態確認用）。
      children: [{ name: '過去棚卸' }],
    },
    {
      name: '共有ドキュメント',
      files: [
        {
          name: '倉庫レイアウト図.pdf',
          uploaderId: admin,
          versions: [
            {
              mimeType: 'application/pdf',
              ageHours: 720,
              body: '%PDF-1.4 倉庫レイアウト図（デモ用プレースホルダ）\n',
            },
          ],
        },
      ],
      children: [
        {
          name: 'マニュアル',
          files: [
            {
              name: '新人向け入荷作業手順.md',
              uploaderId: A.whAdmin,
              versions: [
                {
                  mimeType: 'text/markdown',
                  ageHours: 168,
                  body: '# 新人向け入荷作業手順\n\n1. 受領\n2. 検品\n3. 棚入れ\n',
                },
              ],
            },
          ],
        },
        {
          name: 'テンプレート',
          files: [
            {
              name: '納期回答テンプレート.csv',
              uploaderId: A.ofUser,
              versions: [
                {
                  mimeType: 'text/csv',
                  ageHours: 100,
                  body: '発注番号,商品コード,回答納期,備考\n,,,\n',
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  let folderCount = 0;
  let fileCount = 0;
  let versionCount = 0;

  // 1 ファイル分の版を古い→新しい順に積む（versionNo は 1 始まり）。初版は File と入れ子作成、
  // 2 版目以降は FileVersion 追加（app の同名再アップと同じ版加算）。各版の実体も storageKey へ書き出す。
  async function createFile(file: FileSeed, folderId: string) {
    const fileId = randomUUID();
    for (let i = 0; i < file.versions.length; i += 1) {
      const v = file.versions[i];
      const versionId = randomUUID();
      const versionNo = i + 1;
      const storageKey = `${fileId}/${versionId}`;
      const buf = Buffer.from(v.body, 'utf-8');
      const createdAt = new Date(NOW.getTime() - v.ageHours * 3600 * 1000);
      await writeStorageObject(storageKey, buf);
      const versionData = {
        id: versionId,
        versionNo,
        storageKey,
        byteSize: BigInt(buf.byteLength),
        mimeType: v.mimeType,
        uploadedById: file.uploaderId,
        createdAt,
      };
      if (i === 0) {
        await prisma.file.create({
          data: {
            id: fileId,
            folderId,
            name: file.name,
            createdAt,
            versions: { create: versionData },
          },
        });
      } else {
        await prisma.fileVersion.create({ data: { ...versionData, fileId } });
      }
      versionCount += 1;
    }
    fileCount += 1;
  }

  async function createFolder(node: FolderSeed, parentFolderId: string | null, sortOrder: number) {
    // spaceId は default channel 固定（ADR 0063 / fil-0135）。API から器を選ばせる契約化は fil-0136 以降で、
    // seed は migration の backfill と同じ帰属（全 folder が default channel 配下）を fresh DB でも再現する。
    const folder = await prisma.folder.create({
      data: { name: node.name, parentFolderId, sortOrder, spaceId: DEFAULT_CHANNEL_ID },
    });
    folderCount += 1;
    for (const f of node.files ?? []) {
      await createFile(f, folder.id);
    }
    let order = 1;
    for (const child of node.children ?? []) {
      await createFolder(child, folder.id, order);
      order += 1;
    }
    return folder;
  }

  let rootOrder = 1;
  for (const node of TREE) {
    // ディレクトリ権限（旧 fil-0027 FB+）の付与は不要になった（ADR 0063）。可視性は所属 Space が
    // 決めるため、既定チャネル（DEFAULT_CHANNEL_ID）配下に作るだけで従来どおり全員が読み書きできる。
    await createFolder(node, null, rootOrder);
    rootOrder += 1;
  }
  console.log(
    `Files seeded: ${folderCount} folders / ${fileCount} files / ${versionCount} versions.`,
  );
}

// ファイル分類タグのマスタ + 付与（rete-files-0006/0010/0011/0013/0021/0022）。色付き icon-only 一覧・
// 絞り込みドロップダウン・サイドバーのタグ管理は「タグが 1 件以上」存在しないと UI 上ほぼ不可視になる
// （DD ボタンは tags.length>0 で初めて描画 / 一覧タグ列は付与ゼロだと "—"）。デモ/動作確認で機能を
// 体感できるよう、色とアイコンが分散したサンプルタグを用意し既存ファイルへ付与する。
// 冪等: タグが 1 件でもあれば skip（開発統括が独自に作ったマスタを壊さない）。icon/color は TAG_ICONS /
// TAG_COLORS（@rete/shared SSOT）の許可集合内のリテラルを使う。
async function seedTags() {
  const existing = await prisma.tag.count();
  if (existing > 0) {
    console.log(`Tags already present (${existing}), skipping tags seed.`);
    return;
  }
  // [name, icon(TAG_ICONS), color(TAG_COLORS)]
  const TAG_SEED: Array<[string, string, string]> = [
    ['重要', 'Flag', 'red'],
    ['仕様書', 'FileText', 'blue'],
    ['確認待ち', 'Clock', 'amber'],
    ['完了', 'CheckCircle', 'green'],
    ['機密', 'Lock', 'violet'],
    ['よく使う', 'Star', 'yellow'],
  ];
  const created: string[] = [];
  for (const [name, icon, color] of TAG_SEED) {
    const tag = await prisma.tag.create({ data: { name, icon, color } });
    created.push(tag.id);
  }

  // 既存ファイルへタグを付与（色付き icon-only 列・絞り込み結果を体感させる）。
  // 先頭から順に 1〜2 件のタグを巡回付与。複合 PK 重複は skipDuplicates で吸収。
  const files = await prisma.file.findMany({ select: { id: true }, orderBy: { name: 'asc' } });
  let links = 0;
  for (let i = 0; i < files.length; i += 1) {
    const primary = created[i % created.length];
    const links2 = [primary];
    // 2 件目を一部ファイルに付けて「複数タグ」「OR 絞り込み」も体感可能にする。
    if (i % 2 === 0) links2.push(created[(i + 2) % created.length]);
    for (const tagId of links2) {
      await prisma.fileTag.create({ data: { fileId: files[i].id, tagId } }).catch(() => {});
      links += 1;
    }
  }
  console.log(`Tags seeded: ${created.length} tags / ${links} file-tag links.`);
}

// 操作ログ / 監査（ST-6 閲覧レイヤ）のサンプル。監査ログが 1 件でも在れば skip し冪等にする。
// 本画面は「閲覧 / 検索 / CSV 出力」のレイヤで、記録（interceptor）は hardening H5 の責務。dev では
// その H5 が未実装でも画面を実データで動かせるよう、ここで過去ログ相当を投入する。
//
// 監査の不変性: actorName / actorEmail / systemName は**記録時点のスナップショット**を非正規化保持する
// （Account / TenantSystem を後で改名・削除しても過去ログの表示が変わらない＝改竄でないことを担保）。
// actorAccountId / systemId は nullable FK で、参照先が消えても SetNull で本文は残る。systemId=null は
// ログイン/ログアウト等の「共通操作（横断）」操作（画面フィルタの AUDIT_SYSTEM_COMMON に対応）。
// actionType は @rete/shared AUDIT_ACTION_TYPES の値域（DB enum を使わず文字列 + アプリ層 @IsIn で担保）。
async function seedAuditLogs() {
  const existing = await prisma.auditLog.count();
  if (existing > 0) {
    console.log(`Audit logs already present (${existing}), skipping audit log seed.`);
    return;
  }

  console.log('Seeding audit logs (ST-6)...');

  // actor のスナップショット名/メールは DEMO_ACCOUNT_DEFS（+ bootstrap admin）から引く（記録時点の値を固定保存）。
  const actorById = new Map<string, { name: string; email: string }>([
    [BOOTSTRAP_ADMIN_SUB, { name: 'Rete 管理者', email: ADMIN_EMAIL }],
    ...DEMO_ACCOUNT_DEFS.map((d) => [d.id, { name: d.name, email: d.email }] as const),
  ]);
  // system のスナップショット名は TENANT_SYSTEM_DEFS から引く（systemId=null は「共通操作」）。
  const systemNameById = new Map<string, string>(TENANT_SYSTEM_DEFS.map((s) => [s.id, s.name]));

  type AuditSeed = {
    actorId: string;
    systemId: string | null;
    actionType: 'create' | 'update' | 'delete' | 'read' | 'login' | 'logout' | 'approve' | 'admin';
    feature: string;
    summary: string;
    ip: string;
    ageMinutes: number;
  };

  // 契約システム（Rete／リファレンス）+ rete 運用を題材に、操作種別・システム・実行者・時刻を散らす。
  const LOGS: AuditSeed[] = [
    {
      actorId: DEMO_SUBS.tanaka,
      systemId: null,
      actionType: 'login',
      feature: 'SSO ログイン',
      summary: 'シングルサインオンでログインしました',
      ip: '203.0.113.10',
      ageMinutes: 8,
    },
    {
      actorId: DEMO_SUBS.tanaka,
      systemId: 'SYS-001',
      actionType: 'read',
      feature: 'ホーム',
      summary: 'ホームの掲示板を閲覧しました',
      ip: '203.0.113.10',
      ageMinutes: 12,
    },
    {
      actorId: DEMO_SUBS.tanaka,
      systemId: 'SYS-001',
      actionType: 'update',
      feature: 'お気に入り',
      summary: 'サイドバーのお気に入り並びを更新しました',
      ip: '203.0.113.10',
      ageMinutes: 20,
    },
    {
      actorId: BOOTSTRAP_ADMIN_SUB,
      systemId: null,
      actionType: 'admin',
      feature: 'メンバー管理',
      summary: '新人 太郎 のアカウントを承認しました',
      ip: '198.51.100.4',
      ageMinutes: 35,
    },
    {
      actorId: BOOTSTRAP_ADMIN_SUB,
      systemId: null,
      actionType: 'admin',
      feature: 'ロール管理',
      summary: '業務ロール「事務管理者」の権限を変更しました',
      ip: '198.51.100.4',
      ageMinutes: 42,
    },
    {
      actorId: DEMO_SUBS.whAdmin,
      systemId: 'SYS-001',
      actionType: 'create',
      feature: 'デスク',
      summary: 'スペース「入荷確認」を作成しました',
      ip: '192.0.2.51',
      ageMinutes: 70,
    },
    {
      actorId: DEMO_SUBS.whUser,
      systemId: 'SYS-001',
      actionType: 'update',
      feature: 'デスク',
      summary: 'テーマ「棚番再確認」の担当を更新しました',
      ip: '192.0.2.52',
      ageMinutes: 95,
    },
    {
      actorId: DEMO_SUBS.ofUser,
      systemId: 'SYS-002',
      actionType: 'read',
      feature: 'マスタ',
      summary: '参照マスタ「取引先」を閲覧しました',
      ip: '192.0.2.80',
      ageMinutes: 130,
    },
    {
      actorId: DEMO_SUBS.ofAdmin,
      systemId: 'SYS-002',
      actionType: 'create',
      feature: 'マスタ',
      summary: '参照データ「倉庫一覧」を登録しました',
      ip: '192.0.2.81',
      ageMinutes: 180,
    },
    {
      actorId: DEMO_SUBS.ofAdmin,
      systemId: 'SYS-002',
      actionType: 'approve',
      feature: 'マスタ',
      summary: '参照データ「倉庫一覧」の公開を承認しました',
      ip: '192.0.2.81',
      ageMinutes: 210,
    },
    {
      actorId: DEMO_SUBS.tanaka,
      systemId: 'RETE-DESK',
      actionType: 'create',
      feature: 'チャット',
      summary: 'テーマ「在庫アラートの閾値をどう決めるか」を作成しました',
      ip: '203.0.113.10',
      ageMinutes: 300,
    },
    {
      actorId: DEMO_SUBS.whAdmin,
      systemId: 'RETE-DESK',
      actionType: 'create',
      feature: 'タスク',
      summary: 'チャットからタスク「閾値ロジック試算」を昇格作成しました',
      ip: '192.0.2.51',
      ageMinutes: 340,
    },
    {
      actorId: DEMO_SUBS.whUser,
      systemId: 'RETE-DESK',
      actionType: 'update',
      feature: 'タスク',
      summary: 'タスク「棚番再確認」の担当者を変更しました',
      ip: '192.0.2.52',
      ageMinutes: 380,
    },
    {
      actorId: DEMO_SUBS.ofUser,
      systemId: 'RETE-FILE',
      actionType: 'create',
      feature: 'ファイル',
      summary: '「2026年5月_棚卸差異分析.xlsx」をアップロードしました',
      ip: '192.0.2.80',
      ageMinutes: 420,
    },
    {
      actorId: DEMO_SUBS.ofUser,
      systemId: 'RETE-FILE',
      actionType: 'delete',
      feature: 'ファイル',
      summary: '重複ファイル「コピー〜.xlsx」を削除しました',
      ip: '192.0.2.80',
      ageMinutes: 460,
    },
    {
      actorId: DEMO_SUBS.whAdmin,
      systemId: null,
      actionType: 'logout',
      feature: 'ログアウト',
      summary: 'ログアウトしました',
      ip: '192.0.2.51',
      ageMinutes: 520,
    },
    {
      actorId: DEMO_SUBS.ofAdmin,
      systemId: 'SYS-002',
      actionType: 'update',
      feature: 'マスタ',
      summary: '参照データ「拠点コード」を更新しました',
      ip: '192.0.2.81',
      ageMinutes: 600,
    },
    {
      actorId: DEMO_SUBS.whUser,
      systemId: 'SYS-001',
      actionType: 'delete',
      feature: 'デスク',
      summary: '誤作成したテーマ下書きを削除しました',
      ip: '192.0.2.52',
      ageMinutes: 720,
    },
    {
      actorId: BOOTSTRAP_ADMIN_SUB,
      systemId: null,
      actionType: 'admin',
      feature: 'テナント設定',
      summary: '契約システム「リファレンス」の表示順を変更しました',
      ip: '198.51.100.4',
      ageMinutes: 900,
    },
    {
      actorId: DEMO_SUBS.tanaka,
      systemId: 'RETE-DESK',
      actionType: 'update',
      feature: 'チャット',
      summary: 'テーマ「マスタ重複登録チェック」をクローズしました',
      ip: '203.0.113.10',
      ageMinutes: 1100,
    },
    {
      actorId: DEMO_SUBS.whAdmin,
      systemId: null,
      actionType: 'login',
      feature: 'SSO ログイン',
      summary: 'シングルサインオンでログインしました',
      ip: '192.0.2.51',
      ageMinutes: 1400,
    },
    {
      actorId: DEMO_SUBS.ofUser,
      systemId: 'SYS-002',
      actionType: 'read',
      feature: 'マスタ',
      summary: '参照マスタ一覧を CSV 出力しました',
      ip: '192.0.2.80',
      ageMinutes: 1700,
    },
    {
      actorId: DEMO_SUBS.ofAdmin,
      systemId: 'SYS-002',
      actionType: 'approve',
      feature: 'マスタ',
      summary: '参照データ変更申請を差し戻しました',
      ip: '192.0.2.81',
      ageMinutes: 2200,
    },
    {
      actorId: DEMO_SUBS.whUser,
      systemId: 'RETE-FILE',
      actionType: 'read',
      feature: 'ファイル',
      summary: '「入荷検品マニュアル_v2.pdf」をダウンロードしました',
      ip: '192.0.2.52',
      ageMinutes: 3000,
    },
    {
      actorId: BOOTSTRAP_ADMIN_SUB,
      systemId: null,
      actionType: 'admin',
      feature: 'メンバー管理',
      summary: 'メンバー「臨時 応援」を無効化しました',
      ip: '198.51.100.4',
      ageMinutes: 4300,
    },
  ];

  const rows = LOGS.map((l) => {
    const actor = actorById.get(l.actorId);
    return {
      actorAccountId: l.actorId,
      actorName: actor?.name ?? '不明なユーザー',
      actorEmail: actor?.email ?? 'unknown@rete.local',
      systemId: l.systemId,
      systemName: l.systemId ? (systemNameById.get(l.systemId) ?? l.systemId) : '共通操作',
      actionType: l.actionType,
      feature: l.feature,
      summary: l.summary,
      ipAddress: l.ip,
      userAgent: 'Mozilla/5.0 (seed)',
      createdAt: new Date(NOW.getTime() - l.ageMinutes * 60 * 1000),
    };
  });
  await prisma.auditLog.createMany({ data: rows });
  console.log(
    `Audit logs seeded: ${rows.length} (incl. ${rows.filter((r) => r.systemId === null).length} system-common entries).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
