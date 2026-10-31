'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Download, Info, Layers } from 'lucide-react';
import toast from 'react-hot-toast';
import type { AuditActionType, AuditLogDto, PaginationMeta } from '@rete/shared';
import { AUDIT_EXPORT_MAX_DAYS, AUDIT_PAGE_SIZE, AUDIT_SYSTEM_COMMON, Role } from '@rete/shared';
import { useSession } from '@/features/auth';
import {
  ActionButton,
  FormActions,
  FormButton,
  FormCard,
  FormLabel,
  ListActionRow,
  PageTitle,
  Pagination,
  StatusBadge,
  TableCard,
} from './primitives';
import {
  FilterBar,
  FilterChipSelect,
  FilterClear,
  FilterSearchInput,
} from '@/components/shared/filter-bar';
import { FilterDateRange } from '@/components/shared/date-range-picker';
import { OP_META, OP_OPTIONS } from '../lib/audit-log-display';
import { downloadAuditLogsCsv, fetchAuditLogs } from '../lib/audit-logs-api';
import { fetchTenantSystems } from '../lib/api';
import { apiErrorMessage } from '../lib/api-error';
import { useFileDownload } from '@/hooks/use-file-download';
import { useMountedFetch } from '@/hooks/use-mounted-fetch';
import { highlightMatches } from '@/lib/highlight';
import { formatDateTimeWithSeconds, toLocalYmd } from '@/lib/utils';
import { OverlayDialog } from '@/components/ui/overlay-dialog';
import { TableStatusRows } from './table-status-rows';

// 1 頁の件数はサーバーの既定と同じ 1 値（@rete/shared AUDIT_PAGE_SIZE）を読む。画面側に写しを置くと、
// 片方を変えた時に最後の頁の行数と前へ／次への境目が食い違う（d756）。
const PAGE_SIZE = AUDIT_PAGE_SIZE;

// ─────────────────────────────────────────────────────────────────────────────
// 表示用ヘルパ（純関数）
// ─────────────────────────────────────────────────────────────────────────────

/** 開始〜終了の出力日数（両端含む）。不正・未入力は null。set-0092 */
function exportDayCount(from: string, to: string): number | null {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86_400_000) + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV 出力パネル（set-0082: OverlayDialog モーダル・曇りガラス背景）
// 中身（開始/終了日・クイック期間・注意書き・キャンセル/DL）は set-0083〜0092 を維持。
// ヘッダの✕は出さない（set-0086）。閉じる＝キャンセル / ESC / 背景クリック。
// 内側 sp-card の role=region は region 系テスト維持のため残す。
// ─────────────────────────────────────────────────────────────────────────────

