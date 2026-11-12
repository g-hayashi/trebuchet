import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { ReceiptFileStore } from "@trebuchet/domain";
import { receiptFile, receiptsDir, withDataKey } from "./tenant-store.ts";
import { isNotFound, sha256Hex } from "./util.ts";
import { DK_BYTES } from "./vault-crypto.ts";

/**
 * 証憑のファイルの暗号化（010/R8、data-model §1.8、INV-61）。
 * 形式 `TRC1`: `"TRC1"(4) | salt(16) | nonce(12) | 暗号文 | タグ(16)`。
 * 鍵 Kfile = HKDF-SHA256(DK, salt, "trebuchet/receipt:<entityId 小文字>/v1")（AES-256-GCM）。
 * AAD = `"TRC1" | salt | nonce | UTF-8(entityId 小文字) | UTF-8(sha256)`。
 * 復号は GCM の検証が通り、かつ平文の SHA-256 = 名前のときだけ平文を返す。
 * DK・Kfile はファイル・DB・ログ・応答に出さない（INV-51 の拡張）。Kfile は使い終えたら 0 で埋める
 */

const MAGIC = Buffer.from("TRC1", "ascii");
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + NONCE_BYTES;
const MIN_FILE_BYTES = HEADER_BYTES + TAG_BYTES;

/** 復号できない（欠け・形式違い・改ざん・誤った鍵・別の事業体・別の名前・ハッシュの不一致）。鍵も平文も含めない */
export class ReceiptFileUnreadableError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`receipt file is unreadable: ${reason}`, options);
    this.name = "ReceiptFileUnreadableError";
  }
}

function deriveFileKey(dk: Uint8Array, salt: Uint8Array, entityId: string): Buffer {
  if (dk.length !== DK_BYTES) throw new RangeError(`data key must be ${DK_BYTES} bytes`);
  const info = `trebuchet/receipt:${entityId.toLowerCase()}/v1`;
  return Buffer.from(hkdfSync("sha256", dk, salt, info, KEY_BYTES));
}

function fileAad(salt: Uint8Array, nonce: Uint8Array, entityId: string, sha256: string): Buffer {
  return Buffer.concat([
    MAGIC,
    salt,
    nonce,
    Buffer.from(entityId.toLowerCase(), "utf8"),
    Buffer.from(sha256, "utf8"),
  ]);
}

/**
 * `sha256`（名前）を AAD に束ねて封じる。通常は `encryptReceipt`（名前 = 平文の SHA-256）を使う。
 * 名前と中身が食い違うファイルを作る検査（復号の後のハッシュの確認）のためにだけ分けてある
 */
export function sealReceipt(
  bytes: Uint8Array,
  entityId: string,
  sha256: string,
  dk: Uint8Array,
): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = deriveFileKey(dk, salt, entityId);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(fileAad(salt, nonce, entityId, sha256));
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([MAGIC, salt, nonce, body, cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
}

/** 平文を暗号化する。名前 = `sha256(bytes)` を AAD に束ねる */
export function encryptReceipt(bytes: Uint8Array, entityId: string, dk: Uint8Array): Buffer {
  return sealReceipt(bytes, entityId, sha256Hex(bytes), dk);
}

/**
 * 復号する。GCM の検証が通り、平文の SHA-256 が `sha256`（名前）に一致したときだけ平文を返す。
 * それ以外は `ReceiptFileUnreadableError`（平文を 1 バイトも返さない）
 */
export function decryptReceipt(
  file: Uint8Array,
  entityId: string,
  sha256: string,
  dk: Uint8Array,
): Buffer {
  const data = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (data.length < MIN_FILE_BYTES || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ReceiptFileUnreadableError("unknown format");
  }
  const salt = data.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const nonce = data.subarray(MAGIC.length + SALT_BYTES, HEADER_BYTES);
  const body = data.subarray(HEADER_BYTES, data.length - TAG_BYTES);
  const tag = data.subarray(data.length - TAG_BYTES);

  const key = deriveFileKey(dk, salt, entityId);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(fileAad(salt, nonce, entityId, sha256));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (cause) {
    throw new ReceiptFileUnreadableError("authentication failed", { cause });
  } finally {
    key.fill(0);
  }
  const actual = Buffer.from(sha256Hex(plain), "utf8");
  const expected = Buffer.from(sha256, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    plain.fill(0);
    throw new ReceiptFileUnreadableError("content does not match its name");
  }
  return plain;
}

/**
 * 事業体の `ReceiptFileStore`（data-model §1.8）。置き場所は `receiptFile(entityId, sha256)`。
 * 鍵は `withDataKey` の中でだけ作る（施錠中は `VaultLockedError`）。
 * 書き込みは `<名前>.partial` に書いてから改名する（途中で落ちても壊れたファイルを名前の位置に残さない）
 */
export function createReceiptFileStore(entityId: string): ReceiptFileStore {
  // 形の検査を作る時点で行う（不正な事業体の ID をここで止める）
  receiptsDir(entityId);

  return {
    digest: sha256Hex,

    has(sha256) {
      // 施錠中は存在も教えない（読み書きと同じ扱い）
      withDataKey(() => undefined);
      return existsSync(receiptFile(entityId, sha256));
    },

    put(sha256, bytes) {
      withDataKey((dk) => {
        const path = receiptFile(entityId, sha256);
        if (sha256Hex(bytes) !== sha256) {
          throw new Error("receipt file name does not match its content");
        }
        if (existsSync(path)) return;
        const encrypted = encryptReceipt(bytes, entityId, dk);
        mkdirSync(receiptsDir(entityId), { recursive: true });
        const partial = `${path}.partial`;
        try {
          writeFileSync(partial, encrypted, { mode: 0o600 });
          renameSync(partial, path);
        } catch (e) {
          rmSync(partial, { force: true });
          throw e;
        }
      });
    },

    read(sha256) {
      return withDataKey((dk) => {
        const path = receiptFile(entityId, sha256);
        let file: Buffer;
        try {
          file = readFileSync(path);
        } catch (cause) {
          if (isNotFound(cause)) throw new ReceiptFileUnreadableError("file not found", { cause });
          throw cause;
        }
        return decryptReceipt(file, entityId, sha256, dk);
      });
    },

    discard(sha256) {
      const path = receiptFile(entityId, sha256);
      rmSync(path, { force: true });
      rmSync(`${path}.partial`, { force: true });
    },
  };
}
