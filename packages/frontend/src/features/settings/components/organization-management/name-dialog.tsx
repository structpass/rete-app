'use client';
import { OverlayDialog } from '@/components/ui/overlay-dialog';
import {
  FormActions,
  FormButton,
  FormCard,
  FormLabel,
  OverlayCancelButton,
} from '@/features/settings/components/primitives';
import { Building2 } from 'lucide-react';
import { useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// ダイアログ共通（名前入力フォーム）
// ─────────────────────────────────────────────────────────────────────────────

export function NameDialog({
  title,
  description,
  initialName,
  saving,
  onSave,
  onCancel,
}: {
  title: string;
  description?: string;
  initialName?: string;
  saving: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName ?? '');
  // 初期値からの変更がある間だけ Esc / 背景 / キャンセルに破棄確認を挟む（mdl-0034 規約②）。
  const dirty = name !== (initialName ?? '');
  return (
    <OverlayDialog open onClose={onCancel} ariaLabel={title} dirty={dirty}>
      <FormCard
        icon={<Building2 className="h-4 w-4" aria-hidden="true" />}
        title={title}
        description={description}
      >
        <div style={{ marginBottom: '0.875rem' }}>
          {/* 名前は空を拒否して保存できない（disabled={!name.trim()}）＝正本 comp-form-field の必須バッジを出す。 */}
          <FormLabel htmlFor="entity-name" required>
            名前
          </FormLabel>
          <input
            id="entity-name"
            type="text"
            className="sp-input"
            aria-required="true"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) onSave(name.trim());
            }}
          />
        </div>
        <FormActions>
          <OverlayCancelButton disabled={saving} />
          <FormButton
            variant="primary"
            onClick={() => onSave(name.trim())}
            loading={saving}
            disabled={!name.trim()}
          >
            {/* 既存名の変更=「保存」/ 新規作成=「追加」（initialName の有無で判別） */}
            {initialName != null ? '保存' : '追加'}
          </FormButton>
        </FormActions>
      </FormCard>
    </OverlayDialog>
  );
}
