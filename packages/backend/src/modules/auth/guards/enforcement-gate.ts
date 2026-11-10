import { HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { API_GLOBAL_PREFIX_PATH } from '../../../common/config/api-routes';

/**
 * ログイン後ゲート（MFA 強制・パスワード変更強制）に共通の判定（d1016）。
 *
 * 2 つのガードは「外部 IdP で認証したセッションは通す」「除外 path は通す」「それ以外は 403 で遮断する」
 * という同じ形を持っており、同じ判断を 2 箇所に書くと片方だけを直した時に出口が静かに塞がる・
 * 開く（d849 と同旨）。判定だけをここへ寄せ、それぞれのガードは「何を強制するか」だけを持つ。
 */

/** グローバル prefix（main.ts setGlobalPrefix）。req.path には prefix 込みで載るため照合前に剥がす。 */
const GLOBAL_PREFIX = API_GLOBAL_PREFIX_PATH;

/**
 * 除外 path に当たるか（prefix 剥がし後、`base` 完全一致 or `base/...` のみ）。
 * 部分文字列一致（includes）は使わない（`/foo/settings/mfa-export` 等が誤って除外される穴を作らないため）。
 */
export function isExemptPath(req: Request, exemptBases: readonly string[]): boolean {
  const raw = (req.path || req.url || '').split('?')[0];
  const path = raw.startsWith(GLOBAL_PREFIX) ? raw.slice(GLOBAL_PREFIX.length) : raw;
  return exemptBases.some((b) => path === b || path.startsWith(`${b}/`));
}

/**
 * 外部 IdP が認証したセッションか（出自は authOrigin・d955）。
 * 素通しは「外部 IdP が認証した」と明示された時だけにして、未知の値・空文字・未設定で fail-open しない
 * （Rete 自身の資格情報で入ったセッションは、外部アプリへ認証を渡した後でも強制の対象に残す）。
 */
export function isExternalIdpSession(req: Request): boolean {
  return req.session?.authOrigin === 'external-idp';
}

/** 強制の遮断（403・コード付き）。呼び手は「何を強制するか」だけを渡す。 */
export function rejectWithCode(code: string, message: string): never {
  throw new HttpException({ code, message }, HttpStatus.FORBIDDEN);
}
