import { TagIdSetDto } from './tag-assignment.dto';

/**
 * ファイルのタグ付与集合の置換入力（PUT /files/files/:id/tags）。
 * 全置換セマンティクス（tagIds = 付与後の完全な集合・空配列で全解除）は基底 TagIdSetDto が定義する
 * （フォルダ版 SetFolderTagsDto と共通・§3 コピペ回避 / rete-files-0033）。
 */
export class SetFileTagsDto extends TagIdSetDto {}
