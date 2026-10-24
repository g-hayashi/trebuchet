import { randomBytes } from "node:crypto";
import { hashToken } from "@trebuchet/db";

/** Crockford の base32（I・L・O・U を除く） */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BYTES = 16; // 128 ビット
const GROUP = 4;

/** 128 ビットを 5 ビットずつ並べる（26 文字。先頭の 1 文字は 3 ビット分） */
function encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  const chars = Math.ceil((bytes.length * 8) / 5);
  let out = "";
  for (let i = chars - 1; i >= 0; i--) {
    out += ALPHABET[Number((value >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

/** 回復コードの平文（`XXXX-XXXX-...`。区切りは 4 文字ごと）。秘密なので、保存・記録しない（R7） */
export function generateRecoveryCode(): string {
  const raw = encode(randomBytes(BYTES));
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP) groups.push(raw.slice(i, i + GROUP));
  return groups.join("-");
}

/** 入力の揺れ（小文字・区切り・空白・Crockford の読み替え I/L→1、O→0）を除く */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** 保存するハッシュ。正規化してから `hashToken`（別の SHA-256 を書かない） */
export function hashRecoveryCode(input: string): string {
  return hashToken(normalizeRecoveryCode(input));
}
