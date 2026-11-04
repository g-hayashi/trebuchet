import { describe, expect, it } from "vitest";
import { toCsv } from "../../src/reports/csv.ts";
import { buildJournalBook } from "../../src/reports/journal-book.ts";
import { journal, LINES, type LineSpec } from "../fixtures/sample-year.ts";

describe("仕訳帳（FR-026）", () => {
  it("期間内の仕訳を 日付 → 仕訳番号 の順に、行は行番号の順に並べる", () => {
    const lines = [
      ...journal(5, "2026-01-10", [
        ["debit", "現金", 500],
        ["credit", "売上高", 500],
      ]),
      ...journal(3, "2026-01-20", [
        ["debit", "現金", 300],
        ["credit", "売上高", 300],
      ]),
      ...journal(4, "2026-01-10", [
        ["debit", "現金", 400],
        ["credit", "売上高", 400],
      ]).reverse(),
      ...journal(6, "2026-02-01", [
        ["debit", "現金", 600],
        ["credit", "売上高", 600],
      ]),
    ];
    const book = buildJournalBook({ lines, from: "2026-01-01", to: "2026-01-31" });
    expect(book.entries.map((e) => [e.date, e.journalNo])).toEqual([
      ["2026-01-10", 4],
      ["2026-01-10", 5],
      ["2026-01-20", 3],
    ]);
    expect(book.entries[0]?.lines.map((l) => [l.lineNo, l.side, l.accountName])).toEqual([
      [1, "debit", "現金"],
      [2, "credit", "売上高"],
    ]);
    expect(book.totals).toEqual({ debit: 1_200, credit: 1_200 });
  });

  it("US4-5: 取消済みの仕訳は含まない", () => {
    const book = buildJournalBook({ lines: LINES, from: "2026-09-01", to: "2026-09-30" });
    expect(book.entries.map((e) => e.journalNo)).toEqual([30]);
    expect(book.totals).toEqual({ debit: 1_200, credit: 1_200 });
  });

  it("仕訳のメモと、行の補助科目・取引先・摘要・税区分を含める", () => {
    const lines = journal(
      1,
      "2026-01-10",
      [
        ["debit", "普通預金", 1_100],
        ["credit", "売上高", 1_100],
      ],
      { memo: "1月分" },
    ).map((l) =>
      l.side === "debit"
        ? { ...l, subAccountId: "sub-1", subAccountName: "A銀行", description: "入金" }
        : {
            ...l,
            partnerId: "partner-1",
            partnerName: "取引先A",
            taxCategory: "SALES_10" as const,
            taxAmount: 100,
          },
    );
    const book = buildJournalBook({ lines, from: "2026-01-01", to: "2026-12-31" });
    expect(book.entries[0]).toMatchObject({ journalId: "journal-1", memo: "1月分" });
    expect(book.entries[0]?.lines).toEqual([
      expect.objectContaining({ subAccountName: "A銀行", description: "入金" }),
      expect.objectContaining({ partnerName: "取引先A", taxCategory: "SALES_10", taxAmount: 100 }),
    ]);
  });
});

describe("仕訳帳の並び（FR-038）", () => {
  const pair = (amount: number): LineSpec[] => [
    ["debit", "現金", amount],
    ["credit", "売上高", amount],
  ];
  // 仕訳番号 → [日付, 登録日時]。2 と 3・4 は同じ日付、3 と 4 は同じ登録日時
  const lines = [
    ...journal(1, "2026-01-20", pair(100), { createdAt: "2026-02-01T01:00:00.000Z" }),
    ...journal(2, "2026-01-10", pair(200), { createdAt: "2026-02-01T03:00:00.000Z" }),
    ...journal(3, "2026-01-10", pair(300), { createdAt: "2026-02-01T02:00:00.000Z" }),
    ...journal(4, "2026-01-10", pair(400), { createdAt: "2026-02-01T02:00:00.000Z" }).reverse(),
  ];
  const nos = (sort?: "date" | "created", order?: "asc" | "desc") =>
    buildJournalBook({
      lines,
      from: "2026-01-01",
      to: "2026-01-31",
      ...(sort === undefined ? {} : { sort }),
      ...(order === undefined ? {} : { order }),
    }).entries.map((e) => e.journalNo);

  it("既定は取引日の昇順（日付 → 仕訳番号）", () => {
    expect(nos()).toEqual([2, 3, 4, 1]);
  });

  it("取引日 × 昇順・降順、登録日 × 昇順・降順の 4 通り（同じ値は仕訳番号の順）", () => {
    expect(nos("date", "asc")).toEqual([2, 3, 4, 1]);
    expect(nos("date", "desc")).toEqual([1, 4, 3, 2]);
    expect(nos("created", "asc")).toEqual([1, 3, 4, 2]);
    expect(nos("created", "desc")).toEqual([2, 4, 3, 1]);
  });

  it("行は仕訳の中で、降順でも常に行番号の順", () => {
    for (const order of ["asc", "desc"] as const) {
      const book = buildJournalBook({
        lines,
        from: "2026-01-01",
        to: "2026-01-31",
        sort: "created",
        order,
      });
      for (const e of book.entries) expect(e.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    }
  });

  it("CSV も同じ並び", () => {
    const book = buildJournalBook({
      lines,
      from: "2026-01-01",
      to: "2026-01-31",
      sort: "created",
      order: "desc",
    });
    const rows = toCsv(book).split("\r\n").slice(1);
    const order = rows.map((r) => r.split(",")[1]).filter((n) => n !== undefined && n !== "");
    expect(order.filter((n, i) => order.indexOf(n) === i)).toEqual(["2", "4", "3", "1"]);
  });
});