function CsvExportPanel({
  initialFrom,
  initialTo,
  exporting,
  onClose,
  onDownload,
}: {
  initialFrom: string;
  initialTo: string;
  exporting: boolean;
  onClose: () => void;
  onDownload: (from: string, to: string) => void;
}) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);

  /** クイック期間（基準は今日）。 */
  function applyQuick(kind: '7d' | '30d' | 'thisMonth' | 'lastMonth') {
    const now = new Date();
    if (kind === '7d' || kind === '30d') {
      const days = kind === '7d' ? 6 : 29; // 当日含む 7 / 30 日
      const start = new Date(now);
      start.setDate(start.getDate() - days);
      setFrom(toLocalYmd(start));
      setTo(toLocalYmd(now));
    } else if (kind === 'thisMonth') {
      setFrom(toLocalYmd(new Date(now.getFullYear(), now.getMonth(), 1)));
      setTo(toLocalYmd(now));
    } else {
      setFrom(toLocalYmd(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
      setTo(toLocalYmd(new Date(now.getFullYear(), now.getMonth(), 0)));
    }
  }

  // 出力中は閉じる操作を抑止する。
  const handleClose = () => {
    if (!exporting) onClose();
  };

  // set-0092: 出力日数（両端含む）・上限超過・逆転期間
  const dayCount = exportDayCount(from, to);
  const overLimit = dayCount !== null && dayCount > AUDIT_EXPORT_MAX_DAYS;
  const invalidRange = dayCount !== null && dayCount < 1;
  const canDownload = Boolean(from && to && !overLimit && !invalidRange);

  return (
    <OverlayDialog
      open
      onClose={handleClose}
      ariaLabel="CSV 出力（操作ログ）"
      width="min(420px, 90vw)"
    >
      {/* set-0113: FormCard/FormLabel 構成へ統一（自前ヘッダ/フッタを廃止）。region はテスト互換で維持 */}
      <div role="region" aria-label="CSV 出力（操作ログ）" data-csv-export-panel="">
        <FormCard
          icon={<Download className="h-4 w-4" aria-hidden="true" />}
          title="CSV 出力（操作ログ）"
        >
          {/* set-0083: 旧段落説明は削除。条件・上限は set-0090 の箇条書きへ集約 */}
          {/* set-0091: 日付入力は狭めの固定幅 / set-0092: 終了日右隣に出力日数 */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'flex-end',
              gap: '0.75rem',
              marginBottom: '0.75rem',
            }}
          >
            <div>
              {/* d536: 欄の名前は、同じ画面の絞り込み帯の期間（開始日 / 終了日）と区別できるよう
                  「出力」を冠する（見えるラベルと読み上げ名を揃える）。 */}
              <FormLabel htmlFor="csv-export-from">出力開始日</FormLabel>
              <input
                id="csv-export-from"
                type="date"
                className="sp-input sp-input--filter"
                aria-label="出力開始日"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                required
                style={{ width: '7.5rem' }}
              />
            </div>
            <div>
              <FormLabel htmlFor="csv-export-to">出力終了日</FormLabel>
              <input
                id="csv-export-to"
                type="date"
                className="sp-input sp-input--filter"
                aria-label="出力終了日"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                required
                style={{ width: '7.5rem' }}
              />
            </div>
            {dayCount !== null ? (
              <span
                className="text-xs"
                style={{
                  color:
                    overLimit || invalidRange ? 'var(--sp-accent-red)' : 'var(--sp-text-warm-mute)',
                  paddingBottom: '0.35rem',
                  whiteSpace: 'nowrap',
                }}
                data-csv-export-day-count=""
                aria-live="polite"
              >
                出力日数 {dayCount} 日
                {overLimit ? `（上限 ${AUDIT_EXPORT_MAX_DAYS} 日超過）` : null}
                {invalidRange ? '（期間が不正）' : null}
              </span>
            ) : null}
          </div>

          {/* set-0084: クイック期間ボタンを中央寄せ。寸法は .sp-action-btn の共有グループへ委ねる
              （v2-229: text-xs + inline style の上書きをやめ、透明系の 1 組 = 2rem / .8125rem・ADR 0081 に従う） */}
          <div
            style={{
              display: 'flex',
              gap: '0.25rem',
              flexWrap: 'wrap',
              marginBottom: '0.75rem',
              justifyContent: 'center',
            }}
          >
            {(
              [
                ['過去 7 日', '7d'],
                ['過去 30 日', '30d'],
                ['今月', 'thisMonth'],
                ['先月', 'lastMonth'],
              ] as const
            ).map(([label, kind]) => (
              <button
                key={kind}
                type="button"
                className="sp-action-btn"
                onClick={() => applyQuick(kind)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* set-0090: 出力条件・保存期間を箇条書き（set-0083 旧段落・set-0089 サマリー情報を集約） */}
          <div
            className="text-[0.6875rem] text-[var(--sp-text-warm-mute)]"
            style={{
              padding: '0.625rem',
              background: 'var(--sp-paper)',
              borderRadius: '0.375rem',
              display: 'flex',
              gap: '0.375rem',
              alignItems: 'flex-start',
            }}
          >
            <Info className="h-3 w-3" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }} data-csv-export-notes="">
              <li>出力期間は最大 {AUDIT_EXPORT_MAX_DAYS} 日まで</li>
              <li>現在の絞り込み条件（システム / 操作 / ユーザー）が反映されます</li>
              {/* set-0117 項目5: 保持期間の開示（backend AuditLogsPurgeService.RETENTION_MONTHS=12 と一致）。 */}
              <li>操作ログの保持期間は 12 ヶ月です（それ以前のログは自動削除されます）</li>
            </ul>
          </div>

          <FormActions>
            <FormButton variant="ghost" onClick={handleClose} disabled={exporting}>
              キャンセル
            </FormButton>
            <FormButton
              variant="primary"
              onClick={() => onDownload(from, to)}
              loading={exporting}
              disabled={!canDownload}
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              出力する
            </FormButton>
          </FormActions>
        </FormCard>
      </div>
    </OverlayDialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AuditLogScreen（エントリーポイント）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 操作ログ画面（設定 › セキュリティ › 操作ログ / ST-6）。テナント全体の監査ログを実 API
 * （GET /audit-logs・ADMIN 限定）からフィルタ + サーバー側ページングで読み、期間指定で CSV 出力する。
 * 記録（書き込み）infra は hardening H5 の責務で、本画面は「閲覧 / 検索 / 出力」レイヤ。
 * システムフィルタは契約システム（GET /settings/tenant/systems）+ 横断操作「共通操作」を選択肢にする。
 */
export function AuditLogScreen() {
  const { user, loading: sessionLoading } = useSession();
  const isAdmin = user?.role === Role.ADMIN;

  const [search, setSearch] = useState('');
  const [systemId, setSystemId] = useState('');
  const [actionType, setActionType] = useState<AuditActionType | ''>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<AuditLogDto[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [systems, setSystems] = useState<{ id: string; name: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // 取得失敗を一覧の領域内に残す（d592・正本 ui.ts:109）。toast だけで消すと、空の一覧と
  // 本当に 0 件の一覧が読み分けられない。
  const [loadError, setLoadError] = useState<string | null>(null);

  const [csvOpen, setCsvOpen] = useState(false);
  const { downloading: exporting, download } = useFileDownload();

  // サーバー問い合わせは keyset カーソル駆動（OFFSET は使わない・set-0013）。page はフロント側の
  // ページ番号「表示」用カウンタのみで、実クエリは fetchAction（方向 + カーソル）が決める。
  // 同じ方向・同じカーソルを取り直しても state では変更と見なされないため、押すたびに新しい入れ物を置く
  // （作り直した先頭は {} ではなく undefined で表し、同じ形の再取得も効くようにする・d652）。
  const [fetchAction, setFetchAction] = useState<{
    direction?: 'next' | 'prev' | 'last';
    cursor?: string;
  }>({});
  // 受け取ったカーソルは state でも持ち、ボタンの可否（canPrev / canNext）を同じ描画で決める。
  // ref だけを読むと、カーソルが届かないうちの押し込みで古い位置から取り直してしまう（d652）。
  const [cursors, setCursors] = useState<{ next: string | null; prev: string | null }>({
    next: null,
    prev: null,
  });
  const cursorsRef = useRef<{ next: string | null; prev: string | null }>({
    next: null,
    prev: null,
  });

  // フィルタ変更時はページを 1 へ戻す（別ページにいる時に件数が変わると空表示になるため）。
  const onFilter =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(1);
      setFetchAction({});
    };

  // ── システムフィルタ選択肢（契約システム）の初回ロード ── set-0057: 非 ADMIN はフェッチしない
  useMountedFetch(
    async (alive) => {
      if (!isAdmin) return;
      try {
        const sys = await fetchTenantSystems();
        if (alive()) setSystems(sys.map((s) => ({ id: s.id, name: s.name })));
      } catch {
        // システム一覧の取得失敗はフィルタ選択肢が減るだけ（ログ本体は別途読む）。握りつぶす。
      }
    },
    [isAdmin],
  );

  // ── ログ本体のフェッチ（フィルタ / fetchAction 変更で再取得・stale 応答は requestId で破棄）──
  const reqId = useRef(0);
  useEffect(() => {
    if (!isAdmin) return; // set-0057: 非 ADMIN はフェッチしない
    const id = (reqId.current += 1);
    setIsLoading(true);
    (async () => {
      // この回が投げた問い合わせ（方向 + カーソル）を覚えておく。応答は後から届くため、state の
      // fetchAction を読み直すと、途中で押された移動の値で取り違える（d652）。
      const sent = fetchAction;
      try {
        const res = await fetchAuditLogs({
          limit: PAGE_SIZE,
          search: search.trim() || undefined,
          actionType: actionType || undefined,
          systemId: systemId || undefined,
          from: dateFrom || undefined,
          to: dateTo || undefined,
          direction: sent.direction,
          cursor: sent.cursor,
        });
        if (id !== reqId.current) return; // 後発リクエストが既に走っていれば破棄
        setRows(res.data);
        setMeta(res.meta);
        setLoadError(null);
        // カーソルを返さない応答（古い backend・試験の模擬）でも移動可否の判定が壊れないよう既定へ倒す。
        const received = res.cursors ?? { next: null, prev: null };
        cursorsRef.current = received;
        setCursors(received);
        // d652: 表示するページ番号は、受け取ったカーソルから決める。末尾へ飛ぶ 'last' は行数が分からない
        // ため、サーバーが返す総ページ数へ合わせる（進めた先のページと取得した位置を食い違わせない）。
        const totalPageCount = res.meta?.totalPages ?? 1;
        if (sent.direction === 'last') setPage(totalPageCount);
        else if (sent.direction) setPage((p) => Math.min(totalPageCount, p));
        else setPage(1); // 先頭から読み直した（初回・onFirst・再試行・絞り込み）
      } catch {
        if (id === reqId.current) {
          setRows([]);
          setMeta(null);
          setLoadError('操作ログの読み込みに失敗しました');
          toast.error('操作ログの読み込みに失敗しました');
        }
      } finally {
        if (id === reqId.current) setIsLoading(false);
      }
    })();
    // アンマウント / 次フェッチ時に reqId を進め、最後の in-flight 応答による state 更新も無効化する
    // （フィルタ変更時の stale 破棄に加え、アンマウント後の setState 警告も防ぐ）。
    return () => {
      reqId.current += 1;
    };
  }, [isAdmin, search, systemId, actionType, dateFrom, dateTo, fetchAction]);

  const systemOptions = useMemo(
    () => [
      { value: '', label: 'システム: すべて' },
      ...systems.map((s) => ({ value: s.id, label: s.name })),
      { value: AUDIT_SYSTEM_COMMON, label: '共通操作（認証等）' },
    ],
    [systems],
  );

  const totalPages = meta?.totalPages ?? 1;
  // d652: 移動の可否は「今のページがサーバーから受け取ったカーソル」で決め、取得中と移動中は押せない。
  // 取得中に押せてしまうと、カーソルが差し替わる前の同じ位置から取り直し、行は同じままページ番号だけが
  // 進んで末尾の行へ届かなくなる（41 件・20 件表示のとき 3/3 が 21〜40 行目になる）。押し込みの窓を
  // 閉じるため、受け取ったカーソルは state にも持ち、描画のたびに ref の値を読まないようにする。
  const canPrev = !isLoading && page > 1 && !!cursors.prev;
  const canNext = !isLoading && !!cursors.next;

  // ── CSV エクスポート ──
  async function handleDownload(from: string, to: string) {
    const ok = await download(
      () =>
        downloadAuditLogsCsv({
          search: search.trim() || undefined,
          actionType: actionType || undefined,
          systemId: systemId || undefined,
          from,
          to,
        }),
      'audit-logs.csv',
      { onError: (err) => toast.error(apiErrorMessage(err, 'CSV 出力に失敗しました')) },
    );
    if (ok) setCsvOpen(false);
  }

  // ── 権限ガード（set-0057: organizations-screen と同型・タイトルのみ表示） ──
  if (sessionLoading) return null;
  if (!isAdmin) {
    return (
      <main className="sp-page" style={{ overflowY: 'auto' }}>
        <PageTitle title="操作ログ" />
      </main>
    );
  }

  return (
    <main className="sp-page" style={{ overflowY: 'auto' }}>
      {/* set-0088: description 削除 / set-0089: SummaryGrid 4枚削除（保存期間は set-0090 箇条書きへ） */}
      <PageTitle title="操作ログ" />

      {/* v2-184: 帯は左寄せ（表カードと同じ左端）。set-0087 の「この画面のみ中央寄せ」は撤回した。 */}
      <FilterBar>
        <FilterSearchInput
          placeholder="ユーザー名 / メールで検索..."
          value={search}
          onChange={onFilter(setSearch)}
        />
        <FilterChipSelect
          icon={Layers}
          label="システム"
          ariaLabel="システムで絞り込み"
          value={systemId}
          onChange={onFilter(setSystemId)}
          options={systemOptions.map((opt, i) => (i === 0 ? { ...opt, label: 'すべて' } : opt))}
        />
        <FilterChipSelect
          icon={ClipboardList}
          label="操作"
          ariaLabel="操作種別で絞り込み"
          value={actionType}
          onChange={onFilter((v: AuditActionType | '') => setActionType(v))}
          options={OP_OPTIONS.map((opt, i) => (i === 0 ? { ...opt, label: 'すべて' } : opt))}
        />

        {/* v2-185: 期間は1つのピッカー（連続2ヶ月）で入力する（native input 2本ではどちらを押しても
            片方のピッカーしか開かず、同じ期間を入れるのに2回開く必要があった）。どちらの欄から開いても
            同じピッカーが出て、1回目のクリックで開始日・2回目のクリックで終了日が state へ即時反映する。 */}
        <FilterDateRange
          from={dateFrom}
          to={dateTo}
          onChange={({ from, to }) => {
            onFilter(setDateFrom)(from);
            onFilter(setDateTo)(to);
          }}
        />

        <FilterClear
          onClick={() => {
            setSearch('');
            setSystemId('');
            setActionType('');
            setDateFrom('');
            setDateTo('');
            setPage(1);
            setFetchAction({});
          }}
        />
      </FilterBar>

      {/* set-0152: アクションは帯の外の独立行へ。すぐ下の出力パネルは OverlayDialog（画面中央・set-0082）で
          描画位置は JSX の順序に依らないが、読む順を操作と揃えるためアクション行の直後に置いている。
          v2-180: 表を内容に合う幅へ絞り左寄せにする。表だけを絞ると右寄せのアクション行はページ全幅のままなので、
          CSV 出力ボタンが表の右端から外れて宙に浮く（実測 253px ずれ）。アクション行と TableCard を同じ
          max-width の枠へ入れて右端を揃える。内容列(summary)は長文のため全幅でも折り返す行があり、絞りすぎると
          縦に伸びるため 900px を上限に（実測: 900px で折り返し3行）。ページャ上罫線も表と同じ幅になる。 */}
      <div style={{ maxWidth: 900 }}>
        <ListActionRow>
          <ActionButton
            icon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
            ariaLabel="CSV 出力"
            onClick={() => {
              // 出力中は X/キャンセルと同様に閉じない（set-0082）
              if (exporting) return;
              setCsvOpen((v) => !v);
            }}
          >
            {/* set-0150: 可視ラベルはメンバー画面と同じ「CSV 出力」（空白あり）へ。
                set-0155: 出力パネル側の見出し・読み上げ名も「CSV 出力（操作ログ）」（空白あり）へ
                揃えた＝同じダイアログで見える名前と読み上げ名の表記が割れない。 */}
            CSV 出力
          </ActionButton>
        </ListActionRow>

        {csvOpen && (
          <CsvExportPanel
            initialFrom={dateFrom}
            initialTo={dateTo}
            exporting={exporting}
            onClose={() => setCsvOpen(false)}
            onDownload={handleDownload}
          />
        )}

        <TableCard hoverBand>
          <table className="sp-table sp-table--hoverband">
            <thead>
              <tr>
                <th style={{ width: 130 }}>ユーザー名</th>
                <th style={{ width: 150 }}>システム名</th>
                <th style={{ width: 90 }}>操作</th>
                <th style={{ width: 120 }}>機能名</th>
                <th>内容</th>
                <th style={{ width: 155, whiteSpace: 'nowrap' }}>実行日時</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const opMeta = OP_META[r.actionType];
                return (
                  <tr key={r.id} className="sp-row-pillable">
                    <td className="text-[var(--sp-text-warm)]">
                      {highlightMatches(r.actorName, search)}
                    </td>
                    <td className="text-[var(--sp-text-warm-2)]">{r.systemName}</td>
                    <td>
                      <StatusBadge tone={opMeta.tone}>{opMeta.label}</StatusBadge>
                    </td>
                    <td className="text-[var(--sp-text-warm-2)]">{r.feature || '—'}</td>
                    {/* set-0081: メール列廃止。内容列にもメールを出さず summary のみ（縦幅も1行に戻す） */}
                    <td className="text-[var(--sp-text-warm-2)]">
                      <div
                        style={{
                          color: r.summary ? 'var(--sp-text-warm-2)' : 'var(--sp-text-warm-mute)',
                        }}
                      >
                        {r.summary || '—'}
                      </div>
                    </td>
                    <td
                      className="text-[var(--sp-text-warm-2)]"
                      style={{
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatDateTimeWithSeconds(r.createdAt)}
                    </td>
                  </tr>
                );
              })}
              <TableStatusRows
                colSpan={6}
                isLoading={isLoading}
                empty={rows.length === 0}
                emptyLabel={search ? '操作ログが見つかりませんでした' : '操作ログがありません'}
                // 取得失敗は「見つかりませんでした」（0 件の文言）へ落とさない（空一覧と区別する表示）。
                errorLabel={loadError ? '操作ログの読み込みに失敗しました' : null}
                // d659: 再試行は先頭ページから取り直す（失敗したページのカーソルに依存させない）。
                onRetry={() => {
                  setPage(1);
                  setFetchAction({});
                }}
              />
            </tbody>
          </table>
          <Pagination
            pageLabel={`${page} / ${totalPages} page`}
            // set-0150: 件数の語彙は設定タブ 7 画面で「全 N 件」へ統一（意味は絞り込み後の件数のまま。
            // reference の use-client-pagination も絞り込み後の件数を「全 N 件」と出す）。
            total={loadError ? '全 — 件' : `全 ${meta?.total ?? 0} 件`}
            onFirst={() => {
              setPage(1);
              setFetchAction({});
              setCursors({ next: null, prev: null });
            }}
            onPrev={() => {
              const cursor = cursorsRef.current.prev;
              if (!cursor) return; // d652: 戻り先が無いページからは動かさない
              setPage((p) => Math.max(1, p - 1));
              setFetchAction({ direction: 'prev', cursor });
              // 同じカーソルで二度取り直さないよう、次に受け取るまで手元のカーソルを空にする。
              setCursors({ next: null, prev: null });
            }}
            onNext={() => {
              const cursor = cursorsRef.current.next;
              if (!cursor) return; // d652: 次が無いページからは動かさない
              setPage((p) => Math.min(totalPages, p + 1));
              setFetchAction({ direction: 'next', cursor });
              setCursors({ next: null, prev: null });
            }}
            onLast={() => {
              // 'last' はカーソルを使わない（サーバーが末尾から取る）ため、ページ番号は受け取り後に決める。
              setFetchAction({ direction: 'last' });
              setCursors({ next: null, prev: null });
            }}
            canPrev={canPrev}
            canNext={canNext}
          />
        </TableCard>
      </div>
    </main>
  );
}
