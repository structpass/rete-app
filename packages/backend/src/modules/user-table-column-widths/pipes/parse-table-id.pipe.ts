import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { TABLE_IDS } from '@rete/shared';

const TABLE_ID_SET: ReadonlySet<string> = new Set(TABLE_IDS);

/**
 * route パラメータ `tableId` を TABLE_IDS の許可集合に照らす（d925）。
 * 判定を controller の各ハンドラへ写すと、ハンドラを足すたびに判定文も写すことになり、
 * 片方だけ古くなる。`ParseUUIDPipe` と同じく decorator 側の 1 か所に寄せ、判定を 1 本にする。
 */
@Injectable()
export class ParseTableIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!TABLE_ID_SET.has(value)) {
      throw new BadRequestException('Invalid tableId');
    }
    return value;
  }
}
