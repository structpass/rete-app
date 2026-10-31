import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ReorderFavoritesDto } from './reorder-favorites.dto';

describe('ReorderFavoritesDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const validate = (orderedIds: unknown) =>
    pipe.transform({ orderedIds }, { type: 'body', metatype: ReorderFavoritesDto });

  it.each([200, 201, 1000])('%i 件の全件並び替えを受け付ける', async (count) => {
    const orderedIds = Array.from({ length: count }, () => randomUUID());
    await expect(validate(orderedIds)).resolves.toEqual({ orderedIds });
  });

  it.each([undefined, null, [], 'invalid', ['not-a-uuid']])(
    '不正な入力 %p を拒否する',
    async (orderedIds) => {
      await expect(validate(orderedIds)).rejects.toMatchObject({ status: 400 });
    },
  );

  it('200 件を超えても重複を拒否する', async () => {
    const orderedIds = Array.from({ length: 201 }, () => randomUUID());
    orderedIds[200] = orderedIds[0];
    await expect(validate(orderedIds)).rejects.toMatchObject({ status: 400 });
  });
});
