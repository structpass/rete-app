import type { ModelTheme } from '../types';

/** 画面構造・モデル概念カテゴリの共通仕様テーマ。 */
export const STRUCTURE_THEMES: ModelTheme[] = [
  {
    id: 'thread-shared-model',
    title: 'Thread 共通基底モデル',
    category: 'structure',
    status: 'active',
    summary: 'スレッド=チャット/タスク共通基底。タスク=スレッド＋管理情報。昇格は物理削除しない。',
    sources: ['memory: project_thread_shared_model'],
    purpose:
      'チャットとタスクは情報管理の基底（スレッド）を共有する。この概念を揃えないと昇格や一覧導出のたびに場当たり実装が増える（2026-06-01 設計方針）。',
    spec: [
      {
        type: 'list',
        items: [
          'スレッド = チャットとタスクに共通する情報管理の基底（メッセージ群・議論）。',
          'チャット = スレッドそのもの。',
          'タスク = スレッド情報 ＋ タスク管理情報（担当/期日/ステータス/カテゴリ等）。',
        ],
      },
    ],
    behavior: [
      {
        type: 'p',
        text: '昇格（チャット→タスク D&D）時: そのスレッドは「タスクのスレッド」へ移った扱いになり、チャット明細（一覧）からは消すが物理削除しない。',
      },
      {
        type: 'list',
        items: [
          '専用フラグ列を持たず ChatTheme.promotedTasks（Task.sourceThemeId 片方向リンク）の有無から「昇格済み＝非表示」を導出（非正規化を避ける）。一覧 where に promotedTasks: { none: {} }。',
          'スレッド詳細（findThemeDetail / findThemeById）は意図的にフィルタしない — タスク詳細の「元チャット」リンクが昇格元を id 直引きで開くため（一覧から消えても id アクセスは生かす）。',
        ],
      },
    ],
    relatedAdr: [{ label: 'ADR 0004 conversation hierarchy auth deferred（関連）' }],
    examples: {
      good: ['昇格＝Task 新規作成 + sourceThemeId リンク。一覧非表示はリレーションから導出。'],
      bad: ['昇格時にチャットを物理削除する / 「昇格済み」フラグ列を非正規化で持つ'],
    },
  },
  {
    id: 'space-model',
    title: 'Space 統一モデル（組織＞プロジェクト＞チャネル）',
    navLabel: 'Space 統一モデル',
    category: 'structure',
    status: 'active',
    summary: 'マルチユーザー化の器は統一 Space モデル（組織＞プロジェクト＞チャネル）。',
    sources: ['memory: project_desk_admin_target_model', 'ADR 0037'],
    purpose:
      'desk のマルチユーザー化に向け、組織/グループ/個人のサイドバー分類を場当たりに増やさず、一本の統一モデルで器を表現する。',
    spec: [
      {
        type: 'p',
        text: 'desk の管理対象は統一 Space モデルで表す: 組織 ＞ プロジェクト ＞ チャネル の階層（ADR 0037）。サイドバーは組織|グループ|個人の分類を Space で導出する。',
      },
      {
        type: 'note',
        text: 'selectedSpaceId は Context で保持し、use-desk-view-state の A1 状態機械とは直交（オーバーレイ開閉状態と混ぜない）。お気に入り space は /desk?spaceId= で deep-link 復元。',
      },
    ],
    relatedAdr: [{ label: 'ADR 0037 cm2 org model unified space' }],
  },
  {
    id: 'chat-theme-premise',
    title: 'チャット=テーマ前提',
    category: 'structure',
    status: 'active',
    summary: 'Desk チャットはテーマ（タイトル付きスレッド）前提で設計。無題発話主役は誤り。',
    sources: ['memory: feedback-desk-chat-theme', 'CLAUDE.md（rete）'],
    purpose:
      '業務連絡には必ずテーマがある（発信者が言語化していないだけ）。無題チャットは「見返して何の話か分からない」病理を抱える。Desk が目指すのは振り返りやすい形。',
    spec: [
      {
        type: 'p',
        text: 'Desk のチャットは「テーマ＝タイトル付きスレッド」を前提に設計する。軽量・無題の発話を主役に据える方向（Slack/Teams 的な流れる雑談）は誤り。軽量発話は既存テーマにぶら下がる「スレッド内コメント」が担う。タイトルが要るのは新テーマ起票時のみ。',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          '新規チャット改善で「無題で逃がす」UI を足さない。代わりにテーマ言語化を支援する。',
          '仮タイトルで起票し会話が固まってから確定を促す（起票時に言語化を強制しない）。',
          'タイトル＝短い見出しの規律（長文タイトルは振り返り性を損なう。data-thread-title はモック desk/index.html 由来の属性で React 実装には無い）。',
        ],
      },
    ],
    compliesWith: [{ label: '本タブ 画面構造「Thread 共通基底モデル」' }],
  },
  {
    id: 'test-placement-and-mock-boundary',
    title: 'テスト配置とモック境界',
    category: 'structure',
    status: 'active',
    summary:
      'backend の spec は実装の横（co-location）／frontend は `__tests__/`。モックは実装が触る境界に合わせる。',
    sources: [
      'チケット cmn-0203（/rev-integrity 2026-07-26 の元指摘10）',
      'チケット cmn-0162（frontend 配置の決着）＝コミット 7d26eaa（frontend 4ファイル・分裂2組を `__tests__/` へ統合）',
      'packages/backend/src/modules/chat/{chat.controller.spec.ts, chat.service.spec.ts, repositories/chat.repository.spec.ts}（backend のモック境界の実測起点）',
      'packages/frontend/{vitest.config.ts, vitest.setup.ts, src/test-utils/flush.ts} と src/features/desk/__tests__/use-task-comments.test.ts（frontend setup の実測起点）',
    ],
    purpose:
      '「どちらの流儀も見かける」状態だと新しく spec を書くたびに選び直すことになり、揺れが増え続ける。基準を1箇所に置いて新規の迷いを消す。既存 spec の全件統一はしない（差分の量産に見合う改善が無い）。',
    spec: [
      {
        type: 'table',
        head: ['観点', '対象', '正', '例外 / 補足'],
        rows: [
          [
            '配置',
            'backend',
            'spec は実装ファイルの横に置く（`foo.service.ts` の隣に `foo.service.spec.ts`）。',
            '複数 module にまたがる共有ヘルパ本体とその spec のみ `src/__tests__/` を許容（例: `src/__tests__/factories.ts`）。module 配下の `__tests__/` は作らない。',
          ],
          [
            '配置',
            'frontend',
            'test は実装の隣ではなく `__tests__/` に置く（backend と逆なので取り違えない）。feature 直下（`features/desk/__tests__/`）でも feature 内サブディレクトリ直下（`features/desk/hooks/__tests__/`）でもよく、共有の `components` / `hooks` / `lib` も各ディレクトリ直下の `__tests__/`。',
            '同一対象の test を co-location と `__tests__/` に分裂させない（cmn-0162 で方針決着＝分裂していた2組を統合。既存の全件移動はしていない）。既存の co-location は 11 本（実測。内訳は `src/hooks/` の 7 本と `features/*/hooks/` の 4 本＝dashboard 2・files 1・user-table-column-widths 1）。11 本は既存として動かさないが、例外はこの 11 本に限る＝feature 配下の hooks にも新規 spec は `__tests__/` へ置く。',
          ],
          [
            'モック境界',
            'backend',
            '実装が直接依存する1つ下の層だけを差し替える（controller spec は service を `provide`、service spec は repository を `provide`、repository spec は `PrismaService` を `provide`）。2026-07-29 実測（`35aca4d` 時点・数えているのは「どの層を差し替えたか」＝境界）: controller spec 29件で Repository / PrismaService を直接差し替えるものは 0 件、repository を注入する service の spec 30件は 30件とも repository を差し替え、repository spec 27件は 27件とも `PrismaService` を差し替え。差し替え方は `provide` と直接インスタンス化（`new XxxService(mockRepo as never)`）の2通りで内訳は service 25/5・repository 23/4 だが、書き方が違うだけで境界は同じ（repository 側の4件は mock 変数ではなく fake prisma のオブジェクトリテラルを直接渡す形）。新規 spec でどちらの書き方を採るかは本表の setup / backend 行に従う。',
            'repository を持たない service は `PrismaService` を直接差し替えてよい（実測2件・`app.service.spec.ts`＝`provide` / `modules/auth/oidc/oidc-purge.service.spec.ts`＝直接インスタンス化）。`jest.mock()` はモジュールごと差し替えるしかない外部 npm パッケージ限定（実測5件: mail.service / session-store.config / auth.service / oidc-config.factory / invite.service の各 spec）。`$transaction` を通る repository spec は tx クライアントのモックを別途渡す。本欄の件数も正欄と同時点の実測。',
          ],
          [
            'モック境界',
            'frontend',
            "実装が実際に触る境界へ合わせる。実装が api-client を通るなら `vi.mock('@/lib/api-client')`、実装が生 `fetch` を叩くなら `vi.stubGlobal('fetch')`。",
            '「api-client モックが常に正」ではない。実装より内側/外側をモックすると、通っているつもりの経路が検証されない。',
          ],
          [
            'setup',
            'backend',
            'DI・guard・interceptor が絡むなら `Test.createTestingModule`（jest + @nestjs/testing）。依存を手渡しできる純ロジック service は直接インスタンス化でよい。',
            '新規に適用する基準であり、既存 spec の setup 方式は書き換えない（2026-07-26 時点の実測で TestingModule と直接インスタンス化が拮抗＝多数派が存在しない）。',
          ],
          [
            'setup',
            'frontend',
            '`vi.hoisted()` で mock 関数を宣言し、直下の `vi.mock` factory からそれを参照してから実装を import する。以下 2026-07-29 実測（`35aca4d` 時点・test / spec ファイル 163 件が母集団）: vi.mock 使用 84 ファイル中 82（cmn-0142 で統一）。hook は `renderHook`（47ファイル）、DOM 操作は `fireEvent` が既定（59ファイル／`userEvent` は15の少数派）、非同期の確定待ちは `waitFor`（49ファイル）か共有ヘルパ `src/test-utils/flush.ts`（16ファイル・cmn-0137 で逐語重複を集約）。',
            '新規に適用する基準であり、既存 test の setup 方式は書き換えない（backend の setup 行と同じ扱い）。`renderHook` は wrapper なしが既定（wrapper 付きは2ファイル・正欄と同時点の実測）。mock のリセットは各 spec に書かず vitest 設定側で一律に効かせる（cmn-0225＝backend の cmn-0215 と同じ趣旨。ただしフラグ名は異なり、frontend は vitest の `mockReset` / `restoreMocks`、backend は jest の `resetMocks` / `restoreMocks`）。jsdom の欠損 API 補完と jest-dom matcher は `vitest.setup.ts` が持つので spec 側で再実装しない。',
          ],
        ],
      },
      {
        type: 'note',
        text: '本表の件数を数え直す時は対象を spec / test ファイルに絞る（`--include=*.spec.ts` や `*.test.ts(x)` 等）。本ファイル自身が `vi.mock` などの語を本文として含むため、絞らずに `grep -rl <語> src` を打つと本ファイルが混ざって +1 ずれる。',
      },
    ],
    examples: {
      good: [
        'backend: modules/chat/chat.service.spec.ts（実装の横）',
        'frontend: features/desk/__tests__/task-detail-overlay.test.tsx / features/desk/hooks/__tests__/…（どちらも可）',
        "実装が生 fetch を叩く関数のテストで vi.stubGlobal('fetch') を使う",
      ],
      bad: [
        'backend: modules/chat/__tests__/chat.service.spec.ts（module 配下の __tests__）',
        'frontend の test を backend に合わせて co-location へ動かす（cmn-0162 の方針に逆行）',
        '既存 spec の setup 方式を統一目的だけで書き換える',
      ],
    },
  },
];
