import { describe, expect, it } from "vitest";
import { addMonthsToDate } from "../src/dates.ts";
import { blankToNull, compareText } from "../src/text.ts";
import { findPeriodByDate } from "../src/types.ts";

describe("compareText", () => {
  it("コード単位の順に -1・0・1 を返す", () => {
    expect(compareText("a", "b")).toBe(-1);
    expect(compareText("b", "a")).toBe(1);
    expect(compareText("a", "a")).toBe(0);
    expect(compareText("B", "a")).toBe(-1);
    expect(compareText("10", "9")).toBe(-1);
  });
});

describe("blankToNull", () => {
  it("空白だけ・空・未指定は null、それ以外は前後の空白を除く", () => {
    expect(blankToNull(undefined)).toBeNull();
    expect(blankToNull(null)).toBeNull();
    expect(blankToNull("")).toBeNull();
    expect(blankToNull(" \t ")).toBeNull();
    expect(blankToNull("  メモ ")).toBe("メモ");
  });
});

describe("findPeriodByDate", () => {
  const periods = [
    { startDate: "2024-01-01", endDate: "2024-12-31" },
    { startDate: "2025-01-01", endDate: "2025-12-31" },
  ];

  it("開始日・終了日を含む期間を返し、なければ undefined", () => {
    expect(findPeriodByDate(periods, "2024-01-01")).toBe(periods[0]);
    expect(findPeriodByDate(periods, "2025-12-31")).toBe(periods[1]);
    expect(findPeriodByDate(periods, "2023-12-31")).toBeUndefined();
    expect(findPeriodByDate(periods, "2026-01-01")).toBeUndefined();
  });
});

describe("前年の同じ日（addMonthsToDate の -12 か月）", () => {
  it("存在しない日（2/29 → 平年）は月末にする", () => {
    expect(addMonthsToDate("2024-02-29", -12)).toBe("2023-02-28");
    expect(addMonthsToDate("2025-12-31", -12)).toBe("2024-12-31");
    expect(addMonthsToDate("2025-03-01", -12)).toBe("2024-03-01");
  });
});
