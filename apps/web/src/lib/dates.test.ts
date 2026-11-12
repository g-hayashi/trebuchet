import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  presetRange,
  previousDay,
  previousMonth,
  thisMonth,
  thisYear,
  today,
} from "./dates";

describe("today / thisMonth / thisYear", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ローカル時刻の日付・月・年", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 10, 0, 0));
    expect(today()).toBe("2026-01-05");
    expect(thisMonth()).toBe("2026-01");
    expect(thisYear()).toBe(2026);
  });
});

describe("previousDay", () => {
  it("前日を返す（月・年またぎ、うるう日）", () => {
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2024-03-01")).toBe("2024-02-29");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
  });
});

describe("addDays", () => {
  it("日数を足す・引く（月・年またぎ、うるう日）", () => {
    expect(addDays("2026-05-10", 7)).toBe("2026-05-17");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
    expect(addDays("2025-12-30", 3)).toBe("2026-01-02");
  });
});

describe("previousMonth", () => {
  it("前の月を返す（1 月は前年の 12 月）", () => {
    expect(previousMonth("2026-10")).toBe("2026-09");
    expect(previousMonth("2026-01")).toBe("2025-12");
  });
});

describe("presetRange（011/FR-040）", () => {
  it("今月・先月は暦の月の初日〜末日（2 月、うるう年、1 月の先月は前年 12 月）", () => {
    expect(presetRange("this-month", "2026-11-04")).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(presetRange("this-month", "2024-02-10")).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
    expect(presetRange("last-month", "2026-03-31")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(presetRange("last-month", "2026-01-15")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  it("今四半期は暦の 1〜3・4〜6・7〜9・10〜12 月", () => {
    expect(presetRange("this-quarter", "2026-01-01")).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(presetRange("this-quarter", "2026-06-30")).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
    });
    expect(presetRange("this-quarter", "2026-09-15")).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
    });
    expect(presetRange("this-quarter", "2026-12-31")).toEqual({
      from: "2026-10-01",
      to: "2026-12-31",
    });
  });

  it("今年・昨年は暦の年", () => {
    expect(presetRange("this-year", "2026-11-04")).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(presetRange("last-year", "2026-11-04")).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("日付を渡さなければ今日（ローカル時刻）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 5, 10, 0, 0));
    expect(presetRange("this-month")).toEqual({ from: "2026-05-01", to: "2026-05-31" });
    vi.useRealTimers();
  });
});
