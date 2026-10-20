import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type JournalContext, validateJournal } from "../src/journal.ts";
import { buildBalanceSheet } from "../src/reports/balance-sheet.ts";
import { buildProfitAndLoss } from "../src/reports/profit-and-loss.ts";
import { TAX_RATES } from "../src/seed/tax-rates.ts";
import {
  accountIdOf,
  homeUseArb,
  INDIVIDUAL_ACCOUNT_LIST,
  LEDGER_YEAR,
  type YearLedger,
  yearLedgerArb,
} from "./blue-return-arbitraries.ts";

const runs = { numRuns: 60 };

const contextFor = (ledger: YearLedger): JournalContext => ({
  accounts: ledger.accounts,
  subAccounts: [],
  partners: ledger.partners,
  tags: [],
  periods: [ledger.period],
  taxSettings: [
    { effectiveFrom: "2025-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
  ],
  taxRates: TAX_RATES,
});

const BANK = accountIdOf("1020");
const DRAWINGS = accountIdOf("3090");
const CONTRIBUTION = accountIdOf("3010");
const SALES = accountIdOf("4010");

const usesAccount = (ledger: YearLedger, accountId: string) =>
  ledger.lines.some((l) => l.accountId === accountId) ||
  ledger.opening.some((o) => o.accountId === accountId);

describe("yearLedgerArb", () => {
  it("生成した仕訳はすべて validateJournal を通り、日付は 2025 年の中で、金額は整数", () => {
    fc.assert(
      fc.property(yearLedgerArb, (ledger) => {
        const ctx = contextFor(ledger);
        for (const draft of ledger.journals) {
          const result = validateJournal(draft, ctx);
          expect(result.ok).toBe(true);
          expect(draft.date.startsWith(`${LEDGER_YEAR}-`)).toBe(true);
          for (const l of draft.lines) expect(Number.isSafeInteger(l.amount)).toBe(true);
        }
      }),
      runs,
    );
  });

  it("期首残高は貸借が一致し、科目は重複しない。科目は初期セット", () => {
    fc.assert(
      fc.property(yearLedgerArb, (ledger) => {
        const sum = (side: "debit" | "credit") =>
          ledger.opening.filter((o) => o.side === side).reduce((s, o) => s + o.amount, 0);
        expect(sum("debit")).toBe(sum("credit"));
        expect(new Set(ledger.opening.map((o) => o.accountId)).size).toBe(ledger.opening.length);
        const known = new Set(ledger.accounts.map((a) => a.id));
        for (const o of ledger.opening) {
          expect(known.has(o.accountId)).toBe(true);
          expect(Number.isSafeInteger(o.amount) && o.amount > 0).toBe(true);
        }
        expect(ledger.accounts).toEqual(INDIVIDUAL_ACCOUNT_LIST);
      }),
      runs,
    );
  });

  it("lines は journals の行で、仕訳ごとに貸借が一致する。取引先の参照は取引先の一覧の中", () => {
    fc.assert(
      fc.property(yearLedgerArb, (ledger) => {
        expect(ledger.lines.length).toBe(ledger.journals.reduce((n, j) => n + j.lines.length, 0));
        const partnerIds = new Set(ledger.partners.map((p) => p.id));
        const byJournal = new Map<string, number>();
        for (const l of ledger.lines) {
          expect(l.status).toBe("active");
          expect(l.partnerId === null || partnerIds.has(l.partnerId)).toBe(true);
          byJournal.set(
            l.journalId,
            (byJournal.get(l.journalId) ?? 0) + (l.side === "debit" ? l.amount : -l.amount),
          );
        }
        for (const diff of byJournal.values()) expect(diff).toBe(0);
      }),
      runs,
    );
  });

  it("事業用の口座を使わない帳簿は普通預金を使わない。使う帳簿は事業主貸・事業主借も使い得る", () => {
    fc.assert(
      fc.property(yearLedgerArb, (ledger) => {
        if (!ledger.usesBusinessAccount) expect(usesAccount(ledger, BANK)).toBe(false);
      }),
      runs,
    );
  });

  it("両方の形（普通預金で入出金・事業主貸借で入出金）と、取引先なしの売上が生成される", () => {
    const samples = fc.sample(yearLedgerArb, { numRuns: 200, seed: 20250101 });
    const business = samples.filter((l) => l.usesBusinessAccount);
    const owner = samples.filter((l) => !l.usesBusinessAccount);
    expect(business.some((l) => l.lines.some((x) => x.accountId === BANK))).toBe(true);
    expect(owner.some((l) => l.lines.some((x) => x.accountId === DRAWINGS))).toBe(true);
    expect(owner.some((l) => l.lines.some((x) => x.accountId === CONTRIBUTION))).toBe(true);
    expect(business.some((l) => l.lines.some((x) => x.accountId === DRAWINGS))).toBe(true);
    const sales = samples.flatMap((l) => l.lines.filter((x) => x.accountId === SALES));
    expect(sales.some((x) => x.partnerId === null)).toBe(true);
    expect(sales.some((x) => x.partnerId !== null)).toBe(true);
    // 売上・雑収入・経費（任意科目を含む）が出る
    const used = new Set(samples.flatMap((l) => l.lines.map((x) => x.accountId)));
    for (const code of ["4010", "4020", "5230", "5250", "5310"]) {
      expect(used.has(accountIdOf(code))).toBe(true);
    }
  });

  it("001 の buildProfitAndLoss・buildBalanceSheet にそのまま渡せる", () => {
    fc.assert(
      fc.property(yearLedgerArb, (ledger) => {
        const from = ledger.period.startDate;
        const to = ledger.period.endDate;
        const pl = buildProfitAndLoss({ accounts: ledger.accounts, lines: ledger.lines, from, to });
        const bs = buildBalanceSheet({
          accounts: ledger.accounts,
          opening: ledger.opening,
          lines: ledger.lines,
          periodStart: from,
          asOf: to,
        });
        expect(pl).toBeDefined();
        expect(bs).toBeDefined();
      }),
      runs,
    );
  });
});

describe("homeUseArb", () => {
  it("割合は 0〜10000 の整数で、両端が出る。科目は初期セットの経費", () => {
    const samples = fc.sample(homeUseArb, { numRuns: 300, seed: 7 });
    const expenseIds = new Set(
      INDIVIDUAL_ACCOUNT_LIST.filter((a) => a.category === "expense").map((a) => a.id),
    );
    for (const h of samples) {
      expect(Number.isInteger(h.businessRatio)).toBe(true);
      expect(h.businessRatio).toBeGreaterThanOrEqual(0);
      expect(h.businessRatio).toBeLessThanOrEqual(10000);
      expect(h.fiscalYear).toBe(LEDGER_YEAR);
      expect(expenseIds.has(h.accountId)).toBe(true);
    }
    expect(samples.some((h) => h.businessRatio === 0)).toBe(true);
    expect(samples.some((h) => h.businessRatio === 10000)).toBe(true);
    expect(samples.some((h) => h.businessRatio > 0 && h.businessRatio < 10000)).toBe(true);
  });
});
