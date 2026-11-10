import type { FavoriteKind, ReferenceObjectTypeSummary } from '@rete/shared';
import type { HubMenuItem } from '@/features/hub';

/**
 * 共通アプリシェルのタブ・サイドバー定義（SSOT）。
 * モック index.html のヘッダ 6 タブ + 左サイドバー（通知管理 + 横断お気に入り）に対応する。
 *
 * 未実装のタブは `kind: 'disabled'` とし、UI 側で灰色 + クリック不可にして
 * 「途中」であることを明示する（開発統括要件）。お気に入りは HM-1 で実 API 化済み
 * （`useFavorites` がユーザー別データを取得。本ファイルは遷移解決のみ担う）。
 */

export type ShellTabKey =
  | 'home'
  | 'system'
  | 'gmis'
  | 'gmis-demo'
  | 'desk'
  | 'files'
  | 'settings'
  | 'mock'
  | 'model';

/**
 * 「システム」タブの直後へ並べる外部システム導線（hub menu の key → タブ key）。
 * 在庫管理（reference）の隣に、繋ぎ先が有効なものだけが並ぶ。並び順はこの配列順。
 * gmis は正式な報告管理（d1171）、gmis-demo は開発時だけ出る旧デモ。
 */
const SYSTEM_COMPANION_KEYS = ['gmis', 'gmis-demo'] as const;
export type SystemCompanionKey = (typeof SYSTEM_COMPANION_KEYS)[number];

export interface ShellTab {
  key: ShellTabKey;
  label: string;
  /**
   * - internal: Next ルートへ遷移（href を使う）
   * - external: hub menu の item（resolveFrom）から href / available を解決して遷移
   * - disabled: 未実装。常に灰色 + クリック不可
   */
  kind: 'internal' | 'external' | 'disabled';
  /** internal の遷移先 */
  href?: string;
  /** external の場合、hub menu のどの item key から href / available を解決するか */
  resolveFrom?: string;
}

/** ヘッダタブ順（Home / Desk / File / System / Mock / Setting / Model）。
 *  ラベルは英語・単数形（cmn-0114 の添付モック準拠）。英語化はグローバルメニューのみで、
 *  各画面内タイトルは日本語のまま（スコープ限定）。 */
export const SHELL_TABS: ShellTab[] = [
  { key: 'home', label: 'Home', kind: 'internal', href: '/hub' },
  { key: 'desk', label: 'Desk', kind: 'internal', href: '/desk' },
  { key: 'files', label: 'File', kind: 'internal', href: '/files' },
  { key: 'system', label: 'System', kind: 'external', resolveFrom: 'reference' },
  { key: 'mock', label: 'Mock', kind: 'disabled' },
  { key: 'settings', label: 'Setting', kind: 'internal', href: '/settings' },
  // 共通仕様カタログ（rete 固有共通仕様の正本）。開発・参照向けタブ。
  { key: 'model', label: 'Model', kind: 'internal', href: '/model' },
];

/** プリセット種別（key）→ reference の複数形ルート対応表（hom-0067）。
 *  単数形 key→複数形ルートは機械変換不能（category→categories）のため静的対応表で持つ。
 *  自由定義台帳（isPreset=false）は /dashboard/custom/<key> へ遷移する（下表の外）。 */
const PRESET_OBJECT_TYPE_ROUTES: Record<string, string> = {
  product: '/dashboard/products',
  warehouse: '/dashboard/warehouses',
  carrier: '/dashboard/carriers',
  supplier: '/dashboard/suppliers',
  category: '/dashboard/categories',
};

/**
 * お気に入りクリック時の遷移解決結果。href=null は遷移先未接続（灰色・クリック不可）。 */
export interface ResolvedFavoriteLink {
  href: string | null;
  /** 別オリジン遷移（window.location）か。false なら Next router。 */
  external: boolean;
}

/**
 * お気に入り（kind + targetRef）を遷移先に解決する（純関数）。
 * targetRef を使い、kind ごとに精密 deep link / サブシステムルートへ寄せる（HM-1-4）:
 * - folder → ファイルタブの該当フォルダへ精密ジャンプ（/files?folderId=<targetRef>。query injection 回避で encode）
 * - file   → ファイルタブで編集オーバーレイを開く deep link（/files?fileId=<targetRef>・FF。DL→編集→再アップ導線）
 * - system → reference の対応画面へ deep link（hom-0067）。プリセット種別は複数形ルート、自由定義台帳は
 *   /dashboard/custom/<key>。現存する ObjectType 一覧に一致しないスラッグ（旧 randomUUID 含む）は灰
 * - chat / task → デスク（/desk）
 * - space → デスクの該当器を開いた状態へ deep-link（/desk?spaceId=<targetRef>。CM-2 / ADR 0037）
 *   org / project は desk からは favorite 生成しないため遷移先未定義（deferred・default で灰色）
 *
 * `referenceReachable`（rete-files-0037 / common-0018）: reference の実起動確認結果。`resolveTabs` と同じく、
 * env の available が立っていても実到達不能（`false`）なら system お気に入りを灰色にして空クリック ERR を防ぐ。
 * `undefined`（未確認）は楽観的に available のみで判定する。ヘッダタブと同一の probe 結果を共有する
 * （`ReferenceReachableContext` 経由・二重 probe を避ける）。
 *
 * `objectTypes`（hom-0067）: reference 種別一覧（rete backend の proxy API 経由）。system の deep link 解決と
 * 未知スラッグ判定に使う。空/未取得（縮退）の時はプリセット既知 key を静的解決で後方互換を保ち、それ以外は灰。
 */
