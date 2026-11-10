import { describe, it, expect } from 'vitest';
import {
  extractErrorMessage,
  extractErrorStatus,
  extractValidationErrorMessage,
} from '../error-utils';
import { apiErrorMessage as deskErrorMessage } from '@/features/desk/lib/api-error';
import { apiErrorMessage as settingsErrorMessage } from '@/features/settings/lib/api-error';

describe('extractErrorMessage — 画面共通の API エラー文', () => {
  it('Desk と Settings も同じ抽出関数を使う', () => {
    expect(deskErrorMessage).toBe(extractErrorMessage);
    expect(settingsErrorMessage).toBe(extractErrorMessage);
  });

  it('共通 filter の具体的な理由をそのまま返す', () => {
    expect(
      extractErrorMessage(
        { response: { data: { error: { message: '同名のタグがあります' } } } },
        '失敗',
      ),
    ).toBe('同名のタグがあります');
  });

  it.each([
    undefined,
    null,
    {},
    new Error('network'),
    { message: '内部エラー' },
    { response: { data: { message: '旧形式' } } },
    ...['', 123, true, [], {}, null].map((message) => ({
      response: { data: { error: { message } } },
    })),
  ])('欠落・不正な応答では画面の既定文言を返す (%j)', (err) => {
    expect(extractErrorMessage(err, '保存できませんでした')).toBe('保存できませんでした');
  });
});

/**
 * 画面側が axios を直 import して e.response.status を読む代わりに共通の入口で status を取れることを
 * 固定する（d579: 共通処理を通らない送信経路を残さない）。
 */
describe('extractErrorStatus', () => {
  it('レスポンスの HTTP status を返す', () => {
    expect(extractErrorStatus({ response: { status: 409 } })).toBe(409);
  });

  it('status が無い・数値でない・エラー形状でない時は undefined', () => {
    expect(extractErrorStatus(new Error('network'))).toBeUndefined();
    expect(extractErrorStatus({ response: { status: '409' } })).toBeUndefined();
    expect(extractErrorStatus(undefined)).toBeUndefined();
    expect(extractErrorStatus(null)).toBeUndefined();
  });
});

/**
 * backend の AllExceptionsFilter は class-validator の失敗で message を generic な 'Validation failed' にし、
 * どの項目がどう悪いかを details.validationErrors[] へ入れる。この詳細を優先して取り出せることを固定する
 * （v2-198: 保存失敗時に固定文言だけを出して理由を捨てていた）。
 */
describe('extractValidationErrorMessage', () => {
  it('validationErrors が 1 件なら、その日本語の理由を返す', () => {
    const err = {
      response: {
        data: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: { validationErrors: ['拡張子は ".pdf" の形式で指定してください'] },
          },
        },
      },
    };
    expect(extractValidationErrorMessage(err, '設定の保存に失敗しました')).toBe(
      '拡張子は ".pdf" の形式で指定してください',
    );
  });

  it('validationErrors が複数なら、全部を並べて返す（どの項目がどう悪いか分かる）', () => {
    const err = {
      response: {
        data: {
          error: {
            message: 'Validation failed',
            details: {
              validationErrors: [
                '拡張子は 50 件までです',
                '拡張子は ".pdf" の形式で指定してください',
              ],
            },
          },
        },
      },
    };
    expect(extractValidationErrorMessage(err, '設定の保存に失敗しました')).toBe(
      '拡張子は 50 件までです / 拡張子は ".pdf" の形式で指定してください',
    );
  });

  it('詳細が無い generic な Validation failed は英語のまま出さず fallback へ倒す', () => {
    const err = { response: { data: { error: { message: 'Validation failed' } } } };
    expect(extractValidationErrorMessage(err, '設定の保存に失敗しました')).toBe(
      '設定の保存に失敗しました',
    );
  });

  // 祝日設定の保存（d974）は、この関数で 400（日付の形の誤り）・409（同じ日付の重複）の双方を
  // 画面の理由へ通す。class-validator 由来の 400 と、サーバーが決めた 409 の案内文がどちらも出ること。
  it('祝日の保存で返る 400 の日付エラーは、その理由が画面の文になる', () => {
    const err = {
      response: {
        data: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: { validationErrors: ['date must be a valid ISO 8601 date string'] },
          },
        },
      },
    };
    expect(extractValidationErrorMessage(err, '祝日を保存できませんでした')).toBe(
      'date must be a valid ISO 8601 date string',
    );
  });

  it('祝日の保存で返る 409 の案内文は、そのまま画面の文になる', () => {
    const err = {
      response: {
        data: {
          error: { code: 'CONFLICT', message: 'その日付の祝日は既に登録されています' },
        },
      },
    };
    expect(extractValidationErrorMessage(err, '祝日を保存できませんでした')).toBe(
      'その日付の祝日は既に登録されています',
    );
  });

  it('validationErrors が空配列でも fallback へ倒す', () => {
    const err = {
      response: {
        data: { error: { message: 'Validation failed', details: { validationErrors: [] } } },
      },
    };
    expect(extractValidationErrorMessage(err, '設定の保存に失敗しました')).toBe(
      '設定の保存に失敗しました',
    );
  });

  it('検証以外の業務メッセージはそのまま返す（BadRequest の日本語等）', () => {
    const err = {
      response: { data: { error: { code: 'BAD_REQUEST', message: '上限を超えています' } } },
    };
    expect(extractValidationErrorMessage(err, '設定の保存に失敗しました')).toBe(
      '上限を超えています',
    );
  });

  it('想定外の形（レスポンス無し・文字列以外の要素）は fallback へ倒す', () => {
    expect(extractValidationErrorMessage(new Error('network'), '設定の保存に失敗しました')).toBe(
      '設定の保存に失敗しました',
    );
    expect(
      extractValidationErrorMessage(
        { response: { data: { error: { details: { validationErrors: [123, null] } } } } },
        '設定の保存に失敗しました',
      ),
    ).toBe('設定の保存に失敗しました');
  });
});
