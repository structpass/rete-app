'use client';

import { useState } from 'react';
import { ActionButton, TableCard, RowDeleteButton } from './primitives';

/**
 * 管理グループの所属ユーザー編集部品（set-0188）。
 * 作成サブ画面（選択を貯めて作成時に一括反映）と編集サブ画面（操作ごとに即時反映）で共有する。
 * 表示名は accounts（メンバー一覧 API）から引き、members 側の accountName と二重に持たない。
 */
export function GroupMemberPicker({
  accounts,
  selectedAccountIds,
  disabled,
  onAdd,
  onRemove,
}: {
  accounts: { id: string; name: string }[];
  /** 現在の所属ユーザー（accountId の並び・表示順は指定順）。 */
  selectedAccountIds: string[];
  disabled: boolean;
  onAdd: (accountId: string) => void;
  onRemove: (accountId: string) => void;
}) {
  const [pickedAccountId, setPickedAccountId] = useState('');
  const nameOf = (accountId: string) => accounts.find((a) => a.id === accountId)?.name ?? accountId;
  const candidates = accounts.filter((a) => !selectedAccountIds.includes(a.id));

  return (
    <div>
      <div style={{ marginBottom: '0.5rem', display: 'flex', gap: '0.5rem' }}>
        <select
          className="min-w-0 flex-1 rounded border px-2 py-1 text-sm focus:outline-none focus:border-[var(--sp-focus-border)]"
          value={pickedAccountId}
          onChange={(e) => setPickedAccountId(e.target.value)}
          aria-label="追加するユーザー"
          disabled={disabled}
        >
          <option value="">— 追加するユーザーを選択 —</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <ActionButton
          onClick={() => {
            if (!pickedAccountId) return;
            onAdd(pickedAccountId);
            setPickedAccountId('');
          }}
          disabled={disabled || !pickedAccountId}
          ariaLabel="ユーザーを追加"
        >
          追加
        </ActionButton>
      </div>
      <TableCard>
        <table className="sp-table w-full text-sm">
          <thead>
            <tr>
              <th>ユーザー</th>
              <th style={{ width: 96, textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {selectedAccountIds.map((accountId) => (
              <tr key={accountId} className="sp-row-pillable">
                <td>{nameOf(accountId)}</td>
                <td style={{ textAlign: 'center' }}>
                  <RowDeleteButton
                    label={`${nameOf(accountId)} を所属ユーザーから除外`}
                    disabled={disabled}
                    onClick={() => onRemove(accountId)}
                  />
                </td>
              </tr>
            ))}
            {selectedAccountIds.length === 0 && (
              <tr>
                <td colSpan={2} className="text-[var(--sp-text-warm-mute)]">
                  所属ユーザーはいません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
