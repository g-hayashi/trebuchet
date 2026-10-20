import { argon2, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Result } from "@trebuchet/domain";
import type { AppVersion } from "./types.ts";

const argon2Async = promisify(argon2);

const MAGIC = Buffer.from("TBK1", "ascii");
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const MAX_HEADER_BYTES = 64 * 1024;

/** 本番の鍵の導出の値（R8）。ヘッダーに書く */
export const KDF_MEMORY_KIB = 65536;
export const KDF_PASSES = 3;
export const KDF_PARALLELISM = 1;

/** 復号で受け付ける上限。巨大な値でメモリや時間を食わせない */
const KDF_LIMITS = { memoryMax: 262144, passesMax: 10, parallelismMax: 8 } as const;

export type BackupHeader = {
  format: 1;
  appVersion: AppVersion;
  macId: string;
  createdAt: string;
  kdf: {
    alg: "argon2id";
    salt: string;
    memory: number;
    passes: number;
    parallelism: number;
  };
  cipher: { alg: "aes-256-gcm"; nonce: string };
};

/** 呼び出し側が渡すヘッダーの値。kdf の salt と cipher の nonce は encryptBackup が作る */
export type BackupHeaderInput = { appVersion: AppVersion; macId: string; createdAt: string };

export type KdfInput = { salt: Buffer; memory: number; passes: number; parallelism: number };
export type DeriveKey = (passphrase: string, kdf: KdfInput) => Promise<Buffer>;

/** テストだけが差し替える。本番の経路は Argon2id（既定）で固定 */
export type CryptoOptions = { deriveKey?: DeriveKey };

/** 鍵は Argon2id で 32 バイト。パスフレーズは NFC に正規化する（入力方法の違いで鍵が変わらないように） */
const argon2idDeriveKey: DeriveKey = async (passphrase, kdf) =>
  argon2Async("argon2id", {
    message: Buffer.from(passphrase.normalize("NFC"), "utf8"),
    nonce: kdf.salt,
    parallelism: kdf.parallelism,
    tagLength: KEY_BYTES,
    memory: kdf.memory,
    passes: kdf.passes,
  });

