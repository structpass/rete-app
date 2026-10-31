import {
  IsBoolean,
  ValidateIf,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MembershipScopeType, type HomeGroupPermissionKey } from '@rete/shared';

/**
 * ユーザーグループ作成 DTO（POST /user-groups・システム ADMIN のみ）。
 * Home の設定値は入力の検査（真偽値）のために名前を並べる。
 */
class HomeGroupPermissionsDto {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  canEditHomeBoard?: boolean;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  canEditHomeCalendar?: boolean;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  canEditHomeFaq?: boolean;
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  canManageHomeTags?: boolean;
}

/**
 * 設定値の名前が 1 つでも欠けたら型エラーにする（d874）。正本（HOME_PERMISSIONS）に許可を足した
 * 時に、入力の検査（この DTO）の書き足し忘れを黙って通さない。
 */
type MissingInDto = Exclude<HomeGroupPermissionKey, keyof HomeGroupPermissionsDto>;
export const dtoHasAllHomeGroupFlags: Record<MissingInDto, never> = {};

export class CreateUserGroupDto extends HomeGroupPermissionsDto {
  @ApiProperty({ description: 'グループ名（表示名）' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;
}

/** ユーザーグループ更新 DTO（PATCH /user-groups/:id・システム ADMIN のみ）。 */
export class UpdateUserGroupDto extends HomeGroupPermissionsDto {
  @ApiProperty({ description: 'グループ名（表示名）', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
}

/** グループメンバー追加 DTO（POST /user-groups/:id/members・システム ADMIN のみ）。 */
export class AddUserGroupMemberDto {
  @ApiProperty({ description: '追加するアカウント ID (UUID)' })
  @IsUUID()
  accountId: string;
}

/** グループ grant 付与 DTO（POST /user-groups/:id/grants・システム ADMIN のみ）。 */
export class AddUserGroupScopeGrantDto {
  @ApiProperty({
    enum: ['ORGANIZATION', 'PROJECT', 'CHANNEL'],
    description: 'grant スコープ種別（ORGANIZATION / PROJECT / CHANNEL）',
  })
  @IsIn(['ORGANIZATION', 'PROJECT', 'CHANNEL'])
  scopeType: MembershipScopeType;

  @ApiProperty({
    description:
      'スコープ対象 ID（Organization.id / Project.id / Channel Space.id・archived 不可）',
  })
  @IsUUID()
  scopeId: string;

  @ApiProperty({
    enum: ['ADMIN', 'MEMBER'],
    description: 'スコープ内ロール（グループメンバーへ与える実効ロール）',
  })
  @IsIn(['ADMIN', 'MEMBER'])
  role: 'ADMIN' | 'MEMBER';
}
