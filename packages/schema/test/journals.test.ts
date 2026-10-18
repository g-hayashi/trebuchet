import { describe, expect, it } from "vitest";
import { JournalInput, JournalOutput } from "../src/index.ts";

const A = "0190f3a0-0000-7000-8000-000000000001";
const B = "0190f3a0-0000-7000-8000-000000000002";
const T = "0190f3a0-0000-7000-8000-0000000000aa";

const valid = {
  date: "2026-10-31",
  memo: "10月分",
  lines: [
    { side: "debit", accountId: A, amount: 495_000, tagIds: [T] },
    { side: "credit", accountId: B, amount: 495_000, taxCategory: "SALES_10" },
  ],
};

describe("JournalInput", () => {
  it("正しい入力を受け付ける", () => {
    expect(JournalInput.safeParse(valid).success).toBe(true);
  });

  it("行は 2 行以上", () => {
    expect(JournalInput.safeParse({ ...valid, lines: valid.lines.slice(0, 1) }).success).toBe(
      false,
    );
  });

  it("借方・貸方を 1 行以上ずつ要求する", () => {
    const r = JournalInput.safeParse({
      ...valid,
      lines: valid.lines.map((l) => ({ ...l, side: "debit" })),
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toContain("lines");
  });

  it.each([0, -1, 1.5, 1_000_000_000_000])("金額 %s は拒否する（INV-3）", (amount) => {
    const lines = [{ ...valid.lines[0], amount }, valid.lines[1]];
    const r = JournalInput.safeParse({ ...valid, lines });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["lines", 0, "amount"]);
  });

  it("tagIds の重複・存在しない日付・不明な税区分は拒否する", () => {
    const dupTags = [{ ...valid.lines[0], tagIds: [T, T] }, valid.lines[1]];
    expect(JournalInput.safeParse({ ...valid, lines: dupTags }).success).toBe(false);
    expect(JournalInput.safeParse({ ...valid, date: "2026-02-30" }).success).toBe(false);
    const badTax = [valid.lines[0], { ...valid.lines[1], taxCategory: "SALES_5" }];
    expect(JournalInput.safeParse({ ...valid, lines: badTax }).success).toBe(false);
  });
});

describe("JournalOutput", () => {
  it("仕訳の応答の形", () => {
    const output = {
      id: A,
      journalNo: 1,
      date: "2026-10-31",
      memo: null,
      status: "active",
      version: 1,
      correctsJournalId: null,
      lines: [
        {
          id: B,
          lineNo: 1,
          side: "debit",
          accountId: A,
          subAccountId: null,
          amount: 1000,
          taxCategory: "OUT_OF_SCOPE",
          taxAmount: 0,
          partnerId: null,
          description: null,
          tagIds: [],
        },
      ],
    };
    expect(JournalOutput.parse(output)).toEqual(output);
    expect(JournalOutput.safeParse({ ...output, status: "deleted" }).success).toBe(false);
  });
});
