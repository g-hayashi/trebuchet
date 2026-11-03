/**
 * 証憑のテストが共通で使う合成のバイト列（010-receipts、research R17）。
 * 形式の判定・メタデータの除去・暗号化・重複の判定の入力になる最小のバイト列だけを作る。
 * どれも画素は描けない（寸法やヘッダーだけが意味を持つ）。実データの写真・文字列は入れない。
 * 作り方と匿名化の方針は同じ場所の README.md
 */

const enc = new TextEncoder();

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const u16be = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const u32be = (n: number) =>
  new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u16le = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const u32le = (n: number) =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const ascii = (s: string) => enc.encode(s);
const text = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.slice(from, to));

// ---- JPEG ----

export type JpegOptions = {
  width?: number;
  height?: number;
  /** Exif の Orientation（1〜8）。指定すると Exif の APP1 を作る */
  orientation?: number | undefined;
  /** Exif に GPS の IFD（合成の 0°0′0″N）を入れる。Exif の APP1 を作る */
  gps?: boolean;
  /** APP13（Photoshop の IPTC の形のブロック）を入れる */
  iptc?: boolean;
  /** COM（コメント）を入れる */
  comment?: string | undefined;
  /** XMP の APP1（Exif とは別のセグメント）を入れる */
  xmp?: boolean;
  /** 画素のデータ（エントロピー符号の部分）を変える。SHA-256 の違うファイルを作るのに使う */
  seed?: number;
};

const segment = (marker: number, payload: Uint8Array) =>
  concat(new Uint8Array([0xff, marker]), u16be(payload.length + 2), payload);

/** リトルエンディアンの TIFF（Exif の中身）。IFD0 に Orientation と GPS のポインターを持つ */
function exifTiff(orientation: number | undefined, gps: boolean): Uint8Array {
  const entries: Uint8Array[] = [];
  const count = (orientation !== undefined ? 1 : 0) + (gps ? 1 : 0);
  const ifd0Size = 2 + count * 12 + 4;
  const gpsIfdOffset = 8 + ifd0Size;
  if (orientation !== undefined) {
    // tag 0x0112, type SHORT(3), count 1, 値は 4 バイトの欄の先頭 2 バイト
    entries.push(concat(u16le(0x0112), u16le(3), u32le(1), u16le(orientation), u16le(0)));
  }
  if (gps) {
    // tag 0x8825（GPS IFD へのポインター）、type LONG(4)
    entries.push(concat(u16le(0x8825), u16le(4), u32le(1), u32le(gpsIfdOffset)));
  }
  const ifd0 = concat(u16le(count), ...entries, u32le(0));
  const parts = [ascii("II"), u16le(0x002a), u32le(8), ifd0];
  if (gps) {
    // GPS IFD: LatitudeRef（ASCII "N"）と Latitude（RATIONAL × 3 = 0/1, 0/1, 0/1）
    const gpsIfdSize = 2 + 2 * 12 + 4;
    const latDataOffset = gpsIfdOffset + gpsIfdSize;
    const gpsIfd = concat(
      u16le(2),
      concat(u16le(0x0001), u16le(2), u32le(2), ascii("N\0"), u16le(0)),
      concat(u16le(0x0002), u16le(5), u32le(3), u32le(latDataOffset)),
      u32le(0),
    );
    const rationals = concat(u32le(0), u32le(1), u32le(0), u32le(1), u32le(0), u32le(1));
    parts.push(gpsIfd, rationals);
  }
  return concat(...parts);
}

