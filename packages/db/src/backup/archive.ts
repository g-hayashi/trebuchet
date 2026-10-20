import { createHash } from "node:crypto";
import type { Result } from "@trebuchet/domain";
import type {
  BackupManifest,
  ManifestEntity,
  ManifestFile,
  Snapshot,
  SnapshotFile,
  UnpackedArchive,
} from "./types.ts";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 10_001;

/** 許すパスは `registry.sqlite` と `tenants/<UUID>.sqlite` だけ（パス・トラバーサルの防止） */
const PATH_PATTERN =
  /^(?:registry|tenants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sqlite$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** content_sha256（R10）: アーカイブの平文の SHA-256 */
export const contentSha256 = sha256Hex;

/** `マニフェストの長さ（uint32 BE）| マニフェスト（JSON）| ファイル1 | ファイル2 | …` */
export function packArchive(snapshot: Snapshot): Buffer {
  const files: ManifestFile[] = snapshot.files.map((f) => ({
    path: f.path,
    size: f.bytes.length,
    sha256: sha256Hex(f.bytes),
  }));
  const manifest: BackupManifest = { files, entities: snapshot.manifest.entities };
  const json = Buffer.from(JSON.stringify(manifest), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, ...snapshot.files.map((f) => f.bytes)]);
}

const isNonNegativeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function parseEntities(value: unknown): ManifestEntity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ManifestEntity[] = [];
  for (const e of value as unknown[]) {
    if (typeof e !== "object" || e === null) return undefined;
    const { id, name, fiscalYears } = e as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(fiscalYears)) {
      return undefined;
    }
    const years: ManifestEntity["fiscalYears"] = [];
    for (const y of fiscalYears as unknown[]) {
      if (typeof y !== "object" || y === null) return undefined;
      const { year, journals } = y as Record<string, unknown>;
      if (!isNonNegativeInt(year) || !isNonNegativeInt(journals)) return undefined;
      years.push({ year, journals });
    }
    out.push({ id, name, fiscalYears: years });
  }
  return out;
}

function parseFiles(value: unknown): ManifestFile[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) return undefined;
  const out: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const f of value as unknown[]) {
    if (typeof f !== "object" || f === null) return undefined;
    const { path, size, sha256 } = f as Record<string, unknown>;
    if (typeof path !== "string" || !PATH_PATTERN.test(path)) return undefined;
    if (!isNonNegativeInt(size)) return undefined;
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return undefined;
    const key = path.toLowerCase();
    if (seen.has(key)) return undefined;
    seen.add(key);
    out.push({ path, size, sha256 });
  }
  if (!seen.has("registry.sqlite")) return undefined;
  return out;
}

/**
 * アーカイブを展開する。各ファイルの長さと SHA-256 を検査し、
 * 形式が違うもの・パスが許す形でないもの・ハッシュが合わないものは拒否する。
 */
export function unpackArchive(bytes: Uint8Array): Result<UnpackedArchive, "INVALID"> {
  const invalid = { ok: false, error: "INVALID" } as const;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 4) return invalid;
  const manifestLength = buf.readUInt32BE(0);
  if (manifestLength > MAX_MANIFEST_BYTES || 4 + manifestLength > buf.length) return invalid;
  let raw: unknown;
  try {
    raw = JSON.parse(buf.subarray(4, 4 + manifestLength).toString("utf8"));
  } catch {
    return invalid;
  }
  if (typeof raw !== "object" || raw === null) return invalid;
  const files = parseFiles((raw as Record<string, unknown>).files);
  const entities = parseEntities((raw as Record<string, unknown>).entities);
  if (files === undefined || entities === undefined) return invalid;

  let offset = 4 + manifestLength;
  const out: SnapshotFile[] = [];
  for (const f of files) {
    if (offset + f.size > buf.length) return invalid;
    const body = buf.subarray(offset, offset + f.size);
    if (sha256Hex(body) !== f.sha256) return invalid;
    out.push({ path: f.path, bytes: body });
    offset += f.size;
  }
  if (offset !== buf.length) return invalid;
  return { ok: true, value: { manifest: { files, entities }, files: out } };
}
