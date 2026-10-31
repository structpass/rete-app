import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TaskStatus, Role, DEFAULT_CHANNEL_ID } from '@rete/shared';
import { TasksService } from './tasks.service';
import { TasksRepository } from './repositories/tasks.repository';
import { ScopeVisibilityService } from '../memberships/scope-visibility.service';
import { TaskActivitiesService } from '../task-activities/task-activities.service';
import { ChatService } from '../chat/chat.service';
import type { ReactionToggleResponseDto } from '../chat/dto/chat-response.dto';
import type { ApiResponse } from '../../common/dto';
import { makeTaskEntity, makeCategoryEntity } from '../../__tests__/factories';

/** owner-check メソッドへ渡す最小ユーザーオブジェクト生成ヘルパ（H4）。 */
const mkUser = (id: string, role = Role.MEMBER) => ({ id, role });

const mockTask = makeTaskEntity();

const mockRepo = {
  findManyPaginated: jest.fn(),
  findById: jest.fn(),
  findByIdWithReactions: jest.fn(),
  findAllForTree: jest.fn(),
  create: jest.fn(),
  createWithSortOrder: jest.fn(),
  getDepth: jest.fn(),
  findThemeById: jest.fn(),
  findCategoryById: jest.fn(),
  findCategoryNameById: jest.fn(),
  findAccountById: jest.fn(),
  getSubtreeHeight: jest.fn(),
  getAncestorIds: jest.fn(),
  findSpaceForMove: jest.fn(),
  moveTask: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  // メンション（dsk-0203）: 宛先存在検証 / 自分宛メンション集約。
  countAccountsByIds: jest.fn(),
  findMentionedTaskIds: jest.fn(),
  // 起点カードのリアクショントグル可視性判定用の軽量取得（dsk-0297）。
  findTaskSpaceId: jest.fn(),
};

// 起点カードのリアクショントグル本体を借用する ChatService のモック（dsk-0297・§3 コピペ禁止）。
// 実メソッドへ型で結び付け、モックの戻り形が実装（ApiResponse<ReactionToggleResponseDto>）と食い違えば
// ts-jest の型診断で落ちるようにする（v2-252。旧実装は無型の jest.fn() で envelope 無しの形を素通ししていた）。
const mockChatService: jest.Mocked<Pick<ChatService, 'toggleReaction'>> = {
  toggleReaction: jest.fn(),
};

/**
 * ChatService.toggleReaction の応答。envelope（success/data）と data の形の正本は
 * ApiResponse<ReactionToggleResponseDto>（backend の chat-response.dto = @rete/shared の再公開）で、
 * 実装（chat.service.ts の共通トグル本体）は ok({ reacted }) でこの形を返す。
 * テストが応答形を自前で持たないよう、値の生成をここ 1 箇所へ集約する（v2-252）。
 */
const chatToggleResponse = (reacted: boolean): ApiResponse<ReactionToggleResponseDto> => ({
  success: true,
  data: { reacted },
});

// Space 可視性検証（rete-hardening-0001）のモック。既定は「可視（所属あり）」とし、
// 越境（可視でない）を検証するテストだけ false へ上書きする。
const mockScopeVisibility = {
  canAccessSpace: jest.fn(),
  resolveVisibleSpaceIds: jest.fn(),
  assertVisibleOr404: jest.fn(),
};

// 属性変更の監査記録（dsk-0223）。record は副作用なので既定は成功（resolve）させ、
// 「呼ばれた changes の中身」を検証する。
const mockTaskActivities = {
  record: jest.fn(),
  list: jest.fn(),
};

