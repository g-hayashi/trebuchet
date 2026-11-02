import {
  AiReceiptReading,
  ReceiptCreateOptions,
  ReceiptDeleteInput,
  ReceiptLinkInput,
  ReceiptReplaceOptions,
  ReceiptUnlinkInput,
  ReceiptUpdateInput,
} from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isValidDate } from "../src/dates.ts";
import { normalizeReceiptText } from "../src/receipts/search.ts";
import { jpegBytes, jpegDimensions, jpegSegments } from "./fixtures/receipts/sample-files.ts";
import {
  jpegBytesArb,
  jpegOptionsArb,
  partnerNameArb,
  readingResponseArb,
  receiptFileRowArb,
  receiptInputArb,
  receiptOpsArb,
  receiptRowArb,
  sha256Arb,
} from "./receipt-arbitraries.ts";

// T005: 生成した値が data-model §1 の制約を満たす

describe("receiptInputArb（追加・更新の値）", () => {
  it("ReceiptCreateOptions を満たし、日付は実在し、取引先は前後に空白がない", () => {
    fc.assert(
      fc.property(receiptInputArb, (input) => {
        const parsed = ReceiptCreateOptions.safeParse(input);
        expect(parsed.success).toBe(true);
        if (input.transactionDate !== null) expect(isValidDate(input.transactionDate)).toBe(true);
        if (input.amount !== null) {
          expect(Number.isInteger(input.amount)).toBe(true);
          expect(input.amount).toBeGreaterThan(0);
          expect(input.amount).toBeLessThan(1e12);
        }
        if (input.partnerName !== null) {
          expect(input.partnerName).toBe(input.partnerName.trim());
          expect(input.partnerName.length).toBeGreaterThanOrEqual(1);
          expect(input.partnerName.length).toBeLessThanOrEqual(100);
        }
      }),
    );
  });

  it("取引先の生成は、正規化すると空にならない", () => {
    fc.assert(
      fc.property(partnerNameArb, (name) => {
        expect(normalizeReceiptText(name).length).toBeGreaterThan(0);
      }),
    );
  });

  it("未入力の欄（null）も十分に出る", () => {
    const samples = fc.sample(receiptInputArb, 300);
    for (const key of ["transactionDate", "amount", "partnerName", "memo"] as const) {
      expect(samples.some((s) => s[key] === null)).toBe(true);
      expect(samples.some((s) => s[key] !== null)).toBe(true);
    }
  });
});

describe("receiptRowArb / receiptFileRowArb / sha256Arb", () => {
  it("証憑の行は §1.1 の制約を満たす", () => {
    fc.assert(
      fc.property(receiptRowArb, (row) => {
        expect(row.partnerKey === null).toBe(row.partnerName === null);
        if (row.partnerName !== null) {
          expect(row.partnerKey).toBe(normalizeReceiptText(row.partnerName));
        }
        expect(row.deletedAt === null).toBe(row.deletedReason === null);
        expect(row.version).toBeGreaterThanOrEqual(1);
        expect(row.currentSha256).toMatch(/^[0-9a-f]{64}$/);
        if (row.amount !== null) {
          expect(row.amount).toBeGreaterThan(0);
          expect(row.amount).toBeLessThan(1e12);
        }
        if (row.transactionDate !== null) expect(isValidDate(row.transactionDate)).toBe(true);
        expect(row.memo === null || row.memo.length <= 500).toBe(true);
      }),
    );
  });

  it("ファイルの行は §1.2 の制約を満たす", () => {
    fc.assert(
      fc.property(receiptFileRowArb, (file) => {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.fileVersion).toBeGreaterThanOrEqual(1);
        expect(file.sizeBytes).toBeGreaterThan(0);
        expect(file.sizeBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
        expect(file.originalName.length).toBeGreaterThan(0);
        if (file.width !== null) expect(file.width).toBeGreaterThan(0);
        if (file.height !== null) expect(file.height).toBeGreaterThan(0);
      }),
    );
    fc.assert(fc.property(sha256Arb, (sha) => /^[0-9a-f]{64}$/.test(sha)));
  });
});

