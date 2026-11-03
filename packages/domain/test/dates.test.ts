import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  addDays,
  addMonths,
  addMonthsToDate,
  dateInMonth,
  daysBetween,
  daysInMonth,
  isValidDate,
  monthAtIndex,
  monthEnd,
  monthIndex,
  monthOfDate,
} from "../src/dates.ts";

// R8、INV-35 の予定日、US3 Acceptance 1・3

describe("daysBetween（006 R6・R7 の日付の差）", () => {
  it("後の日付から前の日付を引いた日数（月・年をまたいでもよい）", () => {
    expect(daysBetween("2026-05-10", "2026-05-17")).toBe(7);
    expect(daysBetween("2026-05-17", "2026-05-10")).toBe(-7);
    expect(daysBetween("2026-02-27", "2026-03-02")).toBe(3);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2026-05-10", "2026-05-10")).toBe(0);
  });

  it("addDays の逆（性質）", () => {
    fc.assert(
      fc.property(fc.integer({ min: -4000, max: 4000 }), (n) => {
        expect(daysBetween("2026-06-15", addDays("2026-06-15", n))).toBe(n);
      }),
    );
  });
});

describe("dateInMonth", () => {
  it("その月の指定の日（Acceptance 1）", () => {
    expect(dateInMonth("2026-10", 25)).toBe("2026-10-25");
    expect(dateInMonth("2026-08", 1)).toBe("2026-08-01");
    expect(dateInMonth("2026-12", 28)).toBe("2026-12-28");
  });

  it("末日（31）は月の末日になる（Acceptance 3）", () => {
    expect(dateInMonth("2026-01", 31)).toBe("2026-01-31");
    expect(dateInMonth("2026-02", 31)).toBe("2026-02-28");
    expect(dateInMonth("2026-04", 31)).toBe("2026-04-30");
    expect(dateInMonth("2026-11", 31)).toBe("2026-11-30");
  });

  it("うるう年の 2 月末は 29 日、平年は 28 日", () => {
    expect(dateInMonth("2024-02", 31)).toBe("2024-02-29");
    expect(dateInMonth("2025-02", 31)).toBe("2025-02-28");
    expect(dateInMonth("2100-02", 31)).toBe("2100-02-28");
    expect(dateInMonth("2000-02", 31)).toBe("2000-02-29");
  });

  it("28 日は 2 月でもそのまま", () => {
    expect(dateInMonth("2026-02", 28)).toBe("2026-02-28");
  });

  it("不正な月は RangeError", () => {
    expect(() => dateInMonth("2026-13", 1)).toThrow(RangeError);
    expect(() => dateInMonth("202610", 1)).toThrow(RangeError);
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
          const date = dateInMonth(month, d);
          expect(date.slice(0, 7)).toBe(month);
          const day = Number(date.slice(8, 10));
          expect(day).toBe(Math.min(d, daysInMonth(y, m)));
        },
      ),
    );
  });
});

describe("月の計算", () => {
  it("monthEnd は月の末日", () => {
    expect(monthEnd("2026-10")).toBe("2026-10-31");
    expect(monthEnd("2024-02")).toBe("2024-02-29");
    expect(monthEnd("2025-02")).toBe("2025-02-28");
    expect(() => monthEnd("2026-00")).toThrow(RangeError);
  });

  it("monthIndex と monthAtIndex は逆", () => {
    expect(monthAtIndex(monthIndex("2026-12"))).toBe("2026-12");
    expect(monthIndex("2027-01") - monthIndex("2026-12")).toBe(1);
  });

  it("addMonths は年をまたぐ", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-11", 0)).toBe("2026-11");
  });

  it("monthOfDate は日付の月", () => {
    expect(monthOfDate("2026-10-25")).toBe("2026-10");
  });
});

// 010-receipts R2: 入力期間の判定に使う日付の計算（スキャナ一問一答 問23）

