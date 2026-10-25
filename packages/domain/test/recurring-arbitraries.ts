import type { Recurring } from "@trebuchet/schema";
import fc from "fast-check";

/**
 * 定期仕訳（005 US3）の性質テストのジェネレーター: 定義・今日・登録済みの月・起動の日の列・操作の列。
 * 会計期間は 2025・2026 年度（`setupInvoicing` の準備）。開始月・今日は期間の外にも出る（OUT_OF_PERIOD の確認）
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM` を作る */
const monthOf = (year: number, month: number) => `${year}-${pad(month)}`;

/** 月の通し番号（年 × 12 + 月 - 1）を `YYYY-MM` にする */
export const monthFromIndex = (index: number) => monthOf(Math.floor(index / 12), (index % 12) + 1);
export const indexOfMonth = (month: string) =>
  Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

/** 1〜28 または 31（末日） */
const arbDay = fc.oneof(fc.integer({ min: 1, max: 28 }), fc.constant(31));

/** 2024-10 〜 2027-03 の月 */
const arbMonth = fc
  .integer({ min: indexOfMonth("2024-10"), max: indexOfMonth("2027-03") })
  .map(monthFromIndex);

/** 2025-01-01 〜 2026-12-31 の今日 */
export const arbToday = fc
  .tuple(
    fc.integer({ min: 2025, max: 2026 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => `${y}-${pad(m)}-${pad(d)}`);

/** 定義の元（行は借方・貸方 1 行ずつ。取引先の有無と、使用停止の取引先を使うか） */
export type DefSpec = {
  dayOfMonth: number;
  startMonth: string;
  /** 開始月からの月数。null なら終了月なし */
  endAfter: number | null;
  status: "active" | "paused";
  amount: number;
  partner: "none" | "active" | "inactive";
};

export const arbDefSpec: fc.Arbitrary<DefSpec> = fc.record({
  dayOfMonth: arbDay,
  startMonth: arbMonth,
  endAfter: fc.option(fc.integer({ min: 0, max: 18 }), { nil: null }),
  status: fc.constantFrom("active" as const, "paused" as const),
  amount: fc.integer({ min: 1, max: 900_000_000 }),
  partner: fc.constantFrom("none" as const, "active" as const, "inactive" as const),
});

/** 操作の列で作る定義: 期間の中の開始月・使用中の取引先（登録の経路を通りやすくする） */
const arbLiveDefSpec: fc.Arbitrary<DefSpec> = fc.record({
  dayOfMonth: arbDay,
  startMonth: fc
    .integer({ min: indexOfMonth("2025-01"), max: indexOfMonth("2026-09") })
    .map(monthFromIndex),
  endAfter: fc.option(fc.integer({ min: 0, max: 18 }), { nil: null }),
  status: fc.constant("active" as const),
  amount: fc.integer({ min: 1, max: 900_000_000 }),
  partner: fc.constantFrom("none" as const, "active" as const),
});

export type DefParts = {
  debitAccountId: string;
  creditAccountId: string;
  activePartnerId: string;
  inactivePartnerId: string;
};

/** 定義の元から定義を作る（`id` は呼び出し側が決める） */
export function toRecurring(spec: DefSpec, parts: DefParts, id: string, now: string): Recurring {
  const partnerId =
    spec.partner === "none"
      ? null
      : spec.partner === "active"
        ? parts.activePartnerId
        : parts.inactivePartnerId;
  return {
    id,
    name: `定期仕訳 ${id}`,
    memo: "定期",
    dayOfMonth: spec.dayOfMonth,
    startMonth: spec.startMonth,
    endMonth:
      spec.endAfter === null ? null : monthFromIndex(indexOfMonth(spec.startMonth) + spec.endAfter),
    status: spec.status,
    version: 1,
    lines: [
      {
        lineNo: 1,
        side: "debit",
        accountId: parts.debitAccountId,
        subAccountId: null,
        amount: spec.amount,
        taxCategory: null,
        partnerId,
        description: null,
      },
      {
        lineNo: 2,
        side: "credit",
        accountId: parts.creditAccountId,
        subAccountId: null,
        amount: spec.amount,
        taxCategory: null,
        partnerId: null,
        description: null,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

/** 判定の文脈の変種: 締めた年度、使用停止の科目 */
export type CtxSpec = {
  closed2025: boolean;
  closed2026: boolean;
  debitInactive: boolean;
};

export const arbCtxSpec: fc.Arbitrary<CtxSpec> = fc.record({
  closed2025: fc.boolean(),
  closed2026: fc.boolean(),
  debitInactive: fc.boolean(),
});

/** 登録済み・飛ばした月の集合（`YYYY-MM` の配列。重複あり） */
export const arbDoneMonths = fc.array(arbMonth, { maxLength: 20 });

// ---- 操作の列（INV-35） ----

/** 起動の日の列の 1 つ。`dayStep` は前の日からの進み（0 は同じ日の重複） */
export type RecurringOp =
  | { kind: "tick"; dayStep: number }
  | { kind: "create"; spec: DefSpec }
  | { kind: "pause"; target: number }
  | { kind: "resume"; target: number; fromOffset: number }
  | { kind: "update"; target: number; amount: number; dayOfMonth: number }
  | { kind: "close"; year: 2025 | 2026 }
  | { kind: "reopen"; year: 2025 | 2026 }
  | { kind: "voidPosted"; target: number }
  | { kind: "skip"; target: number; pick: number };

const arbYear = fc.constantFrom(2025 as const, 2026 as const);

const arbRecurringOp: fc.Arbitrary<RecurringOp> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("tick" as const),
      dayStep: fc.constantFrom(0, 0, 1, 3, 12, 40, 75),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("create" as const), spec: arbLiveDefSpec }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("create" as const), spec: arbDefSpec }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("pause" as const), target: fc.nat(50) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("resume" as const),
      target: fc.nat(50),
      fromOffset: fc.integer({ min: -2, max: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("update" as const),
      target: fc.nat(50),
      amount: fc.integer({ min: 1, max: 900_000_000 }),
      dayOfMonth: arbDay,
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("close" as const), year: arbYear }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reopen" as const), year: arbYear }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("voidPosted" as const), target: fc.nat(50) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("skip" as const),
      target: fc.nat(50),
      pick: fc.nat(50),
    }),
  },
);

/** 操作の列（最初の起動の日は `arbToday` が決める） */
export const arbRecurringOps = fc.array(arbRecurringOp, { minLength: 4, maxLength: 30 });
