import { describe, expect, it } from "vitest";
import { JournalAiSuggestionInput, JournalAiSuggestionResult } from "../src/index.ts";

// 011 T043（contracts §1 POST /journals/ai-suggestion）。入力は { date, amount, memo }。
// 金額は整数 0 < amount < 1e12、摘要は空でない

const valid = { date: "2026-05-10", amount: 3300, memo: "コピー用紙" };

describe("JournalAiSuggestionInput", () => {
  it("date・amount・memo を受ける。摘要の前後の空白は取る", () => {
    expect(JournalAiSuggestionInput.parse({ ...valid, memo: "  コピー用紙 " })).toEqual(valid);
  });

  it.each([
    ["金額が 0", { amount: 0 }],
    ["金額が負", { amount: -1 }],
    ["金額が小数", { amount: 10.5 }],
    ["金額が 1 兆以上", { amount: 1_000_000_000_000 }],
    ["摘要が空", { memo: "" }],
    ["摘要が空白だけ", { memo: "  　" }],
    ["摘要がない", { memo: undefined }],
    ["日付が実在しない", { date: "2026-02-30" }],
    ["日付がない", { date: undefined }],
  ])("拒む: %s", (_name, over) => {
    expect(JournalAiSuggestionInput.safeParse({ ...valid, ...over }).success).toBe(false);
  });

  it("金額の上限は 1 兆円未満（999,999,999,999 は通る）", () => {
    expect(JournalAiSuggestionInput.safeParse({ ...valid, amount: 999_999_999_999 }).success).toBe(
      true,
    );
  });
});

describe("JournalAiSuggestionResult", () => {
  const suggestion = {
    accountCode: "5120",
    taxCategory: "PURCHASE_10",
    purpose: "business",
    confidence: 90,
    reason: "通信費",
  };

  it("候補あり・なし（理由つき）を受ける", () => {
    expect(JournalAiSuggestionResult.safeParse({ suggestion }).success).toBe(true);
    expect(
      JournalAiSuggestionResult.safeParse({ suggestion: null, reason: "候補がありません" }).success,
    ).toBe(true);
    expect(JournalAiSuggestionResult.safeParse({ suggestion: null }).success).toBe(true);
  });

  it("候補の形が AiSuggestion でなければ拒む", () => {
    expect(
      JournalAiSuggestionResult.safeParse({ suggestion: { ...suggestion, taxCategory: "X" } })
        .success,
    ).toBe(false);
  });
});
