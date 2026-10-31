'use client';
import { ActionButton, TableCard } from '@/features/settings/components/primitives';
import { TableStatusRows } from '@/features/settings/components/table-status-rows';
import type { OrganizationDto } from '@rete/shared';
import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// 組織ペイン（左）
// ─────────────────────────────────────────────────────────────────────────────

export function OrgPane({
  orgs,
  selectedOrgId,
  updating,
  isLoading,
  searching,
  includeArchived,
  error,
  onRetry,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}: {
  orgs: OrganizationDto[];
  selectedOrgId: string | null;
  updating: boolean;
  isLoading: boolean;
  searching: boolean;
  /** アーカイブ済みを含めて表示中か（空状態の文言に補足を添えるため・set-0117 項目4）。 */
  includeArchived: boolean;
  /** 一覧取得の失敗文言。渡すと 0 件行の代わりに領域内 role="alert" を出す（v2-410）。 */
  error?: string | null;
  /** 取得失敗の表示から取り直す（d659）。 */
  onRetry?: () => void;
  onSelect: (org: OrganizationDto) => void;
  onRename: (org: OrganizationDto) => void;
  onArchive: (org: OrganizationDto) => void;
  onRestore: (org: OrganizationDto) => void;
  onDelete: (org: OrganizationDto) => void;
}) {
  return (
    <TableCard hoverBand borderless>
      <table className="sp-table sp-table--hoverband sp-table--framed">
        <thead>
          <tr>
            <th>組織名</th>
            <th style={{ width: 96, textAlign: 'center' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {orgs.map((org) => {
            const selected = org.id === selectedOrgId;
            return (
              <tr
                key={org.id}
                className={`sp-row-pillable${selected ? ' sp-row-ring' : ''}`}
                onClick={() => onSelect(org)}
                data-selected={selected || undefined}
              >
                <td>
                  <span
                    style={{
                      color: org.archived ? 'var(--sp-text-warm-mute)' : 'var(--sp-text-warm)',
                    }}
                  >
                    {org.name}
                  </span>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
                    <ActionButton
                      icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRename(org);
                      }}
                      disabled={updating}
                      ariaLabel={`${org.name} を改名`}
                      iconOnly
                    >
                      改名
                    </ActionButton>
                    {org.archived ? (
                      <ActionButton
                        icon={<ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRestore(org);
                        }}
                        disabled={updating}
                        ariaLabel={`${org.name} を復元`}
                        iconOnly
                      >
                        復元
                      </ActionButton>
                    ) : (
                      <ActionButton
                        icon={<Archive className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onArchive(org);
                        }}
                        disabled={updating}
                        ariaLabel={`${org.name} をアーカイブ`}
                        iconOnly
                      >
                        アーカイブ
                      </ActionButton>
                    )}
                    <ActionButton
                      icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(org);
                      }}
                      disabled={updating}
                      ariaLabel={`${org.name} を削除`}
                      iconOnly
                    >
                      削除
                    </ActionButton>
                  </span>
                </td>
              </tr>
            );
          })}
          <TableStatusRows
            colSpan={2}
            isLoading={isLoading}
            empty={orgs.length === 0}
            emptyLabel={searching ? '組織が見つかりませんでした' : '組織がありません'}
            emptyDescription={
              searching && !includeArchived ? 'アーカイブ済みは表示していません' : undefined
            }
            // 取得失敗は「見つかりませんでした」（0 件の文言）へ落とさない（空一覧と区別する表示）。
            errorLabel={error ? '組織の取得に失敗しました' : null}
            onRetry={onRetry}
          />
        </tbody>
      </table>
    </TableCard>
  );
}