/** 合成の JPEG。SOI, [APP1 Exif], [APP1 XMP], [APP13], [COM], DQT, SOF0, SOS, 画素の代わりの数バイト, EOI */
export function jpegBytes(options: JpegOptions = {}): Uint8Array {
  const { width = 64, height = 48, orientation, gps = false, seed = 0 } = options;
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (orientation !== undefined || gps) {
    parts.push(segment(0xe1, concat(ascii("Exif\0\0"), exifTiff(orientation, gps))));
  }
  if (options.xmp === true) {
    parts.push(
      segment(
        0xe1,
        concat(
          ascii("http://ns.adobe.com/xap/1.0/\0"),
          ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'),
        ),
      ),
    );
  }
  if (options.iptc === true) {
    // "Photoshop 3.0\0" 8BIM, リソース ID 0x0404、名前（空）、長さ 4、データ
    parts.push(
      segment(
        0xed,
        concat(
          ascii("Photoshop 3.0\0"),
          ascii("8BIM"),
          u16be(0x0404),
          u16be(0),
          u32be(4),
          ascii("TEST"),
        ),
      ),
    );
  }
  if (options.comment !== undefined) {
    parts.push(segment(0xfe, ascii(options.comment)));
  }
  // DQT（精度 0・表 0、64 要素）
  parts.push(segment(0xdb, concat(new Uint8Array([0x00]), new Uint8Array(64).fill(16))));
  // SOF0（精度 8、高さ、幅、成分 1: ID 1、サンプリング 1x1、量子化表 0）
  parts.push(
    segment(
      0xc0,
      concat(new Uint8Array([8]), u16be(height), u16be(width), new Uint8Array([1, 1, 0x11, 0])),
    ),
  );
  // SOS（成分 1: ID 1、表 0/0、Ss 0、Se 63、Ah/Al 0）
  parts.push(segment(0xda, new Uint8Array([1, 1, 0x00, 0, 63, 0])));
  // 画素の代わりの数バイト（0xFF を含めない）
  parts.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, seed & 0x7f, (seed >> 7) & 0x7f]));
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concat(...parts);
}

const MARKER_NAMES = new Map<number, string>([
  [0xd8, "SOI"],
  [0xd9, "EOI"],
  [0xe0, "APP0"],
  [0xe1, "APP1"],
  [0xed, "APP13"],
  [0xfe, "COM"],
  [0xdb, "DQT"],
  [0xc0, "SOF0"],
  [0xda, "SOS"],
]);

/** JPEG のセグメントの並び（SOI から SOS まで、最後が EOI なら EOI も）。SOS の後の画素は読まない */
export function jpegSegments(bytes: Uint8Array): string[] {
  const names: string[] = ["SOI"];
  let i = 2;
  while (i + 3 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1] ?? 0;
    names.push(MARKER_NAMES.get(marker) ?? `0x${marker.toString(16)}`);
    if (marker === 0xda) break;
    i += 2 + ((bytes[i + 2] ?? 0) << 8) + (bytes[i + 3] ?? 0);
  }
  if (bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) names.push("EOI");
  return names;
}

/** SOF0 の寸法 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i + 3 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xc0) {
      const height = ((bytes[i + 5] ?? 0) << 8) + (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) + (bytes[i + 8] ?? 0);
      return { width, height };
    }
    i += 2 + ((bytes[i + 2] ?? 0) << 8) + (bytes[i + 3] ?? 0);
  }
  throw new Error("SOF0 がない");
}

/** 最初の Exif の APP1 から Orientation と GPS の有無を読む。Exif がなければ undefined */
export function readExif(
  bytes: Uint8Array,
): { orientation: number | undefined; hasGps: boolean } | undefined {
  let i = 2;
  while (i + 3 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xda) return undefined;
    const length = ((bytes[i + 2] ?? 0) << 8) + (bytes[i + 3] ?? 0);
    if (marker === 0xe1 && text(bytes, i + 4, i + 10) === "Exif\0\0") {
      const tiff = bytes.subarray(i + 10, i + 2 + length);
      const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
      const little = text(tiff, 0, 2) === "II";
      const ifd = view.getUint32(4, little);
      const n = view.getUint16(ifd, little);
      let orientation: number | undefined;
      let hasGps = false;
      for (let k = 0; k < n; k++) {
        const at = ifd + 2 + k * 12;
        const tag = view.getUint16(at, little);
        if (tag === 0x0112) orientation = view.getUint16(at + 8, little);
        if (tag === 0x8825) hasGps = true;
      }
      return { orientation, hasGps };
    }
    i += 2 + length;
  }
  return undefined;
}

