import type {
  Category,
  Task,
  Folder,
  File,
  FileVersion,
  FileSettings,
  Tag,
  AnnouncementTag,
  Tenant,
  TenantSystem,
  Account,
  Membership,
  ChatTheme,
  ChatMessage,
  Reaction,
  ChatMessageMention,
  ChatThemeMention,
  ChatReadState,
  DeskGroup,
  DeskGroupClassification,
  DeskGroupMember,
} from '@prisma/client';
import { TaskStatus, ChatThemeStatus, ChatThemeMentionField, Role } from '@prisma/client';
import { DEFAULT_CHANNEL_ID, MembershipScopeType } from '@rete/shared';
import type {
  FileWithLatestVersion,
  FolderWithTags,
} from '../modules/files/repositories/files.repository';
import type { MemberWithRelations } from '../modules/members/repositories/members.repository';
import type { OrganizationRow } from '../modules/organizations/repositories/organizations.repository';
import type { ProjectRow } from '../modules/projects/repositories/projects.repository';
import type { SpaceRow } from '../modules/spaces/repositories/spaces.repository';
import type {
  MembershipRow,
  MembershipWithAccount,
} from '../modules/memberships/repositories/memberships.repository';

/**
 * テスト用の Prisma Entity ファクトリ。spec から import して使う。
 * 固定日時を使い、ISO 文字列変換の検証を決定的にする。
 */

const FIXED_DATE = new Date('2026-05-29T01:23:45.000Z');