/** `"TBK1" | ヘッダーの長さ（uint32 BE） | ヘッダー（JSON） | 暗号文 | 認証タグ（16 バイト）` */
export async function encryptBackup(
  archive: Uint8Array,
  passphrase: string,
  header: BackupHeaderInput,
  options: CryptoOptions = {},
): Promise<Buffer> {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const full: BackupHeader = {
    format: 1,
    appVersion: { registry: header.appVersion.registry, tenant: header.appVersion.tenant },
    macId: header.macId,
    createdAt: header.createdAt,
    kdf: {
      alg: "argon2id",
      salt: salt.toString("base64"),
      memory: KDF_MEMORY_KIB,
      passes: KDF_PASSES,
      parallelism: KDF_PARALLELISM,
    },
    cipher: { alg: "aes-256-gcm", nonce: nonce.toString("base64") },
  };
  const headerBytes = Buffer.from(JSON.stringify(full), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  const aad = Buffer.concat([MAGIC, length, headerBytes]);

  const derive = options.deriveKey ?? argon2idDeriveKey;
  const key = await derive(passphrase, {
    salt,
    memory: KDF_MEMORY_KIB,
    passes: KDF_PASSES,
    parallelism: KDF_PARALLELISM,
  });
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(archive), cipher.final()]);
    return Buffer.concat([aad, body, cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function decodeBase64(value: unknown, bytes: number): Buffer | undefined {
  if (typeof value !== "string") return undefined;
  const buf = Buffer.from(value, "base64");
  return buf.length === bytes ? buf : undefined;
}

type ParsedHeader = { header: BackupHeader; salt: Buffer; nonce: Buffer };

/** 形・値の範囲を検査する（format は呼び出し側で確かめ済み）。通らなければ undefined */
function parseHeader(raw: Record<string, unknown>): ParsedHeader | undefined {
  const { appVersion, macId, createdAt, kdf, cipher } = raw;
  if (!isRecord(appVersion) || !isRecord(kdf) || !isRecord(cipher)) return undefined;
  if (!isInt(appVersion.registry, 0, 1_000_000) || !isInt(appVersion.tenant, 0, 1_000_000)) {
    return undefined;
  }
  if (typeof macId !== "string" || typeof createdAt !== "string") return undefined;
  if (kdf.alg !== "argon2id" || cipher.alg !== "aes-256-gcm") return undefined;
  const salt = decodeBase64(kdf.salt, SALT_BYTES);
  const nonce = decodeBase64(cipher.nonce, NONCE_BYTES);
  if (salt === undefined || nonce === undefined) return undefined;
  const { memory, passes, parallelism } = kdf;
  if (!isInt(parallelism, 1, KDF_LIMITS.parallelismMax)) return undefined;
  if (!isInt(passes, 1, KDF_LIMITS.passesMax)) return undefined;
  if (!isInt(memory, 8 * parallelism, KDF_LIMITS.memoryMax)) return undefined;
  return {
    header: {
      format: 1,
      appVersion: { registry: appVersion.registry, tenant: appVersion.tenant },
      macId,
      createdAt,
      kdf: {
        alg: "argon2id",
        salt: kdf.salt as string,
        memory,
        passes,
        parallelism,
      },
      cipher: { alg: "aes-256-gcm", nonce: cipher.nonce as string },
    },
    salt,
    nonce,
  };
}

/**
 * 復号する。GCM の final() が通るまで平文を返さない・使わない。
 * 形式の版が 1 でなければ復号の前に VERSION_MISMATCH。アプリの版が currentVersion と
 * 一致しないときは、復号と検証が通った後に VERSION_MISMATCH。それ以外の失敗は区別せず INVALID。
 */
export async function decryptBackup(
  bytes: Uint8Array,
  passphrase: string,
  currentVersion: AppVersion,
  options: CryptoOptions = {},
): Promise<Result<{ header: BackupHeader; archive: Buffer }, "INVALID" | "VERSION_MISMATCH">> {
  const invalid = { ok: false, error: "INVALID" } as const;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return invalid;
  const headerLength = buf.readUInt32BE(MAGIC.length);
  const headerEnd = MAGIC.length + 4 + headerLength;
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) return invalid;
  if (headerEnd + TAG_BYTES > buf.length) return invalid;

  let raw: unknown;
  try {
    raw = JSON.parse(buf.subarray(MAGIC.length + 4, headerEnd).toString("utf8"));
  } catch {
    return invalid;
  }
  if (!isRecord(raw)) return invalid;
  if (raw.format !== 1) {
    return typeof raw.format === "number" ? { ok: false, error: "VERSION_MISMATCH" } : invalid;
  }
  const parsed = parseHeader(raw);
  if (parsed === undefined) return invalid;

  const aad = buf.subarray(0, headerEnd);
  const body = buf.subarray(headerEnd, buf.length - TAG_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);

  const derive = options.deriveKey ?? argon2idDeriveKey;
  let key: Buffer;
  try {
    key = await derive(passphrase, {
      salt: parsed.salt,
      memory: parsed.header.kdf.memory,
      passes: parsed.header.kdf.passes,
      parallelism: parsed.header.kdf.parallelism,
    });
  } catch {
    return invalid;
  }
  let archive: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, parsed.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plain = decipher.update(body);
    // final() が通る（タグの検証に成功する）まで plain を返さない
    archive = Buffer.concat([plain, decipher.final()]);
  } catch {
    return invalid;
  } finally {
    key.fill(0);
  }

  const { appVersion } = parsed.header;
  if (
    appVersion.registry !== currentVersion.registry ||
    appVersion.tenant !== currentVersion.tenant
  ) {
    return { ok: false, error: "VERSION_MISMATCH" };
  }
  return { ok: true, value: { header: parsed.header, archive } };
}
