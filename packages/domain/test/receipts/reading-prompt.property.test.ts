import { TaxCategoryCode } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SuggestionContext } from "../../src/ports.ts";
import { stripJpegMetadata } from "../../src/receipts/jpeg-metadata.ts";
import {
  buildReceiptReadingRequest,
  RECEIPT_AI_MAX_PX,
  RECEIPT_READING_SYSTEM_PROMPT,
} from "../../src/receipts/reading-prompt.ts";
import { jpegBytes, jpegSegments, readExif } from "../fixtures/receipts/sample-files.ts";

// T031: INV-66（外部の AI に送る証憑の読み取りの要求の中身）。要求は「固定の指示文、科目と税区分の一覧、
// 画像 1 枚」だけで、位置情報・取引先・仕訳・口座・メモ・ファイル名を含まない

const accountArb = fc.record({
  code: fc.stringMatching(/^[0-9]{3,5}$/),
  name: fc.stringMatching(/^[ぁ-んァ-ン一-龥A-Za-z0-9]{1,10}$/),
});
const contextArb: fc.Arbitrary<SuggestionContext> = fc.record({
  accounts: fc.array(accountArb, { maxLength: 12 }),
  taxCategories: fc.subarray([...TaxCategoryCode.options], { minLength: 1 }),
});
const jpegArb = fc
  .record({
    width: fc.integer({ min: 1, max: 4000 }),
    height: fc.integer({ min: 1, max: 4000 }),
    orientation: fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
    gps: fc.boolean(),
    iptc: fc.boolean(),
    xmp: fc.boolean(),
    comment: fc.option(fc.constantFrom("合成の店 山田", "memo", "GPS 35.0,139.0"), {
      nil: undefined,
    }),
    seed: fc.integer({ min: 0, max: 10_000 }),
  })
  .map((o) => jpegBytes(o));

/** 画像を除いた要求の文字列（JSON） */
const textOf = (request: ReturnType<typeof buildReceiptReadingRequest>): string =>
  JSON.stringify({ system: request.system, choices: request.choices, schema: request.schema });

describe("INV-66: buildReceiptReadingRequest", () => {
  it("要求は system・choices・image・schema だけ。指示文は固定、画像は渡した 1 枚そのまま", () => {
    fc.assert(
      fc.property(contextArb, jpegArb, (context, jpeg) => {
        const stripped = stripJpegMetadata(jpeg);
        if (!stripped.ok) throw new Error("fixture must be a jpeg");
        const request = buildReceiptReadingRequest(stripped.value, context);
        expect(Object.keys(request).sort()).toEqual(["choices", "image", "schema", "system"]);
        expect(request.system).toBe(RECEIPT_READING_SYSTEM_PROMPT);
        expect(request.image.mediaType).toBe("image/jpeg");
        expect(request.image.bytes).toEqual(stripped.value);
      }),
    );
  });

  it("選択肢は科目のコードと名前、税区分のコードを全部含み、それ以外の語を持たない", () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        const { choices } = buildReceiptReadingRequest(jpegBytes(), context);
        for (const a of context.accounts) expect(choices).toContain(`${a.code} ${a.name}`);
        for (const t of context.taxCategories) expect(choices).toContain(t);
        // 科目の行と税区分の行と見出しだけで作る（行ごとに出どころが決まる）
        const lines = choices.split("\n").filter((l) => l.length > 0);
        const known = new Set([
          ...context.accounts.map((a) => `${a.code} ${a.name}`),
          ...context.taxCategories.map((t) => `${t}`),
        ]);
        for (const line of lines) {
          const isKnown = known.has(line);
          const isHeading = /[:：]$/.test(line) || line.includes(context.taxCategories.join(", "));
          expect(isKnown || isHeading).toBe(true);
        }
      }),
    );
  });

  it("文脈の外の文字列（取引先・仕訳・口座・メモ・ファイル名）は、指示文にも選択肢にも schema にも入らない", () => {
    const outside = [
      "SENTINEL_PARTNER",
      "SENTINEL_JOURNAL",
      "SENTINEL_ACCOUNT_NAME",
      "SENTINEL_MEMO",
      "receipt-sentinel.jpg",
    ];
    fc.assert(
      fc.property(contextArb, jpegArb, (context, jpeg) => {
        const request = buildReceiptReadingRequest(jpeg, context);
        const text = textOf(request);
        for (const word of outside) expect(text).not.toContain(word);
        // 画像のバイト列は文字列化して含めない（画像は image だけ）
        expect(text).not.toContain("Exif");
      }),
    );
  });

  it("除去を通した画像には、GPS・XMP・IPTC・コメントが残らない（向きだけ）", () => {
    fc.assert(
      fc.property(contextArb, jpegArb, (context, jpeg) => {
        const stripped = stripJpegMetadata(jpeg);
        if (!stripped.ok) throw new Error("fixture must be a jpeg");
        const { image } = buildReceiptReadingRequest(stripped.value, context);
        const names = jpegSegments(image.bytes);
        expect(names).not.toContain("APP13");
        expect(names).not.toContain("COM");
        expect(names.filter((n) => n === "APP1").length).toBeLessThanOrEqual(1);
        expect(readExif(image.bytes)?.hasGps ?? false).toBe(false);
      }),
    );
  });

  it("schema は json_schema の strict の形で、各項目が null を許す", () => {
    const { schema } = buildReceiptReadingRequest(jpegBytes(), {
      accounts: [{ code: "5100", name: "消耗品費" }],
      taxCategories: ["PURCHASE_10"],
    }) as { schema: Record<string, unknown> };
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "transactionDate",
        "amount",
        "partnerName",
        "accountCode",
        "taxCategory",
        "confidence",
        "reason",
      ],
    });
    const properties = schema.properties as Record<string, { type?: unknown; enum?: unknown[] }>;
    for (const key of ["transactionDate", "amount", "partnerName", "accountCode", "taxCategory"]) {
      const p = properties[key];
      if (p?.type === undefined) expect(p?.enum).toContain(null);
      else expect(p.type).toContain("null");
    }
    expect(properties.accountCode?.enum).toEqual(["5100", null]);
    expect(properties.taxCategory?.enum).toEqual(["PURCHASE_10", null]);
  });

  it("画像の長辺の上限は 2,048 画素", () => {
    expect(RECEIPT_AI_MAX_PX).toBe(2048);
  });
});