export function resolveFavoriteLink(
  kind: FavoriteKind,
  targetRef: string,
  menuItems: HubMenuItem[],
  referenceReachable?: boolean,
  objectTypes?: ReferenceObjectTypeSummary[],
): ResolvedFavoriteLink {
  switch (kind) {
    case 'system': {
      const item = menuItems.find((m) => m.key === 'reference');
      if (item && item.available && referenceReachable !== false) {
        const referenceBase = item.href.replace(/\/$/, '');
        const type = objectTypes?.find((o) => o.key === targetRef);
        const presetRoute = PRESET_OBJECT_TYPE_ROUTES[targetRef];
        // 既知のプリセット種別 → 複数形ルート（objectTypes から判定）。
        if (type?.isPreset && presetRoute) {
          return { href: `${referenceBase}${presetRoute}`, external: true };
        }
        // 自由定義台帳 → /dashboard/custom/<key>。
        if (type && !type.isPreset) {
          return {
            href: `${referenceBase}/dashboard/custom/${encodeURIComponent(targetRef)}`,
            external: true,
          };
        }
        // objectTypes 未取得（縮退）時だけプリセット既知 key を静的解決で後方互換を保つ。
        if (presetRoute && (!objectTypes || objectTypes.length === 0)) {
          return { href: `${referenceBase}${presetRoute}`, external: true };
        }
      }
      // 未接続 / 未知スラッグ（旧 randomUUID 含む）/ 実到達不能は遷移不可（灰色）。
      return { href: null, external: false };
    }
    case 'chat':
    case 'task':
      return { href: '/desk', external: false };
    case 'space':
      // 器（Space）へ deep-link。desk page が ?spaceId= を初期 selectedSpaceId に取り込む（CM-2 / ADR 0037）。
      return { href: `/desk?spaceId=${encodeURIComponent(targetRef)}`, external: false };
    case 'folder':
      return { href: `/files?folderId=${encodeURIComponent(targetRef)}`, external: false };
    case 'file':
      return { href: `/files?fileId=${encodeURIComponent(targetRef)}`, external: false };
    default:
      return { href: null, external: false };
  }
}

export interface ResolvedTab {
  key: ShellTabKey;
  label: string;
  active: boolean;
  disabled: boolean;
  /** 遷移先。disabled / 解決失敗時は null。 */
  href: string | null;
  /** 外部（別オリジン）遷移か。true なら window.location、false なら router。 */
  external: boolean;
}

/**
 * SHELL_TABS を hub menu と突き合わせて、描画用の解決済みタブ列にする（純関数）。
 * external タブは対応する hub menu item が available な時だけ有効化し、
 * 未設定 / 取得前は灰色（disabled）にフォールバックする。
 *
 * `referenceReachable` は reference 連携（システムタブ）の **実起動確認**結果（rete-files-0037 / common-0018）。
 * env の available（OIDC 連携完成フラグ）が立っていても reference dev サーバーが落ちていればクリックは
 * `ERR_CONNECTION_REFUSED` で空振りする。これを防ぐため、実到達不能（`false`）が確定したら external タブを
 * 灰色（disabled）にして空クリックを止める。`undefined`（未確認 / 確認前）は従来どおり available のみで判定する
 * （楽観的に有効。確認前のグレー点滅を避ける）。env が available=false なら本フラグに関係なく従来どおり灰色。
 */
export function resolveTabs(
  tabs: ShellTab[],
  menuItems: HubMenuItem[],
  activeKey: ShellTabKey,
  referenceReachable?: boolean,
): ResolvedTab[] {
  // 「システム」タブの直後へ、hub menu が available な外部システム導線を並べる（在庫管理と報告管理を横並びにする・d1171）。
  // available でない導線は出さない（未完成の導線を灰色タブとして増やさない）。
  const companions = SYSTEM_COMPANION_KEYS.flatMap((key): ShellTab[] => {
    const item = menuItems.find((m) => m.key === key && m.available);
    return item ? [{ key, label: item.label, kind: 'external', resolveFrom: key }] : [];
  });
  const visibleTabs = companions.length
    ? tabs.flatMap((tab): ShellTab[] =>
        tab.resolveFrom === 'reference' ? [{ ...tab, label: '在庫管理' }, ...companions] : [tab],
      )
    : tabs;
  return visibleTabs.map((tab) => {
    const base = { key: tab.key, label: tab.label, active: tab.key === activeKey };

    if (tab.kind === 'internal') {
      return { ...base, disabled: false, href: tab.href ?? null, external: false };
    }

    if (tab.kind === 'external') {
      const item = menuItems.find((m) => m.key === tab.resolveFrom);
      // available（env 連携フラグ）かつ 実到達不能が確定していない時だけ有効化する。
      const reachable = tab.resolveFrom !== 'reference' || referenceReachable !== false;
      if (item && item.available && reachable) {
        return { ...base, disabled: false, href: item.href, external: true };
      }
      return { ...base, disabled: true, href: null, external: false };
    }

    // disabled
    return { ...base, disabled: true, href: null, external: false };
  });
}
