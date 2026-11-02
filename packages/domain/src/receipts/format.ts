import type { ReceiptMediaType } from "@trebuchet/schema";

// 証憑のファイルの形式を中身（先頭のバイト）で判定する（010 research R10。拡張子・Content-Type は見ない）

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_MARK = "%PDF-";
/** `%PDF-` を探す範囲（先頭のバイト数） */
const PDF_SCAN_BYTES = 1024;
/** `ftyp` ボックスを読む上限（compatible brands を読み過ぎない） */
const FTYP_MAX_BYTES = 256;

const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx"]);
/** major がこれなら、compatible brands に HEIC の brand があるときだけ HEIC */
const GENERIC_BRANDS = new Set(["mif1", "msf1"]);

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);

const ascii = (bytes: Uint8Array, from: number, to: number): string => {
  let out = "";
  for (let i = from; i < to; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
};

function isPdf(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, PDF_SCAN_BYTES);
  for (let at = 0; at + PDF_MARK.length <= end; at++) {
    if (ascii(bytes, at, at + PDF_MARK.length) === PDF_MARK) return true;
  }
  return false;
}

/** ISOBMFF の `ftyp`（offset 4）の major brand と compatible brands で HEIC を判定する */
function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const size =
    (((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0)) >>>
    0;
  const major = ascii(bytes, 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  if (!GENERIC_BRANDS.has(major)) return false;
  const end = Math.min(size, bytes.length, FTYP_MAX_BYTES);
  for (let at = 16; at + 4 <= end; at += 4) {
    if (HEIC_BRANDS.has(ascii(bytes, at, at + 4))) return true;
  }
  return false;
}

/** JPEG・PNG・PDF・HEIC のどれか。それ以外・空・短いバイト列は undefined */
export function detectReceiptFormat(bytes: Uint8Array): ReceiptMediaType | undefined {
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, PNG)) return "image/png";
  if (isPdf(bytes)) return "application/pdf";
  if (isHeic(bytes)) return "image/heic";
  return undefined;
}
