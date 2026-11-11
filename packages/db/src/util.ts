import { createHash } from "node:crypto";

/** SHA-256（小文字 16 進 64 文字）。文字列は UTF-8 として扱う */
export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** ファイルがない（ENOENT）例外か */
export const isNotFound = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";
