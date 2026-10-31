import type { ModelTheme } from '../types';

/** 用語・命名カテゴリの共通仕様テーマ。 */
export const NAMING_THEMES: ModelTheme[] = [
  {
    id: 'overlay-terminology',
    title: 'オーバーレイ用語',
    category: 'naming',
    status: 'active',
    summary: '重ね表示は「オーバーレイ画面 / ビュー」。「オーバーライド」は誤用なので使わない。',
    sources: ['memory: feedback-overlay-terminology', 'CLAUDE.md（rete）'],
    purpose:
      '元コード（desk/index.html 等）が「オーバーライド」を UI 文脈で誤用していた。用語が割れると会話・コメント・命名で概念を一意に指せない。',
    spec: [
      {
        type: 'p',
        text: '既存ペインの上に重ねて表示する画面/領域は「オーバーレイ画面」「オーバーレイビュー」で統一する。コメント・会話文・PR タイトル・docs の新規記述は全てこの語彙を使う。',
      },
      {
        type: 'table',
        head: ['用語', '意味'],
        rows: [
          ['オーバーレイ (overlay)', '別レイヤーで重ねる「実装の仕組み」'],
          ['モーダル (modal)', '閉じるまで背景操作を受け付けない「操作排他性」'],
          ['モードレス', '背景操作も並行可能な重ね表示'],
          [
            'オーバーライド (override)',
            '同じ領域で内容を差し替える ≠ レイヤー的に重ねる（UI 文脈では誤用）',
          ],
        ],
      },
      {
        type: 'note',
        text: 'Desk のタスク詳細/チャット詳細は厳密にはモードレス・オーバーレイ（背景も触れる）。二重オーバーレイ禁止: タスク昇格フォーム(promote)とタスク詳細(detail)は排他で同時に開かない。',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          '新規クラス名/変数名で UI を指す時は overlay ベース（例: overlay-view）。',
          '既存 is-overlaid-left / is-overlaid-wide は "overlaid" ベースで正しい命名なので維持。',
          '既存「オーバーライド」表記は Surgical Changes に従い、別件で触る時に併せて修正（一括置換は不要）。',
        ],
      },
    ],
    compliesWith: [{ label: '本タブ 用語・命名「Desk 画面命名」' }],
  },
  {
    id: 'desk-screen-names',
    title: 'Desk 画面命名',
    category: 'naming',
    status: 'active',
    summary: 'Desk 4画面＋昇格フォームは「ｘｘ明細／ｘｘ詳細」で統一。',
    sources: ['memory: feedback-desk-screen-names', 'CLAUDE.md（rete）'],
    purpose:
      'Desk 画面に正式名が無く、コードも「タスクツリー」「スレッド表示」など不統一で、会話で画面を一意に指せなかった（2026-05-21 開発統括命名）。',
    spec: [
      {
        type: 'table',
        head: ['正式名称', '配置', 'コード識別子'],
        rows: [
          ['チャット明細', '左ペイン・常時表示', 'data-left-view="list"'],
          ['タスク明細', '右ペイン・常時表示', 'data-right-view="tree"'],
          ['チャット詳細', '右ペイン・オーバーレイ', 'data-right-view="thread"'],
          ['タスク詳細', '左ペイン・オーバーレイ', 'data-left-view="detail"'],
          ['タスク昇格フォーム', '左ペイン・オーバーレイ', 'data-left-view="promote"'],
        ],
      },
      {
        type: 'p',
        text: '「明細」=常時表示の一覧、「詳細」=1件をオーバーレイで重ねた画面。タスク昇格フォーム(promote)はチャット明細カードをタスクツリーへ D&D した時に開き、タスク詳細(detail)と排他（二重オーバーレイ禁止）。',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          '「スレッド」は画面名に使わず、画面内タブ名としてのみ使用。',
          'スレッドタブを指す時は必ず画面名を前置（例: 「チャット詳細のスレッドタブ」）。',
        ],
      },
    ],
    compliesWith: [{ label: '本タブ 用語・命名「オーバーレイ用語」' }],
  },
  {
    id: 'plural-case',
    title: '複数形・case規約',
    category: 'naming',
    status: 'active',
    summary:
      '「分類」は category に固定する。classification は休眠中の Desk 宛先グルーピング専用で、新規に増やさない。',
    sources: ['v2-229（/rev-integrity 2026-09-25 の naming 観点）'],
    purpose:
      '同じ「分類」が category / classification / カテゴリ の3表記で並存し、新規にどれを使うかを決める規約が無かった。放置すると同じ概念が場所ごとに別名で増え、設計意図が読めなくなる。',
    spec: [
      {
        type: 'table',
        head: ['概念', '正', '実体'],
        rows: [
          [
            'タスクの分類（マスタ・列・route・enum）',
            'category',
            'model Category / categoryId / categories コントローラ。日本語で「分類」「分類マスタ」「分類設定」と呼ぶのはこちら。',
          ],
          [
            'Desk 宛先のグルーピング',
            'classification（既存のみ・増やさない）',
            'model DeskGroupClassification / desk-groups 配下の classifications サブルート。frontend の消費者は 0 件で休眠中（ADR 0079）。',
          ],
        ],
      },
      {
        type: 'note',
        text: '新規に「分類」を表す型・列・route・コメントを書く時は category を使う。classification は休眠中の Desk 側の既存名としてだけ残し、増やさない（撤去もしない・ADR 0079）。',
      },
      {
        type: 'note',
        text: 'コレクションを持つ API ルートは複数形にする（categories / themes / messages）。単数形で据え置くのは既存 URL 互換の /chat だけで、配下（chat/themes・chat/themes/:id/messages）が複数形なので新規に増やさない。',
      },
    ],
    compliesWith: [{ label: '本タブ API・データ共通「response shape・命名」' }],
  },
  {
    id: 'direct-message-terminology',
    title: 'ダイレクトメッセージ用語',
    category: 'naming',
    status: 'active',
    summary:
      'Desk 個人タブの 1:1 DM セクション見出しは「ダイレクトメッセージ」で統一（dsk-0353）。',
    sources: [
      'dsk-0353 /discover 決定ログ docs/discover/specs/2026-07-11-membership-addition-ux-design.md',
    ],
    purpose:
      '旧来の「関係者」表記は実体（DM 作成）と一致せず、ボタン／ピッカー／見出しで語が割れていた。利用者の誤クリック経路にもなる（候補クリックで DM 作成が即確定していた）。',
    spec: [
      {
        type: 'table',
        head: ['旧表記', '新表記', '備考'],
        rows: [
          [
            '関係者（セクション見出し）',
            'ダイレクトメッセージ',
            '実体＝1:1 DM チャットルーム作成（POST /spaces{kind:PERSONAL_DM}）と一致',
          ],
          [
            '「メンバーを追加」（＋ボタン）',
            '「ダイレクトメッセージを追加」',
            'title / aria-label とも更新',
          ],
          [
            '「この人とDMを開始しますか？」（確認ダイアログ）',
            '「{名前} とダイレクトメッセージを開始しますか？」',
            '候補名を埋め込んだ具体化版で誤クリック抑止',
          ],
        ],
      },
      {
        type: 'note',
        text: 'ピッカー内部の placeholder/aria-label/emptyMessage（既定「メンバーを検索」「追加できるメンバーがいません」）は呼び出し側（desk-sidebar.tsx）で DM 文言に上書きして使う。新規呼び出しを追加する時は DM 文言を必ず渡すこと。',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          '「関係者」表記を新規コード／UI に持ち込まない（既存は Surgical Changes に従い別件で触る時に修正）。',
          '＋ボタン／ピッカーの文言とセクション見出しが同じドメイン語彙（「ダイレクトメッセージ」）で揃う状態を保つ。',
          '確認ダイアログの文言は候補名を埋め込み、利用者が誰との DM か即座に分かる形にする。',
        ],
      },
    ],
    compliesWith: [{ label: '本タブ 用語・命名「Desk 画面命名」' }],
  },
  {
    id: 'management-group-membership-terminology',
    title: '管理グループ / 所属管理',
    category: 'naming',
    status: 'active',
    summary:
      '管理グループはユーザーを束ねるだけの器。組織・プロジェクト・チャネルへの参加先は所属管理で管理グループ単位に設定する。',
    sources: ['set-0188（開発統括指示 2026-08-29）'],
    purpose:
      '個人ごとの参加先設定による作業量と誤設定を避け、ユーザーの束ねと参加先の編集責務を分離する。',
    spec: [
      {
        type: 'table',
        head: ['用語', '実体', '責務'],
        rows: [
          ['管理グループ', 'UserGroup + UserGroupMember', 'ユーザーの作成済み集合を管理する'],
          [
            '所属管理',
            'UserGroupScopeGrant',
            '管理グループ単位で組織・プロジェクト・チャネルへの参加ロールを編集する',
          ],
        ],
      },
      {
        type: 'note',
        text: 'direct Membership は既存データ・API・実効認可で維持するが、所属管理の画面とmatrix responseには表示しない。管理グループを削除すると、そのグループの所属設定と所属ユーザーも同時に削除され元に戻らない（アーカイブ/復元は持たない）。',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          '管理グループ一覧では新規作成・編集・削除だけを扱い、作成と改名・ユーザー追加/除外は一覧から遷移するサブ画面で行う。',
          '参加先の編集は所属管理だけで行い、個人アカウント列は設けない。',
        ],
      },
    ],
  },
];
