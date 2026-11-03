import { describe, expect, it } from "vitest";
import {
  emptyBytes,
  ftypBrands,
  heicBytes,
  jpegBytes,
  jpegDimensions,
  jpegSegments,
  mislabeledSamples,
  mp4Bytes,
  pdfBytes,
  pngBytes,
  pngDimensions,
  readExif,
  shortBytes,
} from "../fixtures/receipts/sample-files.ts";

// T001: テストが共通で使う合成のバイト列（research R17）。先頭のマーカー・brands・セグメントの並びを確かめる

const head = (bytes: Uint8Array, n: number) => [...bytes.slice(0, n)];
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.slice(from, to));

describe("jpegBytes", () => {
  it("既定は SOI で始まり EOI で終わり、メタデータのセグメントを持たない", () => {
    const bytes = jpegBytes();
    expect(head(bytes, 3)).toEqual([0xff, 0xd8, 0xff]);
    expect(bytes.slice(-2)).toEqual(new Uint8Array([0xff, 0xd9]));
    expect(jpegSegments(bytes)).toEqual(["SOI", "DQT", "SOF0", "SOS", "EOI"]);
    expect(readExif(bytes)).toBeUndefined();
  });

  it("Exif・APP13・COM は指定したときだけ、決まった順（APP1, APP13, COM）で入る", () => {
    const bytes = jpegBytes({ orientation: 6, gps: true, iptc: true, comment: "synthetic" });
    expect(jpegSegments(bytes)).toEqual([
      "SOI",
      "APP1",
      "APP13",
      "COM",
      "DQT",
      "SOF0",
      "SOS",
      "EOI",
    ]);
  });

  it("Exif の Orientation と GPS を読み戻せる", () => {
    expect(readExif(jpegBytes({ orientation: 6, gps: true }))).toEqual({
      orientation: 6,
      hasGps: true,
    });
    expect(readExif(jpegBytes({ orientation: 3 }))).toEqual({ orientation: 3, hasGps: false });
    expect(readExif(jpegBytes({ gps: true }))).toEqual({ orientation: undefined, hasGps: true });
  });

  it("XMP は APP1 の別のセグメントで入る", () => {
    const bytes = jpegBytes({ orientation: 1, xmp: true });
    expect(jpegSegments(bytes)).toEqual(["SOI", "APP1", "APP1", "DQT", "SOF0", "SOS", "EOI"]);
    // Exif の APP1 が先で、読み戻せる
    expect(readExif(bytes)).toEqual({ orientation: 1, hasGps: false });
  });

  it("画素数が違う 2 種を作れる（SOF0 の寸法）", () => {
    expect(jpegDimensions(jpegBytes({ width: 640, height: 480 }))).toEqual({
      width: 640,
      height: 480,
    });
    expect(jpegDimensions(jpegBytes({ width: 1654, height: 2338 }))).toEqual({
      width: 1654,
      height: 2338,
    });
    expect(jpegBytes({ width: 640, height: 480 })).not.toEqual(
      jpegBytes({ width: 1654, height: 2338 }),
    );
  });

  it("同じ指定なら同じバイト列（決定的）、違う指定なら違うバイト列（SHA-256 が変わる）", () => {
    expect(jpegBytes({ orientation: 6 })).toEqual(jpegBytes({ orientation: 6 }));
    expect(jpegBytes({ orientation: 6 })).not.toEqual(jpegBytes({ orientation: 8 }));
    expect(jpegBytes({ seed: 1 })).not.toEqual(jpegBytes({ seed: 2 }));
  });
});

describe("pngBytes", () => {
  it("署名・IHDR の寸法・IEND で終わる", () => {
    const bytes = pngBytes({ width: 120, height: 80 });
    expect(head(bytes, 8)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(ascii(bytes, 12, 16)).toBe("IHDR");
    expect(pngDimensions(bytes)).toEqual({ width: 120, height: 80 });
    expect(ascii(bytes, bytes.length - 8, bytes.length - 4)).toBe("IEND");
  });
});

describe("pdfBytes", () => {
  it("%PDF- で始まり %%EOF で終わる", () => {
    const bytes = pdfBytes();
    expect(ascii(bytes, 0, 5)).toBe("%PDF-");
    expect(ascii(bytes, bytes.length - 6, bytes.length).trim()).toBe("%%EOF");
  });

  it("先頭の余分なバイトのあとに %PDF- を置ける（1,024 バイト以内の判定用）", () => {
    const bytes = pdfBytes({ leading: 100 });
    expect(ascii(bytes, 100, 105)).toBe("%PDF-");
    expect(ascii(bytes, 0, 5)).not.toBe("%PDF-");
  });
});

describe("heicBytes", () => {
  it("ftyp が offset 4 にあり、major と compatible brands を読み戻せる", () => {
    const bytes = heicBytes({ major: "heic", compatible: ["mif1", "heic"] });
    expect(ascii(bytes, 4, 8)).toBe("ftyp");
    expect(ftypBrands(bytes)).toEqual({ major: "heic", compatible: ["mif1", "heic"] });
    // ボックスの大きさ（先頭 4 バイト、ビッグエンディアン）が ftyp の長さと合う
    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    expect(size).toBe(16 + 4 * 2);
  });

  it("major が mif1 で compatible に heic 系があるものと、ないものを作れる", () => {
    expect(ftypBrands(heicBytes({ major: "mif1", compatible: ["heix"] }))).toEqual({
      major: "mif1",
      compatible: ["heix"],
    });
    expect(ftypBrands(heicBytes({ major: "mif1", compatible: ["avif"] }))).toEqual({
      major: "mif1",
      compatible: ["avif"],
    });
  });

  it("mp4Bytes は ftyp を持つが HEIC の brands を持たない", () => {
    const brands = ftypBrands(mp4Bytes());
    expect(brands).toEqual({ major: "isom", compatible: ["isom", "mp42"] });
  });
});

describe("拡張子と違う中身・空・短いバイト列", () => {
  it("mislabeledSamples は名前の拡張子と中身が一致しない", () => {
    const samples = mislabeledSamples();
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (const s of samples) {
      expect(s.originalName).toMatch(/\.(jpg|png|pdf|heic)$/);
      expect(s.bytes.length).toBeGreaterThan(0);
    }
    const byName = new Map(samples.map((s) => [s.originalName, s]));
    expect(ascii(byName.get("receipt.jpg")?.bytes ?? new Uint8Array(), 0, 5)).toBe("%PDF-");
    expect(head(byName.get("receipt.pdf")?.bytes ?? new Uint8Array(), 4)).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    // どの形式でもない（テキスト）
    expect(byName.get("receipt.png")?.actual).toBe("text");
  });

  it("emptyBytes は 0 バイト、shortBytes はどの形式の先頭にも足りない長さ", () => {
    expect(emptyBytes().length).toBe(0);
    expect(shortBytes().length).toBeGreaterThan(0);
    expect(shortBytes().length).toBeLessThan(8);
  });
});
