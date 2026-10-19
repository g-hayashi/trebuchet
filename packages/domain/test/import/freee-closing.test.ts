import { describe, expect, it } from "vitest";
import { isPriorYearClosing } from "../../src/import/freee/closing.ts";
import { groupFreeeJournals, readFreeeFile } from "../../src/import/freee/read.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import { EXPECTED_JOURNAL, FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { readFixture } from "../fixtures/freee/load.ts";

const periods = [makeFiscalPeriod(2024), makeFiscalPeriod(2025)];

describe("isPriorYearClosing（research R5）", () => {
  it("決算整理仕訳 = 1 かつ 日付が会計期間の開始日のときだけ true", () => {
    expect(isPriorYearClosing({ date: "2025-01-01", adjustment: true }, periods)).toBe(true);
    expect(isPriorYearClosing({ date: "2024-01-01", adjustment: true }, periods)).toBe(true);
  });

  it("12-31 付の減価償却（決算整理仕訳 = 1）は false", () => {
    expect(isPriorYearClosing({ date: "2025-12-31", adjustment: true }, periods)).toBe(false);
  });

  it("開始日付でも決算整理仕訳 = 0 なら false", () => {
    expect(isPriorYearClosing({ date: "2025-01-01", adjustment: false }, periods)).toBe(false);
  });

  it("会計期間がない年の 01-01 は false", () => {
    expect(isPriorYearClosing({ date: "2026-01-01", adjustment: true }, periods)).toBe(false);
  });

  it("期首月が 1 月でない会計期間でも、その開始日で判定する", () => {
    const april = [makeFiscalPeriod(2025, { startDate: "2025-04-01", endDate: "2026-03-31" })];
    expect(isPriorYearClosing({ date: "2025-04-01", adjustment: true }, april)).toBe(true);
    expect(isPriorYearClosing({ date: "2025-01-01", adjustment: true }, april)).toBe(false);
  });

  it("フィクスチャでは 2025-01-01 の決算振替だけが true", () => {
    const file = readFreeeFile(readFixture(FIXTURE_FILES.journal));
    if (!file.ok) throw new Error(JSON.stringify(file.error));
    const { journals } = groupFreeeJournals(file.value);
    expect(
      journals.filter((j) => isPriorYearClosing(j, periods)).map((j) => j.freeeJournalId),
    ).toEqual(EXPECTED_JOURNAL.priorYearClosingIds);
  });
});
