import {
  OIDC_SESSION_COOKIE,
  readCookieValue,
  readSignedCookieValue,
  signCookieValue,
} from './oidc-session-cookie';

/**
 * d1269: logout で `_session` を消すための cookie 読み取り。
 * ここが緩むと「他人の session id を投げて消す」経路になるため、署名検証の合否を固定する。
 */
describe('oidc-session-cookie', () => {
  const KEY = 'dev-rete-cookie-key-0123456789abcdef0123';
  const OTHER_KEY = 'rotated-key';

  /** keygrip と同じ形（`_session=<jti>` を署名）の cookie ヘッダを組み立てる。 */
  const signedHeader = (sessionId: string, key = KEY, name = OIDC_SESSION_COOKIE) => {
    const value = `${name}=${sessionId}`;
    return `${value}; ${name}.sig=${signCookieValue(key, value)}`;
  };

  describe('readCookieValue', () => {
    it('名前が完全一致する cookie だけを返すこと（接尾辞一致で拾わない）', () => {
      const header = 'other_session=aaa; _session=bbb; x=ccc';
      expect(readCookieValue(header, '_session')).toBe('bbb');
      expect(readCookieValue(header, 'session')).toBeUndefined();
    });

    it('ヘッダが無い・空なら undefined を返すこと', () => {
      expect(readCookieValue(undefined, '_session')).toBeUndefined();
      expect(readCookieValue('', '_session')).toBeUndefined();
    });
  });

  describe('readSignedCookieValue', () => {
    it('署名が正しければ cookie の値を返すこと', () => {
      expect(readSignedCookieValue(signedHeader('session-1'), OIDC_SESSION_COOKIE, [KEY])).toBe(
        'session-1',
      );
    });

    // rotation 中は旧鍵でも検証できる必要がある（provider は keys を全部試す）。
    it('複数鍵のどれかに一致すれば通すこと（鍵 rotation 中）', () => {
      expect(
        readSignedCookieValue(signedHeader('session-2', OTHER_KEY), OIDC_SESSION_COOKIE, [
          KEY,
          OTHER_KEY,
        ]),
      ).toBe('session-2');
    });

    it('署名が別鍵で作られていれば undefined を返すこと（他人のセッションを消せない）', () => {
      expect(
        readSignedCookieValue(
          signedHeader('attacker-chosen', 'attacker-key'),
          OIDC_SESSION_COOKIE,
          [KEY],
        ),
      ).toBeUndefined();
    });

    it('値を差し替えると署名が合わず undefined を返すこと（改竄検知）', () => {
      const header = signedHeader('session-3');
      const tampered = header.replace('_session=session-3', '_session=victim-session');
      expect(readSignedCookieValue(tampered, OIDC_SESSION_COOKIE, [KEY])).toBeUndefined();
    });

    it('署名 cookie が無い・鍵が空なら undefined を返すこと（検証を飛ばさない）', () => {
      expect(
        readSignedCookieValue('_session=session-4', OIDC_SESSION_COOKIE, [KEY]),
      ).toBeUndefined();
      expect(
        readSignedCookieValue(signedHeader('session-5'), OIDC_SESSION_COOKIE, []),
      ).toBeUndefined();
    });
  });
});
