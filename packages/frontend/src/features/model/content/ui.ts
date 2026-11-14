import type { ModelTheme } from '../types';

/** UI共通カテゴリの共通仕様テーマ。 */
export const UI_THEMES: ModelTheme[] = [
  {
    id: 'button-color',
    title: 'ボタン色規約',
    category: 'ui',
    status: 'active',
    summary: 'ボタン色は「塗り種別」で機械的に決める。色を画面/feature で選ばない。',
    sources: ['memory: feedback-button-color-convention', 'commit 71f3d44'],
    purpose:
      '色を feature ごとに選ぶと量産で必ず分裂する（同じ「保存」が画面ごとに濃紺/ピンクで割れた）。主要/副次の区別を色で一貫表現し、どの画面でも揺れない状態にする。',
    spec: [
      {
        type: 'p',
        text: '色を画面/feature で選ばず、「塗りの有無（種別）」で機械的に決める（開発統括決定 2026-06-10）。新規ボタンはまず「塗りつぶしの主要 / 背景なしの副次 / 危険(destructive)」を判定してトークンを当てる。hex 直書きはしない。',
      },
      {
        type: 'list',
        items: [
          '塗りつぶし（背景塗り）の主要アクション → 緑 var(--sp-accent-teal)。基準＝Desk 送信ボタン。',
          '背景なし（transparent / outline / ghost）の副次アクション → ピンク文字 var(--sp-accent-ink)。基準＝Desk 新規登録ボタン。',
          'destructive（削除・破棄）→ 赤（--sp-accent-red / AlertDialog variant=destructive）。不変。',
        ],
      },
      {
        type: 'note',
        text: '塗り種別→色のマッピングは不変。基底 4 ラベルの塗り種別は mdl-0035 で固定した（保存/送信=緑塗り default/sp-primary・削除=destructive・キャンセル=背景なし sp-action/outline/ghost。旧「同一意味ボタンの塗り種別は画面ごとの UX 判断で割れてよい」2026-06-15 決定は、保存ボタンの色揺れが実際に開発統括指摘へ至ったため 2026-07-11 指摘で上書き）。詳細（ラベル正規化・アイコン併記可否）は UIコンポーネント Button の 3 表を参照。',
      },
    ],
    design: [
      {
        type: 'table',
        head: ['種別', 'トークン', '値', 'hover / active'],
        rows: [
          [
            '主要(塗り)',
            '--sp-accent-teal',
            '#1fb6a2',
            'hover --sp-accent-teal-strong / active --sp-accent-teal-strong-2 / 文字 white',
          ],
          [
            '副次(背景なし)',
            '--sp-accent-ink',
            '#b83d6e',
            '通常 neutral 文字(--sp-text-warm-2)、hover で背景 --sp-accent-soft + ink 文字',
          ],
          ['destructive', '--sp-accent-red', '赤', '不変'],
        ],
      },
      {
        type: 'p',
        text: 'cva Button: default / sp-primary = 緑塗り、sp-action = 透明地＋中立文字（hover で accent-soft 帯 + ink 文字）。settings FormButton: primary = 緑塗り、secondary = 透明地＋accent-ink 文字（枠線なし）、ghost = 透明地＋中立文字。透明系（cva sp-action / .sp-action-btn / FormButton secondary・ghost / オーバーレイの ghost = .fo-btn-ghost）は寸法を .8125rem・weight 500・高さ 2rem・角丸 .375rem の 1 組へ統一し、文字色だけを役割で分ける（中立は汎用 = --foreground 80% / ゴースト・キャンセル = --sp-text-warm-2、セカンダリ = --sp-accent-ink。ADR 0081）。',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: 'Desk 送信=緑塗り、Desk 新規登録=ピンク背景なし（基準・変更しない）',
          demo: 'button-color-good',
        },
      ],
      bad: [
        {
          text: '「設定画面だから青」のように feature で色を選ぶ / #1fb6a2 を hex 直書きする',
          demo: 'button-color-bad',
        },
      ],
    },
  },
  {
    id: 'state-representation',
    title: '状態表現（loading / empty / error）',
    navLabel: '状態表現',
    category: 'ui',
    status: 'active',
    summary:
      'loading は共通 Spinner を使い、表示タイミングは3方式（既定=即時／chat-thread=遅延200ms／task-detail=初回非描画）。error は二層（取得失敗=領域内／操作失敗=toast）。empty は既定＝リスト骨格残置＋明示文言、意図的特例は Files silent / Desk EmptyTreeDropZone。',
    sources: [
      'components/ui/spinner.tsx（共通 Spinner・role=status）',
      'hooks/use-delayed-loading.ts（200ms 閾値・利用は chat-thread のみ）',
      'features/desk/components/chat-thread.tsx（useDelayedLoading の唯一利用）',
      'features/desk/components/task-detail-overlay.tsx（dsk-0234・初回スピナー非描画）',
      'features/shell/components/app-sidebar.tsx / features/dashboard/components/dashboard-view.tsx（即時 Spinner の代表）',
      'hooks/use-crud-api.ts（一覧取得失敗も toast する現状実値・CUD は toast）',
      'features/dashboard/components/dashboard-view.tsx（取得失敗=領域内 role=alert）',
      'features/desk/components/chat-list.tsx / task-tree.tsx（取得失敗=領域内）',
      'features/files/components/files-shell.tsx（取得失敗=領域内＋folderError の再試行は FormButton secondary）',
      'features/settings/components/login-settings-screen.tsx（取得失敗=領域内＋二段階認証 状態取得失敗の再読み込みは FormButton secondary）',
      'features/settings/components/members-screen.tsx（empty 既定＝tbody 空行＋文言）',
      'features/files/components/file-list.tsx（empty 特例＝フォルダ真0 tbody silent・rete-files-0007/0008）',
      'features/desk/components/task-tree.tsx（empty 特例＝タスク真0 EmptyTreeDropZone・rete-desk-0172／絞り込み0＝DOM残置＋文言）',
    ],
    purpose:
      'CRUD ページが量産される中で loading / 空状態 / エラーの見せ方が画面ごとに割れると、ユーザーは「壊れているのか待つべきか」を毎回判断し直すことになる。取得失敗を toast だけにすると消えたあと空領域と区別できなくなるため、永続失敗は領域内に残す。empty は製品意図の差があるため「残置派を既定＋意図的特例」とし、後続が特例をバグ扱いしないように正本化する。',
    spec: [
      {
        type: 'p',
        text: 'loading は共通 Spinner 部品を使い、表示タイミングは実装実値の3方式に書き分ける。error は「取得失敗」と「操作失敗」の二層。empty は既定＋意図的特例（下記 list / note）。EmptyState 共通部品の新設や語彙の全画面機械統一はしない。',
      },
      {
        type: 'list',
        items: [
          'loading（既定）: 共通 Spinner（components/ui/spinner.tsx）を即時表示する。一覧・サイドバー・オーバーレイ等、初回フルペインは出すものが無く、即時 Spinner が「動いている」フィードバックとして正（例: app-sidebar.tsx / dashboard-view.tsx / favorites-manage-overlay.tsx）。',
          'loading（特例・chat-thread）: use-delayed-loading 200ms。stale 内容を保持して裏で再取得する画面向け。高速解決時のスピナーフラッシュを防ぐ。現状の利用箇所は features/desk/components/chat-thread.tsx のみ。',
          'loading（特例・task-detail-overlay）: 初回スピナー非描画（dsk-0234 案A）。loading を描画条件から外し、種データまたは空シェルで先に出す。遅延 hook は使わない。',
          'error（取得失敗）: 一覧・ツリー・ダッシュボード等の表示データ読み込み失敗は領域内に残す（role="alert" + destructive 系色の文言）。toast だけにしない（消えたあと 0件と区別できないため）。再試行ボタンは推奨だが任意。置く時は設定タブの FormButton variant="secondary"（features/settings/components/primitives/form.tsx）を使い、ツールバー帯の部品を流用しない（現状実値: files-shell の folderError 再試行と login-settings-screen の二段階認証 状態取得失敗の再読み込みの2箇所）。',
          'error（操作失敗）: 登録/更新/削除/移動/アップロード等のユーザー操作の失敗は toast（react-hot-toast）へ一元化する。',
          'empty（既定）: リスト骨格を残しつつ明示文言（Settings members の tbody 空行＋文言等）。絞り込み0も DOM 残置＋文言（リスト DOM を丸ごと消して D&D/gap を壊さない）。',
          'empty（特例・潰さない）: (1) Files フォルダ内容の真0＝tbody silent（file-list.tsx total===0 で null・rete-files-0007/0008）(2) Desk タスク真0＝EmptyTreeDropZone（文言＋D&D 受け・rete-desk-0172）。絞り込み0は特例ではなく既定（DOM 残置＋文言）の再掲。',
        ],
      },
      { type: 'demo', demo: 'state-triptych', caption: 'loading / empty / error の3状態見本' },
      {
        type: 'note',
        text: 'useCrudApi（use-crud-api.ts:37）は一覧取得失敗も toast.error している（現状実値）。上記「取得失敗=領域内」とは未整合で、本テーマは嘘の正本にしないため「現状実値の注記」として残す。移行・是正は rete-cross-0001 管轄（crud-consistency 本票では list toast を書き換えない）。',
      },
      {
        type: 'note',
        text: 'empty 方針（rete-cross-0003 確定）: 残置派を既定とし、Files silent と Desk EmptyTreeDropZone は意図的特例として正本に残す。全部を Settings 型文言に寄せると特例の製品意図を壊す。EmptyState 新設・語彙の全画面機械統一・全画面 Settings 型 empty 強制は本テーマ外。製造追随は意図のない乖離のみ（特例をメッセージ強制や DOM 差し替えで潰さない）。',
      },
    ],
    examples: {
      good: [
        {
          text: 'loading は Spinner。取得失敗は領域内 role=alert（永続可視）。操作失敗は toast',
          demo: 'state-usage-good',
        },
      ],
      bad: [
        {
          text: '画面独自の点滅ローダーを手組みする / 取得失敗を toast のみにして領域を空のままにする / 操作失敗を本文に埋めっぱなしにする',
          demo: 'state-usage-bad',
        },
      ],
    },
  },
  {
    id: 'color-tokens',
    title: 'colorトークン直書き禁止',
    category: 'ui',
    status: 'active',
    summary: '色は CSS 変数（--sp-* トークン）参照。hex 直書きしない。',
    sources: ['app/globals.css:57-120（--sp-* トークン全定義）'],
    purpose: '色 hex を直書きすると配色変更が全箇所改修になり、トークン体系（--sp-*）と乖離する。',
    spec: [
      {
        type: 'p',
        text: '配色は globals.css 定義の --sp-* トークンを参照する。新たな色を hex で持ち込まない。',
      },
      {
        type: 'table',
        head: ['分類', '代表トークン'],
        rows: [
          ['面/枠', '--sp-paper / --sp-card / --sp-line-warm / --sp-line-warm-2'],
          [
            'アクセント',
            '--sp-accent-teal（主要）/ --sp-accent-ink（副次）/ --sp-accent-red（destructive）',
          ],
          /* cmn-0136 / ADR 0054: --destructive（globals.css:22）は shadcn/ui プリミティブ
             専用の互換エイリアス。正本は --sp-accent-red（#dc2626・globals.css:108）。
             app 層は --sp-accent-red を直接参照する。 */
          ['文字', '--sp-text-warm / --sp-text-warm-2 / --sp-text-warm-mute'],
          ['状態', '--sp-status-todo-bg/fg・progress・review・done（Badge variant が参照）'],
          ['選択', '--sp-select-soft / --sp-select-hover'],
        ],
      },
      { type: 'demo', demo: 'color-tokens-swatches', caption: '分類別トークンの実色見本' },
      {
        type: 'note',
        text: '意匠特例（hex/パレット温存・mdl-0046）: ①サイドバー member/project アバター識別色 ②fav-kind パステル文字色 ③金属グラデ（.app-sidebar 7段と reference .sidebar-glass は同一パレット複製・.login-metal-page は別シルバー短段） ④desk-rte 文字色/ハイライト ⑤ファイル種別色・ユーザー定義タグ色 ⑥.perm-kind-role/user 識別色 ⑦アクセント上の白文字・checkbox 塗り白・login 純白入力 ⑧model デモの bad 例 ⑨reference の #FDF1F4 のうち data-list-compact hover 以外。セマンティック寄せ済みトークン例: --sp-search-hl / --sp-fav-active / --sp-fav-active-hover。#fff/bg-white 一括置換は対象外。⑩サイドバーのガラス面へ重ねるブロック背景（.files-storage 等）は --sidebar を塗り戻さず、白＋アルファ（例 rgb(255 255 255 / 0.55)）で書く。--sidebar/0.6 塗り戻しでコントラスト 1.64:1 に沈んだ fil-0088 が根拠（globals.css:6492-6499 commit 7f6fb63 で是正済）。',
      },
    ],
    compliesWith: [{ label: 'ボタン色規約（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: 'var(--sp-accent-teal) を参照する（配色変更が globals.css 1箇所で波及）',
          demo: 'color-tokens-usage-good',
        },
      ],
      bad: [
        {
          text: '#1fb6a2 を hex 直書きする（トークン変更が波及せずこの箇所だけ取り残される）',
          demo: 'color-tokens-usage-bad',
        },
      ],
    },
  },
  {
    id: 'crud-consistency',
    title: 'CRUDページ描画一貫性',
    category: 'ui',
    status: 'active',
    summary:
      'useCrudApi は単一エンティティ・標準REST一覧CRUD向けの契約部品（本番採用は現状0・demoのみ）。新設の契約適合画面は第一採用。settings 管理系・ホーム通知（useAnnouncements）は対象外。削除確認は useDeleteConfirm + ConfirmDialog destructive。状態は用途分け（Badge / StatusBadge）。',
    sources: [
      'hooks/use-crud-api.ts:23-102（items/meta/loading + CUD + toast・契約）',
      'hooks/use-delete-confirm.ts:18-39（削除確認共通化）',
      'components/ui/confirm-dialog.tsx（ConfirmDialog）',
      'components/ui/badge.tsx（Badge＝タスク／汎用）',
      'features/settings 系 StatusBadge（設定の多値トーン）',
      'features/dashboard/hooks/use-announcements.ts（kind・既読・reorder＝契約外）',
      'architecture-invariants §6',
    ],
    purpose:
      '同型の一覧・検索・削除確認が個別実装されると全ページ改修が毎回発生する。一方で正本が「既に共通化済み」に読めると、契約外画面への嘘の全面寄せが起きる。契約と現状実値と第一採用ルールを分けて書く。',
    spec: [
      {
        type: 'p',
        text: 'useCrudApi は「単一エンティティ・標準REST（ページネーション GET/POST/PUT/DELETE）の一覧CRUD」向け。契約に合う画面の第一採用部品であり、既存専門 hook の全面リライトはしない。',
      },
      {
        type: 'list',
        items: [
          'useCrudApi 契約: 単一エンティティ＋標準REST一覧CRUD向け。本番 features 配下の採用は現状0（demo のみ）。settings admin 系（複合エンティティ・PATCH中心・非ページネーション）は対象外のまま個別 fetch/toast。',
          '第一採用ルール: これから新設する契約適合の一覧CRUDは useCrudApi で組む。既存の専門 hook（useAnnouncements 等）はリライト契機まで据え置き。',
          'ホーム通知: kind・既読・reorder があり useCrudApi 契約外＝useAnnouncements を維持する（本票で寄せない）。',
          '削除確認: useDeleteConfirm が保持する deleteTarget と ConfirmDialog destructive を組み合わせる（window.confirm や確認なし即 DELETE は使わない）。',
          '状態表示の用途分け: タスク／汎用の状態チップ＝Badge。設定の多値トーン＝StatusBadge。画面独自の色付き span を増やさない（Badge と StatusBadge の部品統合はしない）。',
          '一覧取得失敗の toast vs 領域内は state-representation / rete-cross-0001 管轄。本テーマで useCrudApi の list toast を書き換えない。',
        ],
      },
      {
        type: 'demo',
        demo: 'crud-anatomy',
        caption: 'useCrudApi + Badge + useDeleteConfirm/ConfirmDialog の骨格',
      },
      {
        type: 'note',
        text: '同一パターンの useState + handler が 3 ページ以上で並ぶなら custom hook 化する（グローバル規約 §6）。一括削除 vs 行アイコンの判断は ADR 0021 を参照。',
      },
    ],
    compliesWith: [
      { label: 'architecture-invariants §6 UI の同型ページは hook 抽出（グローバル規約）' },
      { label: '状態表現（loading / empty / error）（本タブ UI共通）' },
    ],
    relatedAdr: [{ label: 'ADR 0021 files ツールバー一括削除 vs 行アイコン' }],
    examples: {
      good: [
        {
          text: '新設の契約適合一覧CRUDを useCrudApi で組む／削除は useDeleteConfirm + ConfirmDialog destructive／汎用状態は Badge・設定多値は StatusBadge',
          demo: 'crud-usage-good',
        },
      ],
      bad: [
        {
          text: 'window.confirm や確認なし即 DELETE／画面独自の色付き span を増やす／契約外のホーム通知を useCrudApi へ無理寄せする',
          demo: 'crud-usage-bad',
        },
      ],
    },
  },
  {
    id: 'typography',
    title: 'フォント（サイズ / 色 / 太さの階層）',
    navLabel: 'フォント',
    category: 'ui',
    status: 'active',
    summary:
      '見出し/小見出し/本文/補助テキストの4階層（標準スケール）と、一覧・高密度領域の第2スケールを size・weight・color で固定する。色指定は Tailwind 任意値クラスで書き、inline style にしない。struct-pass-reference にも同じ正本を適用する。',
    sources: [
      'mdl-0014 現状調査（rete全画面 + struct-pass-reference 横断）',
      'mdl-0017 第2弾（第2スケール正式化・部品タイトル=h2 統一・reference 色記法統一。開発統括決定 2026-07-06）',
      'app/layout.tsx（Geist + Noto Sans JP・rete/reference で共通）',
      'components/shared/page-title.tsx（共通 PageTitle・見出し多数派パターンの基準。旧 settings PageHeader を mdl-0028 で統合）',
    ],
    purpose:
      '正解が文書化されていないと見出し/本文/補助テキストの size・color・weight が画面ごとに割れる（auth 画面だけ別方式・files 機能に見出しが無い等、実際に5箇所の逸脱が発生していた）。4階層を固定し、揺れを構造的に止める。',
    spec: [
      {
        type: 'p',
        text: 'テキストは「見出し(h2) / 小見出し(h3・h4) / 本文 / 補助(caption)」の4階層で扱う。役割ごとに size・weight・color を固定し、画面や feature で個別に選ばない。フォントファミリーは Geist（英数）+ Noto Sans JP（和文）で rete 全体固定（既に統一済・変更不要）。',
      },
      {
        type: 'table',
        head: ['役割', 'サイズ', '太さ', '色トークン'],
        rows: [
          ['見出し（h2）', 'text-xl', 'font-semibold', 'text-[var(--sp-text-warm)]'],
          ['小見出し（h3/h4）', 'text-sm', 'font-semibold', 'text-[var(--sp-text-warm)]'],
          ['本文', 'text-sm', 'font-normal', 'text-[var(--sp-text-warm)]（既定色継承可）'],
          ['補助・caption', 'text-xs', 'font-normal', 'text-[var(--sp-text-warm-mute)]'],
        ],
      },
      { type: 'demo', demo: 'typography-hierarchy', caption: '4階層の実物比較' },
      {
        type: 'note',
        text: 'ダイアログ・カードなど共通部品のタイトルも「見出し（h2）」扱いで text-xl font-semibold に統一する（部品だけ別サイズの例外を作らない）。font-bold は使わない（強調は semibold まで。mdl-0017 開発統括決定）。',
      },
      {
        type: 'note',
        text: '許容する特例（mdl-0045・これ以外へ横展開しない）: ①ユーザー Markdown 描画の見出し（.desk-thread-comment-text h1〜h3 の font-weight:700＝コンテンツ側の太字でありアプリ chrome ではない）②リッチテキストツールバーの書式見本グリフ（desk-rte-toolbar の A/B・fontWeight 700/600・fontSize 12px＝「太字にする」機能の見本表示そのもの）③環境バッジ（env-badge の text-[10px] font-bold＝環境誤認防止の警告意匠・reference で稼働。rete は set-0118 で撤去済みのため該当なし）④reference サイドバーのブランド見出し（text-2xl＝ロゴ扱い）⑤reference 伝票番号（document-form の text-lg）と Markdown プレビュー見出し（[&_h2]:text-lg）⑥カレンダーの暦グリッド（.calendar-left の font-family: Verdana, Meiryo, sans-serif＝日付・時刻の数字幅を揃えて列をずらさないための意図的例外。右上アクション行・予定一覧は本文フォントを継承する・d1273）。',
      },
      {
        type: 'p',
        text: '一覧・高密度領域（Desk のツリー/一覧・設定タブのテーブル・ファイル一覧など情報密度を優先する領域）は、標準スケールの代わりに次の第2スケールを使う。表ヘッダーの詳細規約は「表」テーマを参照。',
      },
      {
        type: 'table',
        head: ['役割', 'サイズ', '太さ', '色トークン'],
        rows: [
          [
            '明細・本文（高密度）',
            '0.8125rem（13px）',
            'font-normal',
            'text-[var(--sp-text-warm)]（既定色継承可）',
          ],
          [
            '補助・ヘッダ（高密度）',
            '0.6875rem（11px）',
            'font-normal〜medium',
            'text-[var(--sp-text-warm-mute)]',
          ],
        ],
      },
      {
        type: 'note',
        text: '色は Tailwind の任意値クラス（例: text-[var(--sp-text-warm)]）で指定し、style={{ color: "var(...)" }} の inline style にしない（grep 性・一貫性のため。destructive色統一 set-0015 の前例に倣う）。旧 settings PageHeader の inline style は共通 PageTitle へ統合済み（mdl-0028）。',
      },
      {
        type: 'note',
        text: '本正本は struct-pass-reference にも適用する。色は text-[var(--sp-text-warm)] / text-[var(--sp-text-warm-mute)] の任意値クラス記法で統一し、text-foreground / text-muted-foreground は新規に使わない（mdl-0017 で既存分を機械置換済み・feature 層の残存は mdl-0029 で追是正。text-foreground/80 や text-sidebar-foreground 等の別用途トークンと shadcn 基底部品の汎用 variant＝badge outline 等は対象外）。',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: 'text-xl font-semibold text-[var(--sp-text-warm)] を Tailwind クラスのみで指定する',
          demo: 'typography-usage-good',
        },
      ],
      bad: [
        {
          text: 'style={{ color: "var(--sp-text-warm)" }} を inline style で指定する',
          demo: 'typography-usage-bad',
        },
      ],
    },
  },
  {
    id: 'icon',
    title: 'アイコン（ライブラリ / サイズ / 太さ / 色 / 意味 / ラベル距離 / 使い所）',
    navLabel: 'アイコン',
    category: 'ui',
    status: 'active',
    summary:
      'ライブラリは lucide-react 固定。サイズは通常4段階（16/14/12/20〜24px）＋限定ヒーロー（32〜40px）を Tailwind 標準クラスで指定し、numeric prop・任意値クラスを使わない。太さは lucide 既定（strokeWidth 2）固定。色は currentColor 継承が原則で、危険操作はアイコンに赤を焼き込まず親ボタンのホバーで表現する。グリフは意味対応表（1意味=1グリフ）に従い、アイコン⇄ラベル間隔はボタン/ツールバー/タブ=4px・チップ=2px に固定する。',
    sources: [
      'mdl-0015 現状調査（rete全画面 + struct-pass-reference 横断）',
      'mdl-0019 第2弾調査（サイズ値・strokeWidth・色指定の残不揃い）+ 開発統括決定3件（2026-07-06）',
      'mdl-0024 第3弾調査（グリフ意味・自作SVG線幅・ラベル距離）+ 開発統括決定3件（2026-07-06）',
      'components/ui/button.tsx（cva size=icon/icon-sm の筐体寸法・gap-1 既定）',
    ],
    purpose:
      'mdl-0015 で記法（Tailwind class 化）は統一したが、値そのものが不揃いのまま残っていた: サイズは同一文脈（閉じる×・削除・編集）で 11〜16px に分裂、太さは自作 SVG が JSX↔CSS 二重管理で 6値に分散、色は正本の「危険操作=赤焼き込み」が実装ゼロで正本と実装が逆転していた。px 階層・太さ・色の運用を reference の姿へ揃えて固定する（mdl-0019 開発統括決定・3論点とも案A）。',
    spec: [
      {
        type: 'p',
        text: 'ライブラリは lucide-react のみを使う（自作 inline SVG は拡張子アイコン・ステータスアイコンなど既存の特例のみ許容し新規には広げない）。サイズは次の通常4段階＋限定ヒーローの階層に収め、Tailwind 標準クラスで指定する。`size={14}` の numeric size prop・`width={14} height={14}` の数値属性・`h-[13px]` 等の任意値クラスはいずれも使わない（階層外の値が必要に見えたら最寄りの階層へ丸める）。',
      },
      {
        type: 'table',
        head: ['階層', 'クラス', '使う文脈'],
        rows: [
          [
            '標準（16px）',
            'h-4 w-4',
            'フォーム/カード操作・オーバーレイの閉じる×・見出し脇・検索入力内など、密度制約のない既定',
          ],
          [
            'コンパクト（14px）',
            'h-3.5 w-3.5',
            '一覧行内の操作（編集・削除等）・ツールバー・高密度領域（Desk/設定テーブル）',
          ],
          [
            '極小（12px）',
            'h-3 w-3',
            '表のソート指標・チップ内の閉じる×・折りたたみシェブロン等の最小要素',
          ],
          [
            '状態（20〜24px）',
            'h-5 w-5 / h-6 w-6',
            'Spinner・アラート・完了表示など単独配置の状態アイコン（通常の上限。大きめ空状態はヒーロー行）',
          ],
          [
            'ヒーロー（32〜40px）',
            'h-8 w-8 / h-9 w-9 / h-10 w-10',
            '認証系の画面中央ヒーロー（パスワード変更 KeyRound h-9・招待完了 CheckCircle2 h-10）と、空状態の大きめアイコン（task-tree ListTree h-8）に限定。通常の状態アイコン上限 h-6 は維持（mdl-0047）',
          ],
        ],
      },
      { type: 'demo', demo: 'icon-size-hierarchy', caption: 'サイズ階層の実物比較' },
      {
        type: 'note',
        text: '太さ: lucide アイコンに strokeWidth を明示指定しない（既定の 2 に固定。rete/reference とも明示ゼロで既に一本化済み）。自作 SVG（file-icon / desk-status-icons / Spinner の二重円 track+arc 等の特例）は細線・形のための opacity/strokeWidth を温存してよいが、線幅の指定は 1 箇所（コンポーネント側）に一元化し、JSX と CSS で二重上書きしない。同一 UI 領域（同じセル・同じ並び）に置く自作 SVG は線幅を単一値に揃える（desk-status 系は 1.5・mdl-0024）。Spinner の opacity-25/75 は二重円の形の一部であり opacity 禁止の対象外。lucide アイコンを opacity 直書きで薄めない（薄さの表現は text-[var(--sp-text-warm-mute)] 等の色トークンで行う）。',
      },
      {
        type: 'p',
        text: 'グリフの意味対応（1意味=1グリフ）: 同じ意味のアクションには必ず同じグリフを使い、下表の対応から逸脱しない（mdl-0024 開発統括決定・lucide 標準の意味に準拠し reference と同語彙）。',
      },
      {
        type: 'table',
        head: ['意味', 'グリフ', '備考'],
        rows: [
          ['追加 / 新規作成', 'Plus', '派生: フォルダ新規=FolderPlus・招待=UserPlus'],
          ['編集', 'Pencil', 'SquarePen / FilePen は使わない'],
          ['削除', 'Trash2', 'X を削除に使わない'],
          ['閉じる', 'X', 'オーバーレイ / チップの閉じる'],
          ['検索', 'Search', '—'],
          ['ダウンロード', 'Download', '—'],
          [
            'アップロード / 添付',
            'Upload / Paperclip',
            'UploadCloud は使わない（Upload に一本化）',
          ],
          [
            'コピー',
            'Copy',
            'Clipboard は操作のコピーに使わない（タグパレットの装飾グリフ候補としての Clipboard は操作対応表の対象外・mdl-0047）',
          ],
          ['アーカイブ / 復元', 'Archive / ArchiveRestore', '—'],
          ['設定', 'Settings', 'Settings2 は使わない'],
          [
            'クリア / 既定へリセット',
            'RotateCcw',
            '巻き戻しの意味に限定。純粋な再読込を作る時は RefreshCw を使う',
          ],
          [
            '列ソート指標',
            'ArrowUp / ArrowDown / ArrowUpDown',
            'Chevron 系はソートに使わない（reference の全テーブルと同語彙）',
          ],
          [
            '展開 / 折りたたみ',
            'ChevronDown / ChevronRight 等',
            'ツリー・セレクト・パンくずの向き表現',
          ],
          ['ドラッグ並べ替え', 'GripVertical', '—'],
        ],
      },
      {
        type: 'p',
        text: 'アイコン⇄ラベルの距離: icon+テキスト併記時の間隔は次の2値に固定する（mdl-0024 開発統括決定・reference の mr-1 と同値）。共通 Button（components/ui/button.tsx）は cva 基底に gap-1 を内蔵済みのため呼び出し側で指定しない。独自 CSS ボタン（.sp-action-btn / .tab-link / .file-tb-btn 等）は gap: 0.25rem。',
      },
      {
        type: 'table',
        head: ['文脈', '間隔', 'クラス'],
        rows: [
          [
            'ボタン / ツールバー / タブ',
            '4px',
            'gap-1（共通 Button は内蔵済み）/ CSS は gap: 0.25rem',
          ],
          ['チップ / Badge 内', '2px', 'gap-0.5'],
        ],
      },
      {
        type: 'table',
        head: ['色の場面', '方式', '備考'],
        rows: [
          [
            '既定',
            '指定なし（currentColor 継承）',
            'アイコンに色を焼き込まないのが原則。親（ボタン/テキスト）の色を継承する',
          ],
          [
            '危険操作（削除等）',
            '親ボタンを is-danger 系に: 平常 text-[var(--sp-text-warm-mute)]・hover で薄赤帯（color-mix red 10%）+ 赤文字',
            '平常は淡グレー・ホバーで薄赤帯 + 赤（.sp-row-icon-btn.is-danger / .sp-action-btn.is-danger / .file-tb-btn-danger が実装）。アイコン自体への赤の常時焼き込みはしない',
          ],
          [
            '意味のある着色',
            'text-[var(--sp-accent-teal)] / text-[var(--sp-accent-ink)] 等',
            '状態表示・完了チェック・画面ヒーローなど意味を持つ場合のみ。同じ役割のアイコンは同じ色にする',
          ],
        ],
      },
      {
        type: 'list',
        items: [
          'icon-only（アイコン単体・aria-label 必須）: 一覧行内の操作（削除・編集等）で使う。明細行にラベルを併記すると表の幅を圧迫するため、ラベルは付けない（開発統括決定）。枠は正方形（2rem）にし、アイコンは枠の水平中央へ置く（.sp-action-btn--icon-only の justify-content: center・set-0195）。',
          'icon+テキスト併記: フォーム・カード単位の操作（保存・新規登録等）で使う。行密度の制約がなく、操作の意味を文言で明示できるため。',
        ],
      },
      {
        type: 'demo',
        demo: 'icon-only-vs-text',
        caption: 'icon-only（一覧行内）と icon+テキスト（フォーム/カード）の使い分け',
      },
      {
        type: 'note',
        text: '色は Tailwind の任意値クラス（例: text-[var(--sp-accent-ink)]）で指定し、style={{ color: "var(...)" }} の inline style にしない（grep 性・一貫性のため）。ファイル種別色・ユーザー定義タグ色の hex は「種別を示す色」そのものなので本規約の対象外（温存）。',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: '一覧行内は h-3.5 w-3.5・削除は親ボタンの hover で赤（アイコンは無着色）',
          demo: 'icon-usage-good',
        },
      ],
      bad: [
        {
          text: 'width={14} 数値属性 + 赤の常時焼き込み + strokeWidth 明示',
          demo: 'icon-usage-bad',
        },
      ],
    },
  },
  {
    id: 'hover',
    title: 'マウスホバー表現（帯色 / 色変化 / cursor / ダウンロード）',
    navLabel: 'マウスホバー表現',
    category: 'ui',
    status: 'active',
    summary:
      '明細行=薄グレー帯のスライド追従（単一要素・ナビと同モーション語彙）/ メニュー=accent-soft+ink の2系統、ボタン=塗りは濃く・透明系はピンク帯出現、無効=not-allowed+減光、ドラッグ=grab を固定する。',
    sources: [
      'mdl-0020 現状調査（rete 全画面 + struct-pass-reference 横断・開発統括決定 2026-07-06）',
      'hom-0123 掲示板ラリー（明細 hover をスライド帯へ改訂・開発統括決定 2026-07-18）',
      '帯スライド共通仕様化（開発統括決定 2026-07-18・dsk-0386/dsk-0387/fil-0085/ref-0036 起点）',
      'components/ui/button.tsx（cva variant の hover/disabled 定義）',
      'app/globals.css（.home-row-hoverband / --sidebar-hover / --sp-nav-motion-* / --sp-accent-soft / --sp-accent-teal-strong）',
    ],
    purpose:
      'ホバーの帯色が3系統（row-hover / accent-soft / paper）に分裂し、無効時のカーソルも3方式（無反応 / 禁止マーク / 矢印）が混在していた。「押せるのか・掴めるのか・無効なのか」がマウスの反応だけで伝わる状態を固定し、揺れを構造的に止める。',
    spec: [
      {
        type: 'p',
        text: '帯スライドは共通仕様である（開発統括決定 2026-07-18）。行や項目単位のホバー反応を持つ常設の一覧的 UI ——明細テーブルの行・ツリーの行・サイドバーの項目・タブの列・セクションメニュー——は、行ごとに背景色を付ける方式ではなく、薄グレーの帯 1 枚が少し遅れてスライドして追いかけてくる方式で作る。適用範囲は rete の全タブと struct-pass-reference。押した時だけ現れて選ぶと消えるドロップダウン／ポップアップの候補メニューだけは対象外で、従来どおりピンク系（accent-soft）の静的ホバーのままとする。明細テーブルの帯は本体行（tbody の行）だけを追従し、列見出しの行（thead）は選べる行ではないため帯の対象外として固定する（d1238）。設定の一覧は共通部品 TableCard（hoverBand）と .sp-table--hoverband を使い、画面ごとに帯を書き写さない。',
      },
      {
        type: 'table',
        head: ['対象', '帯の向き', '帯色', '実装部品'],
        rows: [
          [
            '縦の一覧（明細行・ツリー行・サイドバー項目・セクションメニュー）',
            '縦に追従',
            '薄グレー hsl(var(--sidebar-hover))（黒5%）。ガラス下地のサイドバーは知覚できるよう黒9%を個別指定（cmn-0127）。reference の濃色サイドバーはテーマ変数を使わず直書き値（GlobalNav と同値）',
            'useRowHoverBand + .sp-row-hoverband',
          ],
          [
            '横のタブ列（グローバルメニュー・画面内タブ）',
            '横に追従',
            '同上（下地に応じた薄グレー）',
            '.nav-hoverband と同型',
          ],
          [
            'ドロップダウン／ポップアップの候補メニュー',
            '対象外（帯にしない）',
            'var(--sp-accent-soft) の静的ホバー',
            '—',
          ],
        ],
      },
      {
        type: 'p',
        text: 'ホバーの帯色は「明細行」と「メニュー・候補」の2系統のみを使う。第3の色（--sp-paper 等）や Tailwind 標準グレーを行 hover に使わない。',
      },
      {
        type: 'table',
        head: ['対象', 'hover 帯色', '文字色', '備考'],
        rows: [
          [
            '明細行（テーブル行・カード行・ツリー行）',
            '薄グレー帯 hsl(var(--sidebar-hover))（黒5%）。行個別の :hover 背景ではなく、絶対配置の単一帯要素が --sp-nav-motion-duration/ease でスライド追従する（ナビピル・サイドバーと同語彙）',
            '二次テキスト（日付・タグ等のメタ）のみ本文色へ濃化（即時）。主文字は変えない',
            '選択行は teal 内枠線（.sp-row-ring）だけを持ち面を持たないため、帯を覆い隠さない（行自身の背景が不透明なら帯は見えない・Desk の明細は選択と同時に詳細オーバーレイが被さるため hover 自体が起きない）。ファイルツリーの薄青の板ピルのみ帯を覆う。旧 --sp-row-hover #FDF1F4 の静的帯は廃止（hom-0123 改訂）',
          ],
          [
            'メニュー・ドロップダウン候補・行内操作ボタン',
            'var(--sp-accent-soft) #FCE4EC',
            'var(--sp-accent-ink)',
            'destructive 項目のみ薄赤帯 + --sp-accent-red 文字',
          ],
        ],
      },
      { type: 'demo', demo: 'hover-band', caption: '帯色2系統のライブ見本（マウスを載せて確認）' },
      {
        type: 'p',
        text: 'ボタン・リンクのホバーは次の3行規約で固定する。背景と文字を入れ替える完全な色反転は使わない。',
      },
      {
        type: 'list',
        items: [
          '塗りボタン（primary/teal・destructive/red）: 同色を濃くする。hover=var(--sp-accent-teal-strong) / active=var(--sp-accent-teal-strong-2)（赤は --sp-accent-red-strong）。hex 直書きしない。',
          '透明系（ghost / outline / アイコンボタン）: hover で var(--sp-accent-soft) 帯 + var(--sp-accent-ink) 文字を出現させる。',
          'テキストリンク: hover で下線を出す（色や透明度の変化で代替しない）。',
          'info-action（再送・確認・補助系・set-0132）: 常時 var(--sp-tone-blue)（hsl 210 85% 45% ＝ --info・cmn-0255 で AA 充足のため 50%→45%）帯 + 白文字。hover は同色のまま明度をわずかに落とす軽いフィードバックのみ（新規色トークンは追加しない）。透明系の「sp-accent-soft 帯」と視覚的に被る操作で、再送などの補助アクションを常時識別する用途に限定する（汎用塗りボタンへの転用はしない）。',
        ],
      },
    ],
    behavior: [
      {
        type: 'p',
        text: 'カーソルは要素の状態をそのまま表す。無効なものにカーソルが変わらない実装（pointer-events だけ殺す等）を作らない。',
      },
      {
        type: 'table',
        head: ['状態', 'cursor', '併用する表現'],
        rows: [
          ['クリック可能', 'pointer', 'hover 帯 / 下線などの hover 反応'],
          [
            '無効（disabled・無効リンク）',
            'not-allowed',
            'opacity 減光（0.3〜0.5）。hover 反応は enabled: ガード等で抑止する',
          ],
          ['ドラッグ可能', 'grab（掴んでいる間は grabbing）', 'グリップアイコン等'],
          ['ペイン境界のリサイズ', 'col-resize', 'hover で境界を teal 強調'],
        ],
      },
      { type: 'demo', demo: 'hover-cursor', caption: 'cursor 語彙の見本' },
      {
        type: 'note',
        text: '特例として既存の zoom-in（Desk 明細のオーバーレイ展開）・crosshair（タスク選択列）・progress（処理待ち）は用途固有の語彙として温存する（新規に語彙を増やさない）。',
      },
      {
        type: 'p',
        text: 'ファイルダウンロード可能な要素は用途で2形態に固定する。hover した時だけアイコンが現れる「隠し表現」は使わない（操作は常時可視）。',
      },
      {
        type: 'list',
        items: [
          '個別ファイル: ファイル名そのものをリンクにする（hover で下線 + pointer。ダウンロード実行中は not-allowed + 減光）。',
          '一括・エクスポート: Download アイコン付きの通常ボタンにする（hover は通常ボタン規約に従う）。',
        ],
      },
      { type: 'demo', demo: 'hover-download', caption: 'ダウンロード表現の2形態' },
    ],
    compliesWith: [
      { label: 'colorトークン直書き禁止（本タブ UI共通）' },
      { label: 'ボタン色規約（本タブ UI共通）' },
    ],
    examples: {
      good: [
        {
          text: '明細一覧は単一の薄グレー帯（--sidebar-hover）をスライド追従・無効ボタンは disabled:cursor-not-allowed + 減光',
          demo: 'hover-usage-good',
        },
      ],
      bad: [
        {
          text: '行ごとの静的 :hover 背景（旧 --sp-row-hover 含む）/ Tailwind 標準グレー / disabled で pointer-events だけ殺しカーソル無反応',
          demo: 'hover-usage-bad',
        },
      ],
    },
  },
  {
    id: 'search-highlight',
    title: '検索ハイライト',
    category: 'ui',
    status: 'active',
    summary:
      '検索一致箇所は共通クラス `.sp-search-hl`（薄い黄色）で表現する。実装は `src/lib/highlight.tsx` の highlightMatches（plain text）/ highlightRichText（sanitize済みHTML）に一本化する。',
    sources: ['rete-desk-0048（元実装）', 'cmn-0093（共通基盤への移設）'],
    purpose:
      '検索ハイライトは Desk チャットが最初に実装した後、各画面（タスク/Files/Settings/Home）へ横展開される（cmn-0092）。画面ごとに個別実装すると、色・class名・実装ロジックが割れて保守コストが N 倍になる（グローバル規約§3 コピペ禁止）。',
    spec: [
      {
        type: 'p',
        text: '検索一致箇所は `src/lib/highlight.tsx` の共通関数を通す。新規に個別実装（ローカル関数・独自 class 名）を作らない。',
      },
      {
        type: 'list',
        items: [
          'plain text（一覧の題名等）: highlightMatches(text, query) を使う。ReactNode を返す。',
          'sanitize 済み HTML（本文・description 等）: highlightRichText(cleanHtml, query) を使う。RichTextView がこの順（sanitize→highlight）を担保する。必ず sanitize 後の HTML にのみ適用する（sanitize 前に通すと XSS 経路になる）。',
          'CSS クラスは `.sp-search-hl`（globals.css）固定。薄い黄色・padding 無し（行高を変えない）。画面独自の色/クラスを作らない。',
        ],
      },
      {
        type: 'note',
        text: '大文字小文字を無視して一致。書式タグで分断された語（例: 太字で割れた「在<strong>庫</strong>」）はハイライトしない既知の仕様制限（テキストノード単位の走査のため）。',
      },
    ],
    compliesWith: [{ label: 'architecture-invariants §3 コピペ禁止（グローバル規約）' }],
    examples: {
      good: [
        {
          text: 'highlightMatches(text, query) を通し mark.sp-search-hl（薄黄色）で一致箇所を表現する',
          demo: 'search-highlight-usage-good',
        },
      ],
      bad: [
        {
          text: '画面独自の span + inline style（orange 背景等）でハイライトを手組みする',
          demo: 'search-highlight-usage-bad',
        },
      ],
    },
  },
  {
    id: 'focus-active',
    title: 'アクティブ表現（入力フォーカス / アクティブ明細行）',
    navLabel: 'アクティブ表現',
    category: 'ui',
    status: 'active',
    summary:
      '入力項目のフォーカス=枠線と同太さ 1px を --sp-focus-border（teal #1FB6A2）へ変える・シャドウ無し。アクティブ明細行=teal 内枠線 1px（行の内側に細い緑枠・面や影は持たない・静的）。板ピル（白い面＋柔影＋文字拡大）は mdl-0055 で廃止。明細行に引く teal 線（選択枠・キーボードフォーカス枠）は 1px に統一（cmn-0134）、タブのアクティブ下線だけは別語彙として 2px を保つ（cmn-0135）。',
    sources: [
      'mdl-0023 現状調査（rete全画面 + struct-pass-reference 横断・開発統括決定 2026-07-06）',
      'hom-0123 掲示板ラリー（選択行を teal inset 枠から板ピルへ改訂・開発統括決定 2026-07-18）',
      'hom-0133 / mdl-0055（板ピルの「明細が大きくなる」表現を廃止し teal 枠へ差し戻し・太さは旧 2px より細い 1px・開発統括決定 2026-07-20）',
      'cmn-0134（teal 線の太さを 1px へ一本化＝タブ下線 2px と行のフォーカス枠 2px を 1px へ揃える・rete 全画面 + リファレンス・開発統括決定 2026-07-20）',
      'cmn-0135（うちタブのアクティブ下線だけ 2px へ差し戻し＝1px では選択タブが見えづらい・行の枠 1px は維持・開発統括決定 2026-07-20）',
      'dsk-0401（Desk のチャット詳細/タスク詳細を閉じてもアクティブ枠を維持する方針へ差し戻し・開発統括決定 2026-07-21）',
      'app/globals.css（--sp-focus-border / 各 :focus ルール / .sp-row-ring::after の teal 枠。板ピル .sp-row-pill はファイルツリーの限定用途のみ残存）',
      'components/ui/input.tsx / textarea.tsx（focus-visible:border-[var(--sp-focus-border)]）/ select.tsx（focus:border-[var(--sp-focus-border)]）',
    ],
    purpose:
      'フォーカス表現が「teal 枠+にじみシャドウ / 枠のみ / outline 2px / 表現なし / shadcn ピンク ring」の5方式に分裂していた。「いまアクティブな場所」が同じ見た目で伝わる状態を固定し、色は --sp-focus-border の単一トークンで揺れを構造的に止める。',
    spec: [
      {
        type: 'p',
        text: 'アクティブ（フォーカス/選択中）の枠は teal（--sp-focus-border = --sp-accent-teal #1FB6A2）1色・太さ2種類のみを使う。シャドウ（にじみ・リング・offset 付き ring）は出さない。',
      },
      {
        type: 'table',
        head: ['対象', '枠の描き方', '太さ', 'シャドウ'],
        rows: [
          [
            '入力項目（Input / Textarea / Select / 検索窓・キーワード検索含む）',
            'border-color を --sp-focus-border へ変える（枠線の位置・太さは通常時のまま）',
            '1px（枠線と同太さ）',
            'なし（例外: 下記 .login-metal-card）',
          ],
          [
            '大型入力（コンポーザ / リッチテキストエディタ）',
            '本文入力領域（.desk-rte-body）の :focus-within で枠色だけ変える。ツールバーは焦点枠に含めない（外箱はニュートラルのまま・dsk-0367）',
            '1px',
            'なし',
          ],
          [
            'アクティブ明細行（Home 掲示板 / Desk タスク行 / チャット明細等・行選択の概念がある一覧）',
            'teal 内枠線: 行の内側に沿って細い緑枠を引く（.sp-row-ring::after の inset box-shadow。行の高さ・文字サイズ・背景は選択で変えない＝縞のリズムもそのまま）。行自身の box-shadow ではなく ::after に載せ、フォーカス枠と layer を分ける',
            '1px（旧 cmn-0098 の 2px より細い）',
            'なし。アクティブ化のエフェクト（アニメーション・拡大）は付けない＝静的表示',
          ],
          [
            'ファイルツリーの行選択（例外・fil-0084）',
            '薄青の板ピル（.sp-row-pill + --sp-input-soft-blue）。白背景のツリー上で teal 枠より面の方が視認差を取れるため、板ピル語彙を限定的に残す',
            '面で示す（枠は境界線のみ）',
            '柔影＋極薄リング',
          ],
        ],
      },
      {
        type: 'demo',
        demo: 'focus-active-demo',
        caption:
          '入力フォーカス（1px・シャドウ無し）とアクティブ明細行（teal 内枠線 1px）のライブ見本',
      },
      {
        type: 'list',
        items: [
          '色は必ず var(--sp-focus-border) を参照する（--sp-accent-teal 直参照や rgba 直書きの複製をしない）。',
          '入力欄（Input / Textarea / Select / Combobox・独自 CSS 入力クラス）の旧方式は廃止: にじみシャドウ（0 0 0 2px rgba(teal 18%)）/ outline 2px 実線 / shadcn 既定の ring-ring（ピンク）/「フォーカス表現を出さない」例外。Checkbox / Badge / Dialog close / Tabs 等の非テキスト入力部品には ring-ring が残存（本テーマの対象外・是正するなら別チケット）。',
          '例外: ログインのガラスカード（.login-metal-card）上の入力のみ、ガラス面＋シルバー背景で薄色 input が溶けるため、純白背景と focus 時の薄い teal にじみシャドウ（白縁+color-mix 28%）を許容する（rete-login-0001 で導入済み意匠・globals.css の .login-metal-card input:focus-visible。.sidebar-create-input が色だけ例外なのと同型の「場の例外」）。他画面へ横展開しない。',
          '選択行（teal 枠）と hover 帯（薄グレースライド帯）の関係: 選択行は z-index 2 で帯より前面に出るため、帯が滑ってきても緑枠は隠れない（帯自体は選択行にも掛かる）。マウスホバー表現テーマ参照。',
          'キーボードフォーカスの枠（.desk-chat-card / .desk-task-row / Home 明細行の focus-visible）も teal 1px（cmn-0134 で旧 2px から統一）。さらに選択行にフォーカスが乗った時はフォーカス枠を出さない（選択枠のみで一意に示す）。同色の枠が二重になって「選択行だけ枠が濃い」状態になるのを防ぐ（Home hom-0128 / Desk mdl-0055）。',
          'サイドバーのアクティブメニュー帯は「明細行の白い板ピル」ではなく、すりガラスの帯（Frosted Glass / hom-0131 → cmn-0133 で全画面共通の正本へ昇格）: 白 42% の半透明面＋内側 1px の白フチ＋やわらかいぼかし影＋角丸 8px、左右は margin-inline 6px でガラス枠から逃がす。サイドバーはガラス面（.app-sidebar::before の白40%+blur）の上に乗るため、不透明な白板だと別素材が乗って見える。半透明ゆえホバー帯が透けるので、active 行は hover 帯の測位対象から外す（各サイドバーの rowSelector で :not(.active)）。全5画面（Home / Desk / File / Model / Setting）とリファレンスが同じ意匠。Desk のチャネル行・メンバー/Space 行はクラスが別だが同じ選択帯で、塗りは行ラッパー（.sidebar-channel-row / .sidebar-member-row-wrap）が持つ（★/menu 区画まで届かせるため）。Desk の 組織/グループ/個人 は帯ではなくタブ（下線 teal 2px・cmn-0135）で別語彙。ファイルツリーの行選択は明細行側の規約に従う（サイドバーのメニュー帯ではない）が、色だけ薄青の板ピルを残す例外（fil-0084・上表）。',
          'サイドバーのアクティブピルとホバー帯は、左右の端が必ず同じ位置で揃う（rete・リファレンス共通仕様 / mdl-0056）。どちらもガラス枠の内側から左右 6px 逃がした位置に端を置く。作り方の決まりは3つ:（1）行を入れる器（.app-sidebar-scroll / reference の nav）には左右の余白を持たせない——ホバー帯は器の枠を基準に置かれるため、器に右余白を足すとピルだけが内側へ寄ってズレる（mdl-0054 の実害）。（2）逃がしは行側の margin-inline 6px だけが担う。（3）行が button 要素の時は width: calc(100% - 12px) を明示する——button は width:auto が「中身に合わせる」扱いになり左右 margin を差し引かないため、指定しないとピルだけ 12px はみ出す（Files と Model のサイドバーが該当）。この幅指定は globals.css の §サイドバー行の幅（@layer components の外）が単一ソースで、行の className へ w-full を足すのは禁止（後勝ちして同じズレが再発する）。',
          '行選択の概念が無い表（設定タブ .sp-table 等）にはアクティブ行表現を付けない。',
          'Desk のチャット詳細/タスク詳細のように行クリックで反対ペインへ詳細オーバーレイを開く画面では、詳細を閉じてもその行の teal 枠は消さず表示し続ける（次に別の行を開くまで保持・dsk-0401）。枠は「今オーバーレイが開いているか」ではなく「最後に開いた行はどれか」で描く——オーバーレイの開閉状態（トグル閉じ判定・aria-current・キーボードフォーカス残留抑止）とは別の状態源で駆動し、閉じる操作で枠まで消える結合を作らない。',
        ],
      },
    ],
    behavior: [
      {
        type: 'note',
        text: 'ボタンの focus-visible（teal 2px ring + offset・comp-button 規約 / rete-desk-0149）は「浮いた枠」でフォーカス巡回を示すボタン専用の別規約であり、本テーマ（入力項目・明細行）の対象外。struct-pass-reference も同じ --sp-focus-border トークンと規約を共有する（mdl-0023 で両リポ同時是正）。',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: '入力は focus で枠色だけ teal 化（1px・シャドウ無し）・選択行は teal 内枠線 1px（高さ・文字サイズは変えない・静的）',
          demo: 'focus-usage-good',
        },
      ],
      bad: [
        {
          text: 'focus ににじみシャドウ / ピンク ring / outline 2px / フォーカス表現を消す例外を作る',
          demo: 'focus-usage-bad',
        },
      ],
    },
  },
  {
    id: 'escape-key',
    title: 'Esc キーの挙動（キャンセル同等 / dirty 破棄確認 / 多層優先順位）',
    navLabel: 'Esc キー挙動',
    category: 'ui',
    status: 'active',
    summary:
      'Esc=キャンセル/×と同等（1回で効く）。入力・変更がある閉じ操作は破棄確認を挟み、未編集は即閉じる。編集モード中は編集解除のみ。多層時は手前の層だけが消費する。',
    sources: [
      'mdl-0034 現状調査（rete 全画面 + struct-pass-reference 横断・開発統括決定 2026-07-10）',
      'components/ui/overlay-dialog.tsx（dirty ガード内蔵 / useOverlayClose / OverlayCloseButton）',
      'hooks/use-discard-confirm.ts + components/ui/discard-confirm-dialog.tsx',
    ],
    purpose:
      'Esc の挙動が画面ごとに割れていた（即閉じ / 2段階 / 無反応 / 入力を無警告で破棄）。「Esc を押すと何が起きるか」を全画面で同じにし、書きかけの入力が黙って消える事故と、閉じたいのに閉じない苛立ちの両方を構造的に止める。',
    spec: [
      {
        type: 'p',
        text: 'Esc はその画面の「キャンセル / ×」ボタンと完全に同じ動きをする（規約①）。Esc だけの独自挙動（2回押し要求・無反応）を作らない。1回で効く。',
      },
      {
        type: 'list',
        items: [
          '規約② 入力・変更がある（dirty）閉じ操作は、経路（Esc / 背景クリック / キャンセル / ×）を問わず破棄確認ダイアログを挟む。未編集なら確認を出さず即閉じる。対象は全オーバーレイ・フォーム・編集モード。',
          '規約③ 編集モード（テーマ/メッセージ/コメント/インライン編集）中の Esc は「編集モード解除」のみ。画面（オーバーレイ）ごと閉じない。解除もキャンセルボタンと同じ dirty ガードを通す。',
          '規約④ 破棄確認ダイアログ自体も Esc で閉じられる（＝キャンセル扱い・編集継続）。確認表示中の Esc が背後の画面へ伝播して二重発火しない。',
          '規約⑤ 検索窓フォーカス中の Esc は入力クリア（画面は閉じない）。IME 変換確定の Esc（isComposing）は誤クリア・誤キャンセルしない。',
          '規約⑥ 「Esc で取消」の類のヒントラベルは表示しない（挙動が全画面共通なら都度の案内は不要・Ctrl+Enter 等の非自明ショートカットのみ案内する）。',
        ],
      },
    ],
    behavior: [
      {
        type: 'p',
        text: '規約⑦ 複数の層が同時に開いている時は「手前の層だけ」が Esc を消費する（stopPropagation で背後へ伝播させない）。優先順位は次の固定順。',
      },
      {
        type: 'table',
        head: ['優先', '層', 'Esc の効果'],
        rows: [
          ['1', '破棄確認ダイアログ（AlertDialog）', 'ダイアログを閉じる＝キャンセル（編集継続）'],
          ['2', 'メニュー・ドロップダウン・候補ポップアップ', 'その場で閉じる'],
          ['3', '編集モード（インライン編集含む）', '編集モード解除（dirty なら破棄確認）'],
          ['4', '検索窓（フォーカス中・入力あり）', '入力クリア'],
          ['5', 'オーバーレイ / フォーム画面', '閉じる（dirty なら破棄確認）'],
        ],
      },
      {
        type: 'p',
        text: '実装は共通部品へ寄せる（散文規約はドリフトするため）。OverlayDialog 系は dirty prop を渡すだけで Esc / 背景 / キャンセル / × の全経路が単一ガード（requestClose）を通る。children のキャンセル・×は親の onClose を直接呼ばず useOverlayClose()（または OverlayCloseButton / settings の OverlayCancelButton）を使う。',
      },
      {
        type: 'list',
        items: [
          'OverlayDialog を使わない独自シェル（file-overlay 体裁等）は useDiscardConfirm().request(isDirty, proceed) + DiscardConfirmDialog を直接組み込む（TagMasterOverlay が参照実装。TagPickerOverlay は fil-0080 で OverlayDialog へ移行済み）。',
          'window / document 直付けの keydown で setState 直行の「ガード素通り閉じ」を作らない（use-file-overlays の旧 window Esc は撤去済み）。',
        ],
      },
    ],
    compliesWith: [{ label: 'オーバーレイ用語 / Desk 画面命名（本タブ 構造）' }],
  },
  {
    id: 'table-actions-spacing',
    title: '表右上アクションと表の間隔',
    navLabel: '表アクション余白',
    category: 'ui',
    status: 'active',
    summary:
      '表の直上に接するアクションボタン行から表ヘッダ罫線までの間隔は 4px（0.25rem / mb-1）。フィルタエリア（検索・絞り込み）は表に接する層ではなく、その下に必ずアクション行が挟まる（Desk・設定一覧・掲示板・FAQ・カレンダー）。オーバーレイ内のアクション行のみ 8px（0.5rem / mb-2）許容。Files ツールバー帯（左寄せのセクション型）は対象外。',
    sources: [
      'cmn-0145（4px の共通仕様化）',
      'd1273（表右上の並びを Desk に統一・行とボタンの共通部品化）',
      'app/globals.css:2658（.desk-filter-bar.is-static.sp-filter-bar / フィルタ帯の制御点）',
      'app/globals.css:2672（.sp-list-action-row / 表直上アクション行＝4px・min-height 2rem）',
      'app/globals.css:7220（.tag-master-list-actions + .file-overlay-body / オーバーレイ 8px 許容の特例）',
      'app/globals.css:6717（.file-toolbar / 左寄せツールバー帯＝対象外）',
      'components/shared/list-actions.tsx（ListActionRow / ActionButton＝表右上アクションの共通部品）',
      'reference/packages/frontend/src/components/shared/list-page-actions.tsx:42（mb-1 ＝ 4px ／お手本）',
      'reference/packages/frontend/src/components/shared/data-table-card.tsx:78-81（表側マージンゼロ）',
      'features/model/content/screen-composition.ts「一覧画面」（4段の位置関係・d1273）',
    ],
    purpose:
      '表の直上にあるアクションボタン行から表ヘッダ罫線までの間隔が 4〜12px へ画面ごとに割れており、12px の画面ではボタンが表から浮いて見える（cmn-0145・開発統括指摘 2026-07-22）。一方で絞り込みの帯と操作ボタンを同じ層に混ぜると、画面ごとに並びが変わり「どこまでが絞り込みで、どこからが操作か」が読み取れなくなる（d1273・開発統括指摘 2026-11-12）。表に接するのは常にアクション行で、間隔は 4px の 1 値に固定する。',
    spec: [
      {
        type: 'p',
        text: '表ヘッダ罫線に直接接する行だけが本テーマの対象で、間隔は 4px（0.25rem / mb-1）。フィルタエリアはその上の層で、間にアクション行を挟む（画面構成「一覧画面」の4段）。',
      },
      {
        type: 'table',
        head: ['パターン', '間隔', '備考'],
        rows: [
          [
            '表直上のアクション行（透過地・枠なし・表に接する独立行）／既定',
            '4px（mb-1 / 0.25rem）',
            'reference ListPageActions mb-1 の値を正式採用。rete は Desk・設定 6 画面・掲示板・FAQ・カレンダー予定一覧の .sp-list-action-row が準拠（掲示板・FAQ の「新規登録」も d1273 でこの行へ移した）。行の高さは 2rem を常に確保し、権限でボタンが 0 個でも縮めない。',
          ],
          [
            'フィルタエリア（検索・絞り込みの帯）',
            '表には接しない（間にアクション行が入る）',
            '帯の中に操作ボタンを戻さない（d1273）。タイトルからフィルタエリアまで・フィルタエリアから下の段までの間隔は画面構成「一覧画面」が持つ。',
          ],
          [
            'オーバーレイ内の表の手前アクション行',
            '8px（mb-2 / 0.5rem）許容',
            'タグ管理（.tag-master-list-actions + .file-overlay-body の padding-top: 0.5rem）など、意図的に余白を広げている既存特例＝正本に明記し潰さない。',
          ],
          [
            'Files ツールバー帯（左寄せ・border-top で繋がる）',
            '対象外',
            '.file-toolbar は「表右上ボタン」型ではなく、左右に伸びるツールバー帯（左寄せ＋border-top）。本テーマの管理範囲外（ボタン寸法だけは共通グループに揃える＝d1273）。',
          ],
        ],
      },
      {
        type: 'note',
        text: '新規に「表右上ボタン型」を作る際は 4px を既定とする。8px を使う時はオーバーレイ内に閉じるか、対応履歴に意図的理由を残す（5〜12px の数値を闇で増やさない＝ボタンが表から浮いて見える回帰の構造的防止）。フィルタエリアと表の位置関係は本テーマではなく画面構成「一覧画面」が持つ（同じ帯に複数の解釈が生まれないよう、対象を「表に接する行か」で切り分ける）。',
      },
    ],
    compliesWith: [
      { label: 'ボタン色規約（本タブ UI共通）' },
      { label: 'カラー/フォント（reference 横断で同じトークンを使う）' },
    ],
    examples: {
      good: [
        {
          text: '表直上のアクション行を mb-1 / 0.25rem で置く（reference ListPageActions 同値）。ボタンは表ヘッダ罫線に 4px で接し、権限でボタンが無くても行の高さは保たれる',
          demo: 'table-actions-spacing-good',
        },
      ],
      bad: [
        {
          text: '表に接するアクション行へ 12px の隙間を空けてボタンと表が浮いて見える / オーバーレイなのに 4px へ詰めて特例潰し / 操作ボタンを絞り込み帯の中へ戻して画面ごとに並びが変わる / Files ツールバー帯を本テーマへ寄せようとする',
          demo: 'table-actions-spacing-bad',
        },
      ],
    },
  },
  {
    id: 'known-ui-debt',
    title: '既知のUI負債（漸近収斂対象）',
    navLabel: '既知のUI負債',
    category: 'ui',
    status: 'active',
    summary:
      '即改修せず「該当箇所への次回改修時に収斂」させる既知の UI 実装分裂の債務台帳。新規実装は必ず各項目の収斂先を使い、既存箇所を触る改修では合わせて収斂させる。',
    sources: [
      'cmn-0164（integrity-review 2026-07-23 U-L1/U-L3 の債務台帳化）',
      'plans/integrity-review-rete-2026-07-23.md',
    ],
    purpose:
      '複数シェルに跨る UI 実装の分裂は一括修正すると影響範囲が広く、かといって記録しないと次の 開発エージェントが気づけず分裂が増殖する。「収斂先」を正本へ明記し、該当箇所を触るタイミングで漸近的に一本化する（即改修必須ではない）。',
    spec: [
      {
        type: 'p',
        text: '本テーマは規範ではなく債務台帳。各項目の「収斂先」が正であり、新規コードは収斂先のみを使う。既存の分裂実装を触る改修では、当該箇所を収斂先へ寄せることを改修スコープに含める。解消した項目は本台帳から削除する。',
      },
      {
        type: 'table',
        head: ['項目', '現状の分裂', '収斂先'],
        rows: [
          [
            'U-L1: 行内 編集/削除チップ',
            'dashboard-view.tsx:242-253（お知らせ行）と features/shell/components/favorites-manage-overlay.tsx:226-234（削除ボタン）が ad-hoc Tailwind 直組み。同じ dashboard-view.tsx:652-658 は Button variant="sp-action" size="sp-compact"（cva 経由）で重複',
            'Button variant="ghost" size="sp-compact" 相当（cva 経由）へ寄せる。行内チップを新設する時は cva Button を使い、素の Tailwind 直組みを増やさない',
          ],
          [
            'U-L3a: 閉じる×ボタン',
            'desk-pane-close / desk-catset-icon-btn / file-overlay-close + OverlayCloseButton とシェル別に寸法・色が微差分裂',
            'OverlayCloseButton（共有コンポーネント）へ収斂。新規オーバーレイは必ず OverlayCloseButton を使う',
          ],
          [
            'U-L3b: 行末アイコンボタン',
            '.desk-catset-icon-btn（1.625rem・--sp-text-warm-2）vs 共用 .sp-row-icon-btn（1.75rem・hsl(var(--foreground)/0.7)）',
            '.sp-row-icon-btn（globals.css:994・共用クラス）へ収斂。desk 固有クラスの寸法・色バリエーションを増やさない',
          ],
        ],
      },
      {
        type: 'note',
        text: 'なお U-L2（cva Button の default と sp-primary の重複）は cmn-0164 で解消済み（default は sp-primary と同一クラス文字列を共有するエイリアス＝button.tsx の spPrimaryClasses）。',
      },
    ],
    compliesWith: [{ label: 'ボタン色規約（本タブ UI共通）' }],
  },
];