// ---- PNG ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const pngChunk = (type: string, data: Uint8Array) => {
  const body = concat(ascii(type), data);
  return concat(u32be(data.length), body, u32be(crc32(body)));
};

/** 合成の PNG。署名、IHDR（寸法、8 ビットの RGB）、IDAT（画素の代わりの数バイト）、IEND。CRC は正しい */
export function pngBytes(
  options: { width?: number; height?: number; seed?: number } = {},
): Uint8Array {
  const { width = 64, height = 48, seed = 0 } = options;
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", concat(u32be(width), u32be(height), new Uint8Array([8, 2, 0, 0, 0]))),
    pngChunk("IDAT", new Uint8Array([0x78, 0x01, seed & 0xff, (seed >> 8) & 0xff])),
    pngChunk("IEND", new Uint8Array(0)),
  );
}

/** IHDR の寸法 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// ---- PDF ----

/** 合成の PDF（空の 1 ページ）。`leading` は `%PDF-` の前に置く余分なバイト数（1,024 バイト以内の判定用） */
export function pdfBytes(options: { leading?: number; seed?: number } = {}): Uint8Array {
  const { leading = 0, seed = 0 } = options;
  const body = ascii(
    [
      "%PDF-1.4",
      `% synthetic receipt ${seed}`,
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj",
      "trailer << /Root 1 0 R /Size 4 >>",
      "%%EOF",
      "",
    ].join("\n"),
  );
  return concat(new Uint8Array(leading).fill(0x0a), body);
}

// ---- HEIC（ISOBMFF の ftyp） ----

/**
 * 合成の HEIC。`ftyp` ボックス（major brand、minor version 0、compatible brands）の後に小さな `mdat`。
 * 画像としては読めない
 */
export function heicBytes(options: { major: string; compatible: string[] }): Uint8Array {
  const { major, compatible } = options;
  const ftyp = concat(
    u32be(16 + 4 * compatible.length),
    ascii("ftyp"),
    ascii(major),
    u32be(0),
    ...compatible.map((b) => ascii(b)),
  );
  return concat(ftyp, u32be(12), ascii("mdat"), new Uint8Array([1, 2, 3, 4]));
}

/** `ftyp` の major と compatible brands を読む */
export function ftypBrands(bytes: Uint8Array): { major: string; compatible: string[] } {
  const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const compatible: string[] = [];
  for (let at = 16; at + 4 <= size; at += 4) compatible.push(text(bytes, at, at + 4));
  return { major: text(bytes, 8, 12), compatible };
}

/** `ftyp` を持つが HEIC ではない（MP4 の brands） */
export function mp4Bytes(): Uint8Array {
  return heicBytes({ major: "isom", compatible: ["isom", "mp42"] });
}

// ---- 拡張子と違う中身・空・短いバイト列 ----

export type MislabeledSample = {
  originalName: string;
  bytes: Uint8Array;
  /** 中身の実際の種類 */
  actual: "jpeg" | "png" | "pdf" | "heic" | "text";
};

/** 拡張子と中身が違うファイル。中身で判定する（R10）ので、名前は形式の判定に影響しない */
export function mislabeledSamples(): MislabeledSample[] {
  return [
    { originalName: "receipt.jpg", bytes: pdfBytes(), actual: "pdf" },
    { originalName: "receipt.pdf", bytes: pngBytes(), actual: "png" },
    { originalName: "receipt.png", bytes: ascii("synthetic text, not an image\n"), actual: "text" },
    {
      originalName: "receipt.heic",
      bytes: jpegBytes(),
      actual: "jpeg",
    },
  ];
}

export const emptyBytes = (): Uint8Array => new Uint8Array(0);

/** どの形式の先頭にも足りない長さ（PDF の `%PD` で切れたもの） */
export const shortBytes = (): Uint8Array => new Uint8Array([0x25, 0x50, 0x44]);
