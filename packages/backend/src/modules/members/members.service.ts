import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withUniqueConflictMessage } from '../../common/filters/unique-conflict-context';
import { Role } from '@rete/shared';
import { ok } from '../../common/dto';
import { composeDisplayName } from '../../common/display-name';
import { MembersRepository, UpdateMemberData } from './repositories/members.repository';
import { toMemberDto } from './members.mapper';
import { buildMembersCsv } from './members.csv';
import { UpdateMemberDto } from './dto/update-member.dto';
import { AuditRecorderService, type AuditClientInfo } from '../audit-logs/audit-recorder.service';
import { AUDIT_RETE_SYSTEM_NAME } from '../audit-logs/audit-logs.constants';
import { MfaService } from '../mfa/mfa.service';
import type { AuthenticatedUser } from '../auth/auth.service';

/**
 * メンバー管理（Settings ST-4）のアプリケーションサービス。検証 + オーケストレーションのみを担い、
 * DB アクセスは MembersRepository 経由（§2）、Entity→DTO 変換は mapper（§1）。
 *
 * メンバー実体は既存 Account を流用（新モデルは作らない）。「ロック/解除」は Account.isActive を反転し、
 * 自分自身のロックは弾く（自己ロックアウト防止）。
 *
 * cmn-0047: システムロール（Account.role=ADMIN/MEMBER）の昇格/降格を setSystemRole で担う。
 * 降格は「最後のシステム管理者」「自分自身」を弾く全消失ガード付き。操作は監査ログ（actionType=admin）へ残す。
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly repo: MembersRepository,
    private readonly audit: AuditRecorderService,
    private readonly mfa: MfaService,
  ) {}

  /** 全メンバー（作成順）を返す。 */
  async findAll() {
    const members = await this.repo.findAll();
    return ok(members.map(toMemberDto));
  }

  /**
   * メンバー一覧を CSV（UTF-8 BOM 付き）でエクスポートする。CSV は表示用スナップショット。
   * 出力（持ち出し）の記録は横断 interceptor が担当する（audit-log.interceptor の GET_EXPORT_PATHS・d534）。
   * ここで記録を足すと二重になる。
   */
  async exportCsv(): Promise<string> {
    const members = await this.repo.findAll();
    return buildMembersCsv(members.map(toMemberDto));
  }

  /** メンバー 1 件（行編集オーバーレイのロード用）。 */
  async findOne(id: string) {
    const member = await this.repo.findById(id);
    if (!member) {
      throw new NotFoundException('メンバーが見つかりません');
    }
    return ok(toMemberDto(member));
  }

  /**
   * メンバーを部分更新する（ロック/解除・email 変更）。
   * - 全項目未指定は BadRequest（存在確認もしない）。
   * - 自分自身のロック（isActive=false かつ id===currentUserId）は BadRequest（自己ロックアウト防止）。
   * - email は trim+小文字正規化 → 既存値と同じなら据え置き → 他 Account が同じ email を持つなら
   *   ConflictException。変更時は actor 付きで audit_logs に記録（変更前/変更後の値を含む）。
   *   session.serializer / OIDC は sub=Account.id のため退行なし（session.serializer.ts:16, oidc-config.factory.ts:102）。
   */
  async update(
    id: string,
    dto: UpdateMemberDto,
    actor: AuthenticatedUser,
    client: AuditClientInfo = {},
  ) {
    const hasNamePart = dto.familyName !== undefined || dto.givenName !== undefined;
    if (dto.isActive === undefined && !hasNamePart && dto.email === undefined) {
      throw new BadRequestException(
        '更新する項目（familyName / givenName / isActive / email）がありません',
      );
    }

    const member = await this.repo.findById(id);
    if (!member) {
      throw new NotFoundException('更新対象のメンバーが見つかりません');
    }

    // 自己ロックアウト防止: 自分自身を無効化（ロック）すると以後ログインできなくなるため弾く。
    if (dto.isActive === false && id === actor.id) {
      throw new BadRequestException('自分自身のアカウントはロックできません');
    }

    // 姓・名: 片方だけ指定でももう片方は既存値を使い name を再組み立て（set-0096）。
    let nameFields: Pick<UpdateMemberData, 'name' | 'familyName' | 'givenName'> | undefined;
    if (hasNamePart) {
      const familyName = (dto.familyName !== undefined ? dto.familyName : member.familyName).trim();
      const givenName = (dto.givenName !== undefined ? dto.givenName : member.givenName).trim();
      if (!familyName) {
        throw new BadRequestException('姓は必須です');
      }
      nameFields = {
        familyName,
        givenName,
        name: composeDisplayName(familyName, givenName),
      };
    }

    // email: trim + 小文字正規化 → 既存値と同じなら据え置き（差分なし）→ 別 Account が同じ email を
    // 持っていれば ConflictException。session.serializer / OIDC は sub=Account.id のため退行なし。
    // null は DTO ValidationPipe を通過してしまう（@IsOptional は null を通す）ためここで明示拒否。
    let emailChanged: { before: string; after: string } | undefined;
    if (dto.email !== undefined) {
      if (dto.email === null || typeof dto.email !== 'string') {
        throw new BadRequestException('メールアドレスは必須です');
      }
      const normalizedEmail = dto.email.trim().toLowerCase();
      if (normalizedEmail === '') {
        throw new BadRequestException('メールアドレスは必須です');
      }
      if (normalizedEmail !== member.email) {
        const existing = await this.repo.findOtherAccountByEmail(id, normalizedEmail);
        if (existing) {
          throw new ConflictException(`メールアドレス「${normalizedEmail}」は既に使用されています`);
        }
        emailChanged = { before: member.email, after: normalizedEmail };
      }
    }

    const data: UpdateMemberData = {
      ...nameFields,
      isActive: dto.isActive,
      // emailChanged がある時だけ email を repo.update へ渡す（既存値と同じ値の時は渡さない＝無駄打ちを排除）。
      ...(emailChanged ? { email: emailChanged.after } : {}),
    };
    // 並行更新の一意制約違反も、案内文を保って共通filterへ委譲する。
    const updated = emailChanged
      ? await withUniqueConflictMessage(
          () => this.repo.update(id, data),
          `メールアドレス「${emailChanged.after}」は既に使用されています`,
        )
      : await this.repo.update(id, data);

    // email 変更時のみ監査ログ（管理者操作のトレーサビリティ）。
    // actionType='admin' / feature='members' / details に変更前/変更後を保存。actor は controller から
    // @CurrentUser() 経由で受け取ったセッション全体（name/email 込み）を使い、空 actor を残さない。
    if (emailChanged) {
      await this.audit.record({
        actorAccountId: actor.id,
        actorName: actor.name,
        actorEmail: actor.email,
        systemName: AUDIT_RETE_SYSTEM_NAME,
        actionType: 'admin',
        feature: 'members',
        summary: `メールアドレスを変更（対象 ${id}：${emailChanged.before} → ${emailChanged.after}）`,
        // アクセス元（IP・UA）も同じ 1 行へ載せ、横断 interceptor 行と時刻で突き合わせなくても
        // 「誰が・いつ・どこから」まで読めるようにする（rete-members-0001）。
        ipAddress: client.ipAddress,
        userAgent: client.userAgent,
        details: {
          targetId: id,
          before: emailChanged.before,
          after: emailChanged.after,
        },
      });
    }

    return ok(toMemberDto(updated));
  }

  /**
   * 対象メンバーのログイン試行ロックアウト（set-0025 P4 / lockedUntil）を即時手動解除する（set-0030）。
   * 自動 15 分解除を待たず ADMIN が解除でき、解除後は対象アカウントが即座にログイン試行可能になる。
   * - 対象不在 → NotFoundException
   * - clearLockout は failedLoginAttempts/lockedUntil を AuthService の自動リセットと同一形へ戻す（機構を二重化しない）。
   * - 操作は監査ログ（actionType=admin）へ残す（管理者操作のトレーサビリティ）。
   * コントローラの @Roles(Role.ADMIN) で ADMIN 限定済み（actor は必ずシステム管理者）。
   */
  async unlockLockout(id: string, actor: AuthenticatedUser, client: AuditClientInfo = {}) {
    const member = await this.repo.findById(id);
    if (!member) {
      throw new NotFoundException('対象のメンバーが見つかりません');
    }

    // 実際にロック中（lockedUntil が未来）の時のみ解除＋監査を残す。未ロック対象への unlock は
    // 冪等 no-op で返す（書込も監査ログも残さない）＝監査汚染防止（set-0038・resetMfa と同型の no-op ガード）。
    const now = new Date();
    if (!member.lockedUntil || member.lockedUntil <= now) {
      return ok(toMemberDto(member));
    }

    const updated = await this.repo.clearLockout(id);

    await this.audit.record({
      actorAccountId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'admin',
      feature: 'members',
      summary: `ログイン試行ロックアウトを手動解除（対象 ${id}）`,
      // アクセス元（IP・UA）を同じ行へ（rete-members-0001）。
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: { targetId: id },
    });

    return ok(toMemberDto(updated));
  }

  /**
   * 対象メンバーの二段階認証（MFA/TOTP・ST-2-2）を管理者権限で強制リセットする（set-0033・P6）。
   * TOTP・バックアップコードを全喪失した利用者を DB 直編集せず復旧する。リセット後、強制 MFA が有効なら
   * 対象は次回ログインで再設定を求められる（set-0032 の未設定者強制 redirect に乗る）。
   * - 対象不在 → NotFoundException
   * - 対象が MFA 未設定（リセット対象なし）→ 監査を残さず冪等に現状を返す（no-op・監査汚染防止）。
   * - 実リセット時のみ監査ログ（actionType=admin / feature=members / actor 込み）へ残す。
   * コントローラの @Roles(Role.ADMIN) で ADMIN 限定済み（actor は必ずシステム管理者）。MFA データ削除は MfaService に委譲（モジュール境界）。
   */
  async resetMfa(id: string, actor: AuthenticatedUser, client: AuditClientInfo = {}) {
    // 自己 MFA リセットの禁止（setSystemRole 自己降格 / update 自己ロックと同型の自己破壊ガード）。
    // 管理者リセットは本人コード確認を経ずに削除するため、自分自身に使うと self-service disable
    // （TOTP/バックアップコードによる本人確認）を迂回できる。自分の MFA は設定画面から無効化させる。
    if (id === actor.id) {
      throw new BadRequestException(
        '自分自身の二段階認証は設定画面（セルフサービス）から無効化してください',
      );
    }

    const member = await this.repo.findById(id);
    if (!member) {
      throw new NotFoundException('対象のメンバーが見つかりません');
    }

    const didReset = await this.mfa.adminResetMfa(id);
    if (!didReset) {
      // 対象は MFA 未設定（削除対象なし）。監査を汚さず冪等に現状を返す（set-0030 の no-op 監査汚染の教訓）。
      return ok(toMemberDto(member));
    }

    await this.audit.record({
      actorAccountId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'admin',
      feature: 'members',
      summary: `二段階認証（MFA）を管理者リセット（対象 ${id}）`,
      // アクセス元（IP・UA）を同じ行へ（rete-members-0001）。
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: { targetId: id },
    });

    // リセット後の最新状態（mfaEnabled=false）を返す。再取得失敗時は元データで縮退（リセット自体は成功済）。
    const updated = await this.repo.findById(id);
    return ok(toMemberDto(updated ?? member));
  }

  /**
   * 対象メンバーのシステムロール（Account.role）を ADMIN⇆MEMBER に変更する（cmn-0047・対称の昇格/降格）。
   * 呼び出しはコントローラの @Roles(Role.ADMIN) でシステム ADMIN に限定済み（actor は必ずシステム管理者）。
   *  - 対象不在 → NotFoundException
   *  - 既に同ロール → 冪等に現状を返す（no-op）
   *  - 降格（→MEMBER）時の全消失ガード:
   *      - 自分自身の降格は不可（自己権限喪失防止・self-lockout と同型）
   *      - システム ADMIN が 1 人だけなら降格不可（管理者ゼロ防止）
   * 変更は監査ログ（actionType=admin）へ残す。
   */
  async setSystemRole(
    targetId: string,
    role: Role,
    actor: AuthenticatedUser,
    client: AuditClientInfo = {},
  ) {
    const target = await this.repo.findAccountRole(targetId);
    if (!target) {
      throw new NotFoundException('対象メンバーが見つかりません');
    }

    // 冪等: 既に目的のロールなら DB を触らず現状を返す（監査も残さない）。
    if (target.role === role) {
      return ok({ id: target.id, role: target.role });
    }

    let updated: { id: string; role: Role };
    if (role === Role.MEMBER) {
      // 自己降格の禁止（自分でシステム管理者権限を失うと復旧できなくなるため）。
      if (targetId === actor.id) {
        throw new BadRequestException('自分自身をシステム管理者から降格することはできません');
      }
      // 最後のシステム管理者の降格禁止（管理者ゼロ防止）。count→update を原子化し TOCTOU を防ぐ。
      const result = await this.repo.demoteSystemRoleAtomic(targetId);
      if (result.blocked) {
        throw new BadRequestException(
          '最後のシステム管理者は降格できません（管理者が最低 1 人必要です）',
        );
      }
      updated = result.row!;
    } else {
      // 昇格（MEMBER→ADMIN）はガード不要。
      updated = await this.repo.updateSystemRole(targetId, role);
    }

    const promoted = role === Role.ADMIN;
    await this.audit.record({
      actorAccountId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      systemName: AUDIT_RETE_SYSTEM_NAME,
      actionType: 'admin',
      feature: 'members',
      summary: `システム管理者${promoted ? 'へ昇格' : 'から降格'}（対象 ${targetId}）`,
      // アクセス元（IP・UA）を同じ行へ（rete-members-0001）。
      ipAddress: client.ipAddress,
      userAgent: client.userAgent,
      details: { targetId, from: target.role, to: role },
    });

    return ok({ id: updated.id, role: updated.role });
  }
}
