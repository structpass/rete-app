import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role, SpaceKind } from '@rete/shared';
import { withUniqueConflictMessage } from '../../common/filters/unique-conflict-context';
import { ok } from '../../common/dto';
import { buildArchiveUpdate } from '../../common/services/container.helper';
import { SpacesRepository } from './repositories/spaces.repository';
import { ProjectsRepository } from '../projects/repositories/projects.repository';
import { MembershipsRepository } from '../memberships/repositories/memberships.repository';
import { ScopeVisibilityService } from '../memberships/scope-visibility.service';
import { AccountsRepository } from '../accounts/repositories/accounts.repository';
import { toSpaceDto } from './spaces.mapper';
import { CreateSpaceDto } from './dto/create-space.dto';
import { UpdateSpaceDto } from './dto/update-space.dto';

/**
 * 器（Space）管理のアプリケーションサービス（§2 Repository 分離・§1 DTO 境界）。
 *
 * kind ごとに作成ロジックが異なる（判別共用体）。
 * CHANNEL: プロジェクト ADMIN のみ作成可。membership 不要（project membership で可視）。
 * GROUP: 誰でも作成可。creator の GROUP ADMIN membership を共創。
 * PERSONAL_MEMO: 作成者専用。ownership で可視。
 * PERSONAL_DM: peerAccountId 必須 + 無向ペア重複防止（app 層 cross-check）。
 */
@Injectable()
export class SpacesService {
  constructor(
    private readonly spaceRepo: SpacesRepository,
    private readonly projectRepo: ProjectsRepository,
    private readonly membershipRepo: MembershipsRepository,
    private readonly visibilityService: ScopeVisibilityService,
    private readonly accountRepo: AccountsRepository,
  ) {}

  async create(dto: CreateSpaceDto, userId: string) {
    switch (dto.kind) {
      case SpaceKind.CHANNEL:
        return this.createChannel(dto, userId);
      case SpaceKind.GROUP:
        return this.createGroup(dto, userId);
      case SpaceKind.PERSONAL_MEMO:
        return this.createPersonalMemo(dto, userId);
      case SpaceKind.PERSONAL_DM:
        return this.createPersonalDm(dto, userId);
      default:
        throw new BadRequestException('不明な kind です');
    }
  }

  /**
   * 任意の 1 件を id で取得する（dsk-0330 で DeskGroupsService.moveMember の事前検証用）。
   * 認可判定は呼び出し側（DeskGroupsService）が accountId で行い、ここでは row を返すだけ。
   * §2 Repository 分離（service は repository 経由でのみ DB に触れる）に従い SpaceRow をそのまま返す。
   * 現状の利用者（DeskGroupsService.assertOwnedTargetRef）は row を HTTP に流さず kind / ownerId /
   * peerAccountId のみを読むので DTO 境界（§1）の問題は顕在化しない。
   */
  async findById(id: string) {
    return this.spaceRepo.findById(id); // null 許容
  }

  private async createChannel(dto: CreateSpaceDto, userId: string) {
    if (!dto.projectId) {
      throw new BadRequestException('CHANNEL には projectId が必要です');
    }
    if (!dto.name) {
      throw new BadRequestException('CHANNEL には name が必要です');
    }
    const project = await this.projectRepo.findById(dto.projectId);
    if (!project) throw new NotFoundException('プロジェクトが見つかりません');

    const membership = await this.membershipRepo.findEffectiveMembership(
      userId,
      'PROJECT',
      dto.projectId,
    );
    if (!membership || membership.role !== 'ADMIN') {
      throw new ForbiddenException('このプロジェクトにチャネルを作成する権限がありません');
    }

    const space = await this.spaceRepo.createChannel(dto.projectId, dto.name);
    return ok(toSpaceDto(space));
  }

  private async createGroup(dto: CreateSpaceDto, userId: string) {
    if (!dto.name) {
      throw new BadRequestException('GROUP には name が必要です');
    }
    // creator は GROUP ADMIN membership を共創するためメンバー設定可（dsk-0354）。
    const space = await this.spaceRepo.createGroupWithMembership(dto.name, userId);
    return ok(toSpaceDto(space, { canManageMembers: true }));
  }

  private async createPersonalMemo(dto: CreateSpaceDto, userId: string) {
    // 空文字 / 空白のみの name はデフォルトへフォールバック（?? は "" を素通しするため trim 判定 / rete-common-0011）。
    const name = dto.name?.trim() ? dto.name : '個人メモ';
    const space = await this.spaceRepo.createPersonalMemo(userId, name);
    return ok(toSpaceDto(space));
  }

