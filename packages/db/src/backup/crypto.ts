import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Result, WrappedKey } from "@trebuchet/domain";
import { parseRecoveryKey } from "../recovery-key.ts";
import { isRecord } from "../util.ts";
import { DK_BYTES, unwrapDataKey } from "../vault-crypto.ts";
import { currentRelease, RELEASE_PATTERN } from "./snapshot.ts";
import type { AppVersion } from "./types.ts";

const MAGIC = Buffer.from("TBK1", "ascii");
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const MAX_HEADER_BYTES = 64 * 1024;

/** バックアップの鍵 = HKDF-SHA256(DK, salt=ヘッダーの salt, info)（008 の D1・D9）。パスフレーズも Argon2 も使わない */
const BACKUP_KEY_INFO = "trebuchet/backup/v1";

/** ヘッダーの recovery の包み（`WrappedKey` の各項目を base64 にしたもの。008 の D9） */
export type BackupRecoveryWrap = { salt: string; iv: string; tag: string; wrapped: string };

export type BackupHeader = {
  format: 1;
  appVersion: AppVersion;
  /**
   * 作ったアプリのリリースの版（ルートの package.json の version。例 "0.1.0"）。任意の項目で、以前の
   * バックアップにはない。表示（拒否の文言）だけに使い、受け入れの判定は appVersion で行う。AAD に含まれる
   */
  release?: string | undefined;
  macId: string;
  createdAt: string;
  key: { alg: "hkdf-sha256"; salt: string };
  /** 作成時の recovery の包み。その時点の回復キーだけで DK を開ける（新しい Mac の復元用） */
  recovery: BackupRecoveryWrap;
  cipher: { alg: "aes-256-gcm"; nonce: string };
};

/** 呼び出し側が渡すヘッダーの値。key の salt と cipher の nonce は encryptBackup が作る */
export type BackupHeaderInput = {
  appVersion: AppVersion;
  macId: string;
  createdAt: string;
  /** 今の `auth.sqlite` の recovery の包み */
  recoveryWrap: WrappedKey;
  /** ヘッダーの release。省略すると今の版（`currentRelease()`）、null なら書かない（以前の形式の再現。テスト用） */
  release?: string | null | undefined;
};

/** 鍵は DK から HKDF で 32 バイト。使い終えたら呼び出し側が fill(0) する */
function deriveBackupKey(dk: Uint8Array, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", dk, salt, BACKUP_KEY_INFO, KEY_BYTES));
}

