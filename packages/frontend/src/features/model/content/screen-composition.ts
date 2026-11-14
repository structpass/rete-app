import type { ModelTheme } from '../types';

/**
 * 「画面構成」カテゴリ — 1テーマ＝1画面型。
 * 一覧 / 詳細 / 一覧＋詳細 / メッセージ / 揮発性ポップアップ / フォーム など、抽象度の高い領域レベルで
 * 画面の骨格を定義・整理する（rete-model-0002）。全画面がいずれかの型に厳密に嵌るわけではないが、
 * 型を持つことで共通性が上がり直感的な操作理解につながる。Phase1 は代表（一覧画面）を active 起案。
 */

export const SCREEN_COMPOSITION_THEMES: ModelTheme[] = [
  {
    id: 'screen-list',
    title: '一覧画面',
    category: 'screen-composition',
    status: 'active',
    summary:
      '上部の「タイトル → フィルタエリア → 表直上のアクション行 → 表」の4段＋均一密度の行リスト。アクション行は右寄せ・表ヘッダまで4px・権限でボタンが消えても高さを確保する。0件は既定＝リスト骨格残置＋明示文言（意図的特例あり）。',
    sources: [
      'features: files 一覧 / desk タスク明細',
      'features/settings/components/members-screen.tsx（tbody 空行＋文言＝既定の代表）',
      'features/files/components/file-list.tsx（フォルダ真0＝tbody silent・rete-files-0007/0008）',
      'features/desk/components/task-tree.tsx（タスク真0＝EmptyTreeDropZone・絞り込み0＝DOM残置＋文言）',
      'features/desk/components/desk-shell.tsx + desk-task-toolbar.tsx（フィルタエリア→ボタン→表の並び＝Desk が基準・d1273）',
      'features/dashboard/components/dashboard-view.tsx（掲示板・FAQ を Desk の並びへ揃えた実装・d1273）',
      'features/calendar/calendar-panel.tsx（予定一覧の右上アクション行を共通部品へ移した実装・d1273）',
      'components/shared/list-actions.tsx（ListActionRow / ActionButton＝表右上アクションの共通部品）',
      'app/globals.css の --sp-section-gap（段間）と .sp-list-action-row（行の高さ確保・4px）',
    ],
    purpose:
      '一覧系画面（ファイル一覧・タスク明細・チケット一覧・掲示板/FAQ 等）を共通の骨格で揃え、操作位置や空状態表現が画面ごとに割れるのを防ぐ。上部の段構成（タイトル／フィルタエリア／アクション行／表）の区切りも同じ骨格で揃え、絞り込み・操作・一覧の境界が画面ごとに読み違えられないようにする。あわせて、権限でボタンが出ない人でも表の開始位置が動かないことを骨格の条件に含める。空状態は「残置派を既定＋意図的特例」で説明する（全画面を1表現に機械統一しない）。',
    spec: [
      {
        type: 'p',
        text: '構成は「タイトル（画面名）→ フィルタエリア（検索・絞り込み）→ 表直上のアクション行（新規登録など）→ 表（一覧パネル）」の縦4段。Desk（フィルタエリア → ボタン → 表）を基準に、掲示板・FAQ・カレンダーの予定一覧・ファイルもこの並びへ揃える（d1273）。',
      },
      {
        type: 'table',
        head: ['段', '中身', '間隔（下端→次の段の上端）'],
        rows: [
          [
            'タイトル',
            'PageTitle（画面名）。左寄せ。下余白は PageTitle の mb-3（12px）が持つ',
            'フィルタエリアまで 12px（ページ側の gap で取る画面は mb-3 を打ち消し、合計を 12px に保つ）',
          ],
          [
            'フィルタエリア',
            '検索窓・絞り込みチップ・クリア。透明地・枠なし。操作ボタンはここへ混ぜない',
            'アクション行まで 0〜12px（Desk・掲示板・FAQ は 0px、設定の一覧系5画面は帯の下余白 4px、祝日設定は帯を包む toolbar の gap 6px、ページ全体を gap で積むカレンダーは 12px）。行側で上余白を足さない',
          ],
          [
            'アクション行',
            '一覧に対する操作（新規登録・分類設定・CSV 出力 等）を右寄せで並べる独立行。共通部品 ListActionRow + ActionButton',
            '表まで 4px（cmn-0145）。行の高さは 2rem を常に確保し、ボタンが 0 個でも縮めない',
          ],
          ['表', '一覧パネル（.sp-panel / TableCard）とページャ。行密度は画面間で揃える', '—'],
        ],
      },
      {
        type: 'list',
        items: [
          '検索 / フィルタはフィルタエリアに集約し、本体行へ操作を散らさない。一覧に対する操作（新規登録・分類設定・CSV 出力など）はフィルタエリアへ混ぜず、表の直上の独立行へ右寄せで出す（Desk・設定一覧・掲示板・FAQ・カレンダー予定一覧で同じ並び）。',
          'タイトルとフィルタエリアの間隔は 12px。PageTitle の mb-3 で取る画面（掲示板・FAQ）はそのままでよく、ページ側の gap で取る画面（カレンダー）は PageTitle の下余白を打ち消して gap と二重にしない（合計 24px にしない）。',
          'フィルタエリアとアクション行の間は、画面側の段間（Desk・掲示板・FAQ は 0px＝詰めて置く／設定の一覧系5画面は帯の下余白 4px／祝日設定は帯を包む toolbar の gap 6px／ページ全体を gap で積むカレンダーは 12px）に従い、行側で上余白を足さない。絞り込みの帯を操作行から離しすぎると、どちらが絞り込みでどちらが操作かが読み取りにくくなる。',
          'アクション行と表ヘッダ罫線の間は 4px（UI共通「表右上アクションと表の間隔」・cmn-0145）。フィルタエリアを表へ密着させるのは不可（絞り込みが表の見出しの一部に見える）が、表に接するのはアクション行なので 4px でよい。',
          'アクション行は権限（閲覧のみのメンバー等）でボタンが 0 個になっても行ごと消さない。行の高さ（2rem）を確保し、見る人が違っても表の開始位置を動かさない（開発統括指示 2026-11-12）。同じ理由で、ボタンの有無で行の高さ・余白を変えない。',
          '一覧名を持つ画面（カレンダーの予定一覧「スケジュール」等）は、その見出しを行の左に置き、操作は右へ寄せる（行は space-between）。見出しの有無で行の高さは変えない。',
          '0件（empty）既定: リスト骨格（table/tbody 等）を残しつつ明示文言を出す（Settings members の tbody 空行＋「該当する…がいません」等）。絞り込み0も同様に DOM を残置し文言で示す（D&D の gap index 等の整合を壊さない）。',
          '0件 特例（意図・潰さない）: (1) Files フォルダ内容の真0＝tbody silent（行も文言も出さない・rete-files-0007/0008）(2) Desk タスク真0＝EmptyTreeDropZone（文言＋D&D 受け・rete-desk-0172）。絞り込み0は特例ではなく上記既定（DOM 残置＋文言）の再掲＝リスト DOM を丸ごと差し替えない。',
          '行密度（高さ・余白）は画面間で揃える。選択 / ホバーは行単位で表現する。',
        ],
      },
      {
        type: 'note',
        text: 'EmptyState 共通部品の新設や、語彙の全画面機械統一・全画面 Settings 型 empty 強制は本テーマの scope 外。一覧と詳細を同一画面に併置する場合は「一覧＋詳細画面」型を参照（詳細はオーバーレイ画面で重ねる Desk 方式）。フィルタエリア内の帯の作り方（検索窓 14rem・チップ・クリアの並び）は UIコンポーネント「検索フィルタ」、アクション行とボタンの寸法は同「Toolbar」と UI共通「表右上アクションと表の間隔」が正本で、本テーマは段の位置関係だけを持つ。',
      },
    ],
    compliesWith: [
      { label: '状態表現（loading / empty / error）（本タブ UI共通）' },
      { label: '画面タイトル（本タブ UIコンポーネント）' },
      { label: '検索フィルタ（本タブ UIコンポーネント）' },
      { label: '表右上アクションと表の間隔（本タブ UI共通）' },
    ],
    examples: {
      good: [
        '掲示板・FAQ が「タイトル → フィルタエリア → 表直上のアクション行 → 表」の順で、行と表の間 4px に積む（dashboard-view.tsx・d1273）',
        'Desk がフィルタエリアの直下に右寄せの操作行（分類設定・新規登録）を置き、表へ 4px で接する（desk-shell.tsx）',
        'カレンダーの予定一覧が「スケジュール」見出しを左・新規登録を右に置く同じ行構成（calendar-panel.tsx）',
        '閲覧のみのメンバーでも操作行は残り、表の開始位置が管理者と同じ（掲示板・カレンダー・File）',
        'Settings 一覧の 0件で tbody を残し明示文言を出す（既定）',
        'Desk 絞り込み0でツリー DOM を残したまま「該当なし」文言（task-tree)',
        'Files フォルダ真0の tbody silent・Desk タスク真0の EmptyTreeDropZone（意図的特例）',
      ],
      bad: [
        '検索ボックスを各行に置く',
        '新規登録などの操作ボタンを絞り込み帯の中へ混ぜる（Desk・設定一覧・掲示板・FAQ・カレンダーで並びが揃わなくなる）',
        '権限でボタンが出ない時に操作行ごと消し、表の開始位置が上下に動く',
        'フィルタ帯を表パネルへ密着させ、絞り込みが表の見出しの一部に見える',
        '絞り込み0でリスト DOM ごと消して D&D/gap を壊す',
        'files silent や EmptyTreeDropZone をメッセージ強制や DOM 差し替えで潰す',
      ],
    },
  },
  {
    id: 'screen-detail',
    title: '詳細画面',
    category: 'screen-composition',
    status: 'active',
    summary:
      '1 レコードの詳細表示 + 編集。ヘッダ（タイトル/操作）と本文（属性/タブ）を分離する画面型。',
    sources: [
      'features: desk タスク詳細オーバーレイ（task-detail-overlay.tsx）',
      'features/dashboard/components/dashboard-view.tsx（固定見出し＋本文スクロール）',
      '19df47e2（Desk 詳細の起点カードと属性更新帯を分離した既存構成）',
    ],
    purpose: '詳細・編集画面のヘッダと本文の分離、保存/破棄の確認経路を統一する。',
    spec: [
      {
        type: 'p',
        text: '既定の構成は「ヘッダ（タイトル＋操作）＋ 本文（属性/タブ）」の上下分離。ヘッダは常時見える位置に固定し、本文側のスクロールに追従させない。Desk のスレッド型は下記の分離構成を使う。',
      },
      {
        type: 'list',
        items: [
          'ヘッダにタイトルと主要操作（保存・削除・閉じる等）を集約し、本文へ操作を散らさない。',
          '編集を始めたら保存/破棄の経路を必ず用意する（保存ボタンとキャンセル/破棄ボタンを対で置く）。',
          '閉じる操作（Esc・背景クリック・閉じるボタン）時、書きかけの変更があれば破棄確認を出す（無編集なら確認なしで閉じてよい）。',
        ],
      },
      {
        type: 'note',
        text: 'Desk のスレッド型詳細は、固定タブ・右列の属性更新帯と、本文内の起点カード（題名・説明・投稿者自身の編集操作）に分かれる。起点カードはコメントと同じスクロール領域に置く（19df47e2）。題名カード全体を固定する変更は行わない。属性編集と起点カード編集の双方に保存・キャンセルと未保存変更の破棄確認を用意する。',
      },
      {
        type: 'note',
        text: '一覧と併置する場合は「一覧＋詳細画面」型を参照（詳細はオーバーレイ画面で重ねる Desk 方式・二重オーバーレイ禁止）。',
      },
    ],
    compliesWith: [
      { label: '本タブ 用語・命名「オーバーレイ用語」' },
      { label: '本タブ 用語・命名「Desk 画面命名」' },
    ],
    examples: {
      good: [
        'タスク詳細オーバーレイのヘッダ固定＋編集中 Esc で破棄確認を出す（task-detail-overlay.tsx）',
      ],
      bad: [
        'ヘッダと本文を同一スクロール領域に置きタイトルが本文と一緒に流れる / 編集中でも確認なしに閉じて変更を失わせる',
      ],
    },
  },
  {
    id: 'screen-list-detail',
    title: '一覧＋詳細画面',
    category: 'screen-composition',
    status: 'active',
    summary: '一覧を保持したまま詳細を開く併置型。Desk・Files はオーバーレイ、Home は固定2ペイン。',
    sources: [
      'features: desk-shell.tsx（ChatList＋ChatThread＋TaskDetailOverlay 併置）',
      'features: files-shell.tsx（FileList＋各種 Overlay 併置）',
      'features/dashboard/components/dashboard-view.tsx（通知一覧と詳細・編集を固定2ペインで併置）',
    ],
    purpose: '一覧の文脈を失わずに詳細へ入る導線（オーバーレイ・二重オーバーレイ禁止）を統一する。',
    spec: [
      {
        type: 'p',
        text: 'Desk・Files は一覧画面をそのまま保持し、詳細をオーバーレイ画面（重ねる小窓）として開く。Home は下記の固定2ペイン型を使う。いずれも詳細の表示によって一覧を別画面へ遷移させたり一覧 DOM を差し替えたりしない。',
      },
      {
        type: 'list',
        items: [
          '一覧の行クリック等で詳細オーバーレイを開き、閉じれば一覧はそのままの状態（スクロール位置・選択状態）に戻る。',
          '二重オーバーレイ禁止：詳細オーバーレイが開いている間は別のオーバーレイ画面を同時に開かない（排他）。',
          '一覧の文脈（絞り込み・並び順・スクロール位置）は詳細を開閉しても保持する。',
        ],
      },
      {
        type: 'note',
        text: 'Home（掲示板・FAQ）は既存の固定2ペイン型を使う。一覧を左に残し、右ペイン内で詳細表示と新規・編集フォームを排他で切り替える（dashboard-view.tsx）。詳細を別の小窓へ移す変更は行わない。一覧の絞り込み・並び順・スクロール位置を保持する原則は同じ。独立ルートを持つ Settings の作成・編集ページは「フォーム画面」の対象とする。',
      },
      {
        type: 'note',
        text: 'Homeのカレンダーは左に月2か月または選択週を保持し、右で予定一覧・参照・新規・編集を切り替える。右一覧もDOMと検索・選択・スクロール状態を保持する。日付は日本時間で扱い、予定と一覧は同じ期間データから描画する。常設の操作説明や重複ラベルを追加せず、入力項目と操作の名称、必要時のエラー・確認に絞る。',
      },
      {
        type: 'note',
        text: '詳細オーバーレイ自体の内部構成（ヘッダ/本文分離・保存導線）は「詳細画面」型に従う。',
      },
    ],
    compliesWith: [
      { label: '本タブ 用語・命名「オーバーレイ用語」' },
      { label: '本タブ 用語・命名「Desk 画面命名」' },
    ],
    examples: {
      good: [
        'desk-shell.tsx の ChatList/ChatThread 併置に TaskDetailOverlay を重ねる（一覧は消えない）',
      ],
      bad: [
        '詳細を開く時に一覧ページごと別ルートへ遷移する / タスク詳細と昇格フォームを同時に開いて二重オーバーレイになる',
      ],
    },
  },
  {
    id: 'screen-message',
    title: 'メッセージ画面',
    category: 'screen-composition',
    status: 'active',
    summary: 'スレッド（テーマ）+ 時系列メッセージ + 入力コンポーザーで構成するチャット型。',
    sources: [
      'features: chat-thread.tsx（スレッド見出し＋メッセージ全件＋返信コンポーザー装着）',
      'features: reply-composer.tsx / theme-composer.tsx（入力コンポーザー実装）',
    ],
    purpose: 'チャット系画面のスレッド/明細/コンポーザーの骨格と送信操作を統一する。',
    spec: [
      {
        type: 'p',
        text: '構成は「スレッド見出し（テーマ）＋ 本体（時系列メッセージ全件）＋ 下部コンポーザー（入力）」の3段。テーマは常時見える位置に置き、メッセージ本体はそれ以下に時系列で並べる。',
      },
      {
        type: 'list',
        items: [
          '送信前に空本文・文字数上限をチェックし、満たさない場合は送信を行わない（コンポーザー側でガード）。',
          '入力途中（書きかけ）で画面/オーバーレイを閉じる操作をした場合、書きかけ内容があれば破棄確認を出す。',
          'メッセージ全件は新着が来ても既存メッセージの表示順・スクロール位置を不用意に崩さない。',
        ],
      },
      {
        type: 'note',
        text: 'スレッド＝テーマという前提（無題発話が主役ではない）は「チャット=テーマ前提」型に従う。',
      },
    ],
    compliesWith: [
      { label: '本タブ 画面構造「チャット=テーマ前提」' },
      { label: '本タブ 画面構造「Thread 共通基底モデル」' },
    ],
    examples: {
      good: ['chat-thread.tsx のテーマ見出し固定＋ReplyComposer での空本文送信ガード'],
      bad: [
        'テーマ見出しを本文と同一スクロール領域に置き埋もれさせる / 空本文でも検証なしにそのまま送信されてしまう',
      ],
    },
  },
  {
    id: 'screen-volatile-popup',
    title: '揮発性ポップアップ画面',
    category: 'screen-composition',
    status: 'active',
    summary: 'トースト / メニュー / サジェスト等、状態を持たず短命に出して消える表示の型。',
    sources: [
      'features: toast-provider.tsx（react-hot-toast Toaster・自動消滅）',
      'features: desk-sidebar-row-menu.tsx（コンテキストメニュー）/ mention-suggestion.tsx（入力サジェスト）/ tag-filter-dropdown.tsx（ドロップダウン）/ reaction-picker.tsx（リアクションピッカー）',
    ],
    purpose:
      '短命表示（保存しない・閉じたら消える）の出し方と閉じ経路を整理し、永続画面と区別する。',
    spec: [
      {
        type: 'p',
        text: 'トースト・コンテキストメニュー・ドロップダウン・入力サジェスト・リアクションピッカー等、状態を保存せず短く出して消える表示の型。詳細画面・フォーム画面のような永続画面とは明確に区別する（閉じても内容は残らない）。',
      },
      {
        type: 'list',
        items: [
          '出し方: トリガー（クリック位置・入力位置）起点に添えて出すもの（メニュー/サジェスト/ドロップダウン）と、トリガー不要で一定時間後に自動消滅するもの（トースト）の2系統がある。',
          '閉じ経路: 外側クリック・Esc・選択確定・時間切れ（トーストの自動消滅）のいずれかで閉じる。閉じた後に内容は保持しない（ただしフォーカス復帰由来の body/documentElement クリックは外側扱いしない＝dsk-0310。popover を持つ popup 系のみ該当、トーストは元から該当外）。',
          'トリガー要素がスクロールする画面では、表示位置をスクロールに追従させる（mention-suggestion.tsx の reposition 等）。',
        ],
      },
      {
        type: 'note',
        text: '「閉じたら内容は残らない」が本型の前提。編集内容の保持・破棄確認が要る画面は「詳細画面」「フォーム画面」型を使う。',
      },
    ],
    compliesWith: [{ label: '本タブ UI共通「状態表現（loading / empty / error）」' }],
    examples: {
      good: [
        'トースト（react-hot-toast）が一定時間後に自動消滅し状態を残さない / mention-suggestion.tsx がスクロール追従で位置を保つ',
      ],
      bad: [
        'ドロップダウンを閉じても選択途中の内容が次回開いた時に残ってしまう / トリガー要素をスクロールしてもポップアップ位置が追従せずズレる',
      ],
    },
  },
  {
    id: 'screen-form',
    title: 'フォーム画面',
    category: 'screen-composition',
    status: 'active',
    summary: '新規 / 編集の入力フォーム。必須バッジ・バリデーション・保存/キャンセルの配置型。',
    sources: [
      'features: announcement-form.tsx（＊必須バッジ・バリデーション・保存/キャンセル・Esc破棄）',
      'features: desk-task-form.tsx / settings/components/primitives/form.tsx（フォーム基底例）',
    ],
    purpose: 'フォーム画面の項目構造（必須/エラー/保存導線）を統一し、新規・編集間の差を防ぐ。',
    spec: [
      {
        type: 'p',
        text: '必須項目には「＊必須」バッジを付け、任意項目と視覚的に区別する。入力エラーはその場（インライン or トースト）で示し、送信後に画面遷移してから初めて分かるようにしない。',
      },
      {
        type: 'list',
        items: [
          '保存 / キャンセルは画面下部の定位置に置き、新規作成・編集どちらのフォームでも同じ配置にする。',
          '編集中にキャンセル（Esc・背景クリック含む）した場合、書きかけの変更があれば破棄確認を出す。',
          '新規作成と編集で項目構造・バリデーション経路に差を作らない（同一フォームを両モードで共用する）。',
        ],
      },
      {
        type: 'note',
        text: 'ラベル／＊必須／エラーの構造は共通 FormField primitive（本タブ UI共通「FormField・Label」）に準拠する。FormField は入力の見た目を規定しないラッパのため、desk/dashboard の入力子が warm 配色（--sp-* トークン）を保つことと両立する（hom-0102）。',
      },
    ],
    compliesWith: [
      { label: '本タブ UI共通「状態表現（loading / empty / error）」' },
      { label: '本タブ UI共通「ボタン色規約」' },
      { label: '本タブ UI共通「FormField・Label」' },
    ],
    examples: {
      good: [
        'announcement-form.tsx の FormField 準拠（label/required/error props）＋warm 入力子＋保存/キャンセル定位置の合成パターン',
      ],
      bad: [
        '必須項目に印を付けず送信して初めてエラーが分かる / 新規と編集でボタン配置や項目順が入れ替わる',
      ],
    },
  },
];