describe('TasksService', () => {
  let service: TasksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: TasksRepository, useValue: mockRepo },
        { provide: ScopeVisibilityService, useValue: mockScopeVisibility },
        { provide: TaskActivitiesService, useValue: mockTaskActivities },
        { provide: ChatService, useValue: mockChatService },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
    // 監査記録の既定（成功）。分類名解決の既定（名前付き）も入れておく（dsk-0223）。
    mockTaskActivities.record.mockResolvedValue(undefined);
    mockRepo.findCategoryNameById.mockResolvedValue({ id: 2, name: '出荷' });
    // create / update / move は分類の存在 + 非アーカイブ + Space 整合検証（rete-desk-0140・0158）を通る。
    // 既定は「存在する有効分類（既定タスクの実効 spaceId = DEFAULT_CHANNEL_ID に属す）」とし、不在 /
    // アーカイブ済 / 別 Space を検証するテストだけ個別に上書きする。
    mockRepo.findCategoryById.mockResolvedValue({
      id: 2,
      archivedAt: null,
      spaceId: DEFAULT_CHANNEL_ID,
    });
    // 既定で Space は可視（所属あり）。越境テストのみ false へ上書きする。
    mockScopeVisibility.canAccessSpace.mockResolvedValue(true);
    // 存在秘匿ガード（assertVisibleOr404）の既定は「可視（resolve）」。越境テストのみ
    // NotFoundException で reject へ上書きする。
    mockScopeVisibility.assertVisibleOr404.mockResolvedValue(undefined);
    // 自分宛メンション集約（dsk-0203）の既定は「自分宛なし（空集合）」。点灯テストのみ上書きする。
    mockRepo.findMentionedTaskIds.mockResolvedValue(new Set());
    // v2-259: 可視判定用の軽量取得（findTaskSpaceId）は、各テストが用意した実体（findById /
    // findByIdWithReactions）から id と spaceId を取り出して返す配線にする（実装の取得分割に追随。
    // 検証内容は変えない。個別テストの findTaskSpaceId 上書きは本既定より優先される）。
    mockRepo.findTaskSpaceId.mockImplementation(async (id: number) => {
      const task = (await mockRepo.findById(id)) ?? (await mockRepo.findByIdWithReactions(id));
      return task ? { id: task.id, spaceId: task.spaceId } : null;
    });
  });

  it('サービスが定義されていること', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('Repository.findManyPaginated に LIST_CONFIG を渡し、Entity を DTO へ変換した paginated レスポンスを返すこと', async () => {
      const meta = { total: 1, page: 1, limit: 20, totalPages: 1 };
      // Repository は Entity + meta + 自分宛メンション集合を返す（DTO 変換は Service の責務 / dsk-0203）
      mockRepo.findManyPaginated.mockResolvedValue({
        data: [mockTask],
        meta,
        mentionedTaskIds: new Set<number>(),
      });

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.success).toBe(true);
      expect(result.meta).toEqual(meta);
      expect(result.data).toHaveLength(1);
      // Service が mapper を通し、Date が ISO 文字列化されていること
      expect(typeof result.data[0].createdAt).toBe('string');
      expect(result.data[0].id).toBe(mockTask.id);
      expect(mockRepo.findManyPaginated).toHaveBeenCalledWith(
        { page: 1, limit: 20 },
        expect.objectContaining({
          searchFields: ['title'],
          allowedSortFields: expect.arrayContaining(['createdAt', 'title', 'status', 'dueDate']),
        }),
        undefined,
      );
    });

    it('mentionedTaskIds に含まれるタスクは hasMentionToMe:true へ畳まれる（dsk-0203）', async () => {
      const meta = { total: 1, page: 1, limit: 20, totalPages: 1 };
      mockRepo.findManyPaginated.mockResolvedValue({
        data: [mockTask],
        meta,
        mentionedTaskIds: new Set<number>([mockTask.id]),
      });

      const result = await service.findAll({ page: 1, limit: 20 }, 'acc-1');

      expect(result.data[0].hasMentionToMe).toBe(true);
      // accountId を repository へ渡す（hasMentionToMe 集約のため）。
      expect(mockRepo.findManyPaginated.mock.calls[0][2]).toBe('acc-1');
    });

    it('mentionedTaskIds に含まれないタスクは hasMentionToMe:false（既定）', async () => {
      const meta = { total: 1, page: 1, limit: 20, totalPages: 1 };
      mockRepo.findManyPaginated.mockResolvedValue({
        data: [mockTask],
        meta,
        mentionedTaskIds: new Set<number>([999999]),
      });

      const result = await service.findAll({ page: 1, limit: 20 }, 'acc-1');

      expect(result.data[0].hasMentionToMe).toBe(false);
    });

    it('source theme が読者に不可視なら一覧からIDとタイトルを除く', async () => {
      mockScopeVisibility.resolveVisibleSpaceIds.mockResolvedValue(['task-space']);
      mockRepo.findManyPaginated.mockResolvedValue({
        data: [
          {
            ...makeTaskEntity({ id: 12, spaceId: 'task-space', sourceThemeId: 'secret-theme' }),
            sourceTheme: { id: 'secret-theme', title: '秘匿テーマ', spaceId: 'private-space' },
          },
        ],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
        mentionedTaskIds: new Set<number>(),
      });

      const result = await service.findAll({ page: 1, limit: 20 }, 'reader-1');

      expect(result.data[0].sourceThemeId).toBeNull();
      expect(result.data[0].sourceTheme).toBeNull();
    });

    it('可視なsource themeはIDとタイトルだけを返しspaceIdをDTOへ出さない', async () => {
      mockScopeVisibility.resolveVisibleSpaceIds.mockResolvedValue(['task-space', 'theme-space']);
      mockRepo.findManyPaginated.mockResolvedValue({
        data: [
          {
            ...makeTaskEntity({ id: 13, spaceId: 'task-space', sourceThemeId: 'visible-theme' }),
            sourceTheme: { id: 'visible-theme', title: '公開テーマ', spaceId: 'theme-space' },
          },
        ],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
        mentionedTaskIds: new Set<number>(),
      });

      const result = await service.findAll({ page: 1, limit: 20 }, 'reader-1');

      expect(result.data[0].sourceThemeId).toBe('visible-theme');
      expect(result.data[0].sourceTheme).toEqual({ id: 'visible-theme', title: '公開テーマ' });
    });
  });

  describe('findOne', () => {
    it('存在する場合に TaskResponseDto shape のデータを返すこと', async () => {
      mockRepo.findByIdWithReactions.mockResolvedValue(mockTask);

      const result = await service.findOne(1);

      expect(result.success).toBe(true);
      // dsk-0356: 単体 GET のみ findByIdWithReactions（v2-259: 可視判定は同梱なしの軽量取得で先に行う）
      expect(mockRepo.findTaskSpaceId).toHaveBeenCalledWith(1);
      expect(mockRepo.findByIdWithReactions).toHaveBeenCalledWith(1);
      expect(result.data).toEqual(
        expect.objectContaining({
          id: mockTask.id,
          title: mockTask.title,
          description: mockTask.description,
          status: mockTask.status,
          categoryId: mockTask.categoryId,
          parentTaskId: mockTask.parentTaskId,
          assigneeName: mockTask.assigneeName,
        }),
      );
      // mapper 経由で Date が ISO 文字列になっていること
      expect(typeof result.data.createdAt).toBe('string');
      expect(result.data.startDate).toBe(mockTask.startDate!.toISOString());
    });

    it('存在しない場合に NotFoundException をスローすること', async () => {
      mockRepo.findByIdWithReactions.mockResolvedValue(null);
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });

    it('自分宛メンションがあるタスクは hasMentionToMe:true を返すこと（dsk-0203・単体 GET でも集約）', async () => {
      mockRepo.findByIdWithReactions.mockResolvedValue(mockTask);
      mockRepo.findMentionedTaskIds.mockResolvedValue(new Set([mockTask.id]));

      const result = await service.findOne(mockTask.id, 'acc-1');

      expect(result.data.hasMentionToMe).toBe(true);
      expect(mockRepo.findMentionedTaskIds).toHaveBeenCalledWith([mockTask.id], 'acc-1');
    });

    it('taskは可視でもsource themeが不可視なら詳細からIDとタイトルを除く', async () => {
      mockRepo.findByIdWithReactions.mockResolvedValue({
        ...makeTaskEntity({ id: 22, spaceId: 'task-space', sourceThemeId: 'secret-theme' }),
        sourceTheme: { id: 'secret-theme', title: '秘匿テーマ', spaceId: 'private-space' },
      });
      mockScopeVisibility.canAccessSpace.mockResolvedValue(false);

      const result = await service.findOne(22, 'reader-1');

      expect(result.data.sourceThemeId).toBeNull();
      expect(result.data.sourceTheme).toBeNull();
    });
  });

  describe('toggleReaction（dsk-0297・起点カードへのリアクション）', () => {
    it('可視な参加者なら所有判定なしで ChatService.toggleReaction を { taskId } ターゲットで呼ぶこと', async () => {
      mockRepo.findTaskSpaceId.mockResolvedValue({ id: 1, spaceId: 'space-1' });
      mockChatService.toggleReaction.mockResolvedValue(chatToggleResponse(true));

      const result = await service.toggleReaction(1, 'acc-1', { emoji: '👍' });

      expect(mockRepo.findTaskSpaceId).toHaveBeenCalledWith(1);
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith('acc-1', 'space-1');
      expect(mockChatService.toggleReaction).toHaveBeenCalledWith({ taskId: 1 }, 'acc-1', '👍');
      expect(result).toEqual(chatToggleResponse(true));
    });

    it('spaceId が null の場合は DEFAULT_CHANNEL_ID を可視性チェックへ渡すこと', async () => {
      mockRepo.findTaskSpaceId.mockResolvedValue({ id: 1, spaceId: null });
      mockChatService.toggleReaction.mockResolvedValue(chatToggleResponse(false));

      await service.toggleReaction(1, 'acc-1', { emoji: '🎉' });

      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith(
        'acc-1',
        DEFAULT_CHANNEL_ID,
      );
    });

    it('タスクが存在しない場合に NotFoundException をスローし ChatService を呼ばないこと', async () => {
      mockRepo.findTaskSpaceId.mockResolvedValue(null);

      await expect(service.toggleReaction(999, 'acc-1', { emoji: '👍' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockChatService.toggleReaction).not.toHaveBeenCalled();
    });

    it('非可視 Space の場合は存在秘匿のため NotFoundException をスローし ChatService を呼ばないこと', async () => {
      mockRepo.findTaskSpaceId.mockResolvedValue({ id: 1, spaceId: 'space-2' });
      mockScopeVisibility.assertVisibleOr404.mockRejectedValue(new NotFoundException());

      await expect(service.toggleReaction(1, 'acc-1', { emoji: '👍' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockChatService.toggleReaction).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('category を connect し、日付文字列を Date に変換して createWithSortOrder を呼ぶこと', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      const dto = {
        title: '新タスク',
        categoryId: 2,
        status: TaskStatus.TODO,
        startDate: '2026-06-01T00:00:00.000Z',
        dueDate: '2026-06-05T00:00:00.000Z',
      };
      const result = await service.create(dto);

      expect(result.success).toBe(true);
      const [data, ctx] = mockRepo.createWithSortOrder.mock.calls[0];
      expect(data.title).toBe('新タスク');
      expect(data.category).toEqual({ connect: { id: 2 } });
      expect(data.status).toBe(TaskStatus.TODO);
      expect(data.startDate).toBeInstanceOf(Date);
      expect(data.dueDate).toBeInstanceOf(Date);
      // トップレベル末尾追加（parentTaskId null・afterTaskId なし）
      expect(ctx).toEqual({ spaceId: DEFAULT_CHANNEL_ID, categoryId: 2, parentTaskId: null });
    });

    it('parentTaskId 指定時に parentTask を connect し、ctx に parentTaskId を渡すこと（depth=2 で許容）', async () => {
      mockRepo.getDepth.mockResolvedValue(2);
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ id: 7, categoryId: 1 }));
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: '子タスク', categoryId: 1, parentTaskId: 7 });

      const [data, ctx] = mockRepo.createWithSortOrder.mock.calls[0];
      expect(data.parentTask).toEqual({ connect: { id: 7 } });
      expect(ctx.parentTaskId).toBe(7);
    });

    it('afterTaskId 指定時に ctx へ afterTaskId を渡すこと（兄弟挿入）', async () => {
      // 基準兄弟は同一グループ（categoryId=3・トップレベル）。backend が独立検証する。
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 42, categoryId: 3, parentTaskId: null }),
      );
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: '兄弟', categoryId: 3, afterTaskId: 42 });

      const ctx = mockRepo.createWithSortOrder.mock.calls[0][1];
      expect(ctx).toEqual({
        spaceId: DEFAULT_CHANNEL_ID,
        categoryId: 3,
        parentTaskId: null,
        afterTaskId: 42,
      });
    });

    it('creatorId を渡すと owner を connect して createWithSortOrder を呼ぶこと（H4）', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: 'x', categoryId: 1 }, 'acc-1');

      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.owner).toEqual({ connect: { id: 'acc-1' } });
    });

    it('creatorId 未指定なら owner キーを含まないこと', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: 'x', categoryId: 1 });

      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.owner).toBeUndefined();
    });

    it('spaceId 未指定なら DEFAULT_CHANNEL_ID を connect すること（CM-2 孤児化防止）', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: 'x', categoryId: 1 });

      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.space).toEqual({ connect: { id: '00000000-0000-4000-b000-000000000003' } });
    });

    it('spaceId 指定時はその器を connect すること', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);
      const spaceId = '00000000-0000-4000-b000-000000000099';
      // 分類は同 Space 整合（rete-desk-0158）を満たすよう、指定 spaceId に属す分類を返す。
      mockRepo.findCategoryById.mockResolvedValue({ id: 1, archivedAt: null, spaceId });

      await service.create({ title: 'x', categoryId: 1, spaceId });

      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.space).toEqual({ connect: { id: spaceId } });
    });

    it('子化時は親の器を継承する（dto.spaceId より親優先・サブツリー分裂防止）', async () => {
      mockRepo.getDepth.mockResolvedValue(1);
      const parentSpaceId = '00000000-0000-4000-b000-0000000000aa';
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 7, categoryId: 1, spaceId: parentSpaceId }),
      );
      // 子は親の器を継承するため、分類も親の器（parentSpaceId）に属す前提（rete-desk-0158 整合）。
      mockRepo.findCategoryById.mockResolvedValue({
        id: 1,
        archivedAt: null,
        spaceId: parentSpaceId,
      });
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({
        title: '子',
        categoryId: 1,
        parentTaskId: 7,
        spaceId: '00000000-0000-4000-b000-000000000099',
      });

      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.space).toEqual({ connect: { id: parentSpaceId } });
    });

    it('TaskResponseDto shape を返すこと', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      const result = await service.create({ title: 'x', categoryId: 1 });

      expect(result.data).toEqual(
        expect.objectContaining({
          id: mockTask.id,
          title: mockTask.title,
          status: mockTask.status,
          categoryId: mockTask.categoryId,
        }),
      );
    });
  });

  describe('create — チャット昇格 / ガード', () => {
    it('sourceThemeId 指定でテーマが存在する場合、sourceTheme を connect して create すること', async () => {
      mockRepo.findThemeById.mockResolvedValue({ id: 'theme-1', spaceId: 'space-1' });
      mockRepo.createWithSortOrder.mockResolvedValue(makeTaskEntity({ sourceThemeId: 'theme-1' }));

      await service.create({ title: '昇格', categoryId: 1, sourceThemeId: 'theme-1' });

      expect(mockRepo.findThemeById).toHaveBeenCalledWith('theme-1');
      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.sourceTheme).toEqual({ connect: { id: 'theme-1' } });
    });

    it('作成者がsource themeを見られない場合は404で昇格を拒否する', async () => {
      mockRepo.findThemeById.mockResolvedValue({ id: 'theme-1', spaceId: 'private-space' });
      mockScopeVisibility.assertVisibleOr404.mockRejectedValue(
        new NotFoundException('Resource not found'),
      );

      await expect(
        service.create({ title: '昇格', categoryId: 1, sourceThemeId: 'theme-1' }, 'reader-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('sourceThemeId 指定でテーマが存在しない場合 NotFoundException をスローすること', async () => {
      mockRepo.findThemeById.mockResolvedValue(null);

      await expect(
        service.create({ title: '昇格', categoryId: 1, sourceThemeId: 'missing' }),
      ).rejects.toThrow(NotFoundException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('子化で親 depth=4 の場合 BadRequestException（4 階層超を拒否）をスローすること', async () => {
      // 親 depth=4 → 子は depth 5 になり 4 階層制約に違反
      mockRepo.getDepth.mockResolvedValue(4);
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ id: 9, categoryId: 1 }));

      await expect(
        service.create({ title: '深すぎ子', categoryId: 1, parentTaskId: 9 }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('親 depth=3 までは子化を許容すること（子は 4 階層目、上限ちょうど）', async () => {
      mockRepo.getDepth.mockResolvedValue(3);
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ id: 9, categoryId: 1 }));
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: '4階層目', categoryId: 1, parentTaskId: 9 });

      expect(mockRepo.createWithSortOrder).toHaveBeenCalled();
    });

    it('親が存在しない場合 NotFoundException をスローすること', async () => {
      mockRepo.getDepth.mockResolvedValue(0);
      mockRepo.findById.mockResolvedValue(null);

      await expect(
        service.create({ title: '孤児', categoryId: 1, parentTaskId: 999 }),
      ).rejects.toThrow(NotFoundException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('子化時に categoryId を親から強制継承（フロント指定を上書き）すること', async () => {
      mockRepo.getDepth.mockResolvedValue(1);
      // 親は categoryId=5。DTO は categoryId=1 を渡すが親が優先される。
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ id: 7, categoryId: 5 }));
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: '子', categoryId: 1, parentTaskId: 7 });

      const [data, ctx] = mockRepo.createWithSortOrder.mock.calls[0];
      expect(data.category).toEqual({ connect: { id: 5 } });
      expect(ctx.categoryId).toBe(5);
    });

    it('afterTaskId の基準兄弟が存在しない場合 NotFoundException をスローすること（client 信頼せず独立検証）', async () => {
      mockRepo.findById.mockResolvedValue(null);

      await expect(
        service.create({ title: '兄弟', categoryId: 1, afterTaskId: 999 }),
      ).rejects.toThrow(NotFoundException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('afterTaskId の基準兄弟が別カテゴリの場合 BadRequestException をスローすること', async () => {
      // 基準兄弟は categoryId=9 だが dto は categoryId=1。兄弟グループ不一致で拒否。
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 42, categoryId: 9, parentTaskId: null }),
      );

      await expect(
        service.create({ title: '兄弟', categoryId: 1, afterTaskId: 42 }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('afterTaskId の基準兄弟が別 parentTaskId（グループ違い）の場合 BadRequestException をスローすること', async () => {
      // dto はトップレベル（parentTaskId 未指定→null）だが基準兄弟は parentTaskId=3。
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 42, categoryId: 1, parentTaskId: 3 }),
      );

      await expect(
        service.create({ title: '兄弟', categoryId: 1, afterTaskId: 42 }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('afterTaskId の基準兄弟が同一グループなら create を行うこと（同 categoryId・同 parentTaskId）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 42, categoryId: 1, parentTaskId: null }),
      );
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: '兄弟', categoryId: 1, afterTaskId: 42 });

      const ctx = mockRepo.createWithSortOrder.mock.calls[0][1];
      expect(ctx).toEqual({
        spaceId: DEFAULT_CHANNEL_ID,
        categoryId: 1,
        parentTaskId: null,
        afterTaskId: 42,
      });
    });
  });

  describe('create メンション（dsk-0203・説明面）', () => {
    it('descriptionMentionAccountIds が全て実在すれば createWithSortOrder へ渡す', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(2);
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({
        title: 'T',
        categoryId: 1,
        descriptionMentionAccountIds: ['u2', 'u3'],
      });

      expect(mockRepo.countAccountsByIds).toHaveBeenCalledWith(['u2', 'u3']);
      expect(mockRepo.createWithSortOrder.mock.calls[0][2]).toEqual({
        descriptionMentionAccountIds: ['u2', 'u3'],
        tenmatsuMentionAccountIds: undefined,
      });
    });

    it('重複した descriptionMentionAccountIds は排除してから検証・保存する', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(2);
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({
        title: 'T',
        categoryId: 1,
        descriptionMentionAccountIds: ['u2', 'u3', 'u2'],
      });

      expect(mockRepo.countAccountsByIds).toHaveBeenCalledWith(['u2', 'u3']);
      expect(mockRepo.createWithSortOrder.mock.calls[0][2]).toEqual({
        descriptionMentionAccountIds: ['u2', 'u3'],
        tenmatsuMentionAccountIds: undefined,
      });
    });

    it('存在しない accountId が含まれると BadRequest を投げ createWithSortOrder を呼ばない', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(1); // 2 件指定中 1 件しか実在しない

      await expect(
        service.create({
          title: 'T',
          categoryId: 1,
          descriptionMentionAccountIds: ['u2', 'ghost'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('descriptionMentionAccountIds 未指定なら存在検証をスキップして従来どおり作成する', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: 'T', categoryId: 1 });

      expect(mockRepo.countAccountsByIds).not.toHaveBeenCalled();
      expect(mockRepo.createWithSortOrder.mock.calls[0][2]).toEqual({
        descriptionMentionAccountIds: undefined,
        tenmatsuMentionAccountIds: undefined,
      });
    });

    it('tenmatsuMentionAccountIds が全て実在すれば createWithSortOrder へ渡す（dsk-0284・顛末面）', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(2);
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({
        title: 'T',
        categoryId: 1,
        status: TaskStatus.DONE,
        tenmatsu: '完了',
        tenmatsuMentionAccountIds: ['u2', 'u3'],
      });

      expect(mockRepo.countAccountsByIds).toHaveBeenCalledWith(['u2', 'u3']);
      expect(mockRepo.createWithSortOrder.mock.calls[0][2]).toEqual({
        descriptionMentionAccountIds: undefined,
        tenmatsuMentionAccountIds: ['u2', 'u3'],
      });
    });

    it('tenmatsuMentionAccountIds に実在しない accountId が含まれると BadRequest を投げる（dsk-0284）', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(1);

      await expect(
        service.create({
          title: 'T',
          categoryId: 1,
          status: TaskStatus.DONE,
          tenmatsu: '完了',
          tenmatsuMentionAccountIds: ['u2', 'ghost'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('検証通過後の FK 違反（P2003）は 400 へ変換する（TOCTOU）', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(1);
      mockRepo.createWithSortOrder.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('FK', { code: 'P2003', clientVersion: 'test' }),
      );

      await expect(
        service.create({ title: 'T', categoryId: 1, descriptionMentionAccountIds: ['u2'] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('P2003 以外の Prisma エラーは握らず再 throw する（filter へ委譲 / §4）', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(1);
      mockRepo.createWithSortOrder.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('other', { code: 'P2002', clientVersion: 'test' }),
      );

      await expect(
        service.create({ title: 'T', categoryId: 1, descriptionMentionAccountIds: ['u2'] }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    });
  });

  describe('update メンション（dsk-0203・説明面/顛末面の独立保存）', () => {
    beforeEach(() => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue(mockTask);
    });

    it('descriptionMentionAccountIds が全て実在すれば repository へ渡す（説明面の宛先差し替え）', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(2);

      await service.update(1, {
        description: '<p>本文</p>',
        descriptionMentionAccountIds: ['u2', 'u3'],
      });

      expect(mockRepo.countAccountsByIds).toHaveBeenCalledWith(['u2', 'u3']);
      expect(mockRepo.update.mock.calls[0][2]).toEqual({
        descriptionMentionAccountIds: ['u2', 'u3'],
        tenmatsuMentionAccountIds: undefined,
      });
    });

    it('descriptionMentionAccountIds が空配列なら全クリア意図として [] を渡す（据え置きと区別）', async () => {
      await service.update(1, { description: '<p>本文</p>', descriptionMentionAccountIds: [] });

      expect(mockRepo.update.mock.calls[0][2].descriptionMentionAccountIds).toEqual([]);
    });

    it('tenmatsuMentionAccountIds が全て実在すれば repository へ渡す（顛末面の宛先差し替え）', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(2);

      await service.update(1, {
        tenmatsu: '<p>結論</p>',
        tenmatsuMentionAccountIds: ['u4', 'u5'],
      });

      expect(mockRepo.countAccountsByIds).toHaveBeenCalledWith(['u4', 'u5']);
      expect(mockRepo.update.mock.calls[0][2]).toEqual({
        descriptionMentionAccountIds: undefined,
        tenmatsuMentionAccountIds: ['u4', 'u5'],
      });
    });

    it('両面とも未指定なら undefined（据え置き）で渡す（宛先を巻き込まない）', async () => {
      await service.update(1, { status: TaskStatus.IN_PROGRESS });

      expect(mockRepo.countAccountsByIds).not.toHaveBeenCalled();
      expect(mockRepo.update.mock.calls[0][2]).toEqual({
        descriptionMentionAccountIds: undefined,
        tenmatsuMentionAccountIds: undefined,
      });
    });

    it('重複した宛先は排除してから検証・保存する', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(2);

      await service.update(1, { descriptionMentionAccountIds: ['u2', 'u3', 'u2'] });

      expect(mockRepo.countAccountsByIds).toHaveBeenCalledWith(['u2', 'u3']);
      expect(mockRepo.update.mock.calls[0][2].descriptionMentionAccountIds).toEqual(['u2', 'u3']);
    });

    it('存在しない accountId が含まれると BadRequest を投げ update を呼ばない', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(1);

      await expect(
        service.update(1, { descriptionMentionAccountIds: ['u2', 'ghost'] }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('検証通過後の FK 違反（P2003）は 400 へ変換する（TOCTOU）', async () => {
      mockRepo.countAccountsByIds.mockResolvedValue(1);
      mockRepo.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('FK', { code: 'P2003', clientVersion: 'test' }),
      );

      await expect(service.update(1, { descriptionMentionAccountIds: ['u2'] })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('update', () => {
    it('存在する場合に update を呼んで返すこと', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue({ ...mockTask, title: '更新後' });

      const result = await service.update(1, { title: '更新後' });

      expect(result.success).toBe(true);
      const [id, data] = mockRepo.update.mock.calls[0];
      expect(id).toBe(1);
      expect(data.title).toBe('更新後');
    });

    it('categoryId 変更時に category connect へ変換すること', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { categoryId: 5 });

      const data = mockRepo.update.mock.calls[0][1];
      expect(data.category).toEqual({ connect: { id: 5 } });
      expect(data.categoryId).toBeUndefined();
    });

    it('parentTaskId を null にした時に parentTask を disconnect すること', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { parentTaskId: null } as never);

      const data = mockRepo.update.mock.calls[0][1];
      expect(data.parentTask).toEqual({ disconnect: true });
    });

    it('parentTaskId が数値の場合に parentTask を connect すること', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { parentTaskId: 9 });

      const data = mockRepo.update.mock.calls[0][1];
      expect(data.parentTask).toEqual({ connect: { id: 9 } });
    });

    it('description / status / assigneeName / 日付（値あり）の各更新 arm を変換すること', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, {
        description: '更新説明',
        status: TaskStatus.IN_REVIEW,
        assigneeName: '佐藤',
        startDate: '2026-07-01T00:00:00.000Z',
        dueDate: '2026-07-05T00:00:00.000Z',
      });

      const data = mockRepo.update.mock.calls[0][1];
      expect(data.description).toBe('更新説明');
      expect(data.status).toBe(TaskStatus.IN_REVIEW);
      expect(data.assigneeName).toBe('佐藤');
      expect(data.startDate).toBeInstanceOf(Date);
      expect(data.dueDate).toBeInstanceOf(Date);
    });

    it('顛末も description 同様に保存時 sanitize して XSS を封鎖すること（ADR 0019）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.DONE, tenmatsu: '既存' }),
      );
      mockRepo.update.mockResolvedValue(makeTaskEntity({ status: TaskStatus.DONE }));

      await service.update(1, { tenmatsu: '<p>結論</p><script>alert(1)</script>' });

      const data = mockRepo.update.mock.calls[0][1];
      expect(data.tenmatsu).toBe('<p>結論</p>');
    });

    it('startDate / dueDate を null にした時に null をセットすること', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { startDate: null, dueDate: null } as never);

      const data = mockRepo.update.mock.calls[0][1];
      expect(data.startDate).toBeNull();
      expect(data.dueDate).toBeNull();
    });

    it('存在しない場合に NotFoundException をスローすること', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.update(999, { title: 'x' })).rejects.toThrow(NotFoundException);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('update 後のレスポンスに sourceTheme（元チャットリンク）が保持されること', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      // repo.update が sourceTheme を include して返す（findById と同形）。
      mockRepo.update.mockResolvedValue({
        ...makeTaskEntity({ sourceThemeId: 'theme-1' }),
        sourceTheme: { id: 'theme-1', title: '入荷遅延の相談' },
      });

      const result = await service.update(1, { title: '更新後' });

      expect(result.data.sourceTheme).toEqual({ id: 'theme-1', title: '入荷遅延の相談' });
      expect(result.data.sourceThemeId).toBe('theme-1');
    });
  });

  // 顛末完了ゲート（DBT-5）: タスクは status=DONE かつ顛末が空なら更新/作成を拒否する。
  // 「完了状態は結論（顛末）必須」という状態不変条件として、create / update 両経路に適用する
  // （チャットは対象外＝タスクのみ非対称）。新規 error code は足さず BadRequestException で収める。
  describe('update — 顛末完了ゲート（DBT-5）', () => {
    it('status=DONE へ遷移し顛末が空（既存も dto も未入力）なら BadRequestException をスローすること', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.IN_PROGRESS, tenmatsu: null }),
      );

      await expect(service.update(1, { status: TaskStatus.DONE })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('status=DONE へ遷移し dto で顛末を入力すれば update を行うこと', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.IN_PROGRESS, tenmatsu: null }),
      );
      mockRepo.update.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.DONE, tenmatsu: '取込完了。差分なし。' }),
      );

      const result = await service.update(1, {
        status: TaskStatus.DONE,
        tenmatsu: '取込完了。差分なし。',
      });

      expect(result.success).toBe(true);
      const data = mockRepo.update.mock.calls[0][1];
      expect(data.status).toBe(TaskStatus.DONE);
      expect(data.tenmatsu).toBe('取込完了。差分なし。');
    });

    it('既に DONE かつ顛末記録済みのタスクを、顛末を触らず他項目だけ更新できること', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.DONE, tenmatsu: '既存の結論' }),
      );
      mockRepo.update.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.DONE, tenmatsu: '既存の結論', title: '改題' }),
      );

      const result = await service.update(1, { title: '改題' });

      expect(result.success).toBe(true);
      expect(mockRepo.update).toHaveBeenCalled();
    });

    it('DONE のまま顛末を空文字へ消そうとすると BadRequestException をスローすること', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.DONE, tenmatsu: '既存の結論' }),
      );

      await expect(service.update(1, { tenmatsu: '   ' })).rejects.toThrow(BadRequestException);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('未完了（IN_PROGRESS）なら顛末が空でも更新できること（タスク完了時のみのゲート）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.IN_PROGRESS, tenmatsu: null }),
      );
      mockRepo.update.mockResolvedValue(makeTaskEntity({ status: TaskStatus.IN_PROGRESS }));

      const result = await service.update(1, { title: '途中更新' });

      expect(result.success).toBe(true);
      expect(mockRepo.update).toHaveBeenCalled();
    });

    it('update のレスポンスに顛末が含まれること（DTO 形）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.DONE, tenmatsu: '結論あり' }),
      );
      mockRepo.update.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.DONE, tenmatsu: '結論あり' }),
      );

      const result = await service.update(1, { title: 'x' });

      expect(result.data.tenmatsu).toBe('結論あり');
    });
  });

  describe('create — 顛末完了ゲート（DBT-5）', () => {
    it('status=DONE かつ顛末未指定で作成しようとすると BadRequestException をスローすること', async () => {
      await expect(
        service.create({ title: '完了で作る', categoryId: 1, status: TaskStatus.DONE }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('status=DONE かつ顛末が空白のみで作成しようとすると BadRequestException をスローすること', async () => {
      await expect(
        service.create({
          title: '完了で作る',
          categoryId: 1,
          status: TaskStatus.DONE,
          tenmatsu: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('status=DONE かつ顛末ありなら作成できること', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(
        makeTaskEntity({ status: TaskStatus.DONE, tenmatsu: '初手で完了' }),
      );

      const result = await service.create({
        title: '完了で作る',
        categoryId: 1,
        status: TaskStatus.DONE,
        tenmatsu: '初手で完了',
      });

      expect(result.success).toBe(true);
      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.tenmatsu).toBe('初手で完了');
    });
  });

  describe('分類の Space スコープ整合（rete-desk-0158）', () => {
    it('create: 別 Space に属す categoryId を指定すると BadRequestException（400）になること', async () => {
      // タスクの実効 spaceId = DEFAULT_CHANNEL_ID（default task の spaceId null フォールバック）。
      // 分類は別 Space（'other-space'）に属す → 整合性違反で拒否。
      mockRepo.findCategoryById.mockResolvedValue({
        id: 5,
        archivedAt: null,
        spaceId: 'other-space',
      });

      await expect(service.create({ title: 'x', categoryId: 5 })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('create: categoryId 省略（未分類）なら分類検証をスキップし category を connect せず作成すること', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: '未分類タスク' });

      // 未分類は assertCategoryUsable を呼ばない（findCategoryById 未呼出）。
      expect(mockRepo.findCategoryById).not.toHaveBeenCalled();
      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.category).toBeUndefined();
      // SortOrderContext.categoryId は null（未分類グループ）。
      const ctx = mockRepo.createWithSortOrder.mock.calls[0][1];
      expect(ctx.categoryId).toBeNull();
    });

    it('update: categoryId=null で category disconnect（未分類化）すること', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { categoryId: null });

      // null は検証スキップ（findCategoryById 未呼出）し disconnect へ畳む。
      expect(mockRepo.findCategoryById).not.toHaveBeenCalled();
      const data = mockRepo.update.mock.calls[0][1];
      expect(data.category).toEqual({ disconnect: true });
    });

    it('move: クロス Space 移動時は categoryId を null（未分類）へリセットして moveTask を呼ぶこと', async () => {
      const CH_A = DEFAULT_CHANNEL_ID; // 現器
      const CH_B = '00000000-0000-4000-b000-0000000000b1'; // 同一プロジェクトの別チャネル
      const PROJ = '00000000-0000-4000-b000-000000000002';
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 100, categoryId: 1, spaceId: CH_A }),
      );
      mockRepo.findSpaceForMove.mockImplementation((id: string) =>
        Promise.resolve(
          id === CH_B
            ? { projectId: PROJ, name: 'チャネルB' }
            : id === CH_A
              ? { projectId: PROJ, name: 'チャネルA' }
              : null,
        ),
      );
      mockRepo.getSubtreeHeight.mockResolvedValue(1);
      mockRepo.moveTask.mockResolvedValue(makeTaskEntity({ id: 100, spaceId: CH_B }));

      await service.move(100, {
        parentTaskId: null,
        categoryId: 2,
        afterTaskId: null,
        spaceId: CH_B,
      });

      // クロス Space 移動なので移動先に分類が無く categoryId は null へリセット。分類検証は呼ばない。
      expect(mockRepo.findCategoryById).not.toHaveBeenCalled();
      expect(mockRepo.moveTask).toHaveBeenCalledWith(
        100,
        expect.objectContaining({ categoryId: null, spaceId: CH_B }),
      );
    });
  });

  describe('assignee FK 割当（rete-desk-0062）', () => {
    const accId = '11111111-1111-1111-1111-111111111111';

    it('create: assigneeId 指定で存在検証し assignee を connect すること', async () => {
      mockRepo.findAccountById.mockResolvedValue({ id: accId });
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: 'x', categoryId: 1, assigneeId: accId });

      expect(mockRepo.findAccountById).toHaveBeenCalledWith(accId);
      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.assignee).toEqual({ connect: { id: accId } });
    });

    it('create: assigneeId が存在しない Account なら NotFoundException をスローすること', async () => {
      mockRepo.findAccountById.mockResolvedValue(null);

      await expect(
        service.create({ title: 'x', categoryId: 1, assigneeId: accId }),
      ).rejects.toThrow(NotFoundException);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('create: assigneeId 未指定なら存在検証せず assignee を connect しないこと', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: 'x', categoryId: 1 });

      expect(mockRepo.findAccountById).not.toHaveBeenCalled();
      const data = mockRepo.createWithSortOrder.mock.calls[0][0];
      expect(data.assignee).toBeUndefined();
    });

    it('update: assigneeId 指定で存在検証し assignee を connect すること', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.findAccountById.mockResolvedValue({ id: accId });
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { assigneeId: accId });

      expect(mockRepo.findAccountById).toHaveBeenCalledWith(accId);
      const data = mockRepo.update.mock.calls[0][1];
      expect(data.assignee).toEqual({ connect: { id: accId } });
    });

    it('update: assigneeId=null で assignee を disconnect すること（検証なし）', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { assigneeId: null });

      expect(mockRepo.findAccountById).not.toHaveBeenCalled();
      const data = mockRepo.update.mock.calls[0][1];
      expect(data.assignee).toEqual({ disconnect: true });
    });

    it('update: assigneeId が存在しない Account なら NotFoundException をスローし update しないこと', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.findAccountById.mockResolvedValue(null);

      await expect(service.update(1, { assigneeId: accId })).rejects.toThrow(NotFoundException);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('update: assigneeId 未指定なら assignee キーを update データに含めないこと', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { title: '改題のみ' });

      const data = mockRepo.update.mock.calls[0][1];
      expect(data).not.toHaveProperty('assignee');
    });
  });

  describe('remove', () => {
    it('削除して成功メッセージを返すこと', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.delete.mockResolvedValue(mockTask);

      const result = await service.remove(1);

      expect(result).toEqual({ success: true, data: { message: 'Task deleted successfully' } });
      expect(mockRepo.delete).toHaveBeenCalledWith(1);
    });

    it('存在しない場合に NotFoundException をスローすること', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
      expect(mockRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('update — 所有者チェック（H4）', () => {
    it('user 未指定なら所有者チェックをスキップして更新すること（内部経路）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ ownerId: 'owner-1' }));
      mockRepo.update.mockResolvedValue(mockTask);

      const result = await service.update(1, { title: 'x' }); // user 未指定

      expect(result.success).toBe(true);
      expect(mockRepo.update).toHaveBeenCalledTimes(1);
    });

    it('所有者本人は更新できること（H4）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ ownerId: 'owner-1' }));
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { title: 'x' }, mkUser('owner-1'));

      expect(mockRepo.update).toHaveBeenCalledTimes(1);
    });

    it('ADMIN は他者所有タスクも更新できること（H4 ADMIN バイパス）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ ownerId: 'owner-1' }));
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { title: 'x' }, mkUser('admin-user', Role.ADMIN));

      expect(mockRepo.update).toHaveBeenCalledTimes(1);
    });

    it('非所有者（MEMBER）は Forbidden を投げ update を呼ばないこと（IDOR 防止 / H4）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ ownerId: 'owner-1' }));

      await expect(service.update(1, { title: 'x' }, mkUser('intruder'))).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('ownerId=null タスクは ADMIN のみ更新できること（H4 null guard）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ ownerId: null }));

      await expect(service.update(1, { title: 'x' }, mkUser('some-user'))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('move — 所有者チェック（HIGH-1: IDOR 修正）', () => {
    const setupMoveBase = () => {
      mockRepo.findById.mockImplementation((id: number) => {
        if (id === 100)
          return Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1, ownerId: 'owner-1' }));
        if (id === 7) return Promise.resolve(makeTaskEntity({ id: 7, categoryId: 2 }));
        return Promise.resolve(null);
      });
      mockRepo.findCategoryById.mockResolvedValue({
        id: 2,
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });
      mockRepo.getAncestorIds.mockResolvedValue([7]);
      mockRepo.getSubtreeHeight.mockResolvedValue(1);
      mockRepo.moveTask.mockResolvedValue(
        makeTaskEntity({ id: 100, parentTaskId: 7, categoryId: 2 }),
      );
    };

    it('user 未指定なら所有者チェックをスキップして移動すること（内部経路）', async () => {
      setupMoveBase();

      const result = await service.move(100, { parentTaskId: 7, categoryId: 2, afterTaskId: null });

      expect(result.success).toBe(true);
      expect(mockRepo.moveTask).toHaveBeenCalledTimes(1);
    });

    it('所有者本人は移動できること（H4）', async () => {
      setupMoveBase();

      await service.move(
        100,
        { parentTaskId: 7, categoryId: 2, afterTaskId: null },
        mkUser('owner-1'),
      );

      expect(mockRepo.moveTask).toHaveBeenCalledTimes(1);
    });

    it('ADMIN は他者所有タスクも移動できること（H4 ADMIN バイパス）', async () => {
      setupMoveBase();

      await service.move(
        100,
        { parentTaskId: 7, categoryId: 2, afterTaskId: null },
        mkUser('admin-user', Role.ADMIN),
      );

      expect(mockRepo.moveTask).toHaveBeenCalledTimes(1);
    });

    it('非所有者（MEMBER）は Forbidden を投げ moveTask を呼ばないこと（IDOR 防止 / HIGH-1）', async () => {
      setupMoveBase();

      await expect(
        service.move(
          100,
          { parentTaskId: 7, categoryId: 2, afterTaskId: null },
          mkUser('intruder'),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });

    it('ownerId=null タスクは ADMIN のみ移動できること（H4 null guard）', async () => {
      mockRepo.findById.mockImplementation((id: number) => {
        if (id === 100)
          return Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1, ownerId: null }));
        if (id === 7) return Promise.resolve(makeTaskEntity({ id: 7, categoryId: 2 }));
        return Promise.resolve(null);
      });
      mockRepo.findCategoryById.mockResolvedValue({
        id: 2,
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });
      mockRepo.getAncestorIds.mockResolvedValue([7]);
      mockRepo.getSubtreeHeight.mockResolvedValue(1);

      await expect(
        service.move(
          100,
          { parentTaskId: 7, categoryId: 2, afterTaskId: null },
          mkUser('some-user'),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });
  });

  // Space 越境作成 / 越境 reparent の封鎖（rete-hardening-0001）。create は owner チェック不能のため
  // 可視性検証が唯一の防御線。子化時は親の器を継承するので、確定 spaceId 1 点の検証で parentTaskId
  // 越境も同時に塞ぐ。update は assertOwnerOrAdmin 既存のため、残る穴＝親付替えの越境を同一 Space 制約で封鎖。
  describe('create — Space 越境作成の封鎖（rete-hardening-0001）', () => {
    const SPACE_X = '00000000-0000-4000-b000-0000000000f1';

    it('creatorId が対象 Space を可視でない場合 NotFoundException をスローし作成しないこと（存在秘匿）', async () => {
      mockScopeVisibility.assertVisibleOr404.mockRejectedValue(
        new NotFoundException('Resource not found'),
      );
      mockRepo.findCategoryById.mockResolvedValue({ id: 1, archivedAt: null, spaceId: SPACE_X });

      await expect(
        service.create({ title: 'x', categoryId: 1, spaceId: SPACE_X }, 'intruder'),
      ).rejects.toThrow(NotFoundException);
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith('intruder', SPACE_X);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('creatorId が対象 Space を可視なら作成できること', async () => {
      mockScopeVisibility.assertVisibleOr404.mockResolvedValue(undefined);
      mockRepo.findCategoryById.mockResolvedValue({ id: 1, archivedAt: null, spaceId: SPACE_X });
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: 'x', categoryId: 1, spaceId: SPACE_X }, 'member-1');

      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith('member-1', SPACE_X);
      expect(mockRepo.createWithSortOrder).toHaveBeenCalledTimes(1);
    });

    it('子化時は親継承後の器で可視性検証する（親の器が越境なら 404・parentTaskId 越境を封鎖）', async () => {
      mockScopeVisibility.assertVisibleOr404.mockRejectedValue(
        new NotFoundException('Resource not found'),
      );
      mockRepo.getDepth.mockResolvedValue(1);
      // 親は SPACE_X に居る。子は dto.spaceId に関わらず親の器を継承するので、検証対象は SPACE_X。
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 7, categoryId: 1, spaceId: SPACE_X }),
      );

      await expect(
        service.create(
          { title: '子', categoryId: 1, parentTaskId: 7, spaceId: DEFAULT_CHANNEL_ID },
          'intruder',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith('intruder', SPACE_X);
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('creatorId 未指定（内部経路）でも作成できること（スキップは基盤メソッド側で処理）', async () => {
      mockRepo.createWithSortOrder.mockResolvedValue(mockTask);

      await service.create({ title: 'x', categoryId: 1 });

      // create は accountId 未指定でも assertVisibleOr404 を呼ぶ（内部 skip は基盤メソッドの責務）。
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith(
        undefined,
        expect.any(String),
      );
      expect(mockRepo.createWithSortOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe('update — 越境 reparent の封鎖（rete-hardening-0001）', () => {
    const SPACE_A = '00000000-0000-4000-b000-0000000000a1';
    const SPACE_B = '00000000-0000-4000-b000-0000000000b1';

    it('新親が既存タスクと別 Space なら NotFoundException をスローし update しないこと（存在秘匿）', async () => {
      mockRepo.findById.mockImplementation((id: number) =>
        id === 1
          ? Promise.resolve(makeTaskEntity({ id: 1, spaceId: SPACE_A }))
          : Promise.resolve(makeTaskEntity({ id: 9, spaceId: SPACE_B })),
      );

      await expect(service.update(1, { parentTaskId: 9 })).rejects.toThrow(NotFoundException);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('新親が同一 Space なら parentTask を connect して update すること', async () => {
      mockRepo.findById.mockImplementation((id: number) =>
        id === 1
          ? Promise.resolve(makeTaskEntity({ id: 1, spaceId: SPACE_A }))
          : Promise.resolve(makeTaskEntity({ id: 9, spaceId: SPACE_A })),
      );
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { parentTaskId: 9 });

      const data = mockRepo.update.mock.calls[0][1];
      expect(data.parentTask).toEqual({ connect: { id: 9 } });
    });

    it('新親が存在しない場合 NotFoundException をスローすること', async () => {
      mockRepo.findById.mockImplementation((id: number) =>
        id === 1 ? Promise.resolve(makeTaskEntity({ id: 1 })) : Promise.resolve(null),
      );

      await expect(service.update(1, { parentTaskId: 999 })).rejects.toThrow(NotFoundException);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('parentTaskId=null（トップレベル化）は越境検証の対象外（disconnect は通す）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ id: 1, spaceId: SPACE_A }));
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { parentTaskId: null } as never);

      const data = mockRepo.update.mock.calls[0][1];
      expect(data.parentTask).toEqual({ disconnect: true });
    });
  });

  // 対象タスク自体が非可視 Space にある場合の越境 update/remove を封鎖（cmn-0019 存在秘匿）。
  // 空間可視性チェックを所有者チェック(403)より前に置くため、非可視なら owner 判定に依らず 404。
  describe('update / remove — 対象タスク Space 越境の封鎖（cmn-0019）', () => {
    const SPACE_X = '00000000-0000-4000-b000-0000000000f1';

    it('update: 対象タスクが非可視 Space なら NotFoundException で update しないこと（所有者チェックより前）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 1, spaceId: SPACE_X, ownerId: 'owner-1' }),
      );
      mockScopeVisibility.assertVisibleOr404.mockRejectedValue(
        new NotFoundException('Resource not found'),
      );

      // intruder は非所有者だが、空間チェックが先なので Forbidden でなく NotFound（存在推測防止）。
      await expect(service.update(1, { title: 'x' }, mkUser('intruder'))).rejects.toThrow(
        NotFoundException,
      );
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith('intruder', SPACE_X);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('remove: 対象タスクが非可視 Space なら NotFoundException で delete しないこと（所有者チェックより前）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 1, spaceId: SPACE_X, ownerId: 'owner-1' }),
      );
      mockScopeVisibility.assertVisibleOr404.mockRejectedValue(
        new NotFoundException('Resource not found'),
      );

      await expect(service.remove(1, mkUser('intruder'))).rejects.toThrow(NotFoundException);
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith('intruder', SPACE_X);
      expect(mockRepo.delete).not.toHaveBeenCalled();
    });

    it('update: 対象タスクが可視なら update できること（内部経路 user 未指定）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 1, spaceId: SPACE_X, ownerId: 'owner-1' }),
      );
      mockRepo.update.mockResolvedValue(mockTask);

      await service.update(1, { title: 'x' }); // user 未指定（内部経路）

      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith(undefined, SPACE_X);
      expect(mockRepo.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('remove — 所有者チェック（H4）', () => {
    it('user 未指定なら所有者チェックをスキップして削除すること（内部経路）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ ownerId: 'owner-1' }));
      mockRepo.delete.mockResolvedValue(mockTask);

      const result = await service.remove(1); // user 未指定

      expect(result.success).toBe(true);
      expect(mockRepo.delete).toHaveBeenCalledTimes(1);
    });

    it('所有者本人は削除できること（H4）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ ownerId: 'owner-1' }));
      mockRepo.delete.mockResolvedValue(mockTask);

      await service.remove(1, mkUser('owner-1'));

      expect(mockRepo.delete).toHaveBeenCalledTimes(1);
    });

    it('ADMIN は他者所有タスクも削除できること（H4 ADMIN バイパス）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ ownerId: 'owner-1' }));
      mockRepo.delete.mockResolvedValue(mockTask);

      await service.remove(1, mkUser('admin-user', Role.ADMIN));

      expect(mockRepo.delete).toHaveBeenCalledTimes(1);
    });

    it('非所有者（MEMBER）は Forbidden を投げ delete を呼ばないこと（IDOR 防止 / H4）', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ ownerId: 'owner-1' }));

      await expect(service.remove(1, mkUser('intruder'))).rejects.toThrow(ForbiddenException);
      expect(mockRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('Space boundary regression', () => {
    it('passes the originally visible source to persistence if the task changes Space between reads', async () => {
      mockRepo.findTaskSpaceId.mockResolvedValue({ id: 100, spaceId: DEFAULT_CHANNEL_ID });
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 100, categoryId: null, spaceId: 'changed-space' }),
      );
      mockRepo.getSubtreeHeight.mockResolvedValue(1);
      mockRepo.moveTask.mockRejectedValue(new NotFoundException('Task not found'));
      await expect(
        service.move(100, { parentTaskId: null, categoryId: null, afterTaskId: null }),
      ).rejects.toThrow('Task not found');
      expect(mockRepo.moveTask).toHaveBeenCalledWith(
        100,
        expect.objectContaining({ expectedSpaceId: DEFAULT_CHANNEL_ID }),
      );
    });
    it.each(['create', 'move'] as const)(
      'rejects an uncategorized foreign sibling for %s',
      async (operation) => {
        mockRepo.findById.mockImplementation(async (id: number) =>
          makeTaskEntity({
            id,
            categoryId: null,
            parentTaskId: null,
            spaceId: id === 42 ? 'foreign-space' : DEFAULT_CHANNEL_ID,
          }),
        );
        mockRepo.getSubtreeHeight.mockResolvedValue(1);
        const request =
          operation === 'create'
            ? service.create({ title: 'new', afterTaskId: 42 }, 'acc-1')
            : service.move(100, { parentTaskId: null, categoryId: null, afterTaskId: 42 });
        await expect(request).rejects.toThrow('Sibling task not found');
        expect(mockRepo.moveTask).not.toHaveBeenCalled();
        expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
      },
    );

    it('rejects a foreign parent before traversing its ancestry', async () => {
      mockRepo.findById.mockImplementation(async (id: number) =>
        makeTaskEntity({
          id,
          categoryId: null,
          spaceId: id === 7 ? 'foreign-space' : DEFAULT_CHANNEL_ID,
        }),
      );
      await expect(
        service.move(100, { parentTaskId: 7, categoryId: null, afterTaskId: null }),
      ).rejects.toThrow('Parent task not found');
      expect(mockRepo.getAncestorIds).not.toHaveBeenCalled();
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });
  });

  describe('move', () => {
    // 既定: 対象 id=100 が存在し、移動先 parent=7（depth=1）・category=2 が存在、サブツリー高さ=1。
    const setupHappyPath = () => {
      mockRepo.findById.mockImplementation((id: number) => {
        if (id === 100) return Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1 }));
        if (id === 7) return Promise.resolve(makeTaskEntity({ id: 7, categoryId: 2 }));
        return Promise.resolve(null);
      });
      mockRepo.findCategoryById.mockResolvedValue({
        id: 2,
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });
      // getAncestorIds は対象自身を含む（root=1）。新親 7 が depth=1（root）なら長さ 1。
      // 新親 depth は本配列長から導出するため getDepth は呼ばない（指摘[3]）。
      mockRepo.getAncestorIds.mockResolvedValue([7]); // 新親チェーンに 100 を含まない・新親 depth=1
      mockRepo.getSubtreeHeight.mockResolvedValue(1); // 移動サブツリー高さ=1
      mockRepo.moveTask.mockResolvedValue(
        makeTaskEntity({ id: 100, parentTaskId: 7, categoryId: 2 }),
      );
    };

    it('親変更（別タスクの子へ）: repo.moveTask を payload で呼び TaskResponseDto を返すこと', async () => {
      setupHappyPath();

      const result = await service.move(100, { parentTaskId: 7, categoryId: 2, afterTaskId: null });

      expect(result.success).toBe(true);
      expect(mockRepo.moveTask).toHaveBeenCalledWith(100, {
        expectedSpaceId: DEFAULT_CHANNEL_ID,
        parentTaskId: 7,
        categoryId: 2,
        afterTaskId: null,
      });
      // 単体 TaskResponse shape（ツリー全体ではない）
      expect(result.data).toEqual(
        expect.objectContaining({ id: 100, parentTaskId: 7, categoryId: 2 }),
      );
      expect(typeof result.data.createdAt).toBe('string');
    });

    it('親変更時に getDepth を呼ばず getAncestorIds の長さから新親 depth を導出すること（指摘[3]）', async () => {
      setupHappyPath();

      await service.move(100, { parentTaskId: 7, categoryId: 2, afterTaskId: null });

      // getAncestorIds と getDepth の二重走査を解消（move 経路は getDepth を呼ばない）。
      expect(mockRepo.getAncestorIds).toHaveBeenCalledWith(7);
      expect(mockRepo.getDepth).not.toHaveBeenCalled();
    });

    describe('器（Space）移動 enforce（CM-2 / ADR 0037 §6）', () => {
      const CH_A = '00000000-0000-4000-b000-000000000003'; // 現器（projectId=PROJ_1）
      const CH_B = '00000000-0000-4000-b000-0000000000b1'; // 同一プロジェクトの別チャネル
      const CH_OTHER = '00000000-0000-4000-b000-0000000000b2'; // 別プロジェクトのチャネル
      const GROUP = '00000000-0000-4000-b000-0000000000d1'; // グループ（projectId=null）
      const PROJ_1 = '00000000-0000-4000-b000-000000000002';
      const PROJ_2 = '00000000-0000-4000-b000-0000000000c2';

      const setupTaskInChannelA = () => {
        // 対象タスクは現器 CH_A に居る。トップレベル移動で ancestor 検証を省く。
        mockRepo.findById.mockResolvedValue(
          makeTaskEntity({ id: 100, categoryId: 1, spaceId: CH_A }),
        );
        mockRepo.getSubtreeHeight.mockResolvedValue(1);
        mockRepo.moveTask.mockResolvedValue(makeTaskEntity({ id: 100, spaceId: CH_B }));
      };

      it('同一プロジェクト内チャネル間移動: moveTask の ctx に spaceId を載せること', async () => {
        setupTaskInChannelA();
        mockRepo.findSpaceForMove.mockImplementation((id: string) =>
          Promise.resolve(
            id === CH_B
              ? { projectId: PROJ_1, name: 'チャネルB' }
              : id === CH_A
                ? { projectId: PROJ_1, name: 'チャネルA' }
                : null,
          ),
        );

        await service.move(100, {
          parentTaskId: null,
          categoryId: 2,
          afterTaskId: null,
          spaceId: CH_B,
        });

        expect(mockRepo.moveTask).toHaveBeenCalledWith(
          100,
          expect.objectContaining({ spaceId: CH_B }),
        );
      });

      it('別プロジェクトのチャネルへは移動不可（BadRequest・moveTask 未呼出）', async () => {
        setupTaskInChannelA();
        mockRepo.findSpaceForMove.mockImplementation((id: string) =>
          Promise.resolve(
            id === CH_OTHER ? { projectId: PROJ_2 } : id === CH_A ? { projectId: PROJ_1 } : null,
          ),
        );

        await expect(
          service.move(100, {
            parentTaskId: null,
            categoryId: 2,
            afterTaskId: null,
            spaceId: CH_OTHER,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mockRepo.moveTask).not.toHaveBeenCalled();
      });

      it('移動先 space 不在なら NotFound（moveTask 未呼出）', async () => {
        setupTaskInChannelA();
        mockRepo.findSpaceForMove.mockImplementation((id: string) =>
          Promise.resolve(id === CH_A ? { projectId: PROJ_1 } : null),
        );

        await expect(
          service.move(100, {
            parentTaskId: null,
            categoryId: 2,
            afterTaskId: null,
            spaceId: CH_B,
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(mockRepo.moveTask).not.toHaveBeenCalled();
      });

      it('グループ/個人（projectId=null）へは移動不可（BadRequest）', async () => {
        setupTaskInChannelA();
        mockRepo.findSpaceForMove.mockImplementation((id: string) =>
          Promise.resolve(
            id === GROUP ? { projectId: null } : id === CH_A ? { projectId: PROJ_1 } : null,
          ),
        );

        await expect(
          service.move(100, {
            parentTaskId: null,
            categoryId: 2,
            afterTaskId: null,
            spaceId: GROUP,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mockRepo.moveTask).not.toHaveBeenCalled();
      });

      it('spaceId が現器と同一なら検証スキップ・moveTask の ctx に spaceId を載せないこと', async () => {
        setupTaskInChannelA();

        await service.move(100, {
          parentTaskId: null,
          categoryId: 2,
          afterTaskId: null,
          spaceId: CH_A,
        });

        expect(mockRepo.findSpaceForMove).not.toHaveBeenCalled();
        const ctx = mockRepo.moveTask.mock.calls[0][1];
        expect(ctx.spaceId).toBeUndefined();
      });
    });

    it('トップレベルへの移動（parentTaskId=null）: getDepth を呼ばず depth=0 起点で許容すること', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ id: 100, categoryId: 1 }));
      mockRepo.findCategoryById.mockResolvedValue({
        id: 2,
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });
      mockRepo.getSubtreeHeight.mockResolvedValue(4); // depth 0 + 高さ4 = 4 = MAX ちょうど
      mockRepo.moveTask.mockResolvedValue(
        makeTaskEntity({ id: 100, parentTaskId: null, categoryId: 2 }),
      );

      await service.move(100, { parentTaskId: null, categoryId: 2, afterTaskId: null });

      expect(mockRepo.getDepth).not.toHaveBeenCalled();
      expect(mockRepo.getAncestorIds).not.toHaveBeenCalled();
      expect(mockRepo.moveTask).toHaveBeenCalled();
    });

    it('対象タスクが存在しない場合 NotFoundException をスローすること', async () => {
      mockRepo.findById.mockResolvedValue(null);

      await expect(
        service.move(999, { parentTaskId: null, categoryId: 2, afterTaskId: null }),
      ).rejects.toThrow(NotFoundException);
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });

    it('移動先 category が存在しない場合 NotFoundException をスローすること', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ id: 100 }));
      mockRepo.findCategoryById.mockResolvedValue(null);

      await expect(
        service.move(100, { parentTaskId: null, categoryId: 999, afterTaskId: null }),
      ).rejects.toThrow(NotFoundException);
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });

    it('移動先 parent が存在しない場合 NotFoundException をスローすること', async () => {
      mockRepo.findById.mockImplementation((id: number) =>
        id === 100 ? Promise.resolve(makeTaskEntity({ id: 100 })) : Promise.resolve(null),
      );
      mockRepo.findCategoryById.mockResolvedValue({
        id: 2,
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });

      await expect(
        service.move(100, { parentTaskId: 888, categoryId: 2, afterTaskId: null }),
      ).rejects.toThrow(NotFoundException);
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });

    it('自分自身を親に指定した場合 BadRequestException をスローすること', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ id: 100 }));
      mockRepo.findCategoryById.mockResolvedValue({
        id: 2,
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });

      await expect(
        service.move(100, { parentTaskId: 100, categoryId: 2, afterTaskId: null }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });

    it('自己子孫（移動サブツリー内）への移動の場合 BadRequestException をスローすること', async () => {
      // 新親=50 の祖先チェーンに移動対象 100 が含まれる＝50 は 100 の子孫。循環になる。
      mockRepo.findById.mockImplementation((id: number) =>
        id === 100
          ? Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1 }))
          : Promise.resolve(makeTaskEntity({ id: 50, categoryId: 1 })),
      );
      mockRepo.findCategoryById.mockResolvedValue({
        id: 1,
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });
      mockRepo.getAncestorIds.mockResolvedValue([50, 100, 1]); // チェーンに 100 が出現

      await expect(
        service.move(100, { parentTaskId: 50, categoryId: 1, afterTaskId: null }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });

    it('4 階層超過（新親 depth + サブツリー高さ > MAX）の場合 BadRequestException をスローすること', async () => {
      mockRepo.findById.mockImplementation((id: number) =>
        id === 100
          ? Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1 }))
          : Promise.resolve(makeTaskEntity({ id: 7, categoryId: 1 })),
      );
      mockRepo.findCategoryById.mockResolvedValue({
        id: 1,
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });
      // 新親 depth は getAncestorIds の長さで表す（root=1 / 自身込み）。depth=3 → 長さ 3。
      mockRepo.getAncestorIds.mockResolvedValue([7, 6, 5]); // 新親 depth=3・チェーンに 100 を含まない
      mockRepo.getSubtreeHeight.mockResolvedValue(2); // 3 + 2 = 5 > 4

      await expect(
        service.move(100, { parentTaskId: 7, categoryId: 1, afterTaskId: null }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });

    it('4 階層ちょうど（新親 depth + サブツリー高さ = MAX）は許容すること', async () => {
      mockRepo.findById.mockImplementation((id: number) =>
        id === 100
          ? Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1 }))
          : Promise.resolve(makeTaskEntity({ id: 7, categoryId: 1 })),
      );
      mockRepo.findCategoryById.mockResolvedValue({
        id: 1,
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });
      mockRepo.getAncestorIds.mockResolvedValue([7, 6]); // 新親 depth=2（root=1 / 自身込み）
      mockRepo.getSubtreeHeight.mockResolvedValue(2); // 2 + 2 = 4 = MAX
      mockRepo.moveTask.mockResolvedValue(makeTaskEntity({ id: 100 }));

      await service.move(100, { parentTaskId: 7, categoryId: 1, afterTaskId: null });

      expect(mockRepo.moveTask).toHaveBeenCalled();
    });

    describe('move — afterTaskId 検証（create と同等の独立検証 / 指摘[1]）', () => {
      // 既定: 対象 id=100（categoryId=1, トップレベル）が存在、移動先 category=2 が存在、サブツリー高さ=1。
      // afterTaskId 検証のみを切り出すため parentTaskId=null（トップレベル移動）で組む。
      const setupAfterBase = () => {
        mockRepo.findCategoryById.mockResolvedValue({
          id: 2,
          archivedAt: null,
          spaceId: DEFAULT_CHANNEL_ID,
        });
        mockRepo.getSubtreeHeight.mockResolvedValue(1);
        mockRepo.moveTask.mockResolvedValue(
          makeTaskEntity({ id: 100, parentTaskId: null, categoryId: 2 }),
        );
      };

      it('afterTaskId の基準兄弟が存在しない場合 NotFoundException をスローすること', async () => {
        setupAfterBase();
        mockRepo.findById.mockImplementation((id: number) => {
          if (id === 100) return Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1 }));
          return Promise.resolve(null); // afterTaskId=999 は不在
        });

        await expect(
          service.move(100, { parentTaskId: null, categoryId: 2, afterTaskId: 999 }),
        ).rejects.toThrow(NotFoundException);
        expect(mockRepo.moveTask).not.toHaveBeenCalled();
      });

      it('afterTaskId の基準兄弟が別カテゴリの場合 BadRequestException をスローすること', async () => {
        setupAfterBase();
        // 基準兄弟 42 は categoryId=9 だが移動先 categoryId=2。兄弟グループ不一致。
        mockRepo.findById.mockImplementation((id: number) => {
          if (id === 100) return Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1 }));
          if (id === 42)
            return Promise.resolve(makeTaskEntity({ id: 42, categoryId: 9, parentTaskId: null }));
          return Promise.resolve(null);
        });

        await expect(
          service.move(100, { parentTaskId: null, categoryId: 2, afterTaskId: 42 }),
        ).rejects.toThrow(BadRequestException);
        expect(mockRepo.moveTask).not.toHaveBeenCalled();
      });

      it('afterTaskId の基準兄弟が別 parentTaskId（グループ違い）の場合 BadRequestException をスローすること', async () => {
        // 移動先は parent=7 配下だが基準兄弟 42 は parentTaskId=null。グループ不一致。
        mockRepo.findCategoryById.mockResolvedValue({
          id: 2,
          archivedAt: null,
          spaceId: DEFAULT_CHANNEL_ID,
        });
        mockRepo.getSubtreeHeight.mockResolvedValue(1);
        mockRepo.getAncestorIds.mockResolvedValue([7]); // 新親 depth=1（root）
        mockRepo.findById.mockImplementation((id: number) => {
          if (id === 100) return Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1 }));
          if (id === 7) return Promise.resolve(makeTaskEntity({ id: 7, categoryId: 2 }));
          if (id === 42)
            return Promise.resolve(makeTaskEntity({ id: 42, categoryId: 2, parentTaskId: null }));
          return Promise.resolve(null);
        });

        await expect(
          service.move(100, { parentTaskId: 7, categoryId: 2, afterTaskId: 42 }),
        ).rejects.toThrow(BadRequestException);
        expect(mockRepo.moveTask).not.toHaveBeenCalled();
      });

      it('afterTaskId の基準兄弟が移動先グループに属するなら moveTask を呼ぶこと', async () => {
        setupAfterBase();
        // 基準兄弟 42 は移動先と同一グループ（categoryId=2, トップレベル）。
        mockRepo.findById.mockImplementation((id: number) => {
          if (id === 100) return Promise.resolve(makeTaskEntity({ id: 100, categoryId: 1 }));
          if (id === 42)
            return Promise.resolve(makeTaskEntity({ id: 42, categoryId: 2, parentTaskId: null }));
          return Promise.resolve(null);
        });

        await service.move(100, { parentTaskId: null, categoryId: 2, afterTaskId: 42 });

        expect(mockRepo.moveTask).toHaveBeenCalledWith(100, {
          expectedSpaceId: DEFAULT_CHANNEL_ID,
          parentTaskId: null,
          categoryId: 2,
          afterTaskId: 42,
        });
      });
    });
  });

  describe('アーカイブ済分類への紐づけ拒否（rete-desk-0140）', () => {
    const archivedCategory = { id: 2, archivedAt: new Date() };

    it('create: アーカイブ済分類なら BadRequestException で拒否すること', async () => {
      mockRepo.findCategoryById.mockResolvedValue(archivedCategory);

      await expect(service.create({ title: 'x', categoryId: 2 } as never)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRepo.createWithSortOrder).not.toHaveBeenCalled();
    });

    it('create: 分類不在なら NotFoundException を投げること', async () => {
      mockRepo.findCategoryById.mockResolvedValue(null);

      await expect(service.create({ title: 'x', categoryId: 99 } as never)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('update: categoryId 変更先がアーカイブ済なら拒否し、更新しないこと', async () => {
      mockRepo.findById.mockResolvedValue(mockTask);
      mockRepo.findCategoryById.mockResolvedValue(archivedCategory);

      await expect(service.update(1, { categoryId: 2 } as never)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('move: 移動先分類がアーカイブ済なら拒否すること', async () => {
      mockRepo.findById.mockResolvedValue(makeTaskEntity({ id: 100 }));
      mockRepo.findCategoryById.mockResolvedValue(archivedCategory);

      await expect(
        service.move(100, { categoryId: 2, parentTaskId: null } as never),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });
  });

  describe('findTree', () => {
    it('repo.findAllForTree の結果を toTaskTreeResponse 経由で ok 包装すること', async () => {
      const category = makeCategoryEntity({ id: 1, name: '入荷管理', sortOrder: 0 });
      const root = { ...makeTaskEntity({ id: 1, parentTaskId: null, categoryId: 1 }), category };
      mockRepo.findAllForTree.mockResolvedValue([root]);

      const result = await service.findTree();

      expect(result.success).toBe(true);
      expect(result.data.categories).toHaveLength(1);
      expect(result.data.categories[0].id).toBe(1);
      expect(result.data.categories[0].tasks[0].id).toBe(1);
      expect(result.data.categories[0].tasks[0].children).toEqual([]);
    });

    it('taskSpaceが可視でもsource theme不可視ならtreeからIDとタイトルを除く', async () => {
      const category = makeCategoryEntity({ id: 1, name: '入荷管理', sortOrder: 0 });
      const root = {
        ...makeTaskEntity({ id: 2, parentTaskId: null, categoryId: 1, spaceId: 'task-space' }),
        sourceThemeId: 'secret-theme',
        sourceTheme: { id: 'secret-theme', title: '秘匿テーマ', spaceId: 'private-space' },
        category,
      };
      mockScopeVisibility.resolveVisibleSpaceIds.mockResolvedValue(['task-space']);
      mockRepo.findAllForTree.mockResolvedValue([root]);

      const result = await service.findTree(undefined, 'reader-1');
      const task = result.data.categories[0].tasks[0];

      expect(task.sourceThemeId).toBeNull();
      expect(task.sourceTheme).toBeNull();
    });
  });

  // 存在秘匿の read/move enforcement（rete-hardening-0002）。可視範囲外の器のタスクは
  // 「無いことにする」: 一覧/ツリーは非可視 Space を含めず、単体 GET / move は 404 を返す。
  // IDOR negative: 他 space の id / spaceId を直打ちしても結果に含めない or 404 を、例外型と
  // 包含で assert する（success フラグだけを見ない）。
  describe('存在秘匿 read/move enforcement（rete-hardening-0002）', () => {
    it('findAll: 可視 Space のみへ絞る where（spaceId in 可視集合）を repository へ渡すこと（他 space 非包含）', async () => {
      const visible = ['space-A', 'space-B'];
      mockScopeVisibility.resolveVisibleSpaceIds.mockResolvedValue(visible);
      mockRepo.findManyPaginated.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
        mentionedTaskIds: new Set<number>(),
      });

      await service.findAll({ page: 1, limit: 20 }, 'acc-1');

      expect(mockScopeVisibility.resolveVisibleSpaceIds).toHaveBeenCalledWith('acc-1');
      const config = mockRepo.findManyPaginated.mock.calls[0][1];
      // baseWhere に spaceId フィルタが乗り、可視集合外の器は構造的に取得対象外（他 space 非包含）。
      expect(config.baseWhere).toEqual(expect.objectContaining({ spaceId: { in: visible } }));
    });

    it('findAll: accountId 未指定（内部経路）は絞らず素の LIST_CONFIG を渡すこと', async () => {
      mockRepo.findManyPaginated.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
        mentionedTaskIds: new Set<number>(),
      });

      await service.findAll({ page: 1, limit: 20 });

      expect(mockScopeVisibility.resolveVisibleSpaceIds).not.toHaveBeenCalled();
      const config = mockRepo.findManyPaginated.mock.calls[0][1];
      expect(config.baseWhere).not.toHaveProperty('spaceId');
    });

    it('findOne: 他 space のタスク id を直打ちすると 404（NotFoundException）になり結果を返さないこと', async () => {
      mockRepo.findByIdWithReactions.mockResolvedValue(
        makeTaskEntity({ id: 555, spaceId: 'other-space' }),
      );
      mockScopeVisibility.assertVisibleOr404.mockRejectedValue(
        new NotFoundException('Resource not found'),
      );

      await expect(service.findOne(555, 'intruder')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith(
        'intruder',
        'other-space',
      );
    });

    it('findOne: 可視 Space のタスクは取得できること（404 にならない）', async () => {
      mockRepo.findByIdWithReactions.mockResolvedValue(
        makeTaskEntity({ id: 1, spaceId: 'space-A' }),
      );

      const result = await service.findOne(1, 'member-1');

      expect(result.success).toBe(true);
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith('member-1', 'space-A');
    });

    it('findTree: spaceId 指定で非可視なら 404 になり findAllForTree を呼ばないこと', async () => {
      mockScopeVisibility.assertVisibleOr404.mockRejectedValue(
        new NotFoundException('Resource not found'),
      );

      await expect(service.findTree('other-space', 'intruder')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith(
        'intruder',
        'other-space',
      );
      expect(mockRepo.findAllForTree).not.toHaveBeenCalled();
    });

    it('findTree: spaceId 未指定なら可視 Space 集合を findAllForTree へ渡すこと（他 space 非包含）', async () => {
      const visible = ['space-A'];
      mockScopeVisibility.resolveVisibleSpaceIds.mockResolvedValue(visible);
      mockRepo.findAllForTree.mockResolvedValue([]);

      await service.findTree(undefined, 'acc-1');

      expect(mockRepo.findAllForTree).toHaveBeenCalledWith(undefined, visible);
    });

    it('move: 移動元 Space が非可視なら 404（owner チェック・moveTask より前に弾く）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 100, spaceId: 'other-space', ownerId: 'owner-1' }),
      );
      mockScopeVisibility.assertVisibleOr404.mockRejectedValue(
        new NotFoundException('Resource not found'),
      );

      await expect(
        service.move(
          100,
          { parentTaskId: null, categoryId: 2, afterTaskId: null },
          mkUser('intruder'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith(
        'intruder',
        'other-space',
      );
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });

    it('move: 移動先 Space が非可視なら 404（project 整合検証より前に弾く）', async () => {
      const CH_A = DEFAULT_CHANNEL_ID;
      const CH_X = '00000000-0000-4000-b000-0000000000f9';
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 100, categoryId: 1, spaceId: CH_A, ownerId: 'owner-1' }),
      );
      // 移動元（CH_A）は可視、移動先（CH_X）のみ非可視 → 2 回目の assertVisibleOr404 で reject。
      mockScopeVisibility.assertVisibleOr404
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new NotFoundException('Resource not found'));

      await expect(
        service.move(
          100,
          { parentTaskId: null, categoryId: 2, afterTaskId: null, spaceId: CH_X },
          mkUser('owner-1'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockScopeVisibility.assertVisibleOr404).toHaveBeenCalledWith('owner-1', CH_X);
      // 可視性 NG を優先するため project 整合（findSpaceForMove）まで到達しない。
      expect(mockRepo.findSpaceForMove).not.toHaveBeenCalled();
      expect(mockRepo.moveTask).not.toHaveBeenCalled();
    });
  });

  // 属性変更の監査記録（dsk-0223）。update / move の確定後に TaskActivitiesService.record が
  // 「変わった項目だけ」を from/to ラベル付きで受け取ることを検証する。
  describe('監査ログ記録（dsk-0223）', () => {
    // 担当変更の name 解決に findAccountById（id+name）を使うため既定値を入れておく。
    const setupUpdateBase = () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({
          id: 1,
          status: TaskStatus.TODO,
          categoryId: 1,
          assigneeId: null,
          parentTaskId: null,
          startDate: null,
          dueDate: null,
        }),
      );
      mockRepo.update.mockResolvedValue(makeTaskEntity({ id: 1 }));
      mockRepo.findAccountById.mockResolvedValue({ id: 'acc-9', name: '佐藤花子' });
      // 新カテゴリ名は検証（findCategoryById）から流用する（二重 SELECT 解消後の経路）。
      mockRepo.findCategoryById.mockImplementation((id: number) =>
        Promise.resolve({
          id,
          name: id === 1 ? '入荷' : '出荷',
          archivedAt: null,
          spaceId: DEFAULT_CHANNEL_ID,
        }),
      );
      // 旧カテゴリ名（fromLabel）は findCategoryNameById で解決（existing.categoryId=1 → '入荷'）。
      mockRepo.findCategoryNameById.mockImplementation((id: number) =>
        Promise.resolve(id === 1 ? { id: 1, name: '入荷' } : { id: 5, name: '出荷' }),
      );
    };

    it('status 変更で record が status の from/to ラベル付きで 1 件呼ばれること', async () => {
      setupUpdateBase(); // existing.status = TODO

      // 顛末を伴わない status 変更（TODO→対応中）で status 単独の change のみ積まれることを確認する。
      await service.update(1, { status: TaskStatus.IN_PROGRESS });

      expect(mockTaskActivities.record).toHaveBeenCalledTimes(1);
      const [taskId, actorId, changes] = mockTaskActivities.record.mock.calls[0];
      expect(taskId).toBe(1);
      expect(actorId).toBeNull(); // user 未指定（内部経路）は actor=null。
      expect(changes).toEqual([{ field: 'status', fromLabel: '未着手', toLabel: '対応中' }]);
    });

    it('題名のみの変更で field=thread（スレッドの更新）を1件積むこと（dsk-0246）', async () => {
      setupUpdateBase(); // existing.title = '入荷データ取込'

      await service.update(1, { title: '改題' });

      expect(mockTaskActivities.record).toHaveBeenCalledTimes(1);
      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      expect(changes).toEqual([{ field: 'thread', fromLabel: null, toLabel: null }]);
    });

    it('説明のみの変更で field=thread を1件積むこと（dsk-0246）', async () => {
      setupUpdateBase(); // existing.description = '当日分の入荷 CSV を取り込む'

      await service.update(1, { description: '<p>新しい説明</p>' });

      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      expect(changes).toEqual([{ field: 'thread', fromLabel: null, toLabel: null }]);
    });

    it('題名・説明が現値と同一なら thread を積まないこと（右ペイン属性更新が誤発火しない・dsk-0246）', async () => {
      // 実運用に合わせ existing.description は Tiptap HTML を格納（sanitize 済み）。右ペイン更新はその HTML を
      // 同送するため、sanitize idempotency により thread は誤発火しない（plain-text 比較では検出力が落ちるため HTML ペアで検証）。
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({
          id: 1,
          status: TaskStatus.TODO,
          title: '入荷データ取込',
          description: '<p>当日分の入荷 CSV を取り込む</p>',
        }),
      );
      mockRepo.update.mockResolvedValue(makeTaskEntity({ id: 1 }));

      // 右ペイン更新は title/description を現値のまま同送する。status のみ実変化させる。
      await service.update(1, {
        title: '入荷データ取込',
        description: '<p>当日分の入荷 CSV を取り込む</p>',
        status: TaskStatus.IN_PROGRESS,
      });

      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      expect(changes).toEqual([{ field: 'status', fromLabel: '未着手', toLabel: '対応中' }]);
    });

    it('顛末（tenmatsu）の更新で field=outcome と本文抜粋 toLabel を1件積むこと（null→値・dsk-0345）', async () => {
      setupUpdateBase(); // existing.tenmatsu = null

      await service.update(1, { tenmatsu: '<p>対応の顛末</p>' });

      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      expect(changes).toEqual([{ field: 'outcome', fromLabel: null, toLabel: '対応の顛末' }]);
    });

    it('顛末を空にクリアすると outcome の toLabel は null（固定文フォールバック用・dsk-0345）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 1, status: TaskStatus.IN_PROGRESS, tenmatsu: '<p>既存の顛末</p>' }),
      );
      mockRepo.update.mockResolvedValue(makeTaskEntity({ id: 1 }));

      // DTO は string | undefined。空クリアは ''（frontend isRichTextEmpty → null 正規化前でも空文字到達可）
      await service.update(1, { tenmatsu: '' });

      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      expect(changes).toEqual([{ field: 'outcome', fromLabel: null, toLabel: null }]);
    });

    // dsk-0357: toExcerpt 140 字切り詰め（dsk-0345 code-reviewer LOW の回帰固定）
    it('顛末が140字を超えると outcome の toLabel は先頭140字 + … になること（dsk-0357）', async () => {
      setupUpdateBase(); // existing.tenmatsu = null
      const longPlain = 'あ'.repeat(150);
      await service.update(1, { tenmatsu: `<p>${longPlain}</p>` });

      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      expect(changes).toHaveLength(1);
      expect(changes[0].field).toBe('outcome');
      expect(changes[0].fromLabel).toBeNull();
      expect(changes[0].toLabel).toBe(`${'あ'.repeat(140)}…`);
      expect(changes[0].toLabel).toHaveLength(141);
    });

    it('顛末が現値と同一なら outcome を積まないこと（誤発火しない・dsk-0246）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 1, status: TaskStatus.IN_PROGRESS, tenmatsu: '<p>既存の顛末</p>' }),
      );
      mockRepo.update.mockResolvedValue(makeTaskEntity({ id: 1 }));

      await service.update(1, { tenmatsu: '<p>既存の顛末</p>' });

      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      expect(changes).toEqual([]);
    });

    it('同値指定（status 据え置き）では change を積まないこと', async () => {
      setupUpdateBase(); // existing.status = TODO

      await service.update(1, { status: TaskStatus.TODO });

      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      expect(changes).toEqual([]);
    });

    it('複数項目同時変更で複数 change が積まれること（status / category / assignee / startDate）', async () => {
      setupUpdateBase();

      await service.update(1, {
        status: TaskStatus.IN_PROGRESS,
        categoryId: 5,
        assigneeId: 'acc-9',
        startDate: '2026-07-01T00:00:00.000Z',
      });

      const [, , changes] = mockTaskActivities.record.mock.calls[0] as [
        number,
        string | null,
        Array<{ field: string }>,
      ];
      const fields = changes.map((c) => c.field).sort();
      expect(fields).toEqual(['assignee', 'category', 'startDate', 'status']);
      expect(changes).toContainEqual({ field: 'status', fromLabel: '未着手', toLabel: '対応中' });
      expect(changes).toContainEqual({ field: 'category', fromLabel: '入荷', toLabel: '出荷' });
      expect(changes).toContainEqual({
        field: 'assignee',
        fromLabel: '未割当',
        toLabel: '佐藤花子',
      });
      expect(changes).toContainEqual({
        field: 'startDate',
        fromLabel: '未設定',
        toLabel: '2026/07/01',
      });
    });

    it('update path の親付け替えは field=parent を親No（id）で積むこと（null→7 = なし→7・dsk-0240）', async () => {
      setupUpdateBase(); // existing.parentTaskId = null
      // 親検証（findById）は setupUpdateBase の既定 mock が同一 Space のタスクを返す → 越境ガードを通過。

      await service.update(1, { parentTaskId: 7 });

      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      // 親は No（id）で from/to。null（トップレベル）側は「なし」（move path と同形・dsk-0240）。
      expect(changes).toContainEqual({ field: 'parent', fromLabel: 'なし', toLabel: '7' });
    });

    it('actor は user.id（操作者）として渡されること', async () => {
      setupUpdateBase();

      // makeTaskEntity の ownerId は null。null owner は ADMIN のみ変更可のため ADMIN で owner-check を
      // バイパスし、actor 伝播（user.id）のみを検証する。
      await service.update(
        1,
        { status: TaskStatus.DONE, tenmatsu: 'done' },
        mkUser('admin-actor', Role.ADMIN),
      );

      const [, actorId] = mockTaskActivities.record.mock.calls[0];
      expect(actorId).toBe('admin-actor');
    });

    it('record が throw しても update 本体は成功する（監査失敗が業務操作を巻き戻さない）', async () => {
      setupUpdateBase();
      mockTaskActivities.record.mockRejectedValueOnce(new Error('audit down'));
      const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const result = await service.update(1, { status: TaskStatus.DONE, tenmatsu: 'done' });

      expect(result.success).toBe(true);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('move では parent / category の変化を record に渡すこと', async () => {
      mockRepo.findById.mockImplementation((id: number) => {
        if (id === 100)
          return Promise.resolve(
            makeTaskEntity({ id: 100, parentTaskId: null, categoryId: 1, ownerId: null }),
          );
        if (id === 7)
          return Promise.resolve(makeTaskEntity({ id: 7, title: '親タスクX', categoryId: 2 }));
        return Promise.resolve(null);
      });
      // 新カテゴリ名（toLabel）は検証 findCategoryById から、旧カテゴリ名（fromLabel）は findCategoryNameById から解決。
      mockRepo.findCategoryById.mockResolvedValue({
        id: 2,
        name: '出荷',
        archivedAt: null,
        spaceId: DEFAULT_CHANNEL_ID,
      });
      mockRepo.findCategoryNameById.mockImplementation((id: number) =>
        Promise.resolve(id === 1 ? { id: 1, name: '入荷' } : { id: 2, name: '出荷' }),
      );
      mockRepo.getAncestorIds.mockResolvedValue([7]);
      mockRepo.getSubtreeHeight.mockResolvedValue(1);
      mockRepo.moveTask.mockResolvedValue(
        makeTaskEntity({ id: 100, parentTaskId: 7, categoryId: 2 }),
      );

      await service.move(100, { parentTaskId: 7, categoryId: 2, afterTaskId: null });

      expect(mockTaskActivities.record).toHaveBeenCalledTimes(1);
      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      // 親は No（id）で from/to。null（トップレベル）側は「なし」（dsk-0240）。
      expect(changes).toContainEqual({ field: 'parent', fromLabel: 'なし', toLabel: '7' });
      expect(changes).toContainEqual({ field: 'category', fromLabel: '入荷', toLabel: '出荷' });
    });

    it('move: クロス Space 移動で field=space の変更を移動元名→移動先名で record に渡すこと（dsk-0225）', async () => {
      const CH_A = DEFAULT_CHANNEL_ID; // 移動元
      const CH_B = '00000000-0000-4000-b000-0000000000b1'; // 同一プロジェクトの移動先
      const PROJ = '00000000-0000-4000-b000-000000000002';
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({
          id: 100,
          parentTaskId: null,
          categoryId: 1,
          ownerId: null,
          spaceId: CH_A,
        }),
      );
      mockRepo.findSpaceForMove.mockImplementation((id: string) =>
        Promise.resolve(
          id === CH_B
            ? { projectId: PROJ, name: '出荷チャネル' }
            : id === CH_A
              ? { projectId: PROJ, name: '入荷チャネル' }
              : null,
        ),
      );
      mockRepo.findCategoryNameById.mockResolvedValue({ id: 1, name: '入荷' });
      mockRepo.getSubtreeHeight.mockResolvedValue(1);
      mockRepo.moveTask.mockResolvedValue(makeTaskEntity({ id: 100, spaceId: CH_B }));

      await service.move(100, {
        parentTaskId: null,
        categoryId: 2,
        afterTaskId: null,
        spaceId: CH_B,
      });

      const [, , changes] = mockTaskActivities.record.mock.calls[0];
      expect(changes).toContainEqual({
        field: 'space',
        fromLabel: '入荷チャネル',
        toLabel: '出荷チャネル',
      });
    });
  });

  /**
   * 存在秘匿の応答平準化（v2-254）。対象不在の 404 と、対象が存在するが非可視の 404 が、
   * status だけでなく文言まで一致することを両分岐の実メッセージ比較で固定する。片側だけ変えると
   * 応答本文が「存在するか」の oracle に戻る（ADR 0038）。
   */
  describe('404 の応答平準化（不在と非可視で同じ文言・v2-254）', () => {
    const SPACE_X = 'space-x-invisible';
    const THEME_X = 'theme-x-invisible';

    /** 非可視 Space の可視性ガードが 404 を投げる状況を作る（対象 Space だけ拒否・他は可視）。 */
    const denySpace = (spaceId: string) =>
      mockScopeVisibility.assertVisibleOr404.mockImplementation(
        (accountId: string | undefined | null, target: string) =>
          target === spaceId
            ? Promise.reject(new NotFoundException('Resource not found'))
            : Promise.resolve(undefined),
      );

    /** 実メッセージを取る（例外が無ければ '<no-error>'）。 */
    const messageOf = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return '<no-error>';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };

    it('findOne: 不在と非可視が同じ文言（Task not found）', async () => {
      mockRepo.findByIdWithReactions.mockResolvedValue(null);
      const missing = await messageOf(() => service.findOne(999, 'me'));

      mockRepo.findByIdWithReactions.mockResolvedValue(makeTaskEntity({ id: 1, spaceId: SPACE_X }));
      denySpace(SPACE_X);
      const invisible = await messageOf(() => service.findOne(1, 'me'));

      expect(missing).toBe('Task not found');
      expect(invisible).toBe(missing);
    });

    it('update: 不在と非可視が同じ文言（Task not found）', async () => {
      mockRepo.findById.mockResolvedValue(null);
      const missing = await messageOf(() => service.update(999, { title: 'x' }, mkUser('me')));

      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 1, spaceId: SPACE_X, ownerId: 'me' }),
      );
      denySpace(SPACE_X);
      const invisible = await messageOf(() => service.update(1, { title: 'x' }, mkUser('me')));

      expect(missing).toBe('Task not found');
      expect(invisible).toBe(missing);
    });

    it('remove: 不在と非可視が同じ文言（Task not found）', async () => {
      mockRepo.findById.mockResolvedValue(null);
      const missing = await messageOf(() => service.remove(999, mkUser('me')));

      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 1, spaceId: SPACE_X, ownerId: 'me' }),
      );
      denySpace(SPACE_X);
      const invisible = await messageOf(() => service.remove(1, mkUser('me')));

      expect(missing).toBe('Task not found');
      expect(invisible).toBe(missing);
    });

    it('move: 移動元の不在と非可視が同じ文言（Task not found）', async () => {
      const moveDto = { parentTaskId: null, categoryId: null, afterTaskId: null };

      mockRepo.findById.mockResolvedValue(null);
      const missing = await messageOf(() => service.move(999, moveDto, mkUser('me')));

      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 1, spaceId: SPACE_X, ownerId: 'me' }),
      );
      denySpace(SPACE_X);
      const invisible = await messageOf(() => service.move(1, moveDto, mkUser('me')));

      expect(missing).toBe('Task not found');
      expect(invisible).toBe(missing);
    });

    it('move: 移動先の器の非可視は Target space not found（器の不在と同じ枝）', async () => {
      mockRepo.findById.mockResolvedValue(
        makeTaskEntity({ id: 1, spaceId: DEFAULT_CHANNEL_ID, ownerId: 'me' }),
      );
      denySpace(SPACE_X);

      expect(
        await messageOf(() =>
          service.move(
            1,
            { parentTaskId: null, categoryId: null, afterTaskId: null, spaceId: SPACE_X },
            mkUser('me'),
          ),
        ),
      ).toBe('Target space not found');
    });

    it('toggleReaction: 不在と非可視が同じ文言（Task not found）', async () => {
      mockRepo.findTaskSpaceId.mockResolvedValue(null);
      const missing = await messageOf(() => service.toggleReaction(999, 'me', { emoji: '👍' }));

      mockRepo.findTaskSpaceId.mockResolvedValue({ spaceId: SPACE_X });
      denySpace(SPACE_X);
      const invisible = await messageOf(() => service.toggleReaction(1, 'me', { emoji: '👍' }));

      expect(missing).toBe('Task not found');
      expect(invisible).toBe(missing);
    });

    it('create: 昇格元テーマの不在と非可視が同じ文言（Chat theme not found）', async () => {
      mockRepo.findThemeById.mockResolvedValue(null);
      const missing = await messageOf(() =>
        service.create({ title: 'x', sourceThemeId: THEME_X }, 'me'),
      );

      mockRepo.findThemeById.mockResolvedValue({ id: THEME_X, spaceId: SPACE_X });
      denySpace(SPACE_X);
      const invisible = await messageOf(() =>
        service.create({ title: 'x', sourceThemeId: THEME_X }, 'me'),
      );

      expect(missing).toBe('Chat theme not found');
      expect(invisible).toBe(missing);
    });

    it('create / findTree: 器の非可視は Target space not found（器の不在と同じ枝）', async () => {
      denySpace(SPACE_X);

      expect(await messageOf(() => service.create({ title: 'x', spaceId: SPACE_X }, 'me'))).toBe(
        'Target space not found',
      );
      expect(await messageOf(() => service.findTree(SPACE_X, 'me'))).toBe('Target space not found');
    });
  });

  /**
   * v2-259: 入力依存不変条件（クエリの回数と形はリクエスト入力だけで決まる）。
   * 「対象が存在しない」枝でも可視範囲の解決を通り、対象取得は同梱なしの軽量取得（findTaskSpaceId）で
   * 行うことを固定する（不在の枝が可視範囲の解決と同梱クエリを省略すると、応答時間から対象の存在を
   * 読み分けられる＝timing oracle が戻る）。
   */
  describe('404 の応答コスト平準化（不在でも可視範囲の解決を先に通す・v2-259）', () => {
    /** 呼び出し順の比較（resetMocks 済みなので各テストの 1 回目同士を比べる）。 */
    const calledBefore = (first: jest.Mock, second: jest.Mock): boolean =>
      first.mock.invocationCallOrder[0] < second.mock.invocationCallOrder[0];

    beforeEach(() => {
      // 対象不在（軽量取得が null）でも可視範囲の解決は走る。
      mockRepo.findTaskSpaceId.mockResolvedValue(null);
      mockRepo.findById.mockResolvedValue(null);
      mockScopeVisibility.resolveVisibleSpaceIds.mockResolvedValue(['space-1']);
    });

    it('findOne: 対象不在でも可視範囲の解決を対象取得より先に通る', async () => {
      await expect(service.findOne(999, 'acc-1')).rejects.toThrow(NotFoundException);

      expect(mockScopeVisibility.resolveVisibleSpaceIds).toHaveBeenCalledWith('acc-1');
      expect(
        calledBefore(mockScopeVisibility.resolveVisibleSpaceIds, mockRepo.findTaskSpaceId),
      ).toBe(true);
    });

    it('update: 対象不在でも可視範囲の解決を対象取得より先に通る', async () => {
      await expect(service.update(999, { title: 'x' }, mkUser('acc-1'))).rejects.toThrow(
        NotFoundException,
      );

      expect(mockScopeVisibility.resolveVisibleSpaceIds).toHaveBeenCalledWith('acc-1');
      expect(
        calledBefore(mockScopeVisibility.resolveVisibleSpaceIds, mockRepo.findTaskSpaceId),
      ).toBe(true);
    });

    it('move: 対象不在でも可視範囲の解決を対象取得より先に通る', async () => {
      await expect(
        service.move(
          999,
          { parentTaskId: null, categoryId: null, afterTaskId: null },
          mkUser('acc-1'),
        ),
      ).rejects.toThrow(NotFoundException);

      expect(mockScopeVisibility.resolveVisibleSpaceIds).toHaveBeenCalledWith('acc-1');
      expect(
        calledBefore(mockScopeVisibility.resolveVisibleSpaceIds, mockRepo.findTaskSpaceId),
      ).toBe(true);
    });

    it('remove: 対象不在でも可視範囲の解決を対象取得より先に通る', async () => {
      await expect(service.remove(999, mkUser('acc-1'))).rejects.toThrow(NotFoundException);

      expect(mockScopeVisibility.resolveVisibleSpaceIds).toHaveBeenCalledWith('acc-1');
      expect(
        calledBefore(mockScopeVisibility.resolveVisibleSpaceIds, mockRepo.findTaskSpaceId),
      ).toBe(true);
    });

    it('toggleReaction: 対象不在でも可視範囲の解決を対象取得より先に通る', async () => {
      await expect(service.toggleReaction(999, 'acc-1', { emoji: '👍' })).rejects.toThrow(
        NotFoundException,
      );

      expect(mockScopeVisibility.resolveVisibleSpaceIds).toHaveBeenCalledWith('acc-1');
      expect(
        calledBefore(mockScopeVisibility.resolveVisibleSpaceIds, mockRepo.findTaskSpaceId),
      ).toBe(true);
    });

    it('create: 昇格元テーマの不在でも可視範囲の解決をテーマ取得より先に通る', async () => {
      mockRepo.findThemeById.mockResolvedValue(null);

      await expect(
        service.create({ title: 'x', sourceThemeId: 'theme-x' }, 'acc-1'),
      ).rejects.toThrow(NotFoundException);

      expect(mockScopeVisibility.resolveVisibleSpaceIds).toHaveBeenCalledWith('acc-1');
      expect(calledBefore(mockScopeVisibility.resolveVisibleSpaceIds, mockRepo.findThemeById)).toBe(
        true,
      );
    });
  });
});
