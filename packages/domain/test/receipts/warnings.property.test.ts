import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, addMonthsToDate } from "../../src/dates.ts";
import { inputDeadline, receiptWarnings } from "../../src/receipts/warnings.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import { receiptDateArb, receiptFileRowArb, receiptRowArb } from "../receipt-arbitraries.ts";

// T011: 警告の性質（data-model §2.2。日付の計算は dates.ts のものを使う）

const paramsArb = fc.record({
  cycleMonths: fc.integer({ min: 0, max: 12 }),
  graceBusinessDays: fc.integer({ min: 1, max: 30 }),
});
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

describe("inputDeadline の性質", () => {
  it("猶予を使い切った日は平日で、周期の末日から猶予の営業日数分だけ後にある", () => {
    fc.assert(
      fc.property(receiptDateArb, paramsArb, (date, params) => {
        const deadline = inputDeadline(date, params);
        const cycleEnd = addDays(addMonthsToDate(date, params.cycleMonths), -1);
        expect([1, 2, 3, 4, 5]).toContain(weekday(deadline));
        const days = Math.round(
          (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${cycleEnd}T00:00:00Z`)) / 86_400_000,
        );
        // 7 日に 5 営業日。週末をまたぐ分は 1 週ごとに最大 2 日（先頭が週末の分を含め +2）
        expect(days).toBeGreaterThanOrEqual(params.graceBusinessDays);
        expect(days).toBeLessThanOrEqual(
          params.graceBusinessDays + 2 * Math.ceil(params.graceBusinessDays / 5) + 2,
        );
      }),
    );
  });

  it("取引年月日が後なら、期限は早まらない（単調）", () => {
    fc.assert(
      fc.property(receiptDateArb, fc.nat({ max: 400 }), paramsArb, (date, gap, params) => {
        expect(inputDeadline(addDays(date, gap), params) >= inputDeadline(date, params)).toBe(true);
      }),
    );
  });
});

describe("receiptWarnings の性質", () => {
  const inputArb = fc.record({
    receipt: receiptRowArb,
    currentFile: receiptFileRowArb,
    linkState: fc.constantFrom("none" as const, "linked" as const, "journal_voided" as const),
    receivedDate: receiptDateArb,
  });
  const run = (input: {
    receipt: Parameters<typeof receiptWarnings>[0]["receipt"];
    currentFile: Parameters<typeof receiptWarnings>[0]["currentFile"];
    linkState: Parameters<typeof receiptWarnings>[0]["linkState"];
    receivedDate: string;
  }) => receiptWarnings({ ...input, taxParameters: TAX_PARAMETERS });

  it("削除済みは常に空", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        fc.pre(input.receipt.deletedAt !== null);
        expect(run(input)).toEqual([]);
      }),
    );
  });

  it("コードは重複せず、electronic には紙の警告（期間・解像度・階調）がない", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const codes = run(input).map((w) => w.code);
        expect(new Set(codes).size).toBe(codes.length);
        if (input.receipt.category === "electronic") {
          expect(codes).not.toContain("INPUT_PERIOD_EXCEEDED");
          expect(codes).not.toContain("RESOLUTION_BELOW_GUIDE");
          expect(codes).not.toContain("NOT_FULL_COLOR");
        }
      }),
    );
  });

  it("入力期間の警告 ⇔ paper_scan・取引年月日あり・受領日 > 期限（独立に計算した期限）", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        fc.pre(input.receipt.deletedAt === null);
        const { receipt, receivedDate } = input;
        const warning = run(input).find((w) => w.code === "INPUT_PERIOD_EXCEEDED");
        const expected =
          receipt.category === "paper_scan" &&
          receipt.transactionDate !== null &&
          receivedDate >
            inputDeadline(receipt.transactionDate, { cycleMonths: 2, graceBusinessDays: 7 });
        expect(warning !== undefined).toBe(expected);
        if (warning !== undefined && receipt.transactionDate !== null) {
          expect(warning.details).toEqual({
            deadline: inputDeadline(receipt.transactionDate, {
              cycleMonths: 2,
              graceBusinessDays: 7,
            }),
          });
        }
      }),
    );
  });

  it("未入力の警告 ⇔ 取引年月日・金額・取引先のどれかが null、仕訳の取消の警告 ⇔ journal_voided", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        fc.pre(input.receipt.deletedAt === null);
        const codes = run(input).map((w) => w.code);
        const { receipt } = input;
        const missing =
          receipt.transactionDate === null ||
          receipt.amount === null ||
          receipt.partnerName === null;
        expect(codes.includes("FIELDS_MISSING")).toBe(missing);
        expect(codes.includes("JOURNAL_VOIDED")).toBe(input.linkState === "journal_voided");
      }),
    );
  });
});
