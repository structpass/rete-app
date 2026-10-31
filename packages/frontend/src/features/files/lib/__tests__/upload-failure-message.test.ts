import { formatUploadFailures, uploadFailureReason } from '../upload-failure-message';

/**
 * 失敗トーストの文言組み立て（v2-191）。以前はファイル名だけで理由を捨てていたため、
 * どのファイルがなぜ弾かれたかが画面から分からなかった。名前は出さず理由だけを出す
 * （開発統括の修正依頼・2026-09-23: 1 通が長く、複数件では同じ理由が並ぶだけだった）。
 */
describe('formatUploadFailures', () => {
  it('1 件は拒否理由を出す（名前は出さない）', () => {
    expect(
      formatUploadFailures(['実行形式（.exe や .dll など）のファイルはアップロードできません']),
    ).toBe(
      'アップロードに失敗しました（実行形式（.exe や .dll など）のファイルはアップロードできません）',
    );
  });

  it('理由が取れない失敗（上限・階層など）は文言だけを出す', () => {
    expect(formatUploadFailures([], 1)).toBe('アップロードに失敗しました');
    expect(formatUploadFailures([], 2)).toBe('2 件のアップロードに失敗しました');
  });

  it('2 件は理由を並べる', () => {
    expect(
      formatUploadFailures([
        '実行形式（.exe や .dll など）のファイルはアップロードできません',
        'ファイルサイズが上限（10 MB）を超えています',
      ]),
    ).toBe(
      '2 件のアップロードに失敗しました（実行形式（.exe や .dll など）のファイルはアップロードできません / ファイルサイズが上限（10 MB）を超えています）',
    );
  });

  it('同じ理由は種類で畳む（3 件が同じ理由でも 1 種類だけ出す）', () => {
    expect(formatUploadFailures(['許可されていない拡張子です', '許可されていない拡張子です'])).toBe(
      '2 件のアップロードに失敗しました（許可されていない拡張子です）',
    );
  });

  it('3 種類以上は先頭 2 種類を出し、残りは種類数に畳む（トーストが画面を覆わない）', () => {
    expect(
      formatUploadFailures(['実行形式のため拒否', 'サイズ超過のため拒否', '内容不一致のため拒否']),
    ).toBe(
      '3 件のアップロードに失敗しました（実行形式のため拒否 / サイズ超過のため拒否 / ほか 1 種類）',
    );
  });

  it('理由を出せない失敗（打ち切り）でも総数は total で数える', () => {
    expect(formatUploadFailures(['実行形式のため拒否'], 5)).toBe(
      '5 件のアップロードに失敗しました（実行形式のため拒否）',
    );
    expect(formatUploadFailures([], 3)).toBe('3 件のアップロードに失敗しました');
  });

  it('失敗 0 件では文言を作らない', () => {
    expect(formatUploadFailures([], 0)).toBe('');
  });
});

/** 失敗理由の取り出し（v2-191）。サーバーが訳した文言をそのまま出しつつ、内部向けの英語は出さない。 */
describe('uploadFailureReason', () => {
  const axiosError = (status: number, code: string | undefined, message: string | undefined) => ({
    response: {
      status,
      data: { error: { ...(code && { code }), ...(message && { message }) } },
    },
  });

  it('サーバーが返した理由（400 / 429 の案内文）はそのまま使う', () => {
    expect(
      uploadFailureReason(
        axiosError(
          400,
          'BAD_REQUEST',
          '実行形式（.exe や .dll など）のファイルはアップロードできません',
        ),
      ),
    ).toBe('実行形式（.exe や .dll など）のファイルはアップロードできません');
    expect(
      uploadFailureReason(
        axiosError(
          429,
          'TOO_MANY_REQUESTS',
          'アップロードの回数が多すぎます。少し待ってからお試しください',
        ),
      ),
    ).toBe('アップロードの回数が多すぎます。少し待ってからお試しください');
  });

  it.each(['BAD_REQUEST', 'INTERNAL_ERROR'])('413 は code=%s でもサイズ理由を潰さない', (code) => {
    // 現行と旧サーバーの両方で、判定は HTTP status に基づき案内文を保つ。
    expect(
      uploadFailureReason(axiosError(413, code, 'ファイルサイズが上限（100 MB）を超えています')),
    ).toBe('ファイルサイズが上限（100 MB）を超えています');
  });

  it('サーバー側の想定外（5xx）の汎用英文は日本語へ置き換える', () => {
    expect(
      uploadFailureReason(axiosError(500, 'INTERNAL_ERROR', 'An unexpected error occurred')),
    ).toBe('サーバー側でエラーが発生しました。時間をおいてもう一度お試しください');
    expect(uploadFailureReason(axiosError(503, 'SERVICE_UNAVAILABLE', 'Service Unavailable'))).toBe(
      'サーバー側でエラーが発生しました。時間をおいてもう一度お試しください',
    );
  });

  it('応答を読めない失敗は渡された文言に倒す', () => {
    expect(uploadFailureReason(new Error('Network Error'))).toBe('原因を特定できませんでした');
    expect(uploadFailureReason(undefined)).toBe('原因を特定できませんでした');
    // 呼び出し側の文脈を残せる（自動アップロード・版の保存など）。
    expect(uploadFailureReason(new Error('Network Error'), '新版の保存に失敗しました')).toBe(
      '新版の保存に失敗しました',
    );
  });
});
