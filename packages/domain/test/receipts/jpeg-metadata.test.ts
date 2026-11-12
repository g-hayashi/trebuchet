import { describe, expect, it } from "vitest";
import { stripJpegMetadata } from "../../src/receipts/jpeg-metadata.ts";
import {
  jpegBytes,
  jpegDimensions,
  jpegSegments,
  pdfBytes,
  readExif,
} from "../fixtures/receipts/sample-files.ts";
import { must } from "../result.ts";

// T031: AI に送る前の JPEG のメタデータの除去（research R12、INV-66）

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("stripJpegMetadata", () => {
  it("Exif（GPS つき）・XMP・IPTC・COM をすべて除く。向きがなければ APP1 も残さない", () => {
    const input = jpegBytes({ gps: true, xmp: true, iptc: true, comment: "合成", seed: 3 });
    expect(jpegSegments(input)).toEqual(
      expect.arrayContaining(["APP1", "APP13", "COM", "SOF0", "SOS"]),
    );
    const out = must(stripJpegMetadata(input));
    expect(jpegSegments(out)).toEqual(["SOI", "DQT", "SOF0", "SOS", "EOI"]);
    expect(readExif(out)).toBeUndefined();
  });

  it("向き（Orientation）があれば、向きだけの最小の APP1 を SOI の直後に置く。GPS は残さない", () => {
    for (const orientation of [1, 3, 6, 8]) {
      const out = must(
        stripJpegMetadata(jpegBytes({ orientation, gps: true, xmp: true, comment: "x" })),
      );
      expect(jpegSegments(out)).toEqual(["SOI", "APP1", "DQT", "SOF0", "SOS", "EOI"]);
      expect(readExif(out)).toEqual({ orientation, hasGps: false });
    }
  });

  it("向きを持たない Exif（GPS だけ）は、APP1 ごと除く", () => {
    const out = must(stripJpegMetadata(jpegBytes({ gps: true })));
    expect(jpegSegments(out)).toEqual(["SOI", "DQT", "SOF0", "SOS", "EOI"]);
  });

  it("画素のデータ・寸法は変わらない", () => {
    const input = jpegBytes({ width: 640, height: 480, orientation: 6, gps: true, seed: 99 });
    const out = must(stripJpegMetadata(input));
    expect(jpegDimensions(out)).toEqual({ width: 640, height: 480 });
    // SOS の後ろ（画素と EOI）は元のまま
    const tail = input.slice(input.length - 11);
    expect(out.slice(out.length - 11)).toEqual(tail);
  });

  it("入力を書き換えない。2 回かけても同じ（冪等）", () => {
    const input = jpegBytes({ orientation: 8, gps: true, iptc: true });
    const copy = new Uint8Array(input);
    const once = must(stripJpegMetadata(input));
    expect(input).toEqual(copy);
    expect(must(stripJpegMetadata(once))).toEqual(once);
  });

  it("EOI の後ろの余分なバイト（別の JPEG の写しなど）は持ち越さない", () => {
    const trailing = jpegBytes({ gps: true, comment: "後ろの写し" });
    const out = must(stripJpegMetadata(concat(jpegBytes({ seed: 5 }), trailing)));
    expect(jpegSegments(out)).toEqual(["SOI", "DQT", "SOF0", "SOS", "EOI"]);
    expect(out.length).toBe(must(stripJpegMetadata(jpegBytes({ seed: 5 }))).length);
  });

  it("JPEG でなければ VALIDATION", () => {
    for (const bytes of [new Uint8Array(), new Uint8Array([0xff]), pdfBytes()]) {
      const r = stripJpegMetadata(bytes);
      expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
  });

  it("セグメントの長さが壊れている JPEG は VALIDATION（読み飛ばして素通しにしない）", () => {
    const input = jpegBytes({ gps: true });
    // 最初のセグメントの長さを実際より大きくする
    const broken = new Uint8Array(input);
    broken[4] = 0xff;
    broken[5] = 0xff;
    expect(stripJpegMetadata(broken)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    // 途中で切れている
    expect(stripJpegMetadata(input.slice(0, 7))).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
  });
});
