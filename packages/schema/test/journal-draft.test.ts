import { describe, expect, it } from "vitest";
import { JournalDraft } from "../src/journals.ts";

const line = {
  side: "debit",
  accountId: null,
  subAccountId: null,
  amount: null,
  taxCategory: null,
  partnerId: null,
  tagIds: [],
  description: null,
};
const draft = {
  mode: "detailed",
  date: null,
  memo: "",
  partnerId: null,
  tagIds: [],
  lines: [line],
};
describe("JournalDraft（未完成の入力）", () => {
  it("空欄、空行、左右で異なる値をそのまま保持する", () => {
    expect(JournalDraft.parse(draft)).toEqual(draft);
    expect(JournalDraft.safeParse({ ...draft, date: "2026-", lines: [] }).success).toBe(true);
  });
  it("50行・摘要1000文字まで、金額は整数かnull", () => {
    expect(
      JournalDraft.safeParse({ ...draft, memo: "a".repeat(1000), lines: Array(50).fill(line) })
        .success,
    ).toBe(true);
    for (const invalid of [
      { ...draft, memo: "a".repeat(1001) },
      { ...draft, lines: Array(51).fill(line) },
      { ...draft, lines: [{ ...line, amount: 1.5 }] },
      { ...draft, lines: [{ ...line, amount: "1" }] },
    ])
      expect(JournalDraft.safeParse(invalid).success).toBe(false);
  });
});
