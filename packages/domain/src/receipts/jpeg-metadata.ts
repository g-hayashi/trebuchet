import { ok, type Result, validation } from "../types.ts";

// AI に送る JPEG から位置情報などのメタデータを除く（010 research R12、INV-66、Constitution III）。純関数。
// APP1（Exif・XMP）・APP13（IPTC）・COM を除き、Exif の Orientation だけを最小の APP1 に作り直して
// SOI の直後に置く（向きが失われると画像が横倒しになる）。ほかのセグメントと画素のデータは変えない

const APP1 = 0xe1;
const APP13 = 0xed;
const COM = 0xfe;
const SOS = 0xda;
const EOI = 0xd9;

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const TAG_ORIENTATION = 0x0112;
const TYPE_SHORT = 3;

const malformed = () => validation("JPEG として読めません");

/** マーカーのうち、長さの欄を持たないもの（RSTn・TEM・SOI・EOI） */
const isStandalone = (marker: number) =>
  marker === 0x01 || marker === 0xd8 || marker === EOI || (marker >= 0xd0 && marker <= 0xd7);

/** APP1 の中身（長さの欄を除く）が Exif か */
function isExif(payload: Uint8Array): boolean {
  return EXIF_HEADER.every((b, i) => payload[i] === b);
}

/**
 * Exif の APP1 の中身から Orientation（1〜8）を読む。壊れていれば undefined（向きなしとして扱う）。
 * 範囲外の読み出しは `DataView` が `RangeError` を投げるので、すべて undefined にする
 */
function readOrientation(payload: Uint8Array): number | undefined {
  const tiff = payload.subarray(EXIF_HEADER.length);
  if (tiff.length < 8) return undefined;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0] ?? 0, tiff[1] ?? 0);
  if (order !== "II" && order !== "MM") return undefined;
  const little = order === "II";
  try {
    if (view.getUint16(2, little) !== 0x002a) return undefined;
    const ifd = view.getUint32(4, little);
    const count = view.getUint16(ifd, little);
    for (let k = 0; k < count; k++) {
      const at = ifd + 2 + k * 12;
      if (view.getUint16(at, little) !== TAG_ORIENTATION) continue;
      if (view.getUint16(at + 2, little) !== TYPE_SHORT || view.getUint32(at + 4, little) !== 1) {
        return undefined;
      }
      const value = view.getUint16(at + 8, little);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Orientation だけを持つ APP1（ビッグエンディアンの TIFF。IFD0 は 1 項目） */
function orientationSegment(orientation: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // "MM"、42、IFD0 の位置
    0x00,
    0x01, // 項目数
    0x01,
    0x12,
    0x00,
    TYPE_SHORT,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00, // Orientation
    0x00,
    0x00,
    0x00,
    0x00, // 次の IFD なし
  ];
  const payload = [...EXIF_HEADER, ...tiff];
  const length = payload.length + 2;
  return new Uint8Array([0xff, APP1, (length >> 8) & 0xff, length & 0xff, ...payload]);
}

/**
 * JPEG のバイト列から APP1（Exif・XMP）・APP13・COM を除く。Exif に Orientation があれば、
 * それだけを持つ最小の APP1 を SOI の直後に置く。EOI より後ろは捨てる。
 * SOI で始まらない・セグメントの長さが壊れているときは `VALIDATION`（読み飛ばして素通しにしない）
 */
export function stripJpegMetadata(jpeg: Uint8Array): Result<Uint8Array> {
  const n = jpeg.length;
  if (n < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    return validation("JPEG ではありません");
  }
  const kept: Uint8Array[] = [];
  let orientation: number | undefined;
  let i = 2;
  while (i < n) {
    if (jpeg[i] !== 0xff) return malformed();
    // マーカーの前の詰め物（0xFF の連続）を読み飛ばす
    let m = i + 1;
    while (m < n && jpeg[m] === 0xff) m++;
    if (m >= n) return malformed();
    const marker = jpeg[m] as number;
    if (marker === EOI) {
      kept.push(new Uint8Array([0xff, EOI]));
      i = n;
      break;
    }
    if (isStandalone(marker)) {
      kept.push(jpeg.slice(m - 1, m + 1));
      i = m + 1;
      continue;
    }
    if (m + 2 >= n) return malformed();
    const length = ((jpeg[m + 1] as number) << 8) | (jpeg[m + 2] as number);
    const end = m + 1 + length;
    if (length < 2 || end > n) return malformed();
    const payload = jpeg.subarray(m + 3, end);
    if (marker === APP1 || marker === APP13 || marker === COM) {
      if (marker === APP1 && orientation === undefined && isExif(payload)) {
        orientation = readOrientation(payload);
      }
    } else {
      kept.push(jpeg.slice(m - 1, end));
    }
    i = end;
    if (marker === SOS) {
      // エントロピー符号のデータ: 次のマーカー（0xFF の後が 0x00・RSTn・0xFF 以外）まで写す
      let j = i;
      while (j < n) {
        if (jpeg[j] !== 0xff) {
          j++;
          continue;
        }
        const next = jpeg[j + 1];
        if (next === undefined) {
          j = n;
          break;
        }
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          j += 2;
          continue;
        }
        if (next === 0xff) {
          j++;
          continue;
        }
        break;
      }
      kept.push(jpeg.slice(i, j));
      i = j;
    }
  }

  const head = new Uint8Array([0xff, 0xd8]);
  const parts = [
    head,
    ...(orientation === undefined ? [] : [orientationSegment(orientation)]),
    ...kept,
  ];
  const out = new Uint8Array(parts.reduce((total, p) => total + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return ok(out);
}
