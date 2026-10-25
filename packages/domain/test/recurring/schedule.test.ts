import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { daysInMonth } from "../../src/invoicing/due-date.ts";
import { scheduledDate } from "../../src/recurring/schedule.ts";

// R8、INV-35 の予定日、US3 Acceptance 1・3

describe("scheduledDate", () => {
  it("その月の指定の日（Acceptance 1）", () => {
    expect(scheduledDate("2026-10", 25)).toBe("2026-10-25");
    expect(scheduledDate("2026-08", 1)).toBe("2026-08-01");
    expect(scheduledDate("2026-12", 28)).toBe("2026-12-28");
  });

  it("末日（31）は月の末日になる（Acceptance 3）", () => {
    expect(scheduledDate("2026-01", 31)).toBe("2026-01-31");
    expect(scheduledDate("2026-02", 31)).toBe("2026-02-28");
    expect(scheduledDate("2026-04", 31)).toBe("2026-04-30");
    expect(scheduledDate("2026-11", 31)).toBe("2026-11-30");
  });

  it("うるう年の 2 月末は 29 日、平年は 28 日", () => {
    expect(scheduledDate("2024-02", 31)).toBe("2024-02-29");
    expect(scheduledDate("2025-02", 31)).toBe("2025-02-28");
    expect(scheduledDate("2100-02", 31)).toBe("2100-02-28");
    expect(scheduledDate("2000-02", 31)).toBe("2000-02-29");
  });

  it("28 日は 2 月でもそのまま", () => {
    expect(scheduledDate("2026-02", 28)).toBe("2026-02-28");
  });

  it("不正な月は RangeError", () => {
    expect(() => scheduledDate("2026-13", 1)).toThrow(RangeError);
    expect(() => scheduledDate("202610", 1)).toThrow(RangeError);
  });

  it("任意の月・日で、その月の 1 日〜末日の日付になる", () => {
    const dayArb = fc.oneof(fc.integer({ min: 1, max: 28 }), fc.constant(31));
    fc.assert(
      fc.property(
        fc.integer({ min: 1990, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        dayArb,
        (y, m, d) => {
          const month = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
          const date = scheduledDate(month, d);
          expect(date.slice(0, 7)).toBe(month);
          const day = Number(date.slice(8, 10));
          expect(day).toBe(Math.min(d, daysInMonth(y, m)));
        },
      ),
    );
  });
});
