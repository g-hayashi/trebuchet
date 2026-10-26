import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays, previousDay, previousMonth, thisMonth, thisYear, today } from "./dates";

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
