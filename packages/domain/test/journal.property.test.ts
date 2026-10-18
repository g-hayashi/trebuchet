import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type JournalContext, validateJournal } from "../src/journal.ts";
import { TAX_RATES } from "../src/seed/tax-rates.ts";
import type { Account, DomainError, JournalDraft, LineDraft, SubAccount } from "../src/types.ts";
import {
  accountSetArb,
  balancedLinesArb,
  dateInPeriodArb,
  makeAccount,
  makeFiscalPeriod,
} from "./arbitraries.ts";

const period2026 = makeFiscalPeriod(2026);

function contextFor(accounts: readonly Account[], overrides: Partial<JournalContext> = {}) {
  return {
    accounts,
    subAccounts: [],
    partners: [],
    tags: [],
    periods: [period2026],
    taxSettings: [
      { effectiveFrom: "2026-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
    ],
    taxRates: TAX_RATES,
    ...overrides,
  } satisfies JournalContext;
}

const codes = (errors: readonly DomainError[]) => errors.map((e) => e.code);

function errorsOf(draft: JournalDraft, ctx: JournalContext): DomainError[] {
  const result = validateJournal(draft, ctx);
  if (result.ok) throw new Error("検証が成功してしまった");
  return result.error;
}

/** 任意の科目のセット・会計期間内の日付・貸借が一致する行 */
const validCaseArb = accountSetArb.chain((accounts) =>
  fc.record({
    accounts: fc.constant(accounts),
    date: dateInPeriodArb(period2026),
    lines: balancedLinesArb(accounts),
  }),
);

const sumSide = (lines: readonly LineDraft[], side: "debit" | "credit") =>
  lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);

describe("validateJournal（INV-1〜3, FR-015）", () => {
  it("INV-1: 貸借が一致する任意の仕訳は成功し、行の順に lineNo が 1 から振られる", () => {
    fc.assert(
      fc.property(validCaseArb, ({ accounts, date, lines }) => {
        const result = validateJournal({ date, lines }, contextFor(accounts));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.fiscalPeriodId).toBe(period2026.id);
        expect(result.value.lines.map((l) => l.lineNo)).toEqual(lines.map((_, i) => i + 1));
        expect(result.value.lines.map((l) => l.amount)).toEqual(lines.map((l) => l.amount));
      }),
    );
  });

  it("INV-1: 1行の金額をずらすと UNBALANCED で、details.diff が差額（借方 − 貸方）", () => {
    fc.assert(
      fc.property(
        validCaseArb.chain((c) =>
          fc.record({
            c: fc.constant(c),
            index: fc.nat({ max: c.lines.length - 1 }),
            delta: fc.integer({ min: 1, max: 1_000_000 }),
          }),
        ),
        ({ c, index, delta }) => {
          const lines = c.lines.map((l, i) =>
            i === index ? { ...l, amount: l.amount + delta } : l,
          );
          const errors = errorsOf({ date: c.date, lines }, contextFor(c.accounts));
          const unbalanced = errors.find((e) => e.code === "UNBALANCED");
          const debit = sumSide(lines, "debit");
          const credit = sumSide(lines, "credit");
          expect(unbalanced?.details).toEqual({ debit, credit, diff: debit - credit });
          expect(Math.abs(debit - credit)).toBe(delta);
        },
      ),
    );
  });

  it("INV-2: 借方のみ・貸方のみの仕訳は拒否する", () => {
    fc.assert(
      fc.property(validCaseArb, fc.constantFrom("debit", "credit"), (c, side) => {
        const lines = c.lines.map((l) => ({ ...l, side }));
        const errors = errorsOf({ date: c.date, lines }, contextFor(c.accounts));
        expect(errors).toContainEqual(
          expect.objectContaining({ code: "VALIDATION", details: { field: "lines" } }),
        );
      }),
    );
  });

  it("INV-3: 0 以下・1 兆円以上・整数でない金額は、その行の amount の VALIDATION", () => {
    const badAmountArb = fc.oneof(
      fc.integer({ min: -1_000_000, max: 0 }),
      fc.integer({ min: 1_000_000_000_000, max: Number.MAX_SAFE_INTEGER }),
      fc.double({ min: 0.001, max: 1e9, noInteger: true, noNaN: true }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
    );
    fc.assert(
      fc.property(
        validCaseArb.chain((c) =>
          fc.record({ c: fc.constant(c), index: fc.nat({ max: c.lines.length - 1 }) }),
        ),
        badAmountArb,
        ({ c, index }, amount) => {
          const lines = c.lines.map((l, i) => (i === index ? { ...l, amount } : l));
          const errors = errorsOf({ date: c.date, lines }, contextFor(c.accounts));
          expect(errors).toContainEqual(
            expect.objectContaining({
              code: "VALIDATION",
              details: expect.objectContaining({ lineIndex: index, field: "amount" }),
            }),
          );
          // 金額が不正なときは貸借の判定をしない
          expect(codes(errors)).not.toContain("UNBALANCED");
        },
      ),
    );
  });
});

