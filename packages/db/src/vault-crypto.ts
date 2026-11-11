import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { KeyWrapKind, WrappedKey } from "@trebuchet/domain";
import { RECOVERY_KEY_BYTES } from "./recovery-key.ts";

/**
 * DK（データ鍵）の包みの純関数（008 の D1。写す元: invest-copilot `vaultCrypto.ts`）。I/O もモジュールの状態も持たない。
 * KEK = HKDF-SHA256(ikm, salt, "trebuchet/dk-wrap/v1")、包み = AES-256-GCM(KEK, iv, DK)。
 * AAD は kind と credential_id（recovery は "recovery"）で、行の差し替えを検出する。
 * 正しさの判定は GCM の検証（開けたか）だけ。KEK は使い終えたら 0 で埋める
 */

export const DK_BYTES = 32;
const HKDF_INFO = "trebuchet/dk-wrap/v1";
/** WebAuthn PRF の出力（`prf.results.first`） */
const PRF_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type WrapKind = KeyWrapKind;

/** KEK = HKDF-SHA256(ikm, salt, info) の 32 バイト */
export function deriveKek(ikm: Uint8Array, salt: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, HKDF_INFO, 32));
}

function wrapAad(kind: WrapKind, credentialId: string | null): Buffer {
  if (kind === "passkey" && !credentialId) throw new Error("a passkey wrap needs a credential id");
  if (kind === "recovery" && credentialId !== null) {
    throw new Error("the recovery wrap has no credential id");
  }
  return Buffer.from(
    `${HKDF_INFO}|${kind}|${kind === "passkey" ? credentialId : "recovery"}`,
    "utf8",
  );
}

function checkIkm(kind: WrapKind, ikm: Uint8Array): void {
  const expected = kind === "passkey" ? PRF_BYTES : RECOVERY_KEY_BYTES;
  if (ikm.length !== expected) throw new Error(`${kind} key material must be ${expected} bytes`);
}

/** DK を包む。形の誤り（DK・ikm の長さ、kind と credentialId の組）は例外 */
export function wrapDataKey(
  dk: Uint8Array,
  ikm: Uint8Array,
  kind: WrapKind,
  credentialId: string | null,
): WrappedKey {
  if (dk.length !== DK_BYTES) throw new Error(`the data key must be ${DK_BYTES} bytes`);
  checkIkm(kind, ikm);
  const aad = wrapAad(kind, credentialId);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const kek = deriveKek(ikm, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    cipher.setAAD(aad);
    const wrapped = Buffer.concat([cipher.update(dk), cipher.final()]);
    return { salt, iv, tag: cipher.getAuthTag(), wrapped };
  } finally {
    kek.fill(0);
  }
}

/**
 * 包みを開いて DK を返す。ikm・AAD・保存した値のどれかが違えば null（GCM の検証）。
 * 返した DK は呼び出し側が使い終えたら 0 で埋める
 */
export function unwrapDataKey(
  wrap: WrappedKey,
  ikm: Uint8Array,
  kind: WrapKind,
  credentialId: string | null,
): Buffer | null {
  let kek: Buffer | null = null;
  try {
    checkIkm(kind, ikm);
    const aad = wrapAad(kind, credentialId);
    if (wrap.iv.length !== IV_BYTES || wrap.tag.length !== TAG_BYTES) return null;
    kek = deriveKek(ikm, wrap.salt);
    const decipher = createDecipheriv("aes-256-gcm", kek, wrap.iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(wrap.tag);
    const dk = Buffer.concat([decipher.update(wrap.wrapped), decipher.final()]);
    if (dk.length !== DK_BYTES) {
      dk.fill(0);
      return null;
    }
    return dk;
  } catch {
    return null;
  } finally {
    kek?.fill(0);
  }
}
