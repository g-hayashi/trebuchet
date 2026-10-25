import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clampDay, daysInMonth } from "../../src/dates.ts";
import { dueDate } from "../../src/invoicing/due-date.ts";

// INV-36（data-model §4、R8）

const yearArb = fc.integer({ min: 1990, max: 2100 });
const monthArb = fc.integer({ min: 1, max: 12 });
/** 1〜28 または 31（末日） */
const dayArb = fc.oneof(fc.integer({ min: 1, max: 28 }), fc.constant(31));
const monthsAfterArb = fc.integer({ min: 0, max: 12 });

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const ym = (y: number, m: number) => `${pad(y, 4)}-${pad(m)}`;

describe("clampDay (INV-36)", () => {
  it("常にその月の 1 日〜末日の整数", () => {
    fc.assert(
      fc.property(yearArb, monthArb, dayArb, (y, m, d) => {
        const r = clampDay(y, m, d);
        expect(Number.isInteger(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(daysInMonth(y, m));
      }),
    );
  });

  it("d が末日以下ならそのまま、超えたら末日", () => {
    fc.assert(
      fc.property(yearArb, monthArb, dayArb, (y, m, d) => {
        const last = daysInMonth(y, m);
        expect(clampDay(y, m, d)).toBe(d <= last ? d : last);
      }),
    );
  });

  it("31（末日）は常に末日", () => {
    fc.assert(
      fc.property(yearArb, monthArb, (y, m) => {
        expect(clampDay(y, m, 31)).toBe(daysInMonth(y, m));
      }),
    );
  });

  it("うるう年の 2 月", () => {
    expect(clampDay(2024, 2, 31)).toBe(29);
    expect(clampDay(2024, 2, 28)).toBe(28);
    expect(clampDay(2025, 2, 31)).toBe(28);
    expect(clampDay(2100, 2, 31)).toBe(28); // 100 で割れ 400 で割れない
    expect(clampDay(2000, 2, 31)).toBe(29); // 400 で割れる
  });
});

describe("dueDate (INV-36)", () => {
  it("n か月後の月にあり、d >= 末日 なら末日、そうでなければ d", () => {
    fc.assert(
      fc.property(yearArb, monthArb, monthsAfterArb, dayArb, (y, m, n, d) => {
        const result = dueDate(ym(y, m), n, d);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const total = y * 12 + (m - 1) + n;
        const ty = Math.floor(total / 12);
        const tm = (total % 12) + 1;
        expect(result.slice(0, 7)).toBe(ym(ty, tm));
        const last = daysInMonth(ty, tm);
        const day = Number(result.slice(8, 10));
        expect(day).toBe(d >= last ? last : d);
      }),
    );
  });

  it("12 月分 + 1 か月 = 翌年 1 月", () => {
    expect(dueDate("2026-12", 1, 31)).toBe("2027-01-31");
    expect(dueDate("2026-12", 1, 10)).toBe("2027-01-10");
    expect(dueDate("2026-11", 3, 31)).toBe("2027-02-28");
  });

  it("0 か月後は同じ月", () => {
    expect(dueDate("2026-11", 0, 15)).toBe("2026-11-15");
  });

  it("うるう年の 2 月末", () => {
    expect(dueDate("2024-01", 1, 31)).toBe("2024-02-29");
    expect(dueDate("2025-01", 1, 31)).toBe("2025-02-28");
    expect(dueDate("2024-01", 1, 28)).toBe("2024-02-28");
  });
});
