import type { ModelTheme } from '../types';

/**
 * 「UIコンポーネント」カテゴリ — 1テーマ＝1コンポーネント。
 * rete 共通UI実体（components/ui/*）と features 固有の反復パターンを対象に、各コンポーネントの
 * variant / size / 状態 / 使いどころの規約を集約する（rete-model-0002）。
 * 全12テーマ active 化済み（mdl-0003/0005/0006/0007。stub 段階は完了）。
 */

export const UI_COMPONENT_THEMES: ModelTheme[] = [
  {
    id: 'comp-button',
    title: 'Button',
    category: 'ui-component',
    status: 'active',
    summary:
      'ボタンは cva の variant × size で型化。色は塗り種別で決め（→ボタン色規約）、loading は Spinner + 自動 disabled で一体化。',
    sources: [
      'components/ui/button.tsx',
      'memory: feedback-button-color-convention',
      'mdl-0035（ラベル正規化・variant 対応・アイコン併記）',
    ],
    purpose:
      'ボタンの variant / size / 状態を 1 コンポーネントへ集約し、画面ごとの個別実装や色の分裂・focus 表現の揺れを防ぐ。',
    spec: [
      {
        type: 'p',
        text: '新規ボタンは variant と size を選ぶだけにし、hex 直書きや個別 class での見た目作り込みをしない。color は塗り種別 → トークンのマッピング（ボタン色規約）に従う。',
      },
      {
        type: 'table',
        head: ['variant', '塗り種別 / 用途', '見た目'],
        rows: [
          [
            'default / sp-primary',
            '主要アクション（塗り）',
            '緑塗り var(--sp-accent-teal) + 白文字、hover var(--sp-accent-teal-strong) / active var(--sp-accent-teal-strong-2)',
          ],
          [
            'sp-action',
            '副次アクション（背景なし）',
            '通常 neutral 文字 var(--sp-text-warm-2)、hover で背景 var(--sp-accent-soft) + ink 文字 var(--sp-accent-ink)',
          ],
          ['destructive', '削除・破棄', '赤 var(--sp-accent-red)（AlertDialog destructive と対）'],
          [
            'outline / secondary / ghost / link',
            '汎用（shadcn 系）',
            '枠線 / 弱塗り / 透明 / リンク文字',
          ],
        ],
      },
      { type: 'demo', demo: 'button-variants', caption: 'variant 一覧' },
      {
        type: 'table',
        head: ['size', '寸法', '用途'],
        rows: [
          ['default', 'h-10 px-4', '標準'],
          ['sm', 'h-9 px-3', '小'],
          ['lg', 'h-11 px-8', '大'],
          ['icon / icon-sm', 'h-10 w-10 / h-7 w-7', 'アイコンのみ'],
          [
            'sp-compact',
            'h-8 px-3 text-xs（variant="sp-action" 併用時は .8125rem）',
            'ツールバー等の高密度行',
          ],
        ],
      },
      { type: 'demo', demo: 'button-sizes', caption: 'size 一覧' },
      {
        type: 'list',
        items: [
          'loading=true → 先頭に Spinner を出し、disabled || loading で自動的に不活性化する（二重送信防止）。非同期操作は操作ごとのフラグ（保存中 / 送信中 等）を loading へ渡し、処理中の再入を全経路で塞ぐ。無効化を持たない独自ボタン・独自シェルを作らない（点検: 新規・変更した非同期操作が、処理中にどの経路からも再入できないか）。',
          'focus-visible は teal 2px ring + offset で「浮いた枠」を出す（rete-desk-0149。旧 inset box-shadow は実質不可視だった）。',
          'disabled は opacity-50 + cursor-not-allowed（pointer-events-none は不採用＝カーソルが変わらず「押せそうで押せない」が起きるため。hover 抑止は enabled: ガードで行う）。角丸は基底 rounded-[0.1875rem]・透明系（sp-action）は rounded-[0.375rem]（v2-224 / ADR 0081）。',
        ],
      },
      { type: 'demo', demo: 'button-states', caption: 'loading / disabled の状態' },
      {
        type: 'p',
        text: '保存/送信系ボタンのラベル・variant・アイコンは以下の 3 表で固定する（mdl-0035・開発統括指摘 2026-07-11=画面ごとの「保存/送信」揺れ・色違い・アイコン併記・「xxxを保存」複合形を横断統一）。',
      },
      {
        type: 'table',
        head: ['基底ラベル', '用途', '禁止する言い換え'],
        rows: [
          ['保存', '入力内容の永続化（設定・編集フォーム）', '更新 / 適用 / 確定'],
          ['送信', 'メッセージ・依頼を相手へ出す', '投稿 / 送る'],
          [
            'キャンセル',
            '編集・操作の取りやめ',
            '閉じる（※単なる閲覧の終了は「閉じる」でよい＝キャンセル相当の破棄を伴う時だけ本表の対象）',
          ],
          ['削除', 'データの破壊的除去', '消す / 破棄'],
        ],
      },
      {
        type: 'p',
        text: '複合形（「xxxを保存」「送信する」「招待メールを送信」等）は禁止。基底 4 語をそのまま使う。例外は業務文脈が固有語を要請する場合（例: 発注登録・テナント作成）のみで、reference document-form.tsx の submitLabel prop と同じ「業務ラベルで上書き」パターンに限る。「作成」系の固有語（チャネル作成/グループ作成/メモ作成/アカウント作成 等）や動作名そのもの（パスワード変更/有効化 等）もこの例外の運用＝「対象名詞＋動作」の体言止め（「〜を〜する」の文形は不可）。',
      },
      {
        type: 'table',
        head: ['ラベル', 'variant'],
        rows: [
          ['保存 / 送信', 'default / sp-primary（緑塗り）'],
          ['削除', 'destructive（赤）'],
          ['キャンセル', 'sp-action / outline / ghost（背景なし系）'],
        ],
      },
      {
        type: 'table',
        head: ['項目', 'アイコン併記可否'],
        rows: [
          ['基本', 'label-only（アイコンを添えない）'],
          ['許容', '破壊的操作の強調（Trash2 等）・業務固有ラベルの意味補強（発注登録等）に限定'],
          ['禁止', '独自 SVG アイコン（components/ui 配下の lucide-react 系を流用する）'],
        ],
      },
      {
        type: 'note',
        text: 'settings の FormButton（primitives/form.tsx）は本規約の存在を許容する併存実装（cva Button への統合是非は settings feature 側の判断に委ねる）。ただし色は primary=teal 塗り＝sp-primary と等価であること。reference の sp-action＋アイコン方式を rete へ波及させるかは別判断。',
      },
      {
        type: 'note',
        text: '保存/送信系の「変更なし・未入力」disabled 視覚は teal + opacity 0.5 に統一する（dsk-0412。旧 #B5BCC2 灰ベタ＝desk コンポーザ送信ボタンの hex 直書きは廃止）。塗りボタンの hover は同色濃化（teal-strong）のみで、opacity 減光 hover は用いない。',
      },
    ],
    compliesWith: [
      { label: 'ボタン色規約（本タブ UI共通）' },
      { label: 'colorトークン直書き禁止（本タブ UI共通）' },
    ],
    examples: {
      good: [
        {
          text: '主要操作=variant default/sp-primary、副次=sp-action、削除=destructive を選ぶだけにする',
          demo: 'button-usage-good',
        },
      ],
      bad: [
        {
          text: 'ボタンに直接 bg-[#...] を当てる / 画面ごとに角丸・影を作り込む / loading 中に手で disabled を書き分ける',
          demo: 'button-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-input',
    title: 'Input・Textarea',
    category: 'ui-component',
    status: 'active',
    summary:
      '単一行は Input（--sp-input-h）・複数行は Textarea（min-h 80px）。高さは密度2段階（標準40px / compact32px・mdl-0025）。背景は登録対象=薄青（bg-input-bg）/ 検索・絞り込み=白の2値、非活性は --sp-disabled-bg + 灰字。装飾の個別作り込み禁止。',
    sources: ['components/ui/input.tsx', 'components/ui/textarea.tsx'],
    purpose:
      'テキスト入力の見た目と focus / 活性・非活性表現を画面間で揃え、フォームごとの個別装飾（枠線色・角丸・高さ・背景色の揺れ）を防ぐ。',
    spec: [
      {
        type: 'p',
        text: '新規のテキスト入力は共通 Input / Textarea を使い、className では幅（w-*）等のレイアウトだけを渡す。枠線色・角丸・高さ・focus 表現を画面側で作り込まない。',
      },
      {
        type: 'table',
        head: ['状態', '背景', '文字・その他'],
        rows: [
          [
            '活性（登録対象の入力欄）',
            '薄青 bg-input-bg（--input-bg・可視ギリギリの極薄青）',
            '--sp-text-warm。「入力できる場所」を背景色で示す',
          ],
          [
            '活性（検索・絞り込み用）',
            '白 --sp-card（.sp-input--filter / 検索窓系クラス）',
            '入力項目だが登録対象ではないため薄青を付けない（mdl-0021 開発統括決定）',
          ],
          [
            '非活性（disabled）',
            '中立薄灰 --sp-disabled-bg（#f0f0f2・青味なし）',
            '灰字 --sp-text-warm-mute + cursor-not-allowed。opacity 減光は使わない',
          ],
          [
            'フォーカス（アクティブ）',
            '背景は活性時のまま',
            '枠線を同太さ 1px のまま --sp-focus-border（teal #1FB6A2）へ変える。シャドウ/リング無し（mdl-0023。詳細は UI共通「アクティブ表現」）',
          ],
        ],
      },
      {
        type: 'table',
        head: ['項目', 'Input', 'Textarea'],
        rows: [
          [
            '寸法',
            'h-[var(--sp-input-h)] px-3 text-sm（縦 padding なし・mdl-0027）',
            'min-h-[80px] px-3 py-2 text-sm（縦リサイズ可）',
          ],
          ['枠・面', 'rounded-md border-input bg-input-bg', '同左'],
          [
            'placeholder',
            'text-[var(--sp-text-warm-mute)]・空欄時のみ表示（focus では消さない・入力で消える）',
            '同左',
          ],
          [
            'focus',
            'focus-visible:border-[var(--sp-focus-border)]（枠色変化のみ・ring/シャドウ撤去 mdl-0023）',
            '同左',
          ],
          [
            'disabled',
            'cursor-not-allowed bg-[var(--sp-disabled-bg)] text-[var(--sp-text-warm-mute)]',
            '同左',
          ],
        ],
      },
      {
        type: 'note',
        text: 'プレースホルダ規約は基底CSS（globals.css @layer base の input/textarea::placeholder）で全入力欄へ一律適用する（色=--sp-text-warm-mute・空欄時のみ表示・focus では消さない＝入力でネイティブに消える・mdl-0031 を dsk-0375 で撤回）。独自CSSクラスの入力欄（.sp-input / .settings-input / .desk-filter-keyword 等）も同規約に含まれ、focus で透明化する個別宣言は禁止。例外はダーク地の .sidebar-create-input（専用の減光色のみ。focus でも消さない）。',
      },
      { type: 'demo', demo: 'input-states', caption: 'Input / Textarea の状態' },
      {
        type: 'note',
        text: '非活性の背景に --sp-paper / --muted / opacity 減光を使わない（3系統に割れていたのを mdl-0021 で --sp-disabled-bg へ一本化。--sp-paper は青味残りで活性の薄青と紛れるため不可＝dsk-0213）。独自 CSS の入力欄（.sp-input / .settings-input / .ftree-draft-input 等）も同じ2値規約に従う。',
      },
      {
        type: 'p',
        text: 'フォーム密度は2段階（mdl-0025）: 標準＝ログイン等の単独フォーム（共有 Input h-10 = 40px）／compact＝設定・ファイル・Desk 等の高密度管理画面（32px）。単一行入力の高さはこの2値のみとし、第3の高さ（旧 Desk 約24px・検索窓 約28〜30px 等）を作らない。検索窓・インライン編集入力・ドロップダウン内検索も compact に含める（mdl-0027）。値は必ず密度トークンを参照する（数値直書き禁止）。',
      },
      {
        type: 'table',
        head: ['密度', '入力欄高さ', '内側余白（枠線⇄文字）', '入力文字', '使う場面 / 実装'],
        rows: [
          [
            '標準',
            '40px（h-10・--sp-input-h）',
            '左右 12px（px-3）',
            'text-sm（0.875rem）',
            'ログイン等の単独フォーム。共有 Input / Textarea / Select をそのまま使う',
          ],
          [
            'compact',
            '32px（--sp-input-h-compact）',
            '左右 8px（0.5rem）',
            '0.8125rem',
            '設定・ファイル・Desk の高密度画面。独自クラス（.sp-input / .settings-input / .fo-input / .desk-ticket-input 等）はトークン参照の高さと padding をクラス側が持つ（呼び出し側の height / padding 手書き禁止）',
          ],
        ],
      },
      {
        type: 'p',
        text: '縦の余白（mdl-0027）: 単一行入力は縦 padding を持たない（height 固定 + ブラウザ標準のセンタリングに委ねる。縦 padding 併用は方式が割れるため禁止）。複数行 Textarea のみ縦 padding を持つ（標準 py-2 / compact 0.25rem）。左右の内側余白は上表の2値のみ（10px・4px 等の中間値禁止）。アイコン入り検索窓の左オフセット（アイコン分の padding-left）は例外として許容する。',
      },
      {
        type: 'note',
        text: 'reference の compact フォーム（[data-form-compact]）も同じ 32px へ統一済み（mdl-0025）。密度トークン --sp-input-h / --sp-input-h-compact は reference にも定義済みで両リポとも数値直書き禁止（mdl-0027・look&feel 統一方針）。複数行 Textarea は固定高でなく min-height（標準 80px / compact 3.5rem 目安）。',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: '共通 Input / Textarea をそのまま使い、className はレイアウト（幅）だけ渡す',
          demo: 'input-usage-good',
        },
      ],
      bad: [
        {
          text: '画面独自の枠線色・角丸・高さを作り込む / 複数行入力を Input の縦伸ばしで済ませる',
          demo: 'input-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-select',
    title: 'Select',
    category: 'ui-component',
    status: 'active',
    summary:
      'Select は自前実装（trigger + portal リスト）。trigger は Input と同じ枠・高さ、空選択は placeholder 薄灰、選択中は Check + --sp-select-soft。',
    sources: ['components/ui/select.tsx'],
    purpose:
      'プルダウンの見た目・空選択ラベル・選択中表現・キーボード操作を統一し、フィルタ / フォーム間の揺れと native select の OS 依存見た目を防ぐ。',
    spec: [
      {
        type: 'p',
        text: '単一選択は共通 Select（Select / SelectTrigger / SelectValue / SelectContent / SelectItem の合成）を使う。native <select> の直置きや独自プルダウンの作り込みをしない。',
      },
      {
        type: 'table',
        head: ['部位', '規約', '実装値'],
        rows: [
          [
            'trigger',
            'Input と同じ枠・高さ + 右端 ChevronDown（開くと180°回転）',
            'h-[var(--sp-input-h)] border-input bg-input-bg rounded-md',
          ],
          [
            '空選択',
            'SelectValue の placeholder で薄灰表示（値と視覚的に区別）',
            'text-[var(--sp-text-warm-mute)]',
          ],
          [
            'option 行',
            '左に選択チェック用の余白を確保（pl-8）+ Check アイコン',
            'hover=--sp-select-hover / 選択中=--sp-select-soft',
          ],
          [
            'リスト面',
            'portal + fixed で trigger 幅に追随、上下の空きで自動反転',
            'max-height 240px・z-10001（タスク詳細オーバーレイ 10000 より手前・dsk-0344）',
          ],
        ],
      },
      {
        type: 'demo',
        demo: 'select-states',
        caption: '空選択 / 選択済み / disabled（トリガーは実物＝クリックで開く）',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          'Escape・外側クリックで閉じる。option 選択（mousedown）で値確定と同時に閉じる。',
          'リストは開いていない間も非表示で描画され、選択値のラベル解決（SelectValue 表示）に使われる。',
          'disabled は trigger ごと不活性（cursor-not-allowed + bg-[var(--sp-disabled-bg)] + 灰字 --sp-text-warm-mute。comp-input の非活性規約と同一・mdl-0021）。option 単位の disabled も可。',
        ],
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: '共通 Select + SelectValue placeholder で空選択を示す（trigger 意匠と操作が全画面で同じ）',
          demo: 'select-usage-good',
        },
      ],
      bad: [
        {
          text: 'native select を直置きする / 空選択ラベルを値と同じ濃さで置いて未選択と区別できなくする',
          demo: 'select-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-form-field',
    title: 'FormField・Label',
    category: 'ui-component',
    status: 'active',
    summary:
      'フォーム1項目 = FormField（Label + 入力 + エラーの縦積み・--sp-form-label-gap）。必須は赤「* 必須」バッジ、エラーは --sp-accent-red の下段文言。',
    sources: ['components/ui/form-field.tsx', 'components/ui/label.tsx'],
    purpose:
      'フォーム1項目の構造（ラベル / 必須表示 / エラー余白）を共通化し、項目ごとの手組みによる余白・文言表現のブレを防ぐ。',
    spec: [
      {
        type: 'p',
        text: 'ラベル付き入力は FormField で束ねる。label / required / error / htmlFor を props で渡し、ラベルや必須マーク・エラー文言を画面側で手組みしない。htmlFor と入力の id を必ず紐付ける（クリックでフォーカス + a11y）。高密度一覧の面や既存の密度規約（Desk の属性フォーム・設定タブの FormLabel 等）で FormField を使えない画面は、同じ字面（赤の「* 必須」1 形・入力側は aria-required）で揃える。必須マークはラベルの文字列の外に置き、アクセシブル名（読み上げ名）を変えない。',
      },
      {
        type: 'table',
        head: ['部位', '規約', '実装値'],
        rows: [
          [
            '縦積み',
            'ラベル→入力→エラーを密度トークンの固定間隔に',
            'space-y-[var(--sp-form-label-gap)]（compact は -compact）',
          ],
          [
            'Label',
            'text-sm font-medium leading-none（peer-disabled で薄く）',
            'components/ui/label.tsx',
          ],
          [
            '必須バッジ',
            'ラベル右に赤の「* 必須」（* は大きめ・text-base）。ラベル要素の文字列には含めず、読み上げ名を変えない',
            'ラベル要素の直後に並べる（行 flex の gap で 8px 空ける・text-xs text-[var(--sp-accent-red)]・aria-hidden）',
          ],
          ['エラー文言', '入力の直下に text-sm --sp-accent-red の1行', 'error prop 経由でのみ表示'],
        ],
      },
      { type: 'demo', demo: 'form-field-states', caption: 'ラベル / 必須 / エラーの3形態' },
      {
        type: 'note',
        text: '「必須」はサーバが空を拒否する項目（題名・名前・メール・初期 Space・最大ファイルサイズなど）に付ける。サーバが空を許す項目は任意なので付けない。Desk タスクの分類とステータスは、分類が任意・ステータスが初期値付きで未入力が起きないため、新規登録モードでも必須マークを出さない（rete-desk-0184/0185）。',
      },
      {
        type: 'p',
        text: 'フォームの縦間隔は密度2段階（mdl-0025・comp-input の密度規約と対）。項目間（フィールド↔フィールド）とラベル間（ラベル↔入力欄）はこの2値のみとし、画面ごとに 14px / 8px / 5px 等の中間値を作らない。compact 側は密度トークン参照で実装する。',
      },
      {
        type: 'table',
        head: ['密度', '項目間', 'ラベル↔入力', 'ラベル文字'],
        rows: [
          [
            '標準',
            '16px（space-y-4・--sp-form-gap）',
            '6px（space-y-1.5・--sp-form-label-gap）',
            'text-sm font-medium（共有 Label）',
          ],
          [
            'compact',
            '10px（--sp-form-gap-compact）',
            '4px（--sp-form-label-gap-compact）',
            '0.75rem / 600（.settings-label / .fo-label / .desk-*-label / FIELD_LABEL_STYLE）',
          ],
        ],
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: '1項目 = FormField（label / required / error を props で渡す・id 紐付け）',
          demo: 'form-field-usage-good',
        },
      ],
      bad: [
        {
          text: 'ラベル・必須マーク・エラー文言を画面ごとに手組みし、余白や文言表現が項目ごとに揺れる',
          demo: 'form-field-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-card',
    title: 'Card',
    category: 'ui-component',
    status: 'active',
    summary:
      '囲み面は Card + CardHeader / CardTitle / CardContent の合成。枠 --sp-line-warm・rounded-lg・shadow-sm、余白は p-6 系で固定。',
    sources: ['components/ui/card.tsx', 'app/globals.css（.sp-panel — 高密度の面斑用）'],
    purpose:
      'カード面の枠・余白・見出し位置を揃え、一覧カードや詳細パネルが画面ごとに別の囲み（枠色・影・角丸の揺れ）にならないようにする。',
    spec: [
      {
        type: 'p',
        text: '囲み面（カード・パネル）は Card 合成で作る。枠線色・影・角丸・内側余白を画面側で作り込まない。高密度の一覧ペインのように Card の内側余白（p-6）を持ち込めない面は、枠・角丸・影だけを持つ共通クラス .sp-panel（globals.css・Card と同値）を使う。枠を border-[var(--sp-line-warm)] で手書きしない。',
      },
      {
        type: 'table',
        head: ['部位', '規約', '実装値'],
        rows: [
          ['外枠', '角丸大 + 細枠 + 弱い影', 'rounded-lg border --sp-line-warm bg-card shadow-sm'],
          ['CardHeader', '見出し領域（縦積み間隔 1.5）', 'flex flex-col space-y-1.5 p-6'],
          ['CardTitle', 'h3・大きめ太字', 'text-xl font-semibold leading-none tracking-tight'],
          ['CardContent', '本文（ヘッダ直下は上余白なし）', 'p-6 pt-0'],
        ],
      },
      { type: 'demo', demo: 'card-anatomy', caption: 'Header + Title + Content の基本構成' },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: 'Card + CardHeader / CardTitle / CardContent の合成で囲み面を作る',
          demo: 'card-usage-good',
        },
      ],
      bad: [
        {
          text: '枠色 hex・独自影・独自余白で囲み面を手組みする（そのカードだけ別物になる）/ 枠だけ border-[var(--sp-line-warm)] で手書きして角丸・影を落とす',
          demo: 'card-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-badge',
    title: 'Badge',
    category: 'ui-component',
    status: 'active',
    summary:
      'Badge は rounded-full の小型ラベル。タスク状態色は --sp-status-*（色SSOT=globals.css）で desk のタスク状態表示と同色に保つ。',
    sources: ['components/ui/badge.tsx', 'globals.css --sp-status-*'],
    purpose:
      'ステータス / 件数バッジの色と形を統一し、同じ「対応中」が画面ごとに別の色・別の形で表示されるのを防ぐ。',
    spec: [
      {
        type: 'p',
        text: 'ステータスや件数の小型ラベルは Badge を使う。タスク状態は variant（todo / progress / review / done）を選ぶだけにし、状態色の hex を画面側に持ち込まない。状態色の SSOT は globals.css の --sp-status-* トークン（desk の .desk-task-status と同一トークン参照＝画面間で同色）。',
      },
      {
        type: 'p',
        text: '適用境界: 設定の多値トーンは既存 StatusBadge（高密度10px・strong有無の余白）を維持し、Badge と部品統合しない（UI共通「CRUD共通パターン」）。サイドバー件数は comp-sidebar-link の .sidebar-badge、タブ件数は comp-tabs の .sp-page-tab-badge に従う。未読点・メンション通知・テナント識別帯・添付/タグ選択等の操作チップは、それぞれの専用語彙であり汎用状態バッジに置換しない。',
      },
      {
        type: 'table',
        head: ['variant', '用途', 'トークン（実値）'],
        rows: [
          ['todo', '未対応', '--sp-status-todo-bg #E3F2FD / fg #1565C0（青）'],
          ['progress', '対応中', '--sp-status-progress-bg #FFF4E5 / fg #B66E00（橙）'],
          ['review', 'レビュー中', '--sp-status-review-bg #F3E5F5 / fg #6A1B9A（紫）'],
          ['done', '完了', '--sp-status-done-bg #EAF7EC / fg #2E7D32（緑）'],
          ['default', '件数等の汎用（primary 塗り）', 'bg-primary text-primary-foreground'],
          ['outline', '弱い分類ラベル', 'border-input text-foreground（枠線のみ）'],
        ],
      },
      {
        type: 'list',
        items: [
          '形は rounded-full px-2.5 py-0.5 text-xs font-semibold で固定（四角ラベルを作らない）。',
          'サイズ違いが要る場合も px/py の作り込みでなく、まず既定サイズで収まる文言に絞る。',
        ],
      },
      {
        type: 'demo',
        demo: 'badge-variants',
        caption: 'variant 一覧（状態色は desk と同一トークン）',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: 'タスク状態は Badge variant を選ぶだけ（desk のタスク状態と自動的に同色になる）',
          demo: 'badge-usage-good',
        },
      ],
      bad: [
        {
          text: '状態色を hex 直書きする / 画面独自の四角ラベルを作る（色も形も desk と割れる）',
          demo: 'badge-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-alert-dialog',
    title: 'AlertDialog',
    category: 'ui-component',
    status: 'active',
    summary:
      'Rete共通の確認ダイアログ。左キャンセル／右OKを固定し、本文で対象・操作・結果を判断する。破壊操作は destructive + キャンセル初期フォーカス。',
    sources: ['components/ui/confirm-dialog.tsx', 'components/ui/alert-dialog.tsx'],
    purpose:
      '確認ダイアログの操作（Esc / 先行フォーカス / 破壊操作の赤）を統一し、誤操作と画面ごとの挙動差を防ぐ。',
    spec: [
      {
        type: 'p',
        text: '確認ダイアログは ConfirmDialog（内部は共有AlertDialog）を使う。window.confirm、画面ごとのAlertDialog合成、確認モーダルの手組みをしない。',
      },
      {
        type: 'table',
        head: ['項目', '規約'],
        rows: [
          [
            '重なり',
            'portal で body 直下・z-[10050]。desk のオーバーレイ帯（9998-10000）より上＝常に最前面',
          ],
          [
            'backdrop',
            'bg-[var(--sp-overlay-scrim)] + backdrop-blur-sm（黒塗り透過でなく薄いグレーの曇りガラス）',
          ],
          [
            '面',
            '純白 bg-white p-6 max-w-lg sm:rounded-lg（bg-background はわずかに沈むため使わない）',
          ],
          [
            'ボタン',
            '左「キャンセル」・右「OK」を固定し、呼出元で操作別ラベルへ変更しない。破壊操作のOKだけ variant destructive',
          ],
          ['文言', '本文に対象名または種別、実行する操作、実行後の結果を具体に書く'],
          ['処理中', 'busy中は両ボタンとEsc/背景による取消を無効化し、二重送信と閉じ逃げを防ぐ'],
        ],
      },
      {
        type: 'demo',
        demo: 'alert-dialog-anatomy',
        caption: '基本構成（静的合成。実物の重なりは下の実物起動で確認）',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          'Esc はキャンセル扱いで閉じ、stopPropagation で背後の画面へ伝播させない（閉じた直後に背後の閉じ処理が二重発火するのを防ぐ）。',
          '呼出元が busy を渡して処理中も確認画面を保持する場合は、Escを含む取消を受け付けず、処理完了まで開いたままにする。共通削除フック useDeleteConfirm の close-first（確定直後に閉じ、失敗通知は remove 側へ委譲）と、メンバーのMFAリセット・メール変更の即閉じ経路は既存契約を維持する。busy は閉じた確認画面を再表示する指定ではない。',
          '開いた時は container を先行フォーカスしてから data-autofocus 付きボタン（キャンセル）へ視覚フォーカスを移す（開いた直後から Esc が効く）。',
          '←→ / Tab でボタン間をループ巡回。Enter はフォーカス中ボタンの既定クリックに委ねる。',
          '閉じた時は開く前のフォーカス位置へ復元する（WCAG 2.4.3）。',
        ],
      },
      {
        type: 'demo',
        demo: 'alert-dialog-live',
        caption: '実物を起動して Esc / ←→ / Tab / フォーカス復帰を試す',
      },
    ],
    compliesWith: [
      { label: 'オーバーレイ用語（本タブ 命名）' },
      { label: 'Desk 画面命名 — 二重オーバーレイ禁止（本タブ 命名）' },
      { label: 'Button（本タブ UIコンポーネント）— 破壊操作の destructive と対' },
    ],
    examples: {
      good: [
        {
          text: 'ConfirmDialog destructive + キャンセル初期フォーカスを使い、本文に対象・操作・失われる結果を書く',
          demo: 'alert-dialog-usage-good',
        },
      ],
      bad: [
        {
          text: '確認モーダルを手組みする（操作別ラベル・色・本文・ボタン順が画面ごとに揺れる）',
          demo: 'alert-dialog-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-overlay-dialog',
    title: 'OverlayDialog',
    category: 'ui-component',
    status: 'active',
    summary:
      'オーバーレイ画面の a11y 内蔵 primitive。幅既定 min(420px, 90vw)・backdrop は曇りガラス・focus trap / inert 隔離 / フォーカス復帰を内蔵。',
    sources: ['components/ui/overlay-dialog.tsx'],
    purpose:
      'オーバーレイ画面の開閉と二重オーバーレイ禁止を統一し、重ね表示の a11y（trap / inert / 復帰）を primitive 側へ集約する。',
    spec: [
      {
        type: 'p',
        text: '設定系などの重ね表示（招待操作 / 削除確認 / CSV 出力）は OverlayDialog を使う。パネルは位置決め（センタリング + 幅）だけを担い、カード面（枠・影・余白）は children 側が持つ。fixed div の手組みで重ね表示を作らない。',
      },
      {
        type: 'table',
        head: ['項目', '規約'],
        rows: [
          ['幅', "既定 'min(420px, 90vw)'（width prop で変更可）"],
          [
            'backdrop',
            'bg-[var(--sp-overlay-scrim)] + backdrop-blur-sm・z-[10050]（AlertDialog / Desk の重ね表示と同系の薄いグレーの曇りガラス）',
          ],
          [
            '閉じ経路',
            '背景クリック（closeOnBackdrop 既定 true）/ Esc / children 内の閉じるボタン → すべて onClose に集約',
          ],
          [
            'a11y 属性',
            'role=dialog + aria-modal。見出し要素があれば labelledBy、無ければ ariaLabel を渡す',
          ],
        ],
      },
      {
        type: 'demo',
        demo: 'overlay-dialog-anatomy',
        caption: '構成（静的合成。実物の重なりは下の実物起動で確認）',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          'Tab / Shift+Tab はパネル内部を巡回する（focus trap）。Esc は stopPropagation して onClose を呼ぶ。',
          '開いている間は body 直下の非オーバーレイ要素を inert + aria-hidden で隔離する。複数枚が同時に開いても元状態は集合管理され、最後の 1 枚が閉じた時だけ一括復元される。',
          '開く時は data-autofocus か最初の focusable へ初期フォーカス、閉じた時は開く前の位置へ復帰する。',
        ],
      },
      {
        type: 'demo',
        demo: 'overlay-dialog-live',
        caption: '実物を起動して focus trap / Esc / 背景クリックを試す',
      },
    ],
    compliesWith: [
      { label: 'オーバーレイ用語（本タブ 命名）— 「オーバーレイ画面/ビュー」で統一' },
      { label: 'Desk 画面命名 — 二重オーバーレイ禁止（本タブ 命名）' },
    ],
    examples: {
      good: [
        {
          text: '重ね表示は OverlayDialog 1枚。カード面は children 側で持ち、a11y は primitive に任せる',
          demo: 'overlay-dialog-usage-good',
        },
      ],
      bad: [
        {
          text: 'fixed div を手組みする / オーバーレイの上にさらに一枚重ねる（二重オーバーレイ禁止・backdrop 意匠も割れる）',
          demo: 'overlay-dialog-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-spinner',
    title: 'Spinner',
    category: 'ui-component',
    status: 'active',
    summary:
      'loading 表現は共通 Spinner（回転 SVG・text-current）に一本化。サイズは className の h/w、色は文脈の text-* で指定。',
    sources: ['components/ui/spinner.tsx'],
    purpose:
      'loading 表現を Spinner に一本化し、画面ごとに独自ローダー（点滅・ドット・別アニメ）が生えて表現が揺れるのを防ぐ。',
    spec: [
      {
        type: 'p',
        text: '読み込み中の表現は共通 Spinner を使う。色は text-current 継承（親の text-* で決まる）、サイズは className の h-* w-* で渡す。独自のローディングアニメを作らない。',
      },
      {
        type: 'table',
        head: ['配置', 'サイズ目安', '備考'],
        rows: [
          [
            'ボタン内',
            'h-4 w-4',
            'Button loading=true が自動挿入（comp-button と一体・手で並べない）',
          ],
          ['行内（文言の左）', 'h-4 w-4', '「読み込み中…」等の文言と gap-2 で並べる'],
          [
            '領域/ページ中央',
            'h-6〜h-8',
            'flex items-center justify-center で中央寄せ・色は控えめ（mute 系）',
          ],
        ],
      },
      {
        type: 'list',
        items: [
          'aria-label="読み込み中" role="status" を内蔵（a11y は Spinner 側が持つ・呼び出し側で重ねない）。',
          'アニメは animate-spin のみ（点滅 animate-pulse をローディングに流用しない）。',
        ],
      },
      { type: 'demo', demo: 'spinner-placement', caption: '単体 / ボタン内 / 領域内の配置' },
    ],
    compliesWith: [
      { label: 'Button（本タブ UIコンポーネント）— loading=true と一体' },
      { label: 'colorトークン直書き禁止（本タブ UI共通）' },
    ],
    examples: {
      good: [
        {
          text: '読み込み中は Spinner + 文言（色は text-* 継承・サイズは h/w 指定）',
          demo: 'spinner-usage-good',
        },
      ],
      bad: [
        {
          text: '画面ごとに独自ローダー（点滅ドット・文字点滅など）を手組みする',
          demo: 'spinner-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-page-title',
    title: '画面タイトル',
    category: 'ui-component',
    status: 'active',
    summary:
      'メニュー（タブ / サイドバー項目）でクリックした機能名をコンテンツ領域の左上に共通 PageTitle で表示する。text-xl・semibold・tracking-tight・--sp-text-warm・下余白 mb-3・区切り線なし（reference PageHeader と同一意匠）。',
    sources: [
      'components/shared/page-title.tsx（共通 PageTitle）',
      'struct-pass-reference: components/shared/page-header.tsx（意匠の準拠元・30ページ超で例外なく使用）',
    ],
    purpose:
      '画面タイトルの「ついていたりいなかったり」（Desk の欠落・ホーム/ファイル/設定/モデルの余白と太さのバラつき）を解消し、メニューでクリックした機能名が同じ見た目で必ず左上に出る状態にする（mdl-0028）。',
    spec: [
      {
        type: 'p',
        text: 'サイドバーを持つタブは「サイドバーでクリックした項目名＝画面タイトル」（例: ホームの掲示板/FAQ・設定のメンバー等）。サイドバー項目が画面切替でないタブ（ファイル等）はタブに対応する画面名（日本語。Desk=デスク / File=ファイル 等・英語タブ表記との文字列一致は要求しない＝ADR 0051）を表示する。直書きの h2 を作らず、必ず components/shared/page-title.tsx の PageTitle で組む。',
      },
      {
        type: 'table',
        head: ['部位', '規約', '実装値'],
        rows: [
          [
            'タグ',
            'コンテンツ側タイトルは h2（h1 はサイドバーヘッダーが使用）',
            'PageTitle 内蔵（reference は単独ページ構造のため h1）',
          ],
          [
            '文字',
            'text-xl・semibold・tracking-tight・--sp-text-warm',
            '太字（font-bold）は使わない',
          ],
          [
            '配置',
            'コンテンツ領域の左上・左寄せ',
            'パンくず（Breadcrumb）は設定タブからも廃止（画面タイトルのみ）',
          ],
          ['余白', '下余白 mb-3（0.75rem）・区切り線なし', 'タイトル下に border-b を引かない'],
          [
            '補足説明',
            'タイトル右に同一行 span・text-xs・--sp-text-warm-mute',
            'PageTitle の description prop',
          ],
        ],
      },
      {
        type: 'p',
        text: '例外（表示しない画面）: Desk＝作業机型でサイドバー最上部に「デスク」が常時表示済み・コンテンツはスレッド見出しが主役のため付けない。ログイン等の認証前画面はメニュー文脈が無いため対象外。',
      },
      {
        type: 'demo',
        demo: 'page-title-live',
        caption: 'ライブ見本（実物の共通コンポーネント。下段は補足説明付き）',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          'タイトル文言はメニュー（サイドバー項目 / タブ）の表記と一致させる（別の言い換えをしない）。',
          'タイトル右隣にステータスバッジ等を添える場合は after prop を使う（タイトル文字列に混ぜ込まない）。',
        ],
      },
    ],
    compliesWith: [{ label: 'フォント階層（本タブ typography・見出し=text-xl semibold）' }],
    examples: {
      good: [
        {
          text: '共通 PageTitle で組む（全画面で文字・余白・配置が同一になる）',
          demo: 'page-title-live',
        },
      ],
      bad: [
        {
          text: '直書き h2 で画面ごとに余白や太さを変える / タイトル下に区切り線を引く',
          demo: 'page-title-usage-bad',
        },
      ],
    },
  },
  {
    // mdl-0032: ヘッダーグローバルメニューの正本（hom-0114/hom-0120 実装値の転記。ref-0018 が参照する）。
    id: 'comp-global-nav',
    title: 'グローバルメニュー（ヘッダーナビ）',
    category: 'ui-component',
    status: 'active',
    summary:
      'ヘッダー帯のグローバルメニュー（タブ＋マグネティック・ピル）。寸法・質感・モーションは globals.css の --header-h / --sp-nav-* トークンが正本。reference も同一仕様に揃える（look&feel 統一）。',
    sources: [
      'app/globals.css（--header-h / --sp-nav-pill-tint-top・bottom / --sp-nav-motion-* / --sp-nav-band-bg / --sp-nav-separator / .nav-pill）',
      'features/shell/components/app-header.tsx（ピル計測・.nav-pill-init 付与）',
      'features/shell/lib/nav-config.ts（タブ順・英語ラベルの SSOT）',
      'hom-0114（見た目・質感・モーション・c91f244 等）',
      'hom-0120（タブ遷移直後の誤アニメ修正・.nav-pill-init・253841b）',
      'cmn-0114（薄グレー帯・英語ラベル・等間隔＋縦線セパレータ）',
      'cmn-0119（ヘッダ行 grid 化・タブ列真中央固定）/ set-0138（帯の左→右グラデーション）',
      'memory: project_reference_subsystem_lookfeel_unify',
    ],
    purpose:
      'グローバルメニューの仕様が globals.css にしか無く、後続 開発エージェントと struct-pass-reference（ref-0018）が同じ値を再現できない状態を解消する。実装済みの値をモデルタブへ転記し横断の正本にする（mdl-0032）。',
    spec: [
      {
        type: 'p',
        text: 'ヘッダー帯内にタブ列と選択/ホバーを追従するピル（.nav-pill）を置く。選択表現は真っ白のガラスチップ（cmn-0122 で導入・cmn-0124 追補で白ガラスへ）＝白の不透明度差による縦グラデ（グラデーションレンズのサングラス様・上濃→下淡）＋ blur・白ヘアライン枠・淡い落ち影。白寄りグレー帯の上で視認させるため輪郭要素を最小限で持つ（cmn-0122 の「輪郭を作らない」は本追補で置換）。ピルの位置は transform: translate3d(x, y, 0) で駆動する（横=offsetLeft、縦=offsetTopを測って載せ、top/translateYには頼らない）。幅は width で駆動する。ラベル拡大とピル移動は必ず同一の --sp-nav-motion-* を共有する（別トークンだと「滑らかでない」と知覚される）。',
      },
      {
        type: 'table',
        head: ['部位', '規約', '実装値（globals.css）'],
        rows: [
          [
            '帯高',
            'ヘッダー全体の高さ（cmn-0114 追補 2026-07-13: 旧 44px から3割減）',
            '--header-h: 1.875rem（=30px）',
          ],
          [
            '行レイアウト',
            'ヘッダ行は grid（1fr auto 1fr）でタブ列を左右ブロック幅に依存しない真中央固定（cmn-0119・reference と座標一致）',
            'app-header.tsx: grid-cols-[1fr_auto_1fr]',
          ],
          [
            '帯地色',
            'メニュー行全体の白に近い黒青系グレー帯（スレート hue220・茶み排除の cmn-0124 追補）。左→右へわずかに濃くなるグラデーション（set-0138・左端は追補で一段白く・右端は cmn-0124 で 88%→93% へ明るく）。app-header.tsx の backgroundImage で消費する（gradient は background-color では効かない）',
            '--sp-nav-band-bg: linear-gradient(to right, hsl(220 16% 98.5%/0.96), hsl(220 14% 94%/0.95))',
          ],
          [
            'タブラベル',
            '英語・単数形（cmn-0114。画面内タイトルは日本語のまま）。開発統括の2026-11-11の回答により、在庫管理へのタブは「在庫管理」で固定する（d1240）。外部システム導線（報告管理 等）は hub menu の available な system item から動的に追加され、そのラベルは item の表示名を使う（d1171 / d1214）',
            'Home / Desk / File / 在庫管理 / Mock / Setting / Model（nav-config.ts）',
          ],
          [
            'タブ間隔',
            '全タブ等間隔（cmn-0114）',
            '--sp-nav-tab-gap: 0.75rem（セパレータ位置と共通の単一ソース。旧: gap 2px + Mock だけ ml-4 → 廃止）',
          ],
          [
            'セパレータ',
            'タブ間の縦線（細く・短く・帯に溶け込む薄色。先頭タブの左には出さない）',
            '--sp-nav-separator / 1px × 0.875rem。絶対配置疑似要素（.tab-link + .tab-link::before）でレイアウト・ピル計測に不参加',
          ],
          [
            'タブ高 / ピル高',
            'タブ行とピルの高さ（帯 3割減に伴い比率維持で縮小・cmn-0114 追補）',
            '26px（ピル角丸なし・brd-0199 フラット意匠）',
          ],
          [
            '選択表現',
            '白ガラスチップ＝白の不透明度差による上濃→下淡の縦グラデ（グラデーションレンズのサングラス様・cmn-0122 で導入・cmn-0124 追補で白ガラス化）＋ blur・白ヘアライン枠・淡い落ち影。白帯上の視認のため輪郭要素を最小限で持つ',
            'linear-gradient(180deg, --sp-nav-pill-tint-top: hsl(0 0% 100%/0.92) → --sp-nav-pill-tint-bottom: hsl(0 0% 100%/0.45)) / border: 1px solid hsl(0 0% 100%/0.9) / backdrop-filter: blur(8px) saturate(140%) / box-shadow: 0 1px 4px rgb(15 23 42/0.12)',
          ],
          [
            '文字色',
            'rest=グレー / hover=黒系 / active=黒強めの濃紺（cmn-0124。旧 active 緑 #059669 → 焦げ茶 cmn-0122 → 濃紺。チップと同系の濃色トーン）',
            '--sp-nav-rest-fg: #475569 / --sp-nav-hover-fg: #0f172a / --sp-nav-active-fg: hsl(220 46% 18%)',
          ],
          [
            'モーション時間',
            'ピル移動・ラベル拡大の共通 duration',
            '--sp-nav-motion-duration: 0.52s',
          ],
          [
            'イージング',
            '共通 ease（overshoot なし）',
            '--sp-nav-motion-ease: cubic-bezier(0.16, 0.8, 0.24, 1)',
          ],
          ['ラベル拡大', 'アクティブ/ホバー時の scale', '1.14 倍（overshoot 不使用）'],
          [
            'reduced-motion',
            'transition を none にしない',
            '0.2s / ease-out へ短縮（teleport 防止）',
          ],
          [
            '初回マウント',
            '誤スライド防止',
            '.nav-pill-init で transition を殺してから位置決め（hom-0120）',
          ],
          ['横移動駆動', 'transform 優先', 'translate3d（幅は width）'],
          [
            '縦位置決め',
            'top/translateY に頼らず対象タブの offsetTop を測って translate3d の y に載せる（帯内で上下余白が非対称になる実測ズレを構造的に防ぐ・rete AppHeader と reference global-nav で同型）',
            'app-header.tsx: top = el.offsetTop → translate3d(x, y, 0) の y',
          ],
          [
            '行高拘束',
            'ヘッダ行の grid セルを --header-h（30px）に拘束（items-stretch + min-h-0）。既定の min-height: auto だと右端のボタンが行を押し広げ、ナビだけ 32px 化してタブ/ピルが帯内で上下非対称になる',
            'app-header.tsx: grid h-[var(--header-h)] min-h-0 ... items-stretch',
          ],
        ],
      },
      {
        type: 'p',
        text: '未解決フォローアップ: hom-0119（Safari/iOS の入れ子 backdrop-filter 描画リスク等）は継続検討中。本正本の数値を変えず、実機確認後に別チケットで更新する。',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          'ピルの transform とラベル scale は同一 --sp-nav-motion-duration / --sp-nav-motion-ease を使う（別 duration 禁止）。',
          'prefers-reduced-motion: reduce でも transition: none にせず 0.2s へ短縮する（hom-0114）。',
          'タブ切替直後は .nav-pill-init で一瞬の左スライド誤アニメを出さない（hom-0120）。',
          'タブ切替でヘッダ内の要素を横にシフトさせない（mdl-0038）: テナントバッジはモジュールレベルキャッシュで初回フレームから描画（後着でタブ列を押し動かさない）・タブラベルは太字幅を .tab-link-bold-ghost で常時予約（アクティブ化の font-weight 変化で幅ぶれさせない）。',
          'struct-pass-reference のヘッダーナビ（ref-0018）はこの表の値を参照して揃える。',
        ],
      },
    ],
    compliesWith: [
      { label: 'reference look&feel 統一（project_reference_subsystem_lookfeel_unify）' },
    ],
    // demo 登録が無いため examples は付けない（mdl-0011: ui-component の examples は demo 必須）。
  },
  {
    id: 'comp-filter-bar',
    title: '検索フィルタ',
    category: 'ui-component',
    status: 'active',
    summary:
      '検索フィルタ帯は共通 FilterBar（Desk 統合検索の is-static 意匠）で統一。透明地の flex 帯・検索窓 14rem・絞り込みは icon+label チップ→listbox・クリア（RotateCcw+「クリア」）常設。',
    sources: [
      'components/shared/filter-bar.tsx（FilterBar / FilterSearchInput / FilterChipSelect / FilterClear）',
      'features/desk/components/desk-filter-toolbar.tsx（意匠の発生源＝Desk 統合検索）',
      'app/globals.css（.desk-filter-bar.is-static / .desk-filter-keyword / .desk-filter-icon / .desk-filter-menu / .sp-filter-bar）',
    ],
    purpose:
      '一覧上部の「検索窓＋絞り込み＋クリア」の帯を Desk 意匠へ一本化し、画面ごとの箱・高さ・セレクト実装（sp-card 囲み / native select 直置き）の分裂を防ぐ（mdl-0026）。',
    spec: [
      {
        type: 'p',
        text: '検索フィルタ帯（キーワード検索＋絞り込み条件の帯）は components/shared/filter-bar.tsx の共通コンポーネントで組む。sp-card の箱で囲わない・絞り込みに native <select> を直置きしない（フィルタは FilterChipSelect＝チップ→listbox 型。フォーム内の単一選択は comp-select の共通 Select を使う＝用途で使い分け）。',
      },
      {
        type: 'table',
        head: ['部位', '規約', '実装値'],
        rows: [
          [
            '帯',
            '透明地・枠なしの flex 横一列（箱で囲わない）',
            '.desk-filter-bar.is-static.sp-filter-bar（gap 0.375rem・margin-bottom 0.25rem＝cmn-0145 で 4px 基準に統一）',
          ],
          [
            '検索窓',
            'Search アイコン左 + 角丸枠。帯の左端に置く',
            '.desk-filter-keyword（幅 14rem・font 0.75rem・アイコン left 0.375rem・focus は --sp-focus-border）',
          ],
          [
            '絞り込み',
            'icon+label チップ → popover listbox（単一選択・選択で即閉じ）',
            'FilterChipSelect（高さ 1.875rem・hover --sp-accent-soft + ink・既定値以外で is-active＝teal 文字 + 右上に --sp-accent-ink の赤丸ドット。ラベルは固定表示）',
          ],
          [
            'クリア',
            'RotateCcw+「クリア」を帯に常設（画面ごとに置いたり省いたりしない）',
            'FilterClear（.desk-filter-clear・全条件を既定値へ戻す）',
          ],
          [
            'アクション',
            '帯には置かない。一覧に対するアクションは帯の外・表の直上の独立行（下記）',
            'ListActionRow（primitives/filter-bar.tsx・レイアウト値はすべて CSS 側＝行の外殻 .sp-list-action-row / 内側の右寄せ・間隔 .sp-list-action-row-actions（globals.css）が持ち、部品コードにレイアウト値の直書きは無い・set-0150/set-0155）',
          ],
        ],
      },
      {
        type: 'demo',
        demo: 'filter-bar-live',
        caption: 'ライブ見本（実物の共通コンポーネント。チップをクリックすると listbox が開く）',
      },
    ],
    behavior: [
      {
        type: 'list',
        items: [
          '絞り込みは選択と同時に即反映する（明示の「検索」ボタンを置かない）。',
          'チップの popover は選択で閉じる・Escape / 外側クリック / マウス枠外で閉じる（Desk と同挙動＝useFilterPopover 共有）。ただしフォーカス復帰由来の body/documentElement クリックは外側扱いしない（dsk-0310）。',
          '既定値（すべて）では chip は非アクティブ表示。既定値以外を選ぶと teal 文字（--sp-accent-teal）＋右上の赤丸ドット（--sp-accent-ink）で絞り込み中を示す。この2点はラッパー context に依らず全画面共通で、背景帯・枠は付けない（teal 文字＋ドットの一形のみ。mdl-0033 決定・mdl-0037 で is-static 文脈の非 hover 時に mute 文字へ骨抜きになる CSS 競合を是正し、選択後の soft 背景帯も撤去）。',
          'チップのラベルは選択後も固定表示とする。「ラベル: 選択値」形式は複数選択可能な項目に対応できないため不採用（mdl-0033 開発統括決定）。選択件数バッジも使わない＝選択中インジケータは赤丸ドットに一本化（タグ絞り込み .tag-filter-dd-btn.is-on も同一宣言を共有）。',
          '一覧に対するアクションは、新規登録（新規作成・組織を追加・PJ を追加・メンバーを追加）も補助アクション（CSV 出力・インポート・サンプル・招待）も区別なく、絞り込み帯の中ではなく帯の下・表の直上の独立した右寄せ行へ置く。行は共通部品 ListActionRow（primitives/filter-bar.tsx）1 箇所で定義し、画面ごとに手書きしない。根拠は reference のマスタ系一覧（ListPageActions）と配置を揃えること（開発統括判断 2026-08-05・案A）で、設定タブの全画面（組織管理・権限・プロジェクト管理・メンバーシップ管理・メンバー・招待・操作ログ）が移行済み＝帯の中にアクションを置く画面は無い（set-0149 / set-0151 / set-0152）。帯に残るのは検索窓・絞り込みチップ・クリアと、絞り込み条件そのもの（日付レンジ等）だけ。なお表の各行に置くボタン（行内アクション＝改名・アーカイブ・解除など）は本規約の対象外で、従来どおり操作列に置く。',
          '検索窓（FilterSearchInput）の「値あり」表現は type=search（値あり＋フォーカス中にブラウザ標準の×）+ Escape でクリア（IME 変換確定の Esc は誤クリアしない）。値ありの Esc は stopPropagation し、親オーバーレイの「Esc で閉じる」と両立する。標準×は Tailwind Preflight が抑止するため globals.css の ::-webkit-search-cancel-button 再有効化が前提（独自×ボタンの追加は禁止＝標準×と二重になる）。',
        ],
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: '共通 FilterBar + FilterSearchInput + FilterChipSelect + FilterClear で組む（Desk・設定と同じ見た目/挙動になる。ホームは共通化前から Desk 意匠クラスを直接共有する先行実装（hom-0081）のままで見た目は同一）',
          demo: 'filter-bar-live',
        },
      ],
      bad: [
        {
          text: 'sp-card の箱で帯を囲む / 絞り込みに native select を直置きする（候補リストの見た目が OS 依存になり hover 規約も効かない）/ 選択後の表現を画面独自に変える（「ラベル: 選択値」表示・選択件数バッジ・ink 文字のまま等＝選択後は teal 文字＋赤丸ドットの一形のみ・mdl-0033）',
          demo: 'filter-bar-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-toolbar',
    title: 'Toolbar',
    category: 'ui-component',
    status: 'active',
    summary:
      '一覧上部ツールバーの共通形。flex 横一列・透明地の薄いボタン（hover で ink 文字）・主要アクションは右端。検索・絞り込みは含めない（comp-filter-bar が正本・mdl-0026）。canonical component は未整備（蒸留パターン）。',
    sources: [
      'features/files/components/file-toolbar.tsx',
      'features/desk/components/desk-filter-toolbar.tsx',
      'features/desk/components/desk-task-toolbar.tsx',
      'app/globals.css（.file-toolbar / .desk-filter-bar / .desk-task-tree-toolbar — 反復実装群からの蒸留）',
    ],
    purpose:
      'ツールバーの要素配置（検索・フィルタ・主要アクションの位置）とボタンの見た目を画面間で揃え、行ごとの高さ・色・段組みの揺れを防ぐ。',
    spec: [
      {
        type: 'p',
        text: 'canonical な共通コンポーネントは無く、features 側の反復実装から蒸留した共通形。新規のツールバーは以下の形に合わせる（既存の揺れに合わせて増やさない）。',
      },
      {
        type: 'table',
        head: ['項目', '共通形'],
        rows: [
          ['段組み', 'flex items-center 横一列・gap 0.375〜0.5rem（1行に収める）'],
          [
            'ボタン',
            '透明地 + text 0.75rem + radius 0.375rem・アイコン⇄ラベル gap 0.25rem（mdl-0024）。hover で文字 var(--sp-accent-ink)（塗りボタンを並べない）',
          ],
          [
            '検索・絞り込み',
            'ツールバーには置かない。検索窓＋フィルタチップ＋クリアの帯は comp-filter-bar（共通 FilterBar）へ分離する（mdl-0026）',
          ],
          ['主要アクション', '右端に分離（justify-content: flex-end または margin-left: auto）'],
          ['破壊操作', '文字色 var(--sp-accent-red)（塗らない・右端の主要アクション側に置く）'],
        ],
      },
      {
        type: 'demo',
        demo: 'toolbar-pattern',
        caption: '共通形（透明地の薄いボタン・主要アクション右端）',
      },
      {
        type: 'note',
        text: 'canonical component 化は将来課題。既知の揺れ: ボタン高さ 1.75rem（desk-task）/ 1.875rem（file）。hover 背景は mdl-0050 で var(--sp-accent-soft) + ink 文字へ統一済（旧 var(--sp-row-hover) は全廃）。新規実装ではいずれかに寄せ、揺れを増やさない。なお desk-rte-toolbar（RTE 文字書式のアイコン列）は構造が異なる別系統で本パターンの対象外。「検索窓＋絞り込み＋クリア」の検索フィルタ帯は comp-filter-bar（共通 FilterBar）が正本（mdl-0026）。',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: '主要アクションは右端に分離し、ボタンは透明地 + hover ink で揃える（検索・絞り込みは FilterBar へ）',
          demo: 'toolbar-usage-good',
        },
      ],
      bad: [
        {
          text: 'ボタンの高さ・色・角丸を行内で作り込む / 主要アクションを行の中央に埋める',
          demo: 'toolbar-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-tabs',
    title: 'Tabs',
    category: 'ui-component',
    status: 'active',
    summary:
      '画面内タブは2px下線で選択を示し、strip 下端に1px線を置く。基底は ink の下線と文字。既存の Desk・設定・タグ管理は teal 下線を維持し、文字色と太さは下表の文脈別規約に従う。グローバルメニューのピルと検索モードのセグメント切替は別の語彙。',
    sources: [
      'features/settings/components/primitives/page-tabs.tsx（.sp-page-tabs / .sp-page-tab）',
      'features/desk/components/task-detail-overlay.tsx（.desk-ticket-tabs）',
      'app/globals.css（両クラスの正本 — 反復実装群からの蒸留）',
    ],
    purpose:
      'タブ strip の意匠と選択中表現を下線型に統一し、詳細画面・設定画面ごとの表現差（pill 化・色割れ）を防ぐ。',
    spec: [
      {
        type: 'p',
        text: 'タブ切替は下線型（border-bottom 2px。サイドバー等 strip の罫線へ重ねたい実装は margin-bottom -1px を併用する）で作る。settings 系は .sp-page-tabs（プリミティブ page-tabs.tsx）、desk 詳細は .desk-ticket-tabs が既存実装。新規は .sp-page-tabs への相乗りを第一候補にする。',
      },
      {
        type: 'table',
        head: ['項目', '共通形'],
        rows: [
          [
            'strip',
            'display: flex + 下端 1px var(--sp-line-warm)。タブ下線は 2px（cmn-0135）。サイドバー/タグマスタ/分類設定は margin-bottom -1px で strip 線に重ね、.sp-page-tab / .desk-ticket-tab は strip 線の上へ重ねずに引く',
          ],
          [
            '選択中',
            '基底 .desk-ticket-tab と添付元タブは ink の下線・文字。既存 .sp-page-tab と Desk 詳細は文字/下線とも teal。サイドバー・分類設定・タグ管理は濃色文字＋teal 下線。sp-page-tab / desk-ticket-tab / サイドバー / 分類設定 / タグ管理は太さ600固定、添付元のみ500→600',
          ],
          ['非選択', '薄い文字色（hsl(var(--foreground)/0.65) 等）+ 透明下線。hover で文字を濃く'],
          [
            'バッジ',
            '.sp-page-tab-badge（グレー地・選択中は var(--sp-accent-soft) 地 + ink 文字）',
          ],
        ],
      },
      {
        type: 'demo',
        demo: 'tabs-pattern',
        caption: '共通形（実クラス .sp-page-tabs / .sp-page-tab を描画）',
      },
      {
        type: 'note',
        text: 'canonical component 化は将来課題。選択中クラス名は .active（sp-page-tab）と .is-active（desk-ticket-tab 等）がある。PageTabs は現時点で本番呼出しがなく、見本と将来の共通部品。添付元タブも下線型とする。既存の Desk 詳細・サイドバー・分類設定・タグ管理の配色を、この照合で基底の ink へ変更しない。',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: 'タブは下線型で、選択中は文脈別の共通色を使う（.sp-page-tabs へ相乗り）',
          demo: 'tabs-usage-good',
        },
      ],
      bad: [
        {
          text: '画面独自の pill タブを作る / 選択色を hex 直書きする（下線型の他画面と割れる）',
          demo: 'tabs-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-sidebar-link',
    title: 'Sidebar-link',
    category: 'ui-component',
    status: 'active',
    summary:
      'サイドバー項目は共通 .sidebar-link。active=すりガラスの白ピル（白42%・角丸8px・内側1px白フチ・左右6px逃がし / cmn-0133）、hover=単一スライド帯 hsl(var(--sidebar-hover))、バッジは .sidebar-badge。地はライトメタル調グラデ+白ガラスパネル（dsk-0376）。',
    sources: [
      'features/shell/components/app-sidebar.tsx',
      'dsk-0376（ライトメタル調グラデ+白ガラスへ反転・幅 15.5rem）/ cmn-0118（英語サブシステム名）',
      'features/files/components/files-sidebar.tsx',
      'features/settings/components/settings-sidebar.tsx',
      'features/model/components/model-sidebar.tsx',
      'features/desk/components/desk-sidebar.tsx（別系統 .sidebar-channel）',
      'app/globals.css（.sidebar-link / .sidebar-badge の正本 — 反復実装群からの蒸留）',
    ],
    purpose:
      'サイドバーのナビ項目（active 背景・hover・バッジ・折り畳み）を画面間で統一し、タブごとの独自バッジ・独自 active 色の分裂を防ぐ。',
    spec: [
      {
        type: 'p',
        text: 'サイドバー項目は共通クラス .sidebar-link を使う（<button> / <Link> どちらでも可）。地はライトメタル調（--sidebar: 215 8% 53% 基調の radial-gradient 金属階調）＋白ガラスパネル（.app-sidebar::before = rgb(255 255 255/0.4) + blur(20px) saturate(180%)・角丸10px・inset 10px=padding と一致）の二層構成（dsk-0376。旧ダーク地 220 30% 14% は開発統括差し戻しで撤回済み）。文字は濃スレート（--sidebar-foreground: 222 47% 11%）。色は --sidebar-* トークンから取り、独自色を持ち込まない。',
      },
      {
        type: 'table',
        head: ['状態', '実値'],
        rows: [
          [
            '通常',
            '文字 hsl(var(--sidebar-foreground)/0.75)・padding 0.5rem 0.75rem・text 0.875rem',
          ],
          [
            'hover',
            '背景 hsl(var(--sidebar-hover))（= hsl(222 47% 11% / 0.05)・薄い黒透過。dsk-0376 で旧ピンク系から変更）+ 文字を濃く',
          ],
          [
            'active',
            '白ピル: 背景 hsl(0 0% 100%/0.42) + 角丸 8px + 内側 1px 白フチ hsl(0 0% 100%/0.7) + 影 0 4px 12px hsl(222 47% 11%/0.1) + font-weight 500。行は margin-inline 6px でガラス枠から逃がし、hover 帯も同じ 6px に揃える（cmn-0133・全画面共通／リファレンスも同値）',
          ],
          [
            'disabled',
            '文字 hsl(var(--sidebar-foreground)/0.35) + pointer-events: none（準備中項目）',
          ],
          [
            'バッジ',
            '.sidebar-badge（text 0.625rem・グレー地 hsl(var(--sidebar-border))・rounded）を ml-auto で右端',
          ],
          [
            '折り畳み',
            'グループ開閉は model / desk が実装（▸/▾ or chevron 回転）。静的グループなら不要',
          ],
          [
            '幅',
            '15.5rem（=248px・dsk-0376。パネル左右均等余白 10px 確保＋アイコン付きタブが折り返さない幅。旧 13rem を上書き）',
          ],
          [
            'ヘッダ',
            'h1=英語サブシステム名（Desk / File 等・cmn-0118・1.75rem）。ガラス載せは薄っすら: 近いトーンの淡スレート縦グラデ＋上端極薄白ハイライト（chrome 金属文字にしない）。背景透過・下罫線 hsl(var(--sidebar-border))',
          ],
        ],
      },
      {
        type: 'demo',
        demo: 'sidebar-link-pattern',
        caption: '共通形（実クラス .sidebar-link / .sidebar-badge を --sidebar トークン地で描画）',
      },
      {
        type: 'note',
        text: '旧記述の訂正: hover の --sidebar-hover は dsk-0376 のライトメタル反転で薄い黒透過（222 47% 11% / 0.05）へ変更済み。active は cmn-0133 ですりガラスの白ピルへ統一し、旧 --sidebar-active-bg は撤去済み。Desk の .sidebar-channel / .sidebar-member-row も同じ白ピル。Home の未読件数は共通 .sidebar-badge を使う。Model サイドバーに整備中バッジはなく、本文見出しの整備中は Badge。Desk の未読点・赤丸とお気に入りの種別ラベルは専用通知・識別語彙として維持する。canonical component 化は将来課題。',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: '項目は .sidebar-link、件数は .sidebar-badge を使う（active/hover/バッジが全タブで揃う）',
          demo: 'sidebar-link-usage-good',
        },
      ],
      bad: [
        {
          text: 'active / hover に --sidebar-* トークン外の独自色を直書きする / バッジ色を画面独自に作る（4系統目を増やさない）',
          demo: 'sidebar-link-usage-bad',
        },
      ],
    },
  },
  {
    id: 'comp-table',
    title: 'Table（ヘッダー / フッター）',
    category: 'ui-component',
    status: 'active',
    summary:
      'ヘッダーは Desk 由来の淡色小文字＋中央寄せ＋薄罫線、フッターは共通 Pagination（3列グリッド・背景なし）に統一。mdl-0016 で Files/Settings を Desk/共通部品へ是正。明細の縞模様は偶数行 var(--sp-row-stripe)・設定タブで ON/OFF/色変更（mdl-0022）。',
    sources: [
      'app/globals.css（.sp-table / .file-table / .desk-task-tree-head 系）',
      'components/shared/pagination.tsx',
      'struct-pass-reference: components/shared/pagination.tsx（同型）',
      'struct-pass-reference: app/globals.css / components/shared/data-table.tsx（[data-list-compact] は rete file-table を範として明記）',
    ],
    purpose:
      '表ヘッダー・フッターの意匠が画面ごとに独自実装され数値が微妙にずれていた（mdl-0016 調査で4系統判明）のを1つの規約へ収束させ、以後の新規表実装が同じ揺れを再生産しないようにする。',
    spec: [
      {
        type: 'p',
        text: 'ヘッダーは Desk 系（.desk-task-tree-head 等）の意匠を正本とする。文字色は薄灰色 var(--sp-text-warm-mute)、文字サイズは明細行より一段小さく、中央寄せ、罫線は明細行と同じ薄色 var(--sp-line-warm-2)（濃色 var(--sp-line-warm) は使わない）。列区切りは縦棒でヘッダー行の上下に余白を残す。',
      },
      { type: 'demo', demo: 'table-header', caption: 'ヘッダーの意匠（実物 .sp-table 描画）' },
      {
        type: 'table',
        head: ['要素', '値'],
        rows: [
          ['ヘッダー文字サイズ', '0.6875rem'],
          [
            'ヘッダー上下 padding',
            '0.375rem（Desk 由来・実効ヘッダー高 約28.5px。mdl-0025 で .sp-table / .file-table も統一）',
          ],
          ['明細行文字サイズ', '0.8125rem'],
          [
            '明細行上下 padding',
            '0.5rem（実効行高 約35.5px = 8px×2 + 13px×line-height1.5。全一覧共通）',
          ],
          ['ヘッダー文字色', 'var(--sp-text-warm-mute)'],
          ['ヘッダー下罫線', 'var(--sp-line-warm-2)（薄色・明細行と同じ）'],
          [
            '明細下端（表とフッターの境界）',
            'フッター（Pagination）の上罫線 1px var(--sp-line-warm-2) の1本のみ。最終行の下罫線は撤去する（残すとフッター上罫線と隙間ゼロで重なり実質2pxの二重線になる。mdl-0036）',
          ],
          ['ヘッダー寄せ', '中央（操作列など右寄せしたい列だけ個別に textAlign: right を明示）'],
        ],
      },
      {
        type: 'note',
        text: '明細行の高さは「padding 0.5rem×2 + 文字 0.8125rem × line-height 1.5 ≒ 35.5px」を全一覧（.sp-table / .file-table / Desk task・chat 行）の共通規格とする（mdl-0025）。例外: .file-table のデータセル文字は 0.75rem（名前列 col-name のみ 0.8125rem。行高は col-name が支配するため 35.5px 規格は成立・reference [data-list-compact] もこの値を範に取る）。一覧内に副次テーブル（モーダル内の結果表等）を置く場合も .sp-table を再利用し、inline padding の素 table で別の行高を作らない。例外はインライン編集行（Desk 分類設定 / タグ管理）＝入力欄高さと揃える height: var(--sp-input-h-compact) 固定（根拠コメント必須）。',
      },
      {
        type: 'p',
        text: 'フッターは共通 Pagination コンポーネント（3列グリッド・中央に「全件数＋ナビ4ボタン＋ページ数」・背景色なし・上罫線 1px var(--sp-line-warm-2)＝ヘッダー下罫線と同色）を使う。ナビハンドラ（onFirst/onPrev/onNext/onLast）を1つでも渡した画面だけボタンが描画され、渡さない画面（全件表示のみの一覧）は件数表示のみの静的フッターになる。',
      },
      {
        type: 'demo',
        demo: 'table-footer',
        caption: 'フッター（実ページング／全件表示のみの2パターン）',
      },
      {
        type: 'list',
        items: [
          '件数の言い方は「全 N 件」に固定する（set-0150）。数える対象が人なら助数詞だけ替えて「全 N 名」（所属管理）。「該当 N 件」は使わない——絞り込み条件を適用した後の件数を出す点は reference（use-client-pagination）と同じで、rete も全画面この意味で「全」と書く。「全」を総件数、「該当」を絞り込み後、と読み分ける規約は無い。',
          '明細行数が明らかに少ない固定リスト（Desk のカテゴリ設定・タグ管理等）はフッター自体を省略してよい（ヘッダーあり・フッターなし・外枠罫線ありが既存の正当なパターン）。',
          '設定の通常一覧は取得方式に合わせる。メンバー・招待・管理グループは全件表示の静的フッター、操作ログはページ情報と移動ハンドラを持つフッターを使う。管理グループの読み込み中・取得失敗時は件数を「全 — 件」とし、未取得を0件や1ページと表示しない。',
          '所属管理の2軸マトリクスと組織管理の階層ペインは、通常一覧の件数フッター・ページ送りの対象外とする。行・列や階層の関係を同じ画面で表示し、表の内側のスクロールで閲覧する。',
          'ファイルタブの選択件数バー（全 N 件 — 選択中 M 件）はページネーションでなく選択状態表示のため本テーマの対象外（別役割・現状のまま維持）。',
          '1ページの明細表示件数セレクタ（明細件数 50 ▾ 等）は reference にあるが、現状 rete の一覧は全件取得のためバックエンドの limit/offset 対応が要る機能追加であり、本テーマの見た目統一とは別スコープとして見送り（必要になった時に改めて検討）。',
        ],
      },
      {
        type: 'note',
        text: 'reference の [data-list-compact]（app/globals.css / data-table.tsx）は自身のコード注釈で rete の file-table を範にしたと明記されている（rete が起源）。ヘッダーの数値を Desk/file-table 側に一本化したのはこの経緯を踏まえた判断（mdl-0016）。',
      },
      {
        type: 'p',
        text: '明細の縞模様（mdl-0022 / mdl-0052）: 全明細（テーブル / 一覧）は偶数行（2,4,…行目）に縞背景 var(--sp-row-stripe) を敷く。既定色は #FAFCFF（薄い青み白。DB default・保存済み個人設定と同値。dsk-0377 で一時 #F4F5F7 化したが mdl-0052 の開発統括判断で #FAFCFF を正に確定し差し戻し）。縞は必ず var(--sp-row-stripe) 参照で実装し、カラーコード直書きや独自トークンを作らない——ON/OFF・縞色は設定タブ「個人設定 › 表示設定」でアカウント単位に変更でき、再ログイン時にセッション初期化（SessionProvider）が :root の --sp-row-stripe を一括上書きして反映するため、この 1 変数に載っていない縞は設定に追従できない。',
      },
      {
        type: 'table',
        head: ['要素', '値'],
        rows: [
          ['縞の対象行', '偶数行（2,4,…行目。tr:nth-child(even) / 可視行カウント）'],
          ['縞色トークン', 'var(--sp-row-stripe)（既定 #FAFCFF）'],
          [
            'hover との優先',
            'hover は単一帯（.sp-row-hoverband・薄グレー）が縞の上に重なる（mdl-0050 帯スライド。行個別 :hover 背景は廃止）',
          ],
          [
            'ON/OFF・色変更',
            '設定タブ › 個人設定 › 表示設定（アカウント単位・再ログイン時に反映）',
          ],
        ],
      },
      {
        type: 'note',
        text: '--sp-row-stripe を明細縞以外の装飾背景（見出し帯・コード枠・ダミー行等）へ流用しない。ユーザーが縞 OFF（transparent 化）やカスタム色にすると装飾側が巻き添えで消える／変色するため、装飾背景には var(--sp-paper) を使う（mdl-0022 で流用 4 箇所を是正済み）。',
      },
    ],
    compliesWith: [{ label: 'colorトークン直書き禁止（本タブ UI共通）' }],
    examples: {
      good: [
        {
          text: '.sp-table クラスと共通 Pagination をそのまま使い、個別に文字サイズ・罫線色・グリッド構成を作り込まない',
          demo: 'table-usage-good',
        },
      ],
      bad: [
        {
          text: 'ヘッダーと明細を同じ文字サイズにする／濃い罫線色 var(--sp-line-warm) をヘッダー下線に使う／画面ごとにページネーションを再実装する',
          demo: 'table-usage-bad',
        },
      ],
    },
  },
];
