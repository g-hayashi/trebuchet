import { describe, expect, it } from "vitest";
import {
  HistoryEntry,
  JournalCorrection,
  JournalInput,
  JournalOutput,
  JournalQuery,
  ReopenInput,
  VoidInput,
} from "../src/index.ts";

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

describe("JournalCorrection・VoidInput・ReopenInput（US3）", () => {
  it("訂正は JournalInput に reason と version を加えたもの", () => {
    expect(
      JournalCorrection.safeParse({ ...valid, reason: "金額の誤り", version: 1 }).success,
    ).toBe(true);
    expect(JournalCorrection.safeParse({ ...valid, reason: "金額の誤り" }).success).toBe(false);
    expect(JournalCorrection.safeParse({ ...valid, version: 1 }).success).toBe(false);
    expect(
      JournalCorrection.safeParse({ ...valid, reason: "x", version: 0 }).success,
      "version は 1 以上",
    ).toBe(false);
    const debitOnly = valid.lines.map((l) => ({ ...l, side: "debit" }));
    expect(
      JournalCorrection.safeParse({ ...valid, lines: debitOnly, reason: "x", version: 1 }).success,
    ).toBe(false);
  });

  it("reason の空欄・空白のみ・長さは Zod では拒否しない（ドメインで REASON_REQUIRED にする）", () => {
    for (const reason of ["", "   ", "あ".repeat(501)]) {
      expect(JournalCorrection.safeParse({ ...valid, reason, version: 1 }).success).toBe(true);
      expect(VoidInput.safeParse({ reason, version: 1 }).success).toBe(true);
      expect(ReopenInput.safeParse({ reason }).success).toBe(true);
    }
    expect(VoidInput.safeParse({ version: 1 }).success).toBe(false);
    expect(VoidInput.safeParse({ reason: 1, version: 1 }).success).toBe(false);
    expect(ReopenInput.safeParse({}).success).toBe(false);
  });
});

describe("JournalQuery（US3）", () => {
  it("すべて省略できる。includeVoided は false、limit は 50 が既定", () => {
    expect(JournalQuery.parse({})).toEqual({ includeVoided: false, limit: 50 });
  });

  it("クエリ文字列（API）の値を型に変換する", () => {
    expect(
      JournalQuery.parse({
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
        amountMin: "1000",
        amountMax: "500000",
        partnerId: A,
        accountId: B,
        q: "家賃",
        tagId: T,
        includeVoided: "true",
        cursor: "2026-10-31_12",
        limit: "20",
      }),
    ).toEqual({
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      amountMin: 1000,
      amountMax: 500_000,
      partnerId: A,
      accountId: B,
      q: "家賃",
      tagId: T,
      includeVoided: true,
      cursor: "2026-10-31_12",
      limit: 20,
    });
    expect(JournalQuery.parse({ includeVoided: "false" }).includeVoided).toBe(false);
  });

  it("URL の検索パラメータ（JSON として解釈された値）も受け付ける", () => {
    expect(JournalQuery.parse({ amountMin: 1000, includeVoided: true, q: 123, limit: 10 })).toEqual(
      { amountMin: 1000, includeVoided: true, q: "123", limit: 10 },
    );
  });

  it.each([
    { dateFrom: "2026-02-30" },
    { amountMin: "-1" },
    { amountMax: "1.5" },
    { amountMin: "abc" },
    { partnerId: "x" },
    { includeVoided: "yes" },
    { limit: "0" },
    { limit: "201" },
    { cursor: "12" },
  ])("不正な値 %o は拒否する", (query) => {
    expect(JournalQuery.safeParse(query).success).toBe(false);
  });
});

describe("HistoryEntry（US3）", () => {
  it("変更前後の仕訳・日時・操作・理由", () => {
    const entry = {
      occurredAt: "2026-10-31T09:00:00.000Z",
      action: "correct",
      reason: "金額の誤り",
      before: null,
      after: null,
    };
    expect(HistoryEntry.parse(entry)).toEqual(entry);
    expect(HistoryEntry.safeParse({ ...entry, action: "delete" }).success).toBe(false);
  });
});