describe("addMonthsToDate（010/R2）", () => {
  it("日付に月を足す（問23: 4/21 の 2 か月後の前日は 6/20）", () => {
    expect(addMonthsToDate("2026-04-21", 2)).toBe("2026-06-21");
    expect(addDays(addMonthsToDate("2026-04-21", 2), -1)).toBe("2026-06-20");
  });

  it("年をまたぐ（月を足す・引く）", () => {
    expect(addMonthsToDate("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonthsToDate("2026-01-15", -2)).toBe("2025-11-15");
    expect(addMonthsToDate("2026-12-31", 12)).toBe("2027-12-31");
    expect(addMonthsToDate("2026-06-10", 0)).toBe("2026-06-10");
  });

  it("日は月末に丸める（うるう年を含む）", () => {
    expect(addMonthsToDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDate("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonthsToDate("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonthsToDate("2026-08-31", 1)).toBe("2026-09-30");
    expect(addMonthsToDate("2024-02-29", 12)).toBe("2025-02-28");
  });

  it("結果は実在する日付で、月の差は足した月数（性質）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: -60, max: 60 }),
        (y, m, d, n) => {
          const date = dateInMonth(
            `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`,
            d,
          );
          const result = addMonthsToDate(date, n);
          expect(isValidDate(result)).toBe(true);
          expect(monthIndex(monthOfDate(result)) - monthIndex(monthOfDate(date))).toBe(n);
          expect(Number(result.slice(8, 10))).toBeLessThanOrEqual(Number(date.slice(8, 10)));
        },
      ),
    );
  });
});

describe("addBusinessDays（010/R2）", () => {
  // 2026-11-02 は月曜、2026-11-06 は金曜、2026-11-07 は土曜、2026-11-08 は日曜
  it("土日を除いて営業日を数える", () => {
    expect(addBusinessDays("2026-11-02", 1)).toBe("2026-11-03");
    expect(addBusinessDays("2026-11-02", 4)).toBe("2026-11-06");
    expect(addBusinessDays("2026-11-02", 5)).toBe("2026-11-09");
    expect(addBusinessDays("2026-11-06", 1)).toBe("2026-11-09");
    expect(addBusinessDays("2026-11-06", 7)).toBe("2026-11-17");
  });

  it("土日から数えるときは次の月曜が 1 営業日目", () => {
    expect(addBusinessDays("2026-11-07", 1)).toBe("2026-11-09");
    expect(addBusinessDays("2026-11-08", 1)).toBe("2026-11-09");
    expect(addBusinessDays("2026-11-07", 2)).toBe("2026-11-10");
  });

  it("0 営業日は日付のまま（土日でも動かさない）", () => {
    expect(addBusinessDays("2026-11-02", 0)).toBe("2026-11-02");
    expect(addBusinessDays("2026-11-07", 0)).toBe("2026-11-07");
  });

  it("負の営業日は逆に数える", () => {
    expect(addBusinessDays("2026-11-02", -1)).toBe("2026-10-30");
    expect(addBusinessDays("2026-11-07", -1)).toBe("2026-11-06");
    expect(addBusinessDays("2026-11-09", -5)).toBe("2026-11-02");
  });

  it("問23 の期限: 6/20（土）から 7 営業日後は 6/30", () => {
    expect(addBusinessDays("2026-06-20", 7)).toBe("2026-06-30");
  });

  it("1 営業日以上を足した結果は平日で、逆に引くと元の日付以前の最後の平日に戻る（性質）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 1, max: 40 }),
        (offset, n) => {
          const date = addDays("2026-01-01", offset);
          const result = addBusinessDays(date, n);
          const dow = new Date(`${result}T00:00:00Z`).getUTCDay();
          expect(dow === 0 || dow === 6).toBe(false);
          // 日数は n 以上（土日をはさむ分だけ長い）
          expect(daysBetween(date, result)).toBeGreaterThanOrEqual(n);
          // n 営業日のあいだに平日はちょうど n 日ある
          let weekdays = 0;
          for (let d = addDays(date, 1); d <= result; d = addDays(d, 1)) {
            const w = new Date(`${d}T00:00:00Z`).getUTCDay();
            if (w !== 0 && w !== 6) weekdays++;
          }
          expect(weekdays).toBe(n);
        },
      ),
    );
  });
});
