// 資料実体の再作成用。Codexの表計算ランタイムを使用し、アプリの実行依存には含めない。
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';
import { screenRows, questions, csvFields } from './inventory-documents.mjs';

const output = resolve(process.argv[2]);
await fs.mkdir(output, { recursive: true });
const specs = [
  [
    'screens-v08',
    '画面一覧・操作フロー 第0.8版',
    ['画面番号', '画面・帳票名', '操作の流れ', '要件番号', '設計担当', '確認状況'],
    // 第0.8版も「確認状況」は原本の値のまま出す（d1023。固定の文字で上書きすると、確認の進み具合が
    // 原本と食い違う）。版ごとに違うのは表題だけで、中身の行は同じ原本から作る。
    screenRows,
    [90, 180, 460, 100, 110, 150],
  ],
  [
    'screens-v09',
    '画面一覧・操作フロー 第0.9版',
    ['画面番号', '画面・帳票名', '操作の流れ', '要件番号', '設計担当', '確認状況'],
    screenRows,
    [90, 180, 460, 100, 110, 150],
  ],
  [
    'questions',
    '仕様確認事項一覧 第0.9版',
    ['確認番号', '対象', '確認すること', '内容・回答', '回答者', '回答期限', '状態'],
    questions,
    [90, 80, 180, 480, 110, 120, 150],
  ],
  [
    'csv-v08',
    '入出庫データ項目定義 第0.8版',
    ['基幹の見出し', 'システムの項目', '型', '桁数', '必須', '検証・処理', '正常例'],
    csvFields.map((r) => (r[0] === '注文番号' ? ['確認中', ...r.slice(1)] : r)),
    [140, 140, 85, 80, 65, 330, 170],
  ],
  [
    'csv-v09',
    '入出庫データ項目定義 第0.9版',
    ['基幹の見出し', 'システムの項目', '型', '桁数', '必須', '検証・処理', '正常例'],
    csvFields,
    [140, 140, 85, 80, 65, 330, 170],
  ],
  [
    'profiling',
    '商品マスタ 事前調査・回答表',
    ['照会番号', '検出事項', '件数・組数', '内訳・確認すること', '業務回答者', '期限', '状態'],
    [
      [
        'D-001',
        '商品コードの重複',
        12,
        '名称表記差8組、別商品のコード衝突疑い4組。自動統合せず顧客が判断。',
        '藤原 美咲',
        '2026-11-10',
        '11月5日照会予定',
      ],
      [
        'D-002',
        '取扱単位が未設定',
        37,
        '個・箱・メートルのいずれかを確認。移行側で推測して補完しない。',
        '藤原 美咲',
        '2026-11-10',
        '11月5日照会予定',
      ],
      [
        'D-003',
        '廃止区分が不明',
        9,
        '新規取引を止める商品と履歴参照のみの商品を確認。',
        '藤原 美咲',
        '2026-11-10',
        '11月5日照会予定',
      ],
      [
        'D-004',
        '元データの範囲',
        18420,
        '商品マスタの受領総件数。上記の検出群は重複して含まれる可能性がある。',
        '石川 真由',
        '2026-10-30',
        '受領済み',
      ],
    ],
    [90, 190, 100, 510, 110, 120, 170],
  ],
  [
    'quantity',
    '在庫数量の確認例 第1.0版',
    ['商品コード', '倉庫', '実在庫', '引当済', '出荷可能', '入荷予定', '移送中'],
    [
      ['BK-1042', '本社倉庫', 120, 35, null, 40, 10],
      ['BK-1042', '南物流センター', 60, 20, null, 0, 0],
      ['NT-2080', '本社倉庫', 48, 48, null, 24, 0],
      ['PL-0315', '南物流センター', 0, 0, null, 15, 8],
    ],
    [145, 190, 110, 110, 120, 120, 120],
  ],
];
for (const [key, title, headers, rows, widths] of specs) {
  const wb = Workbook.create();
  const sheet = wb.worksheets.add('確認資料');
  sheet.showGridLines = false;
  const end = String.fromCharCode(64 + headers.length);
  const last = 4 + rows.length;
  sheet.getRange('A1').values = [[title]];
  sheet.getRange('A2').values = [
    [
      '北斗機材 在庫管理システム導入｜' +
        (key.endsWith('v08') ? '2026年10月29日' : '2026年10月30日') +
        '｜架空案件の検証用資料',
    ],
  ];
  sheet.getRange('A4:' + end + last).values = [headers, ...rows];
  sheet.getRange('A1:' + end + last).format.font = {
    name: 'Yu Gothic',
    size: 10,
    color: '#172B4D',
  };
  sheet.getRange('A1').format.font = { name: 'Yu Gothic', size: 14, bold: true, color: '#17365D' };
  sheet.getRange('A1:' + end + '2').format.rowHeightPx = 30;
  sheet.getRange('A4:' + end + '4').format = {
    fill: '#17365D',
    font: { name: 'Yu Gothic', size: 10, bold: true, color: '#FFFFFF' },
    rowHeightPx: 40,
    wrapText: true,
  };
  sheet.getRange('A5:' + end + last).format.wrapText = true;
  sheet.getRange('A5:' + end + last).format.rowHeightPx = 65;
  sheet.getRange('A4:' + end + last).format.verticalAlignment = 'center';
  widths.forEach((w, i) => {
    const col = String.fromCharCode(65 + i);
    sheet.getRange(col + '1:' + col + last).format.columnWidthPx = w;
  });
  for (let r = 5; r <= last; r++)
    if (r % 2 === 1) sheet.getRange('A' + r + ':' + end + r).format.fill = '#F1F5F9';
  sheet.freezePanes.freezeRows(4);
  if (key === 'quantity') {
    sheet.getRange('E5').formulas = [['=C5-D5']];
    sheet.getRange('E5:E8').fillDown();
    sheet.getRange('C5:G8').setNumberFormat('#,##0');
    sheet.getRange('A10').values = [
      [
        '出荷可能数＝実在庫－引当済。入荷予定・移送中は加算しない。要件R-012・R-018、10月30日合意。',
      ],
    ];
    sheet.getRange('A10:G10').format.rowHeightPx = 35;
    wb.recalculate();
    const computed = sheet.getRange('E5:E8').values.flat();
    if (JSON.stringify(computed) !== JSON.stringify([85, 40, 0, 0]))
      throw Error('在庫数量の計算が一致しません。');
  }
  wb.recalculate();
  const preview = await wb.render({
    sheetName: '確認資料',
    range: 'A1:' + end + (key === 'quantity' ? 10 : last),
    scale: 1,
    format: 'png',
  });
  await fs.writeFile(resolve(output, key + '.png'), new Uint8Array(await preview.arrayBuffer()));
  await (await SpreadsheetFile.exportXlsx(wb)).save(resolve(output, key + '.xlsx'));
  console.log(key + ': exported and rendered (資料の再作成用の進捗表示)');
}
