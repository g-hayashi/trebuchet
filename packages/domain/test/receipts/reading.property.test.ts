import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SuggestionContext } from "../../src/ports.ts";
import { compareReadingWithSaved, parseReceiptReading } from "../../src/receipts/reading.ts";
import { normalizeReceiptText } from "../../src/receipts/search.ts";

// T032: INV-67（AI の出力は検証を通ったものだけが候補になる）

const CONTEXT: SuggestionContext = {
  accounts: [
    { code: "5100", name: "消耗品費" },
    { code: "5200", name: "旅費交通費" },
  ],
  taxCategories: ["PURCHASE_10", "PURCHASE_8R"],
};

/** JSON として読める値（型も範囲も無秩序） */
const jsonValueArb = fc.jsonValue();
/** 期待する項目名を持つが、値は無秩序なオブジェクト */
const looseObjectArb = fc.record(
  {
    transactionDate: fc.oneof(
      jsonValueArb,
      fc.constantFrom("2026-10-20", "2026-02-30", "2026-13-01"),
    ),
    amount: fc.oneof(jsonValueArb, fc.integer({ min: -10, max: 2_000_000_000_000 })),
    partnerName: fc.oneof(jsonValueArb, fc.string({ maxLength: 150 })),
    accountCode: fc.oneof(jsonValueArb, fc.constantFrom("5100", "5200", "9999")),
    taxCategory: fc.oneof(jsonValueArb, fc.constantFrom("PURCHASE_10", "SALES_10", "x")),
    confidence: fc.oneof(jsonValueArb, fc.integer({ min: -5, max: 105 })),
    reason: fc.oneof(jsonValueArb, fc.string({ maxLength: 300 })),
  },
  { requiredKeys: [] },
);
const rawArb = fc.oneof(
  fc.string(),
  jsonValueArb.map((v) => JSON.stringify(v)),
  looseObjectArb.map((o) => JSON.stringify(o)),
  looseObjectArb,
  fc.anything(),
);

const isDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
};

describe("INV-67: parseReceiptReading", () => {
  it("任意の応答で例外を投げず、候補はすべて検証を通った値か null", () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const r = parseReceiptReading(raw, CONTEXT);
        const c = r.candidates;
        if (c.transactionDate !== null) expect(isDate(c.transactionDate)).toBe(true);
        if (c.amount !== null) {
          expect(Number.isInteger(c.amount)).toBe(true);
          expect(c.amount).toBeGreaterThan(0);
          expect(c.amount).toBeLessThan(1e12);
        }
        if (c.partnerName !== null) {
          expect(c.partnerName.length).toBeGreaterThanOrEqual(1);
          expect(c.partnerName.length).toBeLessThanOrEqual(100);
          expect(c.partnerName).toBe(c.partnerName.trim());
        }
        if (c.accountCode !== null) {
          expect(CONTEXT.accounts.map((a) => a.code)).toContain(c.accountCode);
        }
        if (c.taxCategory !== null) expect(CONTEXT.taxCategories).toContain(c.taxCategory);
        if (r.confidence !== null) {
          expect(Number.isInteger(r.confidence)).toBe(true);
          expect(r.confidence).toBeGreaterThanOrEqual(0);
          expect(r.confidence).toBeLessThanOrEqual(100);
        }
        if (r.reason !== null) expect(r.reason.length).toBeLessThanOrEqual(200);
      }),
      { numRuns: 500 },
    );
  });

  it("invalid のときは全部 null。succeeded は少なくとも期待する項目名を持つオブジェクトの応答", () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const r = parseReceiptReading(raw, CONTEXT);
        if (r.status === "invalid") {
          expect(r).toEqual({
            status: "invalid",
            candidates: {
              transactionDate: null,
              amount: null,
              partnerName: null,
              accountCode: null,
              taxCategory: null,
            },
            confidence: null,
            reason: null,
          });
        }
      }),
    );
  });

  it("一覧にない科目・税区分は、ほかの項目が何であっても候補なし", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }).filter((s) => !["5100", "5200"].includes(s)),
        fc.string({ maxLength: 12 }).filter((s) => !["PURCHASE_10", "PURCHASE_8R"].includes(s)),
        (accountCode, taxCategory) => {
          const r = parseReceiptReading({ accountCode, taxCategory, amount: 100 }, CONTEXT);
          expect(r.status).toBe("succeeded");
          expect(r.candidates.accountCode).toBeNull();
          expect(r.candidates.taxCategory).toBeNull();
          expect(r.candidates.amount).toBe(100);
        },
      ),
    );
  });

  it("取引先の比べは normalizeReceiptText と同じ（候補と保存した値の見た目の差を無視する）", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ maxLength: 30 }),
        (a, b) => {
          const r = compareReadingWithSaved(
            {
              transactionDate: null,
              amount: null,
              partnerName: a,
              accountCode: null,
              taxCategory: null,
            },
            { transactionDate: null, amount: null, partnerName: b },
          );
          expect(r.partnerMatch).toBe(normalizeReceiptText(a) === normalizeReceiptText(b));
        },
      ),
    );
  });
});
