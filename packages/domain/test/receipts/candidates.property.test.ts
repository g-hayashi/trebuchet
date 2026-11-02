import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween } from "../../src/dates.ts";
import {
  RECEIPT_CANDIDATE_LIMIT,
  RECEIPT_CANDIDATE_WINDOW_DAYS,
  rankJournalCandidates,
} from "../../src/receipts/candidates.ts";
import type { Journal } from "../../src/types.ts";

// T019: 候補の並びの性質（data-model §2.4、R6）

type Input = Parameters<typeof rankJournalCandidates>[1][number];

const BASE = "2026-10-20";

const journalArb = (journalNo: number): fc.Arbitrary<Input> =>
  fc
    .record({
      offset: fc.integer({ min: -30, max: 30 }),
      total: fc.constantFrom(500, 1000, 1500, 2000),
      status: fc.constantFrom<Journal["status"]>("active", "active", "active", "voided"),
    })
    .map(
      ({ offset, total, status }) =>
        ({
          id: `j-${journalNo}`,
          journalNo,
          date: addDays(BASE, offset),
          status,
          lines: [
            { side: "debit", amount: total },
            { side: "credit", amount: total },
          ],
        }) as unknown as Input,
    );

const journalsArb = fc
  .integer({ min: 0, max: 40 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => journalArb(i + 1))));

const amountArb = fc.option(fc.constantFrom(500, 1000, 1500, 2000, 777), { nil: null });

describe("rankJournalCandidates の性質", () => {
  it("結果は有効・範囲内だけ、20 件以下、仕訳番号の重複なし、金額が未入力なら一致は 0 件", () => {
    fc.assert(
      fc.property(journalsArb, amountArb, (journals, amount) => {
        const ranked = rankJournalCandidates(
          { transactionDate: BASE, amount },
          journals,
          "2026-12-31",
        );
        expect(ranked.length).toBeLessThanOrEqual(RECEIPT_CANDIDATE_LIMIT);
        expect(new Set(ranked.map((c) => c.journal.id)).size).toBe(ranked.length);
        for (const c of ranked) {
          expect(c.journal.status).toBe("active");
          expect(Math.abs(daysBetween(BASE, c.journal.date))).toBeLessThanOrEqual(
            RECEIPT_CANDIDATE_WINDOW_DAYS,
          );
          expect(c.daysDiff).toBe(Math.abs(daysBetween(BASE, c.journal.date)));
          expect(c.amountMatches).toBe(amount !== null && c.total === amount);
        }
      }),
    );
  });

  it("隣り合う候補は ①一致 ②日付の差 ③金額の差 ④仕訳番号 の辞書式の順", () => {
    fc.assert(
      fc.property(journalsArb, amountArb, (journals, amount) => {
        const ranked = rankJournalCandidates(
          { transactionDate: BASE, amount },
          journals,
          "2026-12-31",
        );
        const key = (c: (typeof ranked)[number]) => [
          c.amountMatches ? 0 : 1,
          c.daysDiff,
          amount === null ? 0 : Math.abs(c.total - amount),
          c.journal.journalNo,
        ];
        for (let i = 1; i < ranked.length; i++) {
          const a = key(ranked[i - 1] as (typeof ranked)[number]);
          const b = key(ranked[i] as (typeof ranked)[number]);
          const firstDiff = a.findIndex((x, k) => x !== b[k]);
          expect(firstDiff).toBeGreaterThanOrEqual(0);
          expect(a[firstDiff] as number).toBeLessThan(b[firstDiff] as number);
        }
      }),
    );
  });

  it("入力の順に依存しない", () => {
    fc.assert(
      fc.property(journalsArb, amountArb, (journals, amount) => {
        const receipt = { transactionDate: BASE, amount };
        const forward = rankJournalCandidates(receipt, journals, "2026-12-31");
        const backward = rankJournalCandidates(receipt, [...journals].reverse(), "2026-12-31");
        expect(backward).toEqual(forward);
      }),
    );
  });

  it("候補を落とすのは範囲・取消・上限だけ（範囲内の有効な仕訳が 20 件以下なら全部残る）", () => {
    fc.assert(
      fc.property(journalsArb, amountArb, (journals, amount) => {
        const eligible = journals.filter(
          (j) =>
            j.status === "active" &&
            Math.abs(daysBetween(BASE, j.date)) <= RECEIPT_CANDIDATE_WINDOW_DAYS,
        );
        const ranked = rankJournalCandidates(
          { transactionDate: BASE, amount },
          journals,
          "2026-12-31",
        );
        expect(ranked).toHaveLength(Math.min(eligible.length, RECEIPT_CANDIDATE_LIMIT));
      }),
    );
  });
});

describe("基準日", () => {
  it("取引年月日がなければ受領日（第 3 引数）を使う", () => {
    fc.assert(
      fc.property(journalsArb, (journals) => {
        const a = rankJournalCandidates({ transactionDate: null, amount: 1000 }, journals, BASE);
        const b = rankJournalCandidates(
          { transactionDate: BASE, amount: 1000 },
          journals,
          "2000-01-01",
        );
        expect(a).toEqual(b);
      }),
    );
  });
});
