import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 対称暗号化ユーティリティ（AES-256-GCM）。MFA の TOTP secret を DB へ平文で持たないための at-rest 暗号化に使う。
 *
 * - 鍵は env `MFA_TOTP_ENC_KEY`（32 byte を hex 64 文字 or base64 で指定）。
 * - 未設定/不正長なら isConfigured()=false。MFA 機能のみ graceful degradation で無効化し、アプリ全体の起動は止めない
 *   （ADR 0035 のメール graceful degradation と同型 / operational-policy §3）。
 * - 出力フォーマット: `iv:authTag:ciphertext`（各 hex）。GCM の auth tag を同梱し改竄検知する。
 * - 鍵そのもの・平文 secret は log に絶対に出さない（§2）。
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM 推奨 96bit nonce

/**
 * 鍵文字列を 32 byte へ解決する。hex(64 文字) を優先し、失敗時に base64 を試す。不正なら null。
 * 起動時の本番検査（main.ts の validateProductionSecrets）もこの関数で形を確かめる
 * （暗号化が受け付ける形と起動検査が受け付ける形を 1 か所に揃え、片方だけ変わる状態を作らない）。
 */
export function parseMfaTotpEncKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  // hex（64 文字）
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // base64（32 byte にデコードできるもの）
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === KEY_BYTES) return buf;
  } catch {
    /* fallthrough */
  }
  return null;
}

/** env から 32 byte 鍵を解決する。 */
function resolveKey(): Buffer | null {
  return parseMfaTotpEncKey(process.env.MFA_TOTP_ENC_KEY);
}

/** 暗号鍵が正しく設定されているか（= MFA 機能を有効化できるか）。未設定/不正長なら false（graceful degradation 判定点）。 */
export function isSecretCryptoConfigured(): boolean {
  return resolveKey() !== null;
}

/** SecretCrypto が未設定（鍵不在/不正）で暗号化が要求された時に投げる。呼び出し側は isSecretCryptoConfigured で事前判定済の前提。 */
export class SecretCryptoNotConfiguredError extends Error {
  constructor() {
    super('MFA_TOTP_ENC_KEY が未設定/不正のため暗号化を実行できません');
    this.name = 'SecretCryptoNotConfiguredError';
  }
}

/** 平文を AES-256-GCM で暗号化し `iv:authTag:ciphertext`（hex）を返す。 */
export function encryptSecret(plaintext: string): string {
  const key = resolveKey();
  if (!key) throw new SecretCryptoNotConfiguredError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

/** encryptSecret の出力を復号して平文を返す。改竄/鍵不一致は auth tag 検証で例外になる。 */
export function decryptSecret(encoded: string): string {
  const key = resolveKey();
  if (!key) throw new SecretCryptoNotConfiguredError();
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new Error('暗号化フォーマットが不正です');
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
