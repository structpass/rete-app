/**
 * File モジュール共通定数。アップロードの hard cap（OOM/DoS backstop）と、業務設定（FileSettings）の
 * 既定値・単一行 id を一元管理する。controller（multipart 切断）と service（業務上限検証）が同じ値を参照する。
 */
import { resolve } from 'path';

/**
 * アップロードの暫定ハードキャップ（OOM/DoS 防止の安全弁・100 MiB）。multipart パーサ層（FileInterceptor）で
 * ディスクの一時ファイルに受ける前に切断する（fil-0121 で memory storage を撤去）。業務上限
 * （FileSettings.maxSizeBytes）はこの範囲内で可変で、これとは別物。本値は撤去せず backstop として残す
 * （業務上限を撤廃してもメモリ・ディスクの両側を防ぐ）。
 */
export const UPLOAD_HARD_LIMIT_BYTES = 100 * 1024 * 1024;

/**
 * アップロード受付時の一時フォルダ名（fil-0121）。multer（diskStorage）がここに一時ファイルを受ける。
 * storageKey は `<fileId>/<versionId>`（UUID 由来）のため `.tmp` と衝突しない。
 */
export const UPLOAD_TEMP_DIR_NAME = '.tmp';

/**
 * 実体保存ルート（`FILE_STORAGE_ROOT`・既定 `./storage/files`）を絶対パスへ解決する。
 * LocalFsStorageService の保存ルートと controller の multer 一時受け先が同じ値を指すための単一ソース
 * （fil-0121）。実装ごとに式を複製すると env 既定の変更時に片方だけ動く drift が生じる。
 */
export function resolveStorageRoot(): string {
  return resolve(process.env.FILE_STORAGE_ROOT ?? './storage/files');
}

/** multer の一時受け先（保存ルート配下の `UPLOAD_TEMP_DIR_NAME`）を絶対パスへ解決する（fil-0121）。 */
export function resolveUploadTempDir(): string {
  return resolve(resolveStorageRoot(), UPLOAD_TEMP_DIR_NAME);
}

/** FileSettings 未設定（行なし）時の既定最大サイズ。既存挙動を変えないため hard cap と同値（実質無制限）。 */
export const DEFAULT_MAX_SIZE_BYTES = UPLOAD_HARD_LIMIT_BYTES;

/** FileSettings 未設定時の既定許可拡張子。空配列 = 全拡張子許可（既存挙動を変えない）。 */
export const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = [];

/**
 * 常に拒否する拡張子（v2-197 要求版2）。**コードで固定で、設定からは外せない**。
 *
 * 中身が実行形式のファイルは内容署名の検査でも常時拒否されるが、その検査はバイナリの先頭バイトだけを
 * 見る。先頭が実行形式の署名でないファイル（例: 中身がテキストの `foo.exe`）はその層を素通りするため、
 * 「実行形式として扱う形式」を名前でも止める層がここに要る。開発統括の修正依頼（要求版2）で、この層を
 * 編集可能な一覧へ混ぜると「外せそう」に見えることが問題になったため、rejectedExtensions とは別の
 * 定数として分離し、画面では読み取り専用で表示する（API の応答にも別フィールドで載せる）。
 */
export const FIXED_REJECTED_EXTENSIONS: readonly string[] = [
  '.exe',
  '.dll',
  '.msi',
  '.scr',
  '.com',
];

/**
 * FileSettings 未設定時の既定「追加で拒否する拡張子」（v2-197 要求版2）。空配列 = 追加の拒否なし。
 *
 * 中身がテキストのスクリプト（.bat / .cmd / .ps1 / .sh）は内容署名の常時拒否（service の署名検査）を
 * 素通りするため、名前で止める層がここにしかない。管理者は画面から自由に追加・削除できる。
 * FIXED_REJECTED_EXTENSIONS はこの一覧とは別の層で、ここへ入れても保存値からは除かれる（常に拒否される
 * ものを編集一覧へ持つ意味が無く、画面でも「外せる」と誤解させるため）。
 */
export const DEFAULT_REJECTED_EXTENSIONS: readonly string[] = ['.bat', '.cmd', '.ps1', '.sh'];

/** FileSettings の単一行運用 id（常にこの id で upsert する）。 */
export const FILE_SETTINGS_SINGLETON_ID = 'singleton';

/** allowedExtensions に登録できる拡張子の最大件数（DoS/誤操作の安全弁）。 */
export const MAX_ALLOWED_EXTENSIONS = 50;

/** rejectedExtensions に登録できる拡張子の最大件数（DoS/誤操作の安全弁・allowedExtensions と同数）。 */
export const MAX_REJECTED_EXTENSIONS = 50;