describe("receiptOpsArb（操作の列）", () => {
  it("どの操作も、対応する入力の Zod を満たす（対象は添字で指す）", () => {
    fc.assert(
      fc.property(receiptOpsArb, (ops) => {
        for (const op of ops) {
          switch (op.kind) {
            case "add":
              expect(ReceiptCreateOptions.safeParse(op.input).success).toBe(true);
              break;
            case "update":
              expect(ReceiptUpdateInput.safeParse({ ...op.changes, version: 1 }).success).toBe(
                true,
              );
              break;
            case "replace":
              expect(
                ReceiptReplaceOptions.safeParse({ reason: op.reason, version: 1 }).success,
              ).toBe(true);
              break;
            case "delete":
              expect(ReceiptDeleteInput.safeParse({ reason: op.reason, version: 1 }).success).toBe(
                true,
              );
              break;
            case "link":
              expect(
                ReceiptLinkInput.safeParse({
                  journalId: "00000000-0000-7000-8000-000000000001",
                  reason: op.reason,
                }).success,
              ).toBe(true);
              break;
            case "unlink":
              expect(ReceiptUnlinkInput.safeParse({ reason: op.reason }).success).toBe(true);
              break;
            case "read":
              break;
          }
          if (op.kind !== "add") {
            expect(Number.isInteger(op.target)).toBe(true);
            expect(op.target).toBeGreaterThanOrEqual(0);
          }
        }
      }),
    );
  });

  it("全種類の操作が出て、追加で始まる列も出る", () => {
    const kinds = new Set(fc.sample(receiptOpsArb, 200).flatMap((ops) => ops.map((o) => o.kind)));
    expect([...kinds].sort()).toEqual(
      ["add", "delete", "link", "read", "replace", "unlink", "update"].sort(),
    );
  });

  it("追加の内容の種（seed）が違えば、別のバイト列になる", () => {
    const seeds = fc
      .sample(receiptOpsArb, 100)
      .flatMap((ops) =>
        ops.flatMap((o) => (o.kind === "add" || o.kind === "replace" ? [o.seed] : [])),
      );
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

describe("jpegOptionsArb / jpegBytesArb（JPEG のセグメント）", () => {
  it("SOI で始まり EOI で終わり、寸法が指定どおり。メタデータは指定したものだけ", () => {
    fc.assert(
      fc.property(jpegOptionsArb, (options) => {
        const bytes = jpegBytes(options);
        const segments = jpegSegments(bytes);
        expect(segments[0]).toBe("SOI");
        expect(segments.at(-1)).toBe("EOI");
        expect(segments).toContain("SOF0");
        expect(segments.includes("APP13")).toBe(options.iptc === true);
        expect(segments.includes("COM")).toBe(options.comment !== undefined);
        const app1 = segments.filter((s) => s === "APP1").length;
        const wantExif = options.orientation !== undefined || options.gps === true ? 1 : 0;
        expect(app1).toBe(wantExif + (options.xmp === true ? 1 : 0));
        expect(jpegDimensions(bytes)).toEqual({ width: options.width, height: options.height });
      }),
    );
  });

  it("jpegBytesArb は JPEG のバイト列で、メタデータの有無が混ざる", () => {
    const samples = fc.sample(jpegBytesArb, 100);
    expect(samples.every((b) => b[0] === 0xff && b[1] === 0xd8)).toBe(true);
    const withMeta = samples.filter((b) =>
      jpegSegments(b).some((s) => s === "APP1" || s === "APP13"),
    );
    expect(withMeta.length).toBeGreaterThan(0);
    expect(withMeta.length).toBeLessThan(samples.length);
  });
});

describe("readingResponseArb（AI の応答の文字列）", () => {
  const lists = {
    accountCodes: ["5110", "6150", "7100"],
    taxCategories: ["PURCHASE_10", "OUT_OF_SCOPE"] as const,
  };

  it("AiReceiptReading に合う応答、一部の項目だけ外れる応答、JSON でない応答がどれも出る", () => {
    const samples = fc.sample(readingResponseArb(lists), 400);
    let valid = 0;
    let partial = 0;
    let notJson = 0;
    let notObject = 0;
    for (const raw of samples) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        notJson += 1;
        continue;
      }
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        notObject += 1;
      } else if (AiReceiptReading.safeParse(json).success) valid += 1;
      else partial += 1;
    }
    expect(valid).toBeGreaterThan(0);
    expect(partial).toBeGreaterThan(0);
    expect(notJson).toBeGreaterThan(0);
    expect(notObject).toBeGreaterThan(0);
  });

  it("科目の一覧にないコードも出る（INV-67 の入力）", () => {
    const codes = fc.sample(readingResponseArb(lists), 400).flatMap((raw) => {
      try {
        const json = JSON.parse(raw) as { accountCode?: unknown };
        return typeof json?.accountCode === "string" ? [json.accountCode] : [];
      } catch {
        return [];
      }
    });
    expect(codes.some((c) => lists.accountCodes.includes(c))).toBe(true);
    expect(codes.some((c) => !lists.accountCodes.includes(c))).toBe(true);
  });
});
