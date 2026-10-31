'use client';
import { ActionButton, TableCard } from '@/features/settings/components/primitives';
import { TableStatusRows } from '@/features/settings/components/table-status-rows';
import type { SpaceDto } from '@rete/shared';
import { Archive, ArchiveRestore, Hash, Pencil, Trash2 } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// チャネルペイン（右）
// ─────────────────────────────────────────────────────────────────────────────

export function ChannelPane({
  channels,
  updating,
  isLoading,
  searching,
  includeArchived,
  error,
  onRetry,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}: {
  channels: SpaceDto[];
  updating: boolean;
  isLoading: boolean;
  searching: boolean;
  includeArchived: boolean;
  /** 一覧取得の失敗文言。渡すと 0 件行の代わりに領域内 role="alert" を出す（v2-410）。 */
  error?: string | null;
  /** 取得失敗の表示から取り直す（d659）。 */
  onRetry?: () => void;
  onRename: (channel: SpaceDto) => void;
  onArchive: (channel: SpaceDto) => void;
  onRestore: (channel: SpaceDto) => void;
  onDelete: (channel: SpaceDto) => void;
}) {
  return (
    <TableCard hoverBand borderless>
      <table className="sp-table sp-table--hoverband sp-table--framed">
        <thead>
          <tr>
            <th>チャネル名</th>
            <th style={{ width: 96, textAlign: 'center' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {/* 取得中も既に持っている行を描き続ける（読み直しのたびに一覧が空へ戻らない）。
              読み込み中・失敗・0 件の行は TableStatusRows が受け持つ。 */}
          {channels.map((ch) => (
            <tr key={ch.id}>
              <td>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.375rem',
                    color: ch.archived ? 'var(--sp-text-warm-mute)' : 'var(--sp-text-warm)',
                  }}
                >
                  <Hash
                    className="h-3.5 w-3.5 text-[var(--sp-text-warm-mute)]"
                    aria-hidden="true"
                  />
                  {ch.name}
                </span>
              </td>
              <td style={{ textAlign: 'center' }}>
                <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
                  {ch.archived ? (
                    <ActionButton
                      icon={<ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />}
                      onClick={() => onRestore(ch)}
                      disabled={updating}
                      ariaLabel={`${ch.name} を復元`}
                      iconOnly
                    >
                      復元
                    </ActionButton>
                  ) : (
                    <>
                      <ActionButton
                        icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() => onRename(ch)}
                        disabled={updating}
                        ariaLabel={`${ch.name} を改名`}
                        iconOnly
                      >
                        改名
                      </ActionButton>
                      <ActionButton
                        icon={<Archive className="h-3.5 w-3.5" aria-hidden="true" />}
                        onClick={() => onArchive(ch)}
                        disabled={updating}
                        ariaLabel={`${ch.name} をアーカイブ`}
                        iconOnly
                      >
                        アーカイブ
                      </ActionButton>
                    </>
                  )}
                  <ActionButton
                    icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                    onClick={() => onDelete(ch)}
                    disabled={updating}
                    ariaLabel={`${ch.name} を削除`}
                    iconOnly
                  >
                    削除
                  </ActionButton>
                </span>
              </td>
            </tr>
          ))}
          <TableStatusRows
            colSpan={2}
            isLoading={isLoading}
            empty={channels.length === 0}
            emptyLabel={searching ? 'チャネルが見つかりませんでした' : 'チャネルがありません'}
            emptyDescription={
              searching && !includeArchived ? 'アーカイブ済みは表示していません' : undefined
            }
            // 取得失敗は「見つかりませんでした」（0 件の文言）へ落とさない（空一覧と区別する表示）。
            errorLabel={error ? 'チャネルの取得に失敗しました' : null}
            onRetry={onRetry}
          />
        </tbody>
      </table>
    </TableCard>
  );
}
