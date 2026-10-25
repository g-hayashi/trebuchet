import { describe, expect, it } from "vitest";
import {
  AcknowledgeInput,
  RecurringInput,
  RecurringUpdate,
  ResumeInput,
  SkipRunInput,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";
const ID2 = "0190f3a0-0000-7000-8000-000000000002";

const lines = [
  { side: "debit", accountId: ID, amount: 30000 },
  { side: "credit", accountId: ID2, amount: 30000 },
];
const ok = { name: "家賃", dayOfMonth: 25, startMonth: "2026-04", lines };

describe("RecurringInput", () => {
  it("最小の入力が通る。摘要・終了月・confirm は任意", () => {
    expect(RecurringInput.safeParse(ok).success).toBe(true);
    expect(
      RecurringInput.safeParse({ ...ok, memo: "事務所", endMonth: "2027-03", confirm: true })
        .success,
    ).toBe(true);
  });
  it("dayOfMonth は 1〜28 または 31。29・30 は拒否（R8）", () => {
    const check = (dayOfMonth: number) => RecurringInput.safeParse({ ...ok, dayOfMonth }).success;
    expect([check(1), check(28), check(31)]).toEqual([true, true, true]);
    expect([check(0), check(29), check(30), check(32), check(1.5)]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
  it("月は YYYY-MM。endMonth は startMonth 以降", () => {
    expect(RecurringInput.safeParse({ ...ok, startMonth: "2026-13" }).success).toBe(false);
    expect(RecurringInput.safeParse({ ...ok, startMonth: "2026-4" }).success).toBe(false);
    expect(RecurringInput.safeParse({ ...ok, endMonth: "2026-04" }).success).toBe(true);
    expect(RecurringInput.safeParse({ ...ok, endMonth: "2026-03" }).success).toBe(false);
  });
  it("name は空でない", () => {
    expect(RecurringInput.safeParse({ ...ok, name: "" }).success).toBe(false);
  });
  it("行は 2 行以上。金額は正の整数", () => {
    expect(RecurringInput.safeParse({ ...ok, lines: [lines[0]] }).success).toBe(false);
    expect(
      RecurringInput.safeParse({
        ...ok,
        lines: [{ ...lines[0], amount: 0 }, lines[1]],
      }).success,
    ).toBe(false);
  });
  it("税区分・取引先・摘要は行ごとに任意", () => {
    expect(
      RecurringInput.safeParse({
        ...ok,
        lines: [
          { ...lines[0], taxCategory: "PURCHASE_10", partnerId: ID2, description: "家賃" },
          lines[1],
        ],
      }).success,
    ).toBe(true);
  });
});

describe("RecurringUpdate", () => {
  it("version が必須。confirm は任意", () => {
    expect(RecurringUpdate.safeParse({ ...ok, version: 1 }).success).toBe(true);
    expect(RecurringUpdate.safeParse({ ...ok, version: 2, confirm: true }).success).toBe(true);
    expect(RecurringUpdate.safeParse(ok).success).toBe(false);
    expect(RecurringUpdate.safeParse({ ...ok, version: 0 }).success).toBe(false);
  });
  it("dayOfMonth の境界は RecurringInput と同じ", () => {
    expect(RecurringUpdate.safeParse({ ...ok, version: 1, dayOfMonth: 30 }).success).toBe(false);
    expect(RecurringUpdate.safeParse({ ...ok, version: 1, dayOfMonth: 31 }).success).toBe(true);
  });
});

describe("ResumeInput", () => {
  it("version が必須。fromMonth・confirm は任意", () => {
    expect(ResumeInput.safeParse({ version: 1 }).success).toBe(true);
    expect(ResumeInput.safeParse({ version: 1, fromMonth: "2026-10", confirm: true }).success).toBe(
      true,
    );
    expect(ResumeInput.safeParse({}).success).toBe(false);
    expect(ResumeInput.safeParse({ version: 1, fromMonth: "2026-13" }).success).toBe(false);
  });
});

describe("SkipRunInput", () => {
  it("reason が必須", () => {
    expect(SkipRunInput.safeParse({ reason: "今月は不要" }).success).toBe(true);
    expect(SkipRunInput.safeParse({}).success).toBe(false);
  });
});

describe("AcknowledgeInput", () => {
  it("runIds は UUID の配列で 1 件以上", () => {
    expect(AcknowledgeInput.safeParse({ runIds: [ID, ID2] }).success).toBe(true);
    expect(AcknowledgeInput.safeParse({ runIds: [] }).success).toBe(false);
    expect(AcknowledgeInput.safeParse({ runIds: ["x"] }).success).toBe(false);
  });
});
