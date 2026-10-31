import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/**
 * columnKey に許す文字: 英数字 / `-` / `_` / `.` / `:` のみ（制御文字 / 空白 / Unicode を排除する）。
 */
const COLUMN_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * プロトタイプ汚染防止: フロントエンドの store がレスポンスを `widths[columnKey]` として
 * 直接展開するため、予約名は DB 入口で弾く。
 */
const RESERVED_COLUMN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * route パラメータ `columnKey` の形と予約名を decorator 側の 1 か所で検査する（d925）。
 * 形の定義を controller のハンドラごとに写すと、片方だけ古くなる。
 */
@Injectable()
export class ParseColumnKeyPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!COLUMN_KEY_RE.test(value) || RESERVED_COLUMN_KEYS.has(value)) {
      throw new BadRequestException('Invalid columnKey');
    }
    return value;
  }
}
