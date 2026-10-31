import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ok } from '../../common/dto';
import { buildArchiveUpdate } from '../../common/services/container.helper';
import { ProjectsRepository } from './repositories/projects.repository';
import { OrganizationsRepository } from '../organizations/repositories/organizations.repository';
import { MembershipsRepository } from '../memberships/repositories/memberships.repository';
import { toProjectDto } from './projects.mapper';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

/**
 * プロジェクト管理のアプリケーションサービス（§2 Repository 分離・§1 DTO 境界）。
 *
 * create: 組織の ADMIN membership 保有者のみ（ADR 0037 §3.2）。
 * update: プロジェクトの ADMIN membership 保有者のみ。
 * findAll: 自分が可視な組織配下のプロジェクト（可視＝org membership 原則）。
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly repo: ProjectsRepository,
    private readonly orgRepo: OrganizationsRepository,
    private readonly membershipRepo: MembershipsRepository,
  ) {}

  async create(dto: CreateProjectDto, userId: string) {
    // 組織の実在確認
    const org = await this.orgRepo.findById(dto.organizationId);
    if (!org) throw new NotFoundException('組織が見つかりません');

    // 組織 ADMIN 権限チェック
    const membership = await this.membershipRepo.findEffectiveMembership(
      userId,
      'ORGANIZATION',
      dto.organizationId,
    );
    if (!membership || membership.role !== 'ADMIN') {
      throw new ForbiddenException('この組織にプロジェクトを作成する権限がありません');
    }

    // 作成者 + adminAccountIds（dedup）で ADMIN 群を確定
    const adminAccountIds = [...new Set([userId, ...(dto.adminAccountIds ?? [])])];

    const project = await this.repo.createWithMemberships(
      { organizationId: dto.organizationId, name: dto.name },
      adminAccountIds,
    );
    // 作成者は当該プロジェクトの ADMIN（adminAccountIds に必ず含まれる）＝チャネル管理可。
    return ok(toProjectDto(project, adminAccountIds.includes(userId)));
  }

  async findAll(userId: string, organizationId?: string) {
    // 可視組織 ID を取得してプロジェクト一覧を解決
    const visibleOrgs = await this.orgRepo.findVisibleForUser(userId);
    const visibleOrgIds = visibleOrgs.map((o) => o.id);

    const projects = await this.repo.findVisibleForUser(visibleOrgIds, organizationId, userId);

    // 閲覧者が ADMIN を持つ PROJECT scopeId を一括取得し、各プロジェクトへ canManageChannels を畳む（N+1 回避）。
    const adminScopes = await this.membershipRepo.findEffectiveAdminScopeIds(userId, 'PROJECT');
    const adminProjectIds = new Set(adminScopes.map((s) => s.scopeId));

    return ok(projects.map((p) => toProjectDto(p, adminProjectIds.has(p.id))));
  }

  async update(id: string, dto: UpdateProjectDto, userId: string) {
    const project = await this.repo.findById(id);
    if (!project) throw new NotFoundException('プロジェクトが見つかりません');

    const membership = await this.membershipRepo.findEffectiveMembership(userId, 'PROJECT', id);
    if (!membership || membership.role !== 'ADMIN') {
      throw new ForbiddenException('このプロジェクトを編集する権限がありません');
    }

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.archived !== undefined) Object.assign(data, buildArchiveUpdate(dto.archived));

    // archive/restore は system ADMIN 経路と同じ transaction 内 cascade を通す（配下 CHANNEL を同時に更新）。
    // name-only update は従来どおり単純 update のまま（配下 CHANNEL の archive 状態に触れない）。
    const updated =
      dto.archived === undefined
        ? await this.repo.update(id, data)
        : await this.repo.adminUpdateWithCascade(id, data, dto.archived);
    // update に到達するのは PROJECT ADMIN のみ（上で forbidden ガード済）＝チャネル管理可。
    return ok(toProjectDto(updated, true));
  }

  /**
   * 全プロジェクト一覧（membership 非依存・テナント管理 ADMIN 向け）。
   * system Role=ADMIN gating は呼び出し元コントローラの @Roles(Role.ADMIN) が担う。
   * organizationId で組織絞り込み可（省略時は全 project）。includeArchived=true で archived 含む全件。
   */
  async findAllAdmin(organizationId?: string, includeArchived?: boolean) {
    const projects = await this.repo.findAllAdmin(includeArchived, organizationId);
    // テナント管理 ADMIN は全 project を管理可（canManageChannels=true 固定）
    return ok(projects.map((p) => toProjectDto(p, true)));
  }

  /**
   * プロジェクト作成（system ADMIN 専用・membership 非依存・set-0162 admin 経路）。
   * 現行 create は ORGANIZATION ADMIN membership 必須で system ADMIN 免除がないため、
   * membership を持たない組織にも PJ を追加できる専用経路として新設する。
   * 作成者（=system ADMIN）は membership を共創しない（admin 経路は membership 非依存で
   * 全操作できるため。PJ ADMIN 不在でも管理が詰まらない）。
   */
  async createAdmin(dto: CreateProjectDto) {
    const org = await this.orgRepo.findById(dto.organizationId);
    if (!org) throw new NotFoundException('組織が見つかりません');

    const adminAccountIds = dto.adminAccountIds ?? [];
    const project = await this.repo.createWithMemberships(
      { organizationId: dto.organizationId, name: dto.name },
      adminAccountIds,
    );
    return ok(toProjectDto(project, true));
  }

  /**
   * プロジェクトを管理 ADMIN として部分更新する（改名 / archive トグル + 連鎖 cascade）。
   * - 対象プロジェクト不在 → NotFoundException
   * - membership チェックなし（system Role=ADMIN gate はコントローラ層が担う）
   * - archive 時は配下 CHANNEL Space を同一 tx で連鎖 archive する
   * - 復元（archived=false）時は配下も連鎖復元する（MVP 単純版）
   */
  async adminUpdate(id: string, dto: UpdateProjectDto) {
    const project = await this.repo.findById(id);
    if (!project) throw new NotFoundException('プロジェクトが見つかりません');

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.archived !== undefined) Object.assign(data, buildArchiveUpdate(dto.archived));

    const updated = await this.repo.adminUpdateWithCascade(id, data, dto.archived);
    // テナント管理 ADMIN は全 project を管理可（canManageChannels=true 固定）
    return ok(toProjectDto(updated, true));
  }

  /**
   * プロジェクトの物理削除（system ADMIN 専用・set-0162）。
   * 配下 CHANNEL（archived 含む全物理行）があれば 409 で拒否（アーカイブを促す）。
   * 削除時は孤児 membership（scopeType=PROJECT）を同一 tx で掃除する。
   */
  async adminDelete(id: string) {
    const project = await this.repo.findById(id);
    if (!project) throw new NotFoundException('プロジェクトが見つかりません');

    const deleted = await this.repo.deleteIfNoChannels(id);
    if (!deleted) {
      throw new ConflictException(
        '配下のチャネルが存在するため削除できません。アーカイブしてください',
      );
    }
    return ok({ id });
  }
}
