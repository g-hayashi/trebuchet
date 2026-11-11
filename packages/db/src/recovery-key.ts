import { randomBytes } from "node:crypto";

/**
 * 回復キー（008 の D1。写す元: invest-copilot `recoveryKey.ts`）。160 ビットの乱数を Crockford base32
 * （I・L・O・U を除く）の 4 文字区切り 8 組で表す。乱数そのものが包みの ikm で、保存・記録しない
 * （ハッシュも保存しない。正しさは包みが開けたかで判定する）
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 回復キーの乱数（160 ビット） */
export const RECOVERY_KEY_BYTES = 20;
const CHARS = (RECOVERY_KEY_BYTES * 8) / 5; // 32

export function formatRecoveryKey(secret: Uint8Array): string {
  if (secret.length !== RECOVERY_KEY_BYTES) {
    throw new Error(`a recovery key is ${RECOVERY_KEY_BYTES} bytes`);
  }
  let buffer = 0;
  let bits = 0;
  let out = "";
  for (const byte of secret) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
      buffer &= (1 << bits) - 1;
    }
  }
  return (out.match(/.{4}/g) ?? []).join("-");
}

/** 新しい回復キー。`secret` は使い終えたら呼び出し側が 0 で埋める */
export function generateRecoveryKey(): { text: string; secret: Buffer } {
  const secret = randomBytes(RECOVERY_KEY_BYTES);
  return { text: formatRecoveryKey(secret), secret };
}

/** 小文字・区切り・空白・読み違えやすい文字（I/L → 1、O → 0）を受ける。形が違えば null */
export function parseRecoveryKey(input: string): Buffer | null {
  const normalized = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (normalized.length !== CHARS) return null;
  const secret = Buffer.alloc(RECOVERY_KEY_BYTES);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of normalized) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) {
      secret.fill(0);
      return null;
    }
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      secret[offset++] = (buffer >> (bits - 8)) & 0xff;
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  return secret;
}
