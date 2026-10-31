'use client';

import type { ReactNode } from 'react';
import type { HomeGroupPermissions } from '@rete/shared';
import { UserCog } from 'lucide-react';
import { FormCard, FormLabel } from './primitives';

const HOME_PERMISSION_LABELS = {
  canEditHomeBoard: '掲示板',
  canEditHomeCalendar: 'カレンダー',
  canEditHomeFaq: 'FAQ',
  canManageHomeTags: 'タグ管理',
} satisfies Record<keyof HomeGroupPermissions, string>;

/**
 * 管理グループのフォーム外枠（set-0188）。
 * 作成サブ画面と編集サブ画面で共有する。枠・説明文・グループ名入力・「所属ユーザー」見出しまでを持ち、
 * 所属ユーザーの編集部品と確定ボタンは children で受ける（作成は作成時に一括反映、編集は操作ごとに
 * 即時反映と、確定の意味が画面ごとに違うため）。
 */
export function GroupFormCard({
  name,
  onNameChange,
  nameDisabled,
  permissions,
  onPermissionsChange,
  children,
}: {
  name: string;
  onNameChange: (value: string) => void;
  /** グループ名入力を編集不可にする（保存中など）。 */
  nameDisabled: boolean;
  permissions: HomeGroupPermissions;
  onPermissionsChange: (value: HomeGroupPermissions) => void;
  children: ReactNode;
}) {
  return (
    <FormCard
      icon={<UserCog className="h-4 w-4" aria-hidden="true" />}
      title="グループ"
      description="組織・プロジェクト・チャネルへの参加先は所属管理で設定します。"
    >
      <div style={{ marginBottom: '0.875rem' }}>
        {/* グループ名はサーバが空を拒否する（CreateUserGroupDto.name = MinLength(1)）ため
            正本 comp-form-field に従い「* 必須」を出す。 */}
        <FormLabel htmlFor="group-name" required>
          グループ名
        </FormLabel>
        <input
          id="group-name"
          type="text"
          className="sp-input"
          aria-required="true"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={80}
          disabled={nameDisabled}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
      </div>

      <fieldset disabled={nameDisabled} className="mb-4">
        <legend className="mb-2 text-sm font-medium text-[var(--sp-text-warm)]">
          Homeの編集権限
        </legend>
        <div className="flex flex-wrap gap-4">
          {(Object.entries(HOME_PERMISSION_LABELS) as [keyof HomeGroupPermissions, string][]).map(
            ([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={permissions[key]}
                  onChange={(event) =>
                    onPermissionsChange({ ...permissions, [key]: event.target.checked })
                  }
                  style={{ accentColor: 'var(--sp-accent-ink)' }}
                />
                {label}
              </label>
            ),
          )}
        </div>
      </fieldset>

      <h4 className="mb-2 text-sm font-medium text-[var(--sp-text-warm)]">所属ユーザー</h4>
      {children}
    </FormCard>
  );
}
