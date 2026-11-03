import { describe, expect, it } from "vitest";
import { detectReceiptFormat } from "../../src/receipts/format.ts";
import {
  emptyBytes,
  heicBytes,
  jpegBytes,
  mislabeledSamples,
  mp4Bytes,
  pdfBytes,
  pngBytes,
  shortBytes,
} from "../fixtures/receipts/sample-files.ts";

// T011: 形式は中身で判定する（research R10。拡張子・Content-Type は見ない）

describe("detectReceiptFormat", () => {
  it("4 形式を判定する", () => {
    expect(detectReceiptFormat(jpegBytes())).toBe("image/jpeg");
    expect(detectReceiptFormat(pngBytes())).toBe("image/png");
    expect(detectReceiptFormat(pdfBytes())).toBe("application/pdf");
    expect(detectReceiptFormat(heicBytes({ major: "heic", compatible: ["mif1", "heic"] }))).toBe(
      "image/heic",
    );
  });

  it("PDF は先頭 1,024 バイト以内に %PDF- があればよい（境目を含む）", () => {
    expect(detectReceiptFormat(pdfBytes({ leading: 100 }))).toBe("application/pdf");
    expect(detectReceiptFormat(pdfBytes({ leading: 1019 }))).toBe("application/pdf");
    expect(detectReceiptFormat(pdfBytes({ leading: 1020 }))).toBeUndefined();
  });

  it("HEIC は major brand が 6 つのどれかなら通る", () => {
    for (const major of ["heic", "heix", "heim", "heis", "hevc", "hevx"]) {
      expect(detectReceiptFormat(heicBytes({ major, compatible: [] }))).toBe("image/heic");
    }
  });

  it("major が mif1・msf1 のときは compatible brands に HEIC の brand が要る", () => {
    for (const major of ["mif1", "msf1"]) {
      expect(detectReceiptFormat(heicBytes({ major, compatible: ["mif1", "heic"] }))).toBe(
        "image/heic",
      );
      expect(detectReceiptFormat(heicBytes({ major, compatible: ["hevx"] }))).toBe("image/heic");
      expect(detectReceiptFormat(heicBytes({ major, compatible: ["mif1", "msf1"] }))).toBe(
        undefined,
      );
      expect(detectReceiptFormat(heicBytes({ major, compatible: [] }))).toBeUndefined();
    }
  });

  it("ftyp があっても HEIC でなければ対象外（MP4、AVIF）", () => {
    expect(detectReceiptFormat(mp4Bytes())).toBeUndefined();
    expect(detectReceiptFormat(heicBytes({ major: "avif", compatible: ["mif1"] }))).toBeUndefined();
  });

  it("拡張子と違う中身は、中身の形式になる（名前は見ない）", () => {
    const expected = {
      pdf: "application/pdf",
      png: "image/png",
      jpeg: "image/jpeg",
      heic: "image/heic",
      text: undefined,
    } as const;
    for (const sample of mislabeledSamples()) {
      expect(detectReceiptFormat(sample.bytes), sample.originalName).toBe(expected[sample.actual]);
    }
  });

  it("空・短いバイト列は undefined（例外にしない）", () => {
    expect(detectReceiptFormat(emptyBytes())).toBeUndefined();
    expect(detectReceiptFormat(shortBytes())).toBeUndefined();
    expect(detectReceiptFormat(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
    expect(
      detectReceiptFormat(new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70])),
    ).toBeUndefined();
  });

  it("先頭だけを見る（後ろを切っても、署名があれば同じ判定）", () => {
    expect(detectReceiptFormat(jpegBytes().slice(0, 3))).toBe("image/jpeg");
    expect(detectReceiptFormat(pngBytes().slice(0, 8))).toBe("image/png");
  });

  it("ftyp の大きさが実際より大きくても読み過ぎない", () => {
    const bytes = heicBytes({ major: "mif1", compatible: ["mif1", "heic"] });
    const truncated = bytes.slice(0, 20);
    expect(detectReceiptFormat(truncated)).toBeUndefined();
  });
});