/** `"TBK1" | ヘッダーの長さ（uint32 BE） | ヘッダー（JSON） | 暗号文 | 認証タグ（16 バイト）` */
export function encryptBackup(
  archive: Uint8Array,
  dk: Uint8Array,
  header: BackupHeaderInput,
): Buffer {
  if (dk.length !== DK_BYTES) throw new RangeError(`data key must be ${DK_BYTES} bytes`);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const release = header.release === undefined ? currentRelease() : header.release;
  const full: BackupHeader = {
    format: 1,
    appVersion: { registry: header.appVersion.registry, tenant: header.appVersion.tenant },
    ...(release === null ? {} : { release }),
    macId: header.macId,
    createdAt: header.createdAt,
    key: { alg: "hkdf-sha256", salt: salt.toString("base64") },
    recovery: {
      salt: Buffer.from(header.recoveryWrap.salt).toString("base64"),
      iv: Buffer.from(header.recoveryWrap.iv).toString("base64"),
      tag: Buffer.from(header.recoveryWrap.tag).toString("base64"),
      wrapped: Buffer.from(header.recoveryWrap.wrapped).toString("base64"),
    },
    cipher: { alg: "aes-256-gcm", nonce: nonce.toString("base64") },
  };
  const headerBytes = Buffer.from(JSON.stringify(full), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  const aad = Buffer.concat([MAGIC, length, headerBytes]);

  const key = deriveBackupKey(dk, salt);
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

function decodeBase64(value: unknown, bytes: number): Buffer | undefined {
  if (typeof value !== "string") return undefined;
  const buf = Buffer.from(value, "base64");
  return buf.length === bytes ? buf : undefined;
}

type ParsedHeader = {
  header: BackupHeader;
  salt: Buffer;
  nonce: Buffer;
  recoveryWrap: WrappedKey;
};

/** 形・値の範囲を検査する（format は呼び出し側で確かめ済み）。通らなければ undefined */
function parseHeader(raw: Record<string, unknown>): ParsedHeader | undefined {
  const { appVersion, macId, createdAt, key, recovery, cipher } = raw;
  if (!isRecord(appVersion) || !isRecord(key) || !isRecord(recovery) || !isRecord(cipher)) {
    return undefined;
  }
  if (!isInt(appVersion.registry, 0, 1_000_000) || !isInt(appVersion.tenant, 0, 1_000_000)) {
    return undefined;
  }
  // release は任意（以前のバックアップにはない）。あれば版の形でなければならない
  const release = "release" in raw ? releaseOf(raw) : undefined;
  if ("release" in raw && release === undefined) return undefined;
  if (typeof macId !== "string" || typeof createdAt !== "string") return undefined;
  if (key.alg !== "hkdf-sha256" || cipher.alg !== "aes-256-gcm") return undefined;
  const salt = decodeBase64(key.salt, SALT_BYTES);
  const nonce = decodeBase64(cipher.nonce, NONCE_BYTES);
  // 包みの長さは key_wraps の CHECK と同じ（salt 32・iv 12・tag 16・wrapped 32）
  const wrapSalt = decodeBase64(recovery.salt, 32);
  const wrapIv = decodeBase64(recovery.iv, 12);
  const wrapTag = decodeBase64(recovery.tag, 16);
  const wrapped = decodeBase64(recovery.wrapped, DK_BYTES);
  if (salt === undefined || nonce === undefined) return undefined;
  if (
    wrapSalt === undefined ||
    wrapIv === undefined ||
    wrapTag === undefined ||
    wrapped === undefined
  ) {
    return undefined;
  }
  return {
    header: {
      format: 1,
      appVersion: { registry: appVersion.registry, tenant: appVersion.tenant },
      ...(release === undefined ? {} : { release }),
      macId,
      createdAt,
      key: { alg: "hkdf-sha256", salt: key.salt as string },
      recovery: {
        salt: recovery.salt as string,
        iv: recovery.iv as string,
        tag: recovery.tag as string,
        wrapped: recovery.wrapped as string,
      },
      cipher: { alg: "aes-256-gcm", nonce: cipher.nonce as string },
    },
    salt,
    nonce,
    recoveryWrap: { salt: wrapSalt, iv: wrapIv, tag: wrapTag, wrapped },
  };
}

const invalid = { ok: false, error: "INVALID" } as const;

type Parsed = ParsedHeader & { aad: Buffer; body: Buffer; tag: Buffer };

/** ヘッダーの release が版の形の文字列ならその値、そうでなければ undefined */
function releaseOf(raw: Record<string, unknown>): string | undefined {
  const value = raw.release;
  return typeof value === "string" && RELEASE_PATTERN.test(value) ? value : undefined;
}

/** マジック・長さ・JSON を検査してヘッダーの JSON（認証していない値）を返す。形が違えば undefined */
function readRawHeader(
  bytes: Uint8Array,
): { buf: Buffer; headerEnd: number; raw: Record<string, unknown> } | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    return undefined;
  }
  const headerLength = buf.readUInt32BE(MAGIC.length);
  const headerEnd = MAGIC.length + 4 + headerLength;
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) return undefined;
  if (headerEnd + TAG_BYTES > buf.length) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(buf.subarray(MAGIC.length + 4, headerEnd).toString("utf8"));
  } catch {
    return undefined;
  }
  return isRecord(raw) ? { buf, headerEnd, raw } : undefined;
}

/**
 * ヘッダーの release（作ったアプリのリリースの版）を、復号せずに読む。`VERSION_MISMATCH` の文言に版を示すため。
 * 形式の版が 1 でないファイルも読む。認証の前の値なので表示だけに使う（版の形の文字列に限る）。
 * なければ・読めなければ undefined
 */
export function readBackupRelease(bytes: Uint8Array): string | undefined {
  const read = readRawHeader(bytes);
  return read === undefined ? undefined : releaseOf(read.raw);
}