export function makeCategoryEntity(overrides: Partial<Category> = {}): Category {
  return {
    id: 1,
    name: '入荷',
    // 分類は Space スコープ（rete-desk-0158）。テスト用の既定 spaceId。
    spaceId: 'space-1',
    sortOrder: 0,
    archivedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeTaskEntity(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: '入荷データ取込',
    description: '当日分の入荷 CSV を取り込む',
    status: TaskStatus.IN_PROGRESS,
    tenmatsu: null,
    categoryId: 1,
    parentTaskId: null,
    sortOrder: 0,
    sourceThemeId: null,
    assigneeId: null,
    assigneeName: '山田太郎',
    startDate: new Date('2026-05-01T00:00:00.000Z'),
    dueDate: new Date('2026-05-10T00:00:00.000Z'),
    ownerId: null, // H4: 作成者 Account FK（既存タスクは null）
    spaceId: null, // CM-2: 器スコープ（既存タスクは null → seed で DEFAULT_CHANNEL に収容）
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeFolderEntity(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 'folder-1',
    name: '受入オペレーション',
    spaceId: DEFAULT_CHANNEL_ID, // ADR 0063: 帰属器（既存 folder は migration で default channel へ backfill）
    parentFolderId: null,
    sortOrder: 0,
    createdById: null, // 作成者不明（ADR 0063 で監査用途のみ・可視性には効かない）
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/**
 * 付与タグ込みの Folder（一覧 mapper / repository の戻り型・rete-files-0033）。
 * tags は既定で空配列、第 2 引数に Tag を渡すと FolderTag→Tag include 済の付与行として載る（file 版と対称）。
 */
export function makeFolderWithTags(
  overrides: Partial<Folder> = {},
  tags: Tag[] = [],
): FolderWithTags {
  const folder = makeFolderEntity(overrides);
  return {
    ...folder,
    tags: tags.map((tag) => ({ folderId: folder.id, tagId: tag.id, createdAt: FIXED_DATE, tag })),
  };
}

/**
 * File Entity。fil-0146 で file 起点の repo 取得（findFileById 等）が所属フォルダの spaceId を
 * include で同乗させるようになったため、既定で `folder: { spaceId }` を載せる（第 2 引数で非可視
 * space を再現できる）。folder を読まない旧来の用途には余分なプロパティが付くだけで無害。
 * overrides に folder を渡すと呼び出し側の値が勝つ（Partial ヘルパーの一般契約・cmn-0422）。
 */
export function makeFileEntity(
  overrides: Partial<File> = {},
  folderSpaceId: string = DEFAULT_CHANNEL_ID,
): File & { folder: { spaceId: string } } {
  return {
    id: 'file-1',
    name: '在庫アラート閾値検討メモ.md',
    folderId: 'folder-1',
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    folder: { spaceId: folderSpaceId },
    ...overrides,
  };
}

export function makeFileVersionEntity(overrides: Partial<FileVersion> = {}): FileVersion {
  return {
    id: 'version-1',
    fileId: 'file-1',
    versionNo: 1,
    storageKey: 'folder-1/file-1/v1',
    byteSize: BigInt(2048),
    mimeType: 'text/markdown',
    uploadedById: 'account-1',
    createdAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeFileSettingsEntity(overrides: Partial<FileSettings> = {}): FileSettings {
  return {
    id: 'singleton',
    maxSizeBytes: BigInt(10 * 1024 * 1024),
    allowedExtensions: ['.pdf', '.md'],
    rejectedExtensions: [],
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeTagEntity(overrides: Partial<Tag> = {}): Tag {
  return {
    id: 'tag-1',
    name: '重要',
    icon: 'Star',
    color: 'slate',
    // fil-0094: 既定は未アーカイブ（null）。アーカイブ済は overrides で archivedAt を指定する。
    archivedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/** お知らせ専用タグ Entity（rete-home-0043 / cmn-0040 で各 spec のインライン定義を集約）。Tag と同形だが別マスタ。 */
export function makeAnnouncementTagEntity(
  overrides: Partial<AnnouncementTag> = {},
): AnnouncementTag {
  return {
    id: 'atag-1',
    kind: 'board',
    name: '重要',
    icon: 'Star',
    color: 'slate',
    archivedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/**
 * 最新版（versions 先頭 1 件 + uploadedBy.name）+ 付与タグを含む File（一覧 mapper / repository の戻り型）。
 * version を空配列にすると「実体未保存ファイル」の防御パスを検証できる。tags は既定で空配列、
 * 第 4 引数に Tag を渡すと FileTag→Tag include 済の付与行として載る（rete-files-0006）。
 */
export function makeFileWithLatestVersion(
  fileOverrides: Partial<File> = {},
  uploaderName = '山田太郎',
  versionOverrides: Partial<FileVersion> = {},
  tags: Tag[] = [],
): FileWithLatestVersion {
  const file = makeFileEntity(fileOverrides);
  const version = makeFileVersionEntity({ fileId: file.id, ...versionOverrides });
  return {
    ...file,
    versions: [{ ...version, uploadedBy: { name: uploaderName } }],
    tags: tags.map((tag) => ({ fileId: file.id, tagId: tag.id, createdAt: FIXED_DATE, tag })),
  };
}

export function makeTenantEntity(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'singleton',
    name: '開発法人',
    badgeColor: 'none',
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeTenantSystemEntity(overrides: Partial<TenantSystem> = {}): TenantSystem {
  return {
    id: 'SYS-001',
    name: 'テストシステム',
    isRete: false,
    enabled: true,
    sortOrder: 0,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/**
 * メンバー管理（ST-4）の repository 戻り型（select 済の Account）。
 * passwordHash 等の機密列は select 段階で既に除外済。
 */
// ============================================================
// CM-2 ファクトリ（Organization / Project / Space / Membership）
// ============================================================

export function makeOrganizationRow(overrides: Partial<OrganizationRow> = {}): OrganizationRow {
  return {
    id: 'org-1',
    name: 'テスト組織',
    sortOrder: 0,
    archivedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeProjectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 'proj-1',
    organizationId: 'org-1',
    name: 'テストプロジェクト',
    sortOrder: 0,
    archivedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeSpaceRow(overrides: Partial<SpaceRow> = {}): SpaceRow {
  return {
    id: 'space-1',
    kind: 'CHANNEL',
    projectId: 'proj-1',
    ownerId: null,
    peerAccountId: null,
    name: 'general',
    sortOrder: 0,
    archivedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/**
 * MembershipsRepository.findByScope / upsert 戻り型（account.name 込み）のファクトリ。
 * accountName が省略された場合は 'テストユーザー' を返す。
 */
export function makeMembershipWithAccount(
  overrides: Partial<Omit<MembershipWithAccount, 'account'>> = {},
  accountName = 'テストユーザー',
): MembershipWithAccount {
  return {
    id: 'membership-1',
    accountId: 'account-1',
    scopeType: MembershipScopeType.ORGANIZATION as unknown as MembershipWithAccount['scopeType'],
    scopeId: 'org-1',
    role: 'MEMBER' as MembershipWithAccount['role'],
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    account: { name: accountName },
    ...overrides,
  };
}

/**
 * 素の MembershipRow（account を含まない基本 select 形状 / findById・findByScope の戻り型）のファクトリ。
 * account.name を含む makeMembershipWithAccount（repository 拡張形）とは別物で、こちらは select 列のみ。
 * scopeType / scopeId / role を override し、複数スコープ（ORG/PROJECT/GROUP）× 複数ロールを並べる。
 */
export function makeMembershipRow(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    id: 'membership-1',
    accountId: 'account-1',
    scopeType: 'ORGANIZATION' as MembershipRow['scopeType'],
    scopeId: 'org-1',
    role: 'MEMBER' as MembershipRow['role'],
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeMemberWithRelations(
  overrides: Partial<Omit<MemberWithRelations, 'systemAccess'>> = {},
  systemIds: string[] = [],
): MemberWithRelations {
  return {
    id: 'account-1',
    name: '田中 太郎',
    familyName: '田中',
    givenName: '太郎',
    email: 'tanaka@struct-pass.example',
    isActive: true,
    lockedUntil: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    // MFA 既定は未設定（null）。有効化済みを作る時は overrides に `mfaSetting: { enabled: true }` を渡す（set-0033）。
    mfaSetting: null,
    ...overrides,
  };
}

// ============================================================
// Account / Membership ファクトリ（複数ユーザー・複数スコープのテストデータ生成）
// ============================================================

/**
 * Account エンティティ（identity SoT）のファクトリ。passwordHash 等の機密列も型上含むため
 * fixture として固定値を入れる（spec は DTO に漏れていないことの検証側で使う）。
 * 複数ユーザーを並べる時は id / email / name / role を override で振り分ける。
 */
export function makeAccountEntity(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    email: 'user@rete.local',
    passwordHash: 'argon2-hash-placeholder',
    credentialsChangedAt: null,
    name: 'テストユーザー',
    familyName: 'テストユーザー',
    givenName: '',
    role: Role.MEMBER,
    isActive: true,
    mustChangePassword: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/**
 * 素の Membership エンティティ（CM-2 / ADR 0037）のファクトリ。account.name を含む
 * makeMembershipWithAccount（repository 戻り型）とは別物で、こちらは DB 行そのもの。
 * scopeType / scopeId / role を override し、複数スコープ（ORG/PROJECT/GROUP）× 複数ロールを並べる。
 */
export function makeMembershipEntity(overrides: Partial<Membership> = {}): Membership {
  return {
    id: 'membership-1',
    accountId: 'account-1',
    scopeType: 'ORGANIZATION' as Membership['scopeType'],
    scopeId: 'org-1',
    role: 'MEMBER' as Membership['role'],
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

// ============================================================
// Chat ファクトリ（Theme / Message / Reaction / Mention / ReadState）
// ============================================================

/**
 * ChatTheme（タイトル付きスレッド）のファクトリ。spaceId は既定で器に所属させた状態
 * （'space-1'）を返す。status / tenmatsu / archivedAt を override し、OPEN/CLOSED・顛末有無・
 * アーカイブ済などのバリエーションを作る。lastMessageAt はソート検証用に override 可能。
 */
export function makeChatThemeEntity(overrides: Partial<ChatTheme> = {}): ChatTheme {
  return {
    id: 'theme-1',
    title: '在庫アラートの閾値をどう決めるか',
    description: '一律閾値だと過剰/欠品が出るので区分ごとに持たせたい。',
    tenmatsu: null,
    status: ChatThemeStatus.OPEN,
    authorId: 'account-1',
    spaceId: 'space-1',
    lastMessageAt: FIXED_DATE,
    archivedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/**
 * ChatMessage（スレッド内の発話）のファクトリ。themeId / authorId / body / createdAt を
 * override し、長スレッド（多数の発話）や投稿者の分散を組み立てる。
 */
export function makeChatMessageEntity(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    themeId: 'theme-1',
    authorId: 'account-1',
    body: 'まずは区分 3 段階で試してみましょう。',
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/**
 * Reaction（絵文字リアクション）のファクトリ。messageId / themeId / taskCommentId / taskId は XOR
 * （ちょうど一つが非 NULL）制約があるため、既定はメッセージ対象（messageId 非 NULL /他は NULL）。
 * 他対象を作る時は `{ messageId: null, taskId: 1 }` 等を override で渡す（dsk-0297）。
 * emoji は @rete/shared REACTION_EMOJIS の値域。
 */
export function makeReactionEntity(overrides: Partial<Reaction> = {}): Reaction {
  return {
    id: 'reaction-1',
    messageId: 'message-1',
    themeId: null,
    taskCommentId: null,
    taskId: null,
    authorId: 'account-1',
    emoji: '👍',
    createdAt: FIXED_DATE,
    ...overrides,
  };
}

/**
 * ChatMessageMention（メッセージ→宛先アカウントの多対多 join 行）のファクトリ。
 * From/To メンションフィルタのテストで、messageId × accountId のペアを組む。
 */
export function makeChatMessageMentionEntity(
  overrides: Partial<ChatMessageMention> = {},
): ChatMessageMention {
  return {
    messageId: 'message-1',
    accountId: 'account-2',
    ...overrides,
  };
}

/**
 * ChatThemeMention（テーマ本文 説明/顛末 → 宛先アカウントの join 行）のファクトリ。
 * field（DESCRIPTION / TENMATSU）で本文のどの面の宛先かを切り替える。
 */
export function makeChatThemeMentionEntity(
  overrides: Partial<ChatThemeMention> = {},
): ChatThemeMention {
  return {
    themeId: 'theme-1',
    accountId: 'account-2',
    field: ChatThemeMentionField.DESCRIPTION,
    ...overrides,
  };
}

/**
 * ChatReadState（テーマ × アカウントの最終既読時刻）のファクトリ。lastReadAt を override し、
 * 既読/未読（lastReadAt より後の他者発話があれば未読）のバリエーションを作る。
 * 既読行が無い状態は本ファクトリを使わない（= 一度も開いていない）ことで表現する。
 */
export function makeChatReadStateEntity(overrides: Partial<ChatReadState> = {}): ChatReadState {
  return {
    accountId: 'account-1',
    themeId: 'theme-1',
    lastReadAt: FIXED_DATE,
    ...overrides,
  };
}

// ============================================================
// DeskGroups ファクトリ（グループ分類 / グループ / 宛先メンバー・dsk-0368）
// ============================================================

export function makeDeskGroupClassificationEntity(
  overrides: Partial<DeskGroupClassification> = {},
): DeskGroupClassification {
  return {
    id: 'c1',
    accountId: 'acc-1',
    name: 'グループ分類1',
    sortOrder: 0,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

export function makeDeskGroupEntity(overrides: Partial<DeskGroup> = {}): DeskGroup {
  return {
    id: 'g1',
    accountId: 'acc-1',
    name: 'グループ1',
    classificationId: null,
    sortOrder: 0,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}

/** targetRef は Space.id（PERSONAL_MEMO / DM。dsk-0330 の targetRef 検証を参照）。 */
export function makeDeskGroupMemberEntity(
  overrides: Partial<DeskGroupMember> = {},
): DeskGroupMember {
  return {
    id: 'm1',
    accountId: 'acc-1',
    groupId: 'g1',
    targetRef: 'space-1',
    sortOrder: 0,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  };
}
