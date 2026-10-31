'use client';
import { ActionButton, TableCard } from '@/features/settings/components/primitives';
import { TableStatusRows } from '@/features/settings/components/table-status-rows';
import type { ProjectDto } from '@rete/shared';
import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// プロジェクトペイン（中央）
// ─────────────────────────────────────────────────────────────────────────────

export function ProjectPane({
  projects,
  selectedProjectId,
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
  projects: ProjectDto[];
  selectedProjectId: string | null;
  updating: boolean;
  isLoading: boolean;
  searching: boolean;
  includeArchived: boolean;
  /** 一覧取得の失敗文言。渡すと 0 件行の代わりに領域内 role="alert" を出す（v2-410）。 */
  error?: string | null;
  /** 取得失敗の表示から取り直す（d659）。 */
  onRetry?: () => void;
  onSelect: (project: ProjectDto) => void;
  onRename: (project: ProjectDto) => void;
  onArchive: (project: ProjectDto) => void;
  onRestore: (project: ProjectDto) => void;
  onDelete: (project: ProjectDto) => void;
}) {
  return (
    <TableCard hoverBand borderless>
      <table className="sp-table sp-table--hoverband sp-table--framed">
        <thead>
          <tr>
            <th>プロジェクト名</th>
            <th style={{ width: 96, textAlign: 'center' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {/* 取得中も既に持っている行を描き続ける（読み直しのたびに一覧が空へ戻らない）。
              読み込み中・失敗・0 件の行は TableStatusRows が受け持つ。 */}
          {projects.map((proj) => {
            const selected = proj.id === selectedProjectId;
            return (
              <tr
                key={proj.id}
                className={`sp-row-pillable${selected ? ' sp-row-ring' : ''}`}
                onClick={() => onSelect(proj)}
                data-selected={selected || undefined}
              >
                <td
                  style={{
                    color: proj.archived ? 'var(--sp-text-warm-mute)' : 'var(--sp-text-warm)',
                  }}
                >
                  {proj.name}
                </td>
                <td style={{ textAlign: 'center' }}>
                  <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
                    <ActionButton
                      icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRename(proj);
                      }}
                      disabled={updating}
                      ariaLabel={`${proj.name} を改名`}
                      iconOnly
                    >
                      改名
                    </ActionButton>
                    {proj.archived ? (
                      <ActionButton
                        icon={<ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRestore(proj);
                        }}
                        disabled={updating}
                        ariaLabel={`${proj.name} を復元`}
                        iconOnly
                      >
                        復元
                      </ActionButton>
                    ) : (
                      <ActionButton
                        icon={<Archive className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onArchive(proj);
                        }}
                        disabled={updating}
                        ariaLabel={`${proj.name} をアーカイブ`}
                        iconOnly
                      >
                        アーカイブ
                      </ActionButton>
                    )}
                    <ActionButton
                      icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(proj);
                      }}
                      disabled={updating}
                      ariaLabel={`${proj.name} を削除`}
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
            empty={projects.length === 0}
            emptyLabel={
              searching ? 'プロジェクトが見つかりませんでした' : 'プロジェクトがありません'
            }
            emptyDescription={
              searching && !includeArchived ? 'アーカイブ済みは表示していません' : undefined
            }
            // 取得失敗は「見つかりませんでした」（0 件の文言）へ落とさない（空一覧と区別する表示）。
            errorLabel={error ? 'プロジェクトの取得に失敗しました' : null}
            onRetry={onRetry}
          />
        </tbody>
      </table>
    </TableCard>
  );
}
