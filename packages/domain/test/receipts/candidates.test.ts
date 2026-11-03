import { describe, expect, it } from "vitest";
import {
  RECEIPT_CANDIDATE_LIMIT,
  RECEIPT_CANDIDATE_WINDOW_DAYS,
  rankJournalCandidates,
} from "../../src/receipts/candidates.ts";
import type { Journal } from "../../src/types.ts";

// T019: 結びつける仕訳の候補の並べ方（data-model §2.4、research R6、FR-011）

type Input = Parameters<typeof rankJournalCandidates>[1][number];

/** 借方 1 行・貸方 1 行（同額）の仕訳。`total` が借方合計 */
function journal(over: Partial<Journal> & { journalNo: number; total?: number }): Input {
  const { total = 1000, ...rest } = over;
  return {
    id: `j-${over.journalNo}`,
    date: "2026-10-20",
    status: "active",
    lines: [
      {
        id: "l1",
        lineNo: 1,
        side: "debit",
        accountId: "a",
        subAccountId: null,
        amount: total,
        taxCategory: "NON_TAXABLE",
        partnerId: null,
        description: null,
        tagIds: [],
      },
      {
        id: "l2",
        lineNo: 2,
        side: "credit",
        accountId: "b",
        subAccountId: null,
        amount: total,
        taxCategory: "NON_TAXABLE",
        partnerId: null,
        description: null,
        tagIds: [],
      },
    ],
    ...rest,
  } as Input;
}

const receipt = (over: { transactionDate?: string | null; amount?: number | null } = {}) => ({
  transactionDate: "2026-10-20" as string | null,
  amount: 1000 as number | null,
  ...over,
});

const nos = (r: ReturnType<typeof rankJournalCandidates>) => r.map((c) => c.journal.journalNo);

describe("定数", () => {
  it("範囲は ±14 日、上位 20 件", () => {
    expect(RECEIPT_CANDIDATE_WINDOW_DAYS).toBe(14);
    expect(RECEIPT_CANDIDATE_LIMIT).toBe(20);
  });
});

describe("rankJournalCandidates: 並び", () => {
  const today = "2026-10-31";

  it("①借方合計 = 金額 が先、②日付の差、③金額の差、④仕訳番号の順", () => {
    const journals = [
      journal({ journalNo: 1, date: "2026-10-20", total: 900 }), // 一致なし、差 0 日、差額 100
      journal({ journalNo: 2, date: "2026-10-25", total: 1000 }), // 一致、5 日
      journal({ journalNo: 3, date: "2026-10-21", total: 1000 }), // 一致、1 日
      journal({ journalNo: 4, date: "2026-10-20", total: 1500 }), // 一致なし、差 0 日、差額 500
      journal({ journalNo: 5, date: "2026-10-21", total: 1000 }), // 一致、1 日（3 と同順位 → 番号）
    ];
    const ranked = rankJournalCandidates(receipt(), journals, today);
    expect(nos(ranked)).toEqual([3, 5, 2, 1, 4]);
  });

  it("日付の差は絶対値（前後どちらも同じ）", () => {
    const journals = [
      journal({ journalNo: 1, date: "2026-10-23" }), // +3
      journal({ journalNo: 2, date: "2026-10-18" }), // -2
    ];
    const ranked = rankJournalCandidates(receipt(), journals, today);
    expect(ranked.map((c) => [c.journal.journalNo, c.daysDiff])).toEqual([
      [2, 2],
      [1, 3],
    ]);
  });

  it("金額の差の小さい順（日付が同じ、どちらも不一致）", () => {
    const journals = [
      journal({ journalNo: 1, total: 1500 }),
      journal({ journalNo: 2, total: 1100 }),
      journal({ journalNo: 3, total: 700 }),
    ];
    expect(nos(rankJournalCandidates(receipt(), journals, today))).toEqual([2, 3, 1]);
  });

  it("各候補は journal（参照）・total・daysDiff・amountMatches を持つ", () => {
    const [c] = rankJournalCandidates(
      receipt(),
      [journal({ journalNo: 7, date: "2026-10-22", total: 1000 })],
      today,
    );
    expect(c).toEqual({
      journal: { id: "j-7", journalNo: 7, date: "2026-10-22", status: "active" },
      total: 1000,
      daysDiff: 2,
      amountMatches: true,
    });
  });

  it("借方合計は借方の行だけの合計（貸方は数えない）", () => {
    const j = journal({ journalNo: 1, total: 400 });
    j.lines = [
      ...j.lines,
      { ...j.lines[0], id: "l3", lineNo: 3, amount: 600 },
      { ...j.lines[1], id: "l4", lineNo: 4, amount: 600 },
    ] as Input["lines"];
    const [c] = rankJournalCandidates(receipt(), [j], today);
    expect(c).toMatchObject({ total: 1000, amountMatches: true });
  });
});

describe("rankJournalCandidates: 金額が未入力", () => {
  it("①③は同順位になり、日付の差 → 仕訳番号で並ぶ。amountMatches はすべて false", () => {
    const journals = [
      journal({ journalNo: 1, date: "2026-10-25", total: 1000 }),
      journal({ journalNo: 2, date: "2026-10-21", total: 5 }),
      journal({ journalNo: 3, date: "2026-10-21", total: 999_999 }),
    ];
    const ranked = rankJournalCandidates(receipt({ amount: null }), journals, "2026-10-31");
    expect(nos(ranked)).toEqual([2, 3, 1]);
    expect(ranked.every((c) => !c.amountMatches)).toBe(true);
  });
});

describe("rankJournalCandidates: 基準日と範囲", () => {
  it("基準日は取引年月日。±14 日の内側（両端を含む）だけを残す", () => {
    const journals = [
      journal({ journalNo: 1, date: "2026-10-06" }), // -14
      journal({ journalNo: 2, date: "2026-10-05" }), // -15
      journal({ journalNo: 3, date: "2026-11-03" }), // +14
      journal({ journalNo: 4, date: "2026-11-04" }), // +15
    ];
    const ranked = rankJournalCandidates(receipt(), journals, "2026-12-31");
    expect(nos(ranked)).toEqual([1, 3]);
  });

  it("取引年月日がなければ受領日（第 3 引数）が基準日", () => {
    const journals = [
      journal({ journalNo: 1, date: "2026-10-31" }),
      journal({ journalNo: 2, date: "2026-10-10" }),
    ];
    const ranked = rankJournalCandidates(
      receipt({ transactionDate: null }),
      journals,
      "2026-10-30",
    );
    expect(ranked.map((c) => [c.journal.journalNo, c.daysDiff])).toEqual([[1, 1]]);
  });

  it("取消済みの仕訳は除く", () => {
    const journals = [
      journal({ journalNo: 1, status: "voided" }),
      journal({ journalNo: 2, status: "active" }),
    ];
    expect(nos(rankJournalCandidates(receipt(), journals, "2026-10-31"))).toEqual([2]);
  });

  it("上位 20 件まで", () => {
    const journals = Array.from({ length: 30 }, (_, i) => journal({ journalNo: i + 1 }));
    const ranked = rankJournalCandidates(receipt(), journals, "2026-10-31");
    expect(ranked).toHaveLength(20);
    expect(nos(ranked)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("入力の配列を変えない", () => {
    const journals = [journal({ journalNo: 2 }), journal({ journalNo: 1 })];
    const copy = structuredClone(journals);
    rankJournalCandidates(receipt(), journals, "2026-10-31");
    expect(journals).toEqual(copy);
  });
});
