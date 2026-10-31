'use client';

/**
 * テナント設定画面（設定タブ ST-1）。
 * モック settings/tenant-settings/index.html の <main class="sp-page"> を移植。
 *
 * データは backend `api/v1/settings/tenant*` に接続（ST-1 backend で配線）。
 * マウント時に GET でテナント情報を取得し、更新内容を API へ反映する。
 */

import { useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { Role } from '@rete/shared';
import { useSession } from '@/features/auth';
import { FormActions, FormButton, FormCard, PageTitle } from './primitives';
import toast from 'react-hot-toast';
import { useMountedFetch } from '@/hooks/use-mounted-fetch';
import { useDiscardConfirm } from '@/hooks/use-discard-confirm';
import { useEscapeConsume } from '@/hooks/use-escape-consume';
import { DiscardConfirmDialog } from '@/components/ui/discard-confirm-dialog';
import {
  BADGE_PALETTE,
  type TenantBadgeColor,
  type TenantInfo,
} from '../lib/sample/tenant-settings';
import { useTenantInfoContext } from '@/features/shell/hooks/tenant-info-context';
import { fetchTenantInfo, updateTenantInfo } from '../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// ローカル型
// ─────────────────────────────────────────────────────────────────────────────

/** カラーピッカーの選択肢定義。 */
const COLOR_OPTIONS: { value: TenantBadgeColor; label: string }[] = [
  { value: 'green', label: '緑' },
  { value: 'red', label: '赤' },
  { value: 'blue', label: '青' },
  { value: 'none', label: 'なし' },
];

// ─────────────────────────────────────────────────────────────────────────────
// ColorSwatch（カラーピッカーの swatch dot）
// ─────────────────────────────────────────────────────────────────────────────

function ColorSwatch({ color }: { color: TenantBadgeColor }) {
  if (color === 'none') {
    return (
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          border: '1px solid var(--sp-line-warm)',
          flexShrink: 0,
          background:
            'repeating-linear-gradient(45deg, var(--sp-paper), var(--sp-paper) 4px, var(--sp-card) 4px, var(--sp-card) 8px)',
        }}
      />
    );
  }
  const p = BADGE_PALETTE[color];
  return (
    <span
      aria-hidden="true"
      style={{
        width: 14,
        height: 14,
        borderRadius: 3,
        border: `1px solid ${p.border}`,
        background: p.bg,
        flexShrink: 0,
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TenantSettingsScreen（エントリーポイント）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * テナント設定画面（ST-1）。
 *
 * テナント情報: テナント名入力 + バッジ色ラジオピッカー。更新は API 反映（set-0105）。
 * システム一覧は set-0167 で撤去（個別 ON/OFF は不要・システム追加はタブ定義に任せる）。
 */
export function TenantSettingsScreen() {
  const { user, loading: sessionLoading } = useSession();
  const isAdmin = user?.role === Role.ADMIN;
  const discard = useDiscardConfirm();

  // set-0105: ヘッダ左端テナントバッジへ同一タブ即時反映
  const { setTenantInfo } = useTenantInfoContext();

  // ── テナント情報 state ──
  const [tenantName, setTenantName] = useState('');
  const [badgeColor, setBadgeColor] = useState<TenantBadgeColor>('none');

  // 保存済みテナント情報のスナップショット（キャンセル時の戻し先）。ロード時と更新成功時に更新する。
  const savedInfo = useRef<TenantInfo>({ name: '', badgeColor: 'none' });

  // ── 初回ロード（テナント情報）── set-0057: 非 ADMIN はフェッチしない
  useMountedFetch(
    async (alive) => {
      if (!isAdmin) return;
      try {
        const info = await fetchTenantInfo();
        if (!alive()) return;
        savedInfo.current = { name: info.name, badgeColor: info.badgeColor };
        setTenantName(info.name);
        setBadgeColor(info.badgeColor);
      } catch {
        if (alive()) toast.error('設定の読み込みに失敗しました');
      }
    },
    [isAdmin],
  );

  // ── テナント情報「更新」（API 反映 + ヘッダバッジ即時反映 set-0105）──
  async function handleSaveTenantInfo() {
    try {
      const updated = await updateTenantInfo({ name: tenantName, badgeColor });
      savedInfo.current = { name: updated.name, badgeColor: updated.badgeColor };
      setTenantName(updated.name);
      setBadgeColor(updated.badgeColor);
      setTenantInfo(updated);
      toast.success('テナント情報を更新しました');
    } catch {
      toast.error('テナント情報の更新に失敗しました');
    }
  }

  // ── テナント情報「キャンセル」（v2-171: 編集を保存済みの値へ戻す。API は呼ばない）──
  function handleCancelTenantInfo() {
    discard.request(
      tenantName !== savedInfo.current.name || badgeColor !== savedInfo.current.badgeColor,
      () => {
        setTenantName(savedInfo.current.name);
        setBadgeColor(savedInfo.current.badgeColor);
        toast.success('変更をキャンセルしました');
      },
    );
  }

  // Esc は「キャンセル」と同じ経路にする（UI 共通仕様 escape-key 規約①②。破棄確認の表示中は
  // AlertDialog 側が Esc を消費するため何もしない）。ADMIN 以外はボタンもダイアログも出さない。
  useEscapeConsume(handleCancelTenantInfo, {
    enabled: isAdmin && !sessionLoading,
    guardSelector: '[role="alertdialog"]',
  });

  // ── テナント名プレビュー（選択中の色で見せる） ──
  const previewPalette = BADGE_PALETTE[badgeColor];
  const previewStyle: React.CSSProperties =
    badgeColor !== 'none'
      ? {
          background: previewPalette.bg,
          color: previewPalette.fg,
          border: `1px solid ${previewPalette.border}`,
          padding: '1px 8px',
          borderRadius: 4,
          fontSize: '0.75rem',
          fontWeight: 600,
        }
      : {
          color: 'var(--sp-text-warm)',
          fontSize: '0.75rem',
          fontWeight: 600,
        };

  // ── 権限ガード（set-0057: organizations-screen と同型・タイトルのみ表示） ──
  if (sessionLoading) return null;
  if (!isAdmin) {
    return (
      <main className="sp-page" style={{ overflowY: 'auto' }}>
        <PageTitle title="テナント設定" />
      </main>
    );
  }

  return (
    <main className="sp-page" style={{ overflowY: 'auto' }}>
      <PageTitle title="テナント設定" />

      <DiscardConfirmDialog
        open={discard.open}
        onConfirm={discard.onConfirm}
        onCancel={discard.onCancel}
      />
      {/* v2-180: 全幅(1153px)で間延びしていたフォームを内容に合う幅へ絞り左寄せにする（表のある画面と同じ 680px）。 */}
      <div style={{ maxWidth: 680 }}>
        {/* ============ §2 テナント情報（名称 + バッジ色） ============ */}
        <FormCard title="テナント情報" icon={<Info className="h-4 w-4" aria-hidden="true" />}>
          {/* テナント名入力 */}
          <div style={{ marginBottom: '1rem' }}>
            <label
              htmlFor="tenant-name"
              className="text-xs font-semibold text-[var(--sp-text-warm-mute)]"
              style={{ display: 'block', marginBottom: '0.375rem' }}
            >
              テナント名
            </label>
            <input
              id="tenant-name"
              type="text"
              className="sp-input"
              placeholder="例: 本番 / STG / 開発法人 ..."
              maxLength={20}
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              style={{
                /* set-0113: 単行入力の標準 maxWidth 20rem */
                width: '100%',
                maxWidth: '20rem',
              }}
            />
          </div>

          {/* 表示色ラジオピッカー */}
          <div style={{ marginBottom: '0.5rem' }}>
            <div
              className="text-xs font-semibold text-[var(--sp-text-warm-mute)]"
              style={{ marginBottom: '0.375rem' }}
            >
              表示色
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {COLOR_OPTIONS.map((opt) => {
                const selected = badgeColor === opt.value;
                return (
                  <label
                    key={opt.value}
                    className="text-[0.8125rem] text-[var(--sp-text-warm)]"
                    style={{
                      position: 'relative',
                      cursor: 'pointer',
                      userSelect: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.375rem',
                      padding: '0.375rem 0.75rem',
                      border: `1px solid ${selected ? 'var(--sp-accent-ink)' : 'var(--sp-line-warm)'}`,
                      borderRadius: '0.375rem',
                      background: selected ? 'var(--sp-accent-soft)' : 'var(--sp-card)',
                      transition: 'border-color 0.15s, background-color 0.15s',
                      fontWeight: selected ? 600 : 400,
                    }}
                  >
                    <input
                      type="radio"
                      name="tenant-color"
                      value={opt.value}
                      checked={selected}
                      onChange={() => setBadgeColor(opt.value)}
                      style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                    />
                    <ColorSwatch color={opt.value} />
                    {opt.label}
                  </label>
                );
              })}
            </div>
          </div>

          {/* テナント名プレビュー（選択中の色で確認） */}
          {tenantName && (
            <div
              className="text-xs text-[var(--sp-text-warm-mute)]"
              style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            >
              <span>プレビュー:</span>
              <span style={previewStyle}>{tenantName}</span>
            </div>
          )}

          <FormActions>
            <FormButton variant="ghost" onClick={handleCancelTenantInfo}>
              キャンセル
            </FormButton>
            <FormButton variant="primary" onClick={handleSaveTenantInfo}>
              保存
            </FormButton>
          </FormActions>
        </FormCard>
      </div>
    </main>
  );
}