  private async createPersonalDm(dto: CreateSpaceDto, userId: string) {
    const { peerAccountId } = dto;
    if (!peerAccountId) {
      throw new BadRequestException('PERSONAL_DM には peerAccountId が必要です');
    }
    // 自分自身との DM は不可（1:1 は別人前提・self-DM ガード / rete-common-0011）。
    if (peerAccountId === userId) {
      throw new BadRequestException('自分自身との DM は作成できません');
    }
    // peerAccountId の実在確認（存在しない/削除済み ID での不正な DM 作成を防ぐ / cmn-0074）。
    const peer = await this.accountRepo.findById(peerAccountId);
    if (!peer) {
      throw new NotFoundException('相手のアカウントが見つかりません');
    }
    // 無向ペア重複防止（ADR 0037 §2、事前チェック）
    const existing = await this.spaceRepo.findExistingDm(userId, peerAccountId);
    if (existing) {
      throw new ConflictException('この相手との DM は既に存在します');
    }
    // 並行作成の一意制約違反も、案内文を保って共通filterへ委譲する。
    const space = await withUniqueConflictMessage(
      () => this.spaceRepo.createPersonalDm(userId, peerAccountId),
      'この相手との DM は既に存在します',
    );
    return ok(toSpaceDto(space));
  }

  /**
   * 器一覧を返す。?kind&?projectId の組み合わせで絞り込む。
   * CHANNEL: projectId 必須。そのプロジェクトが可視なことを確認してから一覧取得。
   * GROUP: 自分が membership を持つグループのみ。
   * PERSONAL_MEMO/DM: 自分が owner/peer のもの。
   * kind 未指定: ScopeVisibilityService で全可視 spaceId を解決し id リストで返す（軽量版）。
   */
  /**
   * @param userRole システム ADMIN 判定用（dsk-0354: GROUP の canManageMembers）。省略時は scope-ADMIN のみ。
   * @param includeArchived CHANNEL のみ有効: true で archived も返す（既定: archived 除外）。
   *   設定「チャネル管理」モーダルの「アーカイブ済を表示」→復元導線の裏側。
   */
  async findAll(
    userId: string,
    kind?: SpaceKind,
    projectId?: string,
    userRole?: Role,
    includeArchived?: boolean,
  ) {
    if (kind === SpaceKind.CHANNEL) {
      if (!projectId) throw new BadRequestException('CHANNEL 一覧には projectId が必要です');
      return this.findVisibleChannels(userId, projectId, includeArchived);
    }
    if (kind === SpaceKind.GROUP) {
      const spaces = await this.spaceRepo.findGroupsForUser(userId);
      // dsk-0354: メンバー設定 UI ゲート。memberships.add と同条件（scope-ADMIN or システム ADMIN）。
      // ProjectDto.canManageChannels と同型で一括取得し N+1 を避ける。
      const isSystemAdmin = userRole === Role.ADMIN;
      const adminScopes = isSystemAdmin
        ? []
        : await this.membershipRepo.findEffectiveAdminScopeIds(userId, 'GROUP');
      const adminGroupIds = new Set(adminScopes.map((s) => s.scopeId));
      return ok(
        spaces.map((row) =>
          toSpaceDto(row, {
            canManageMembers: isSystemAdmin || adminGroupIds.has(row.id),
          }),
        ),
      );
    }
    if (kind === SpaceKind.PERSONAL_MEMO) {
      const spaces = await this.spaceRepo.findPersonalMemosForUser(userId);
      return ok(spaces.map((row) => toSpaceDto(row)));
    }
    if (kind === SpaceKind.PERSONAL_DM) {
      // dsk-0325: 双方の Account（owner / peer）を結合済で取得し、viewer 視点で peerName を解決する。
      // - partnerId = row.ownerId === userId ? row.peerAccountId : row.ownerId（自分ではない側）。
      // - partnerId === row.peerAccountId のときは row.peer が相手を指す（peerAccountId 経由）。
      // - partnerId === row.ownerId のときは row.owner が相手を指す（ownerId 経由）。
      // どちらの結合 Account も id === partnerId を保証しているので、その name を返す。
      // isActive は絞らない（退会・ロック済みでも 'DM' 固定に落ちない＝本質要件）。
      const rows = await this.spaceRepo.findPersonalDmsForUserWithPeer(userId);
      const spaces = rows.map((row) => {
        const partnerId = row.ownerId === userId ? row.peerAccountId : row.ownerId;
        const peerName =
          partnerId && row.peer?.id === partnerId
            ? row.peer.name
            : partnerId && row.owner?.id === partnerId
              ? row.owner.name
              : null;
        return toSpaceDto(row, { peerName });
      });
      return ok(spaces);
    }
    // kind 未指定: 可視 space ID のみ返す（全詳細は N+1 になるため ID リストに留める）
    const ids = await this.visibilityService.resolveVisibleSpaceIds(userId);
    return ok(ids);
  }