describe("validateJournal の参照の検証", () => {
  const cash = makeAccount("asset", { name: "現金" });
  const sales = makeAccount("revenue", { name: "売上高" });
  const inactive = makeAccount("expense", { name: "停止中", isActive: false });
  const accounts = [cash, sales, inactive];
  const subOfSales: SubAccount = {
    id: "0000000b-0000-7000-8000-000000000001",
    accountId: sales.id,
    name: "A社",
    isActive: true,
  };
  const ctx = contextFor(accounts, { subAccounts: [subOfSales] });
  const draft = (lines: LineDraft[], date = "2026-10-31"): JournalDraft => ({ date, lines });
  const debit = (accountId: string, extra: Partial<LineDraft> = {}): LineDraft => ({
    side: "debit",
    accountId,
    amount: 1000,
    ...extra,
  });
  const credit = (accountId: string, extra: Partial<LineDraft> = {}): LineDraft => ({
    side: "credit",
    accountId,
    amount: 1000,
    ...extra,
  });

  it("存在しない科目は ACCOUNT_NOT_FOUND（行の番号つき）", () => {
    const missing = "0000000a-0000-7000-8000-ffffffffffff";
    const errors = errorsOf(draft([debit(missing), credit(sales.id)]), ctx);
    expect(errors).toEqual([
      expect.objectContaining({
        code: "ACCOUNT_NOT_FOUND",
        details: { lineIndex: 0, field: "accountId", accountId: missing },
      }),
    ]);
  });

  it("使用停止の科目は ACCOUNT_INACTIVE", () => {
    const errors = errorsOf(draft([debit(inactive.id), credit(sales.id)]), ctx);
    expect(codes(errors)).toEqual(["ACCOUNT_INACTIVE"]);
    expect(errors[0]?.details).toMatchObject({ lineIndex: 0, field: "accountId" });
  });

  it("補助科目が別の科目に属していれば拒否する", () => {
    const errors = errorsOf(
      draft([debit(cash.id, { subAccountId: subOfSales.id }), credit(sales.id)]),
      ctx,
    );
    expect(errors).toEqual([
      expect.objectContaining({
        code: "VALIDATION",
        details: expect.objectContaining({ lineIndex: 0, field: "subAccountId" }),
      }),
    ]);
    const ok = validateJournal(
      draft([debit(cash.id), credit(sales.id, { subAccountId: subOfSales.id })]),
      ctx,
    );
    expect(ok.ok).toBe(true);
  });

  it("存在しない取引先・タグは拒否する", () => {
    const errors = errorsOf(
      draft([
        debit(cash.id, { partnerId: "0000000c-0000-7000-8000-000000000001" }),
        credit(sales.id, { tagIds: ["0000000d-0000-7000-8000-000000000001"] }),
      ]),
      ctx,
    );
    expect(errors.map((e) => e.details)).toEqual([
      expect.objectContaining({ lineIndex: 0, field: "partnerId" }),
      expect.objectContaining({ lineIndex: 1, field: "tagIds" }),
    ]);
  });

  it("会計期間のない日付は OUT_OF_PERIOD。最後の期間より後なら会計期間の作成を提案する", () => {
    const after = errorsOf(draft([debit(cash.id), credit(sales.id)], "2027-01-01"), ctx);
    expect(after).toEqual([
      expect.objectContaining({
        code: "OUT_OF_PERIOD",
        details: { date: "2027-01-01", suggest: "create_fiscal_period" },
      }),
    ]);
    const before = errorsOf(draft([debit(cash.id), credit(sales.id)], "2025-12-31"), ctx);
    expect(before).toEqual([
      expect.objectContaining({ code: "OUT_OF_PERIOD", details: { date: "2025-12-31" } }),
    ]);
  });

  it("締め済みの期間の日付は PERIOD_CLOSED（訂正仕訳を提案する）", () => {
    const closed = contextFor(accounts, {
      periods: [{ ...period2026, status: "closed", closedAt: "2027-03-01T00:00:00.000Z" }],
    });
    const errors = errorsOf(draft([debit(cash.id), credit(sales.id)]), closed);
    expect(errors).toEqual([
      expect.objectContaining({
        code: "PERIOD_CLOSED",
        details: { fiscalYear: 2026, suggest: "correcting_entry" },
      }),
    ]);
  });

  it("消費税の設定が tax_excluded の期間の日付は TAX_METHOD_UNSUPPORTED", () => {
    const excluded = contextFor(accounts, {
      taxSettings: [
        { effectiveFrom: "2026-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
        {
          effectiveFrom: "2026-07-01",
          taxpayerStatus: "general",
          accountingMethod: "tax_excluded",
        },
      ],
    });
    expect(
      validateJournal(draft([debit(cash.id), credit(sales.id)], "2026-06-30"), excluded).ok,
    ).toBe(true);
    const errors = errorsOf(draft([debit(cash.id), credit(sales.id)], "2026-07-01"), excluded);
    expect(codes(errors)).toEqual(["TAX_METHOD_UNSUPPORTED"]);
  });

  it("複数の違反はすべて返す", () => {
    const missing = "0000000a-0000-7000-8000-ffffffffffff";
    const errors = errorsOf(
      draft(
        [
          debit(missing),
          debit(inactive.id, { amount: 500 }),
          credit(cash.id, { subAccountId: subOfSales.id }),
        ],
        "2027-02-01",
      ),
      ctx,
    );
    expect(codes(errors).sort()).toEqual(
      ["ACCOUNT_INACTIVE", "ACCOUNT_NOT_FOUND", "OUT_OF_PERIOD", "UNBALANCED", "VALIDATION"].sort(),
    );
  });

  it("摘要とメモは前後の空白を除き、空なら null。タグの重複は拒否する", () => {
    const result = validateJournal(
      {
        date: "2026-10-31",
        memo: "  ",
        lines: [debit(cash.id, { description: " 10月分 " }), credit(sales.id)],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memo).toBeNull();
    expect(result.value.lines.map((l) => l.description)).toEqual(["10月分", null]);

    const tag = { id: "0000000d-0000-7000-8000-000000000001" };
    const dup = errorsOf(
      draft([debit(cash.id, { tagIds: [tag.id, tag.id] }), credit(sales.id)]),
      contextFor(accounts, { tags: [tag] }),
    );
    expect(dup[0]?.details).toMatchObject({ lineIndex: 0, field: "tagIds" });
  });
});