/**
 * タグ横断検索（searchFilesByTags / searchFoldersByTags）の 1 リクエスト最大返却件数。
 * repository は SEARCH_RESULT_LIMIT + 1 件を取得し、超過を検出して truncated フラグを立てる。
 * 件数は 200 件に切って返す（暴走スキャン防止・name 検索と同方針）。
 */
export const SEARCH_RESULT_LIMIT = 200;

/**
 * 一括タグ操作（POST /files/tags/assign）の対象不在・非可視の共通文言（fil-0148・M1）。
 *
 * 存在秘匿（ADR 0038）は「見えない対象の拒否と、本当に存在しない対象の拒否の文言を揃える」ことで成り立ち、
 * 文言差はそのまま「どの判定で落ちたか」の oracle になる。一括経路では実在検証（400）と可視性拒否が
 * 同じステータス・同じ文言になるよう、両者の文言をこの定数 1 個へ集約する（fil-0148: 2 文言制は
 * {fileIds:[非可視ファイル], folderIds:[任意Y]} プローブで Y の存在判別を許す原理的穴を持つため、
 * 1 文言化でのみ閉塞できる）。origin（files / folders）× 不在 / 非可視の 4 ケースがすべてこの文言へ
 * 倒れることで、scheme 横断プローブにも oracle が開かない（criteria 1・M1 完遂）。
 */
export const BATCH_TARGET_NOT_FOUND_MESSAGE = '存在しないファイルまたはフォルダが含まれています';

/**
 * 単件経路（1 リクエスト 1 対象）の対象不在・非可視・版不在の共通文言（fil-0154・ADR 0066）。
 *
 * BATCH_TARGET_NOT_FOUND_MESSAGE との使い分けは対象数で決まる。一括は複数前提の言い回し
 * （「〜が含まれています」）なので単件へ流用すると日本語として破綻する。揃えるのは「1 文言であること」
 * であって文字列そのものではないため、単件用に本定数を別途持つ（fil-0154 設計裁定）。
 *
 * 集約対象は取得・アップロード・版追加・ダウンロード（版指定を含む）・削除・フォルダ作成・タグ設定・
 * フォルダ内容取得。版指定 DL の版不在も本文言へ倒すことで「ファイルはあるが版が無い」が応答から
 * 読み取れない（fil-0154 criteria 4）。**移動系 2 経路は対象外**（移動元と移動先の 2 対象を扱うため
 * 同一文言にするとどちらが不在か分からず利用者が直せない。fil-0155 で存在秘匿の検証を済ませ、
 * 「不在と非可視が同一文言で返るため 3 文言でも oracle にならない」ことを確認の上、現状維持と裁定。
 * 根拠は files.service.ts moveFolder 冒頭コメント）。
 */
export const SINGLE_TARGET_NOT_FOUND_MESSAGE = '対象が見つかりません';

/**
 * フォルダ移動の自己宛て 400 文言（fil-0116）。ADR 0063（fil-0136）で folder-acl.service を撤去した際に
 * 本ファイルへ移設した（repository の reason → service の文言翻訳という §4 の流れに沿う置き場）。
 */
export const FOLDER_MOVE_SELF_MESSAGE = 'フォルダを自身へは移動できません';

/** フォルダ移動の自身の子孫宛て 400 文言（fil-0116）。FOLDER_MOVE_SELF_MESSAGE と同型。 */
export const FOLDER_MOVE_CYCLE_MESSAGE = 'フォルダを自身の子孫へは移動できません';

/**
 * フォルダ階層の最大深さ（対象フォルダ自身を含みルートまで最大 100 フォルダ・fil-0118）。
 * 書き込み時の深さ検査（files.repository の tx 内）とパンくず組み立てが同じ値を参照する正本。
 */
export const FOLDER_MAX_DEPTH = 100;

/**
 * 階層深さ上限超過（400）の固定文言（fil-0118）。
 * repository は reason='depth_exceeded' を返すだけで文言を知らず、service が本定数へ翻訳する
 * （§4 エラー一元化）。経路（作成 / 移動 / ACL 解決の単件要求）で文言が割れると構造の存在が
 * 観測できるため、1 箇所へ集約して揃える（一括タグの存在秘匿文言 BATCH_TARGET_NOT_FOUND_MESSAGE と
 * 同じ集約理由・fil-0148）。
 */
export const FOLDER_DEPTH_EXCEEDED_MESSAGE = 'フォルダの階層が深すぎるため操作できません';

/** 構造参照の解決で 1 回に受ける id 数の上限（設計 §2.3・本文 1 本あたりの参照 10 件に余裕を持たせる）。 */
export const REF_RESOLVE_MAX = 20;

/** パス表記の区切り（設計 §2.2・spec §6.2 と同じ表記）。フロントの PATH_SEP と同じ文字列。 */
export const REF_PATH_SEP = ' ＞ ';