  private async findVisibleChannels(userId: string, projectId: string, includeArchived?: boolean) {
    // 閲覧は親 PROJECT / ORGANIZATION の実効所属、または直接 CHANNEL の可視性を
    // 加算する（ADR 0037 / 0075）。作成・更新の PROJECT ADMIN 条件とは分ける。
    const membership = await this.membershipRepo.findEffectiveMembership(
      userId,
      'PROJECT',
      projectId,
    );
    if (!membership) {
      const project = await this.projectRepo.findById(projectId);
      const orgMembership = project
        ? await this.membershipRepo.findEffectiveMembership(
            userId,
            'ORGANIZATION',
            project.organizationId,
          )
        : null;
      if (!orgMembership) {
        // 直接 CHANNEL の所属だけなら、同じ PJ の兄弟チャネルを返さない。
        // 可視集合は非アーカイブのみ。includeArchived でこの境界を広げない。
        const visibleIds = new Set(await this.visibilityService.resolveVisibleSpaceIds(userId));
        const channels = await this.spaceRepo.findChannelsByProject(projectId);
        const visibleChannels = channels.filter((space) => visibleIds.has(space.id));
        if (visibleChannels.length === 0) {
          throw new ForbiddenException('このプロジェクトのチャネルを閲覧する権限がありません');
        }
        return ok(visibleChannels.map((row) => toSpaceDto(row)));
      }
    }
    const spaces = await this.spaceRepo.findChannelsByProject(projectId, includeArchived);
    return ok(spaces.map((row) => toSpaceDto(row)));
  }

  /**
   * 器を更新する。CHANNEL/GROUP のみ対象（personal 系は BadRequest）。
   * 権限チェック: CHANNEL → PROJECT ADMIN / GROUP → GROUP ADMIN。
   */
  async update(id: string, dto: UpdateSpaceDto, userId: string) {
    const space = await this.spaceRepo.findById(id);
    if (!space) throw new NotFoundException('器が見つかりません');

    if (space.kind === 'PERSONAL_MEMO' || space.kind === 'PERSONAL_DM') {
      throw new BadRequestException('個人スペースは更新できません');
    }

    // 権限チェック
    if (space.kind === 'CHANNEL') {
      if (!space.projectId) throw new BadRequestException('CHANNEL にプロジェクト ID がありません');
      const m = await this.membershipRepo.findEffectiveMembership(
        userId,
        'PROJECT',
        space.projectId,
      );
      if (!m || m.role !== 'ADMIN')
        throw new ForbiddenException('このチャネルを編集する権限がありません');
    } else {
      // GROUP
      const m = await this.membershipRepo.findEffectiveMembership(userId, 'GROUP', id);
      if (!m || m.role !== 'ADMIN')
        throw new ForbiddenException('このグループを編集する権限がありません');
    }

    // アーカイブ済みスペースの改名はガード（rete-common-0011）。
    // 復元（archived:false）は許可し、改名のみ拒否する（先に復元してから改名する導線）。
    if (space.archivedAt && dto.name !== undefined) {
      throw new BadRequestException(
        'アーカイブ済みのスペースは改名できません（先に復元してください）',
      );
    }

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.archived !== undefined) Object.assign(data, buildArchiveUpdate(dto.archived));

