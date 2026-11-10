import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { API_GLOBAL_PREFIX_PATH } from '../../../common/config/api-routes';
import { isExemptPath, isExternalIdpSession, rejectWithCode } from './enforcement-gate';

/**
 * ログイン後ゲートの共通判定（d1016）。MFA 強制とパスワード変更強制が同じ判断を持っていたため、
 * ここへ寄せた（同じ判断を 2 箇所に書くと、片方だけを直した時に出口が静かに塞がる・開く）。
 */
describe('enforcement-gate', () => {
  const req = (init: { path?: string; url?: string; authOrigin?: string }) =>
    ({
      path: init.path,
      url: init.url,
      session: init.authOrigin === undefined ? {} : { authOrigin: init.authOrigin },
    }) as unknown as Request;

  describe('isExternalIdpSession', () => {
    it('authOrigin が external-idp の時だけ true（未設定・未知の値では fail-open しない）', () => {
      expect(isExternalIdpSession(req({ authOrigin: 'external-idp' }))).toBe(true);
      expect(isExternalIdpSession(req({ authOrigin: 'local' }))).toBe(false);
      expect(isExternalIdpSession(req({ authOrigin: 'something' }))).toBe(false);
      expect(isExternalIdpSession(req({}))).toBe(false);
      expect(isExternalIdpSession({} as unknown as Request)).toBe(false);
    });
  });

  describe('isExemptPath', () => {
    const bases = ['/auth/me', '/auth/login'];

    it('グローバル prefix を剥がして、base 完全一致と base/... だけを通す', () => {
      expect(isExemptPath(req({ path: `${API_GLOBAL_PREFIX_PATH}/auth/me` }), bases)).toBe(true);
      expect(isExemptPath(req({ path: `${API_GLOBAL_PREFIX_PATH}/auth/login/mfa` }), bases)).toBe(
        true,
      );
    });

    it('部分文字列一致では通さない（同じ接頭辞の別パスを除外しない）', () => {
      expect(isExemptPath(req({ path: `${API_GLOBAL_PREFIX_PATH}/auth/me-export` }), bases)).toBe(
        false,
      );
      expect(isExemptPath(req({ path: `${API_GLOBAL_PREFIX_PATH}/settings/login` }), bases)).toBe(
        false,
      );
    });

    it('query を落としてから照合する（path が無い時は url を使う）', () => {
      expect(isExemptPath(req({ url: `${API_GLOBAL_PREFIX_PATH}/auth/me?x=1` }), bases)).toBe(true);
    });
  });

  describe('rejectWithCode', () => {
    it('403 とコード付きの本文で止める', () => {
      try {
        rejectWithCode('MFA_SETUP_REQUIRED', 'MFA の設定が必要です');
        fail('例外になっていない');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(403);
        expect((e as HttpException).getResponse()).toEqual({
          code: 'MFA_SETUP_REQUIRED',
          message: 'MFA の設定が必要です',
        });
      }
    });
  });
});