/** マジック・長さ・JSON・形を検査する（認証はしない）。format が 1 でなければ VERSION_MISMATCH */
function parseFile(bytes: Uint8Array): Result<Parsed, "INVALID" | "VERSION_MISMATCH"> {
  const read = readRawHeader(bytes);
  if (read === undefined) return invalid;
  const { buf, headerEnd, raw } = read;
  if (raw.format !== 1) {
    return typeof raw.format === "number" ? { ok: false, error: "VERSION_MISMATCH" } : invalid;
  }
  const parsed = parseHeader(raw);
  if (parsed === undefined) return invalid;
  return {
    ok: true,
    value: {
      ...parsed,
      aad: buf.subarray(0, headerEnd),
      body: buf.subarray(headerEnd, buf.length - TAG_BYTES),
      tag: buf.subarray(buf.length - TAG_BYTES),
    },
  };
}

/**
 * 受け入れるアプリの版: registry・tenant のマイグレーションの数がどちらも今以下（古い版は復元で今の版まで
 * マイグレーションを当てる。マイグレーションは足すだけで、適用済みを書き換えない）。どちらかが今より多ければ、
 * 新しい版のアプリで作られたもの
 */
export function isAcceptableVersion(backup: AppVersion, current: AppVersion): boolean {
  return backup.registry <= current.registry && backup.tenant <= current.tenant;
}

/**
 * DK で復号する。GCM の final() が通るまで平文を返さない・使わない。
 * 形式の版が 1 でなければ復号の前に VERSION_MISMATCH。アプリの版が currentVersion より新しい
 * （`isAcceptableVersion` が false）ときは、復号と検証が通った後に VERSION_MISMATCH。それ以外の失敗
 * （誤った鍵、改ざん、切り詰め）は区別せず INVALID。
 */
export function decryptBackup(
  bytes: Uint8Array,
  dk: Uint8Array,
  currentVersion: AppVersion,
): Result<{ header: BackupHeader; archive: Buffer }, "INVALID" | "VERSION_MISMATCH"> {
  const parsed = parseFile(bytes);
  if (!parsed.ok) return parsed;
  const { header, salt, nonce, aad, body, tag } = parsed.value;
  if (dk.length !== DK_BYTES) return invalid;

  const key = deriveBackupKey(dk, salt);
  let archive: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
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

  if (!isAcceptableVersion(header.appVersion, currentVersion)) {
    return { ok: false, error: "VERSION_MISMATCH" };
  }
  return { ok: true, value: { header, archive } };
}

export type RecoveryDecryption = {
  header: BackupHeader;
  archive: Buffer;
  /** 開けた DK。使い終えたら呼び出し側が fill(0) する */
  dk: Buffer;
  /** DK を開けた recovery の包み（ヘッダーのもの、または渡した今の包み） */
  recoveryWrap: WrappedKey;
};

/**
 * 回復キーで復号する（008 の D9、INV-54）。ヘッダーの recovery の包み → `currentWraps`（今の `auth.sqlite` の
 * recovery の包み）の順に回復キーで DK を開き、その DK で本体を復号する。DK は変わらないので、回復キーを
 * 再発行した後でも古いバックアップを開ける。どの包みでも、誤った回復キー・別の DK・改ざんは INVALID
 * （本体は 1 バイトも使わない）。回復キーの形が違えば INVALID。版の判定は `decryptBackup` と同じ。
 */
export function decryptBackupWithRecoveryKey(
  bytes: Uint8Array,
  recoveryKey: string,
  currentVersion: AppVersion,
  currentWraps: readonly WrappedKey[] = [],
): Result<RecoveryDecryption, "INVALID" | "VERSION_MISMATCH"> {
  const parsed = parseFile(bytes);
  if (!parsed.ok) return parsed;
  const secret = parseRecoveryKey(recoveryKey);
  if (secret === null) return invalid;
  try {
    for (const wrap of [parsed.value.recoveryWrap, ...currentWraps]) {
      const dk = unwrapDataKey(wrap, secret, "recovery", null);
      if (dk === null) continue;
      const decrypted = decryptBackup(bytes, dk, currentVersion);
      if (decrypted.ok) return { ok: true, value: { ...decrypted.value, dk, recoveryWrap: wrap } };
      dk.fill(0);
      // 本体を開けた（鍵が正しい）のに新しい版のものだったときだけ、他の包みを試さずに知らせる
      if (decrypted.error === "VERSION_MISMATCH") return decrypted;
    }
    return invalid;
  } finally {
    secret.fill(0);
  }
}