    const updated = await this.spaceRepo.update(id, data);
    // update 到達時は CHANNEL/GROUP の scope-ADMIN 済み（上で forbidden ガード）。
    // GROUP のみ canManageMembers を true で返す（dsk-0354）。
    return ok(
      toSpaceDto(updated, {
        canManageMembers: space.kind === 'GROUP',
      }),
    );
  }

  /**
   * system Role=ADMIN 向けの器一覧（membership 非依存・テナント管理用・dsk-0319）。
   * kind=GROUP: 全 GROUP（従来挙動）。
   * kind=CHANNEL: projectId 必須で配下チャネル全件（set-0162 admin 経路・membership 非依存）。
   * 他 kind は BadRequestException。
   * system Role=ADMIN gating は呼び出し元コントローラの @Roles(Role.ADMIN) が担う。
   */
  async findAllAdmin(kind?: SpaceKind, projectId?: string, includeArchived?: boolean) {
    if (kind === SpaceKind.GROUP) {
      const groups = await this.spaceRepo.findAllGroupsAdmin(includeArchived);
      // テナント管理 ADMIN は全 GROUP を管理可（canManageMembers=true 固定）。
      return ok(groups.map((row) => toSpaceDto(row, { canManageMembers: true })));
    }
    if (kind === SpaceKind.CHANNEL) {
      if (!projectId) {
        throw new BadRequestException('CHANNEL 一覧には projectId が必要です');
      }
      const channels = await this.spaceRepo.findChannelsByProject(projectId, includeArchived);
      return ok(channels.map((row) => toSpaceDto(row)));
    }
    throw new BadRequestException('ADMIN 一覧は GROUP / CHANNEL のみ対応しています');
  }

  /**
   * system Role=ADMIN 向けの器作成（membership 非依存・set-0162 admin 経路）。
   * CHANNEL のみ対応（projectId + name 必須）。GROUP は通常経路（誰でも作成可）で足りるため対象外。
   */
  async createAdmin(dto: CreateSpaceDto) {
    if (dto.kind !== SpaceKind.CHANNEL) {
      throw new BadRequestException('ADMIN 作成は CHANNEL のみ対応しています');
    }
    if (!dto.projectId) {
      throw new BadRequestException('CHANNEL には projectId が必要です');
    }
    if (!dto.name) {
      throw new BadRequestException('CHANNEL には name が必要です');
    }
    const project = await this.projectRepo.findById(dto.projectId);
    if (!project) throw new NotFoundException('プロジェクトが見つかりません');

    const space = await this.spaceRepo.createChannel(dto.projectId, dto.name);
    return ok(toSpaceDto(space));
  }

  /**
   * system Role=ADMIN 向けの器更新（membership 非依存・set-0162 admin 経路）。
   * CHANNEL/GROUP のみ（personal 系は BadRequest）。改名 / archive トグル。
   */
  async adminUpdate(id: string, dto: UpdateSpaceDto) {
    const space = await this.spaceRepo.findById(id);
    if (!space) throw new NotFoundException('器が見つかりません');

    if (space.kind === 'PERSONAL_MEMO' || space.kind === 'PERSONAL_DM') {
      throw new BadRequestException('個人スペースは更新できません');
    }

    // アーカイブ済みスペースの改名はガード（通常経路と同じ・rete-common-0011）。
    if (space.archivedAt && dto.name !== undefined) {
      throw new BadRequestException(
        'アーカイブ済みのスペースは改名できません（先に復元してください）',
      );
    }

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.archived !== undefined) Object.assign(data, buildArchiveUpdate(dto.archived));

    const updated = await this.spaceRepo.update(id, data);
    return ok(
      toSpaceDto(updated, {
        canManageMembers: space.kind === 'GROUP',
      }),
    );
  }

  /**
   * system Role=ADMIN 向けの器の物理削除（membership 非依存・set-0162）。
   * CHANNEL のみ対応。紐づき（archived 含む全物理行: tasks / categories / chatThemes / folders）
   * があれば 409 で拒否（アーカイブを促す）。Folder は onDelete: Restrict のため DB エラー
   * （P2003）も 409 へ変換する。GROUP はチャット用の器で本画面の対象外のため拒否。
   */
  async adminDelete(id: string) {
    const space = await this.spaceRepo.findById(id);
    if (!space) throw new NotFoundException('器が見つかりません');

    if (space.kind !== SpaceKind.CHANNEL) {
      throw new BadRequestException('物理削除は CHANNEL のみ対応しています');
    }

    // 紐づき検査と削除は repository の直列化 tx（runInSerializableTransaction）内で原子化済み。
    // 並行挿入は P2034（write conflict）で abort され、リトライ上限後はグローバル
    // PrismaExceptionFilter が 409 へ変換する（Folder の Restrict に起因する P2003 も同 filter が
    // 409 へ変換するため、モジュール内 try/catch は持たない・cmn-0251 準拠）。
    const deleted = await this.spaceRepo.deleteChannelIfNoChildren(id);
    if (!deleted) {
      throw new ConflictException(
        '配下のデータが存在するため削除できません。アーカイブしてください',
      );
    }
    return ok({ id });
  }
}
