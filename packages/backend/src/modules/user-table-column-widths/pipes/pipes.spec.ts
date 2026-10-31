import { BadRequestException } from '@nestjs/common';
import { TABLE_IDS } from '@rete/shared';
import { ParseColumnKeyPipe, ParseTableIdPipe } from './index';

describe('ParseTableIdPipe', () => {
  const pipe = new ParseTableIdPipe();

  it.each([...TABLE_IDS])('許可集合の tableId "%s" はそのまま通す', (tableId) => {
    expect(pipe.transform(tableId)).toBe(tableId);
  });

  it.each(['unknown-table', '', 'FILES-LIST', 'files-list '])(
    '許可集合に無い tableId "%s" は 400 にする',
    (tableId) => {
      expect(() => pipe.transform(tableId)).toThrow(BadRequestException);
    },
  );
});

describe('ParseColumnKeyPipe', () => {
  const pipe = new ParseColumnKeyPipe();

  it.each(['name', 'order_no', 'col-1', 'a.b', 'ns:key', 'a'.repeat(64)])(
    '許可文字のみの columnKey "%s" はそのまま通す',
    (key) => {
      expect(pipe.transform(key)).toBe(key);
    },
  );

  it.each([
    '',
    'a'.repeat(65),
    '__proto__',
    'constructor',
    'prototype',
    'name with space',
    'name<script>',
    '日本語',
    'name/../etc',
    'a\nb',
  ])('不正な columnKey "%s" は 400 にする', (key) => {
    expect(() => pipe.transform(key)).toThrow(BadRequestException);
  });
});
