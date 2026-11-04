import { describe, expect, it } from "vitest";
import { suggestFromHistory } from "../../src/journals/suggest.ts";
import type { Journal, JournalLine } from "../../src/types.ts";
import { NOW } from "../test-dates.ts";

function lineOf(journal: Journal, index: number): JournalLine {
  const line = journal.lines[index];
  if (line === undefined) throw new Error("合成仕訳の行がない");
  return line;
}

function journal(n: number, over: Partial<Journal> = {}): Journal {
  const line = (side: "debit" | "credit"): JournalLine => ({
    id: `${n}-${side}`,
    lineNo: side === "debit" ? 1 : 2,
    side,
    accountId: side === "debit" ? `expense-${n}` : "cash",
    subAccountId: null,
    amount: 100,
    taxCategory: "OUT_OF_SCOPE",
    taxAmount: 0,
    partnerId: null,
    description: null,
    tagIds: [],
  });
  return {
    id: `journal-${n}`,
    journalNo: n,
    date: "2026-10-01",
    fiscalPeriodId: "period",
    memo: "ABC 123",
    status: "active",
    correctsJournalId: null,
    source: "manual",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [line("debit"), line("credit")],
    ...over,
  };
}

describe("suggestFromHistory", () => {
  it("明細と同じNFKC・大文字・空白・数字の正規化で一致し、最新順に最大3件", () => {
    const rows = [journal(1), journal(4), journal(2), journal(3)];
    expect(
      suggestFromHistory(rows, { memo: "ａｂｃ　9999" }).map((s) => s.sourceJournalId),
    ).toEqual(["journal-4", "journal-3", "journal-2"]);
    expect(rows.map((j) => j.journalNo)).toEqual([1, 4, 2, 3]);
  });

  it("摘要または取引先で一致し、日付を仕訳番号より優先する", () => {
    const older = journal(20);
    const newer = journal(1, { date: "2026-10-02", memo: "別の摘要" });
    lineOf(newer, 1).partnerId = "partner";
    expect(
      suggestFromHistory([older, newer], { memo: "abc123", partnerId: "partner" }),
    ).toMatchObject([
      { sourceJournalId: newer.id, creditPartnerId: "partner" },
      { sourceJournalId: older.id },
    ]);
    expect(suggestFromHistory([newer], { partnerId: "other" })).toEqual([]);
  });

  it("取消・多行・借貸片側だけ・空の条件は候補にしない", () => {
    const many = journal(2);
    many.lines.push({ ...lineOf(many, 0), id: "third" });
    const oneSide = journal(3);
    lineOf(oneSide, 1).side = "debit";
    expect(
      suggestFromHistory([journal(1, { status: "voided" }), many, oneSide], { memo: "abc123" }),
    ).toEqual([]);
    expect(suggestFromHistory([journal(1, { memo: null })], {})).toEqual([]);
    expect(suggestFromHistory([journal(1, { memo: " " })], { memo: "　" })).toEqual([]);
  });

  it("借方・貸方・税区分・取引先の組が同じなら最新だけを返す", () => {
    const old = journal(1);
    const recent = journal(2, { lines: old.lines });
    expect(suggestFromHistory([old, recent], { memo: "abc123" })).toEqual([
      {
        debitAccountId: "expense-1",
        creditAccountId: "cash",
        debitTaxCategory: "OUT_OF_SCOPE",
        creditTaxCategory: "OUT_OF_SCOPE",
        debitPartnerId: null,
        creditPartnerId: null,
        sourceJournalId: recent.id,
        date: recent.date,
      },
    ]);
  });

  it("左右それぞれの税区分・取引先を保持し、片側だけ違う候補も重ねない", () => {
    const first = journal(1);
    lineOf(first, 0).taxCategory = "PURCHASE_10";
    lineOf(first, 1).taxCategory = "SALES_10";
    lineOf(first, 0).partnerId = "debit-partner";
    lineOf(first, 1).partnerId = "credit-partner";
    const second = journal(2, { lines: first.lines.map((l) => ({ ...l })) });
    lineOf(second, 1).taxCategory = "OUT_OF_SCOPE";
    const third = journal(3, { lines: first.lines.map((l) => ({ ...l })) });
    lineOf(third, 1).partnerId = "other-partner";
    const suggestions = suggestFromHistory([first, second, third], { memo: "abc123" });
    expect(suggestions).toHaveLength(3);
    expect(suggestions[2]).toMatchObject({
      debitTaxCategory: "PURCHASE_10",
      creditTaxCategory: "SALES_10",
      debitPartnerId: "debit-partner",
      creditPartnerId: "credit-partner",
    });
    expect(suggestFromHistory([first], { partnerId: "debit-partner" })).toHaveLength(1);
    expect(suggestFromHistory([first], { partnerId: "credit-partner" })).toHaveLength(1);
  });
});
