import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isValidDate } from "../src/dates.ts";
import { type JournalContext, validateJournal } from "../src/journal.ts";
import { buildBalanceSheet } from "../src/reports/balance-sheet.ts";
import { buildProfitAndLoss } from "../src/reports/profit-and-loss.ts";
import { TAX_RATES } from "../src/seed/tax-rates.ts";
import type { FixedAsset } from "../src/types.ts";
import {
  accountIdOf,
  deferredAssetArb,
  deferredDecisionsArb,
  homeUseArb,
  INDIVIDUAL_ACCOUNT_LIST,
  LEDGER_YEAR,
  lumpSumAssetArb,
  straightLineAssetArb,
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

const isDate = (s: string) => isValidDate(s) && /^\d{4}-\d{2}-\d{2}$/.test(s);
const yearOf = (date: string) => Number(date.slice(0, 4));
const serviceDateOf = (a: FixedAsset) => a.inServiceOn ?? a.acquiredOn;
const ASSET_ACCOUNT_IDS = new Set(
  INDIVIDUAL_ACCOUNT_LIST.filter((a) => a.category === "asset").map((a) => a.id),
);

/** 009 data-model §1.3 の制約（定額法・一括償却に共通） */
function expectCommonAssetConstraints(a: FixedAsset) {
  expect(isDate(a.acquiredOn)).toBe(true);
  expect(a.acquiredOn >= "2007-04-01").toBe(true);
  if (a.inServiceOn !== null) {
    expect(isDate(a.inServiceOn)).toBe(true);
    expect(a.inServiceOn >= a.acquiredOn).toBe(true);
  }
  expect(Number.isSafeInteger(a.acquisitionCost)).toBe(true);
  expect(a.acquisitionCost).toBeGreaterThan(0);
  expect(a.businessRatio).toBeGreaterThanOrEqual(0);
  expect(a.businessRatio).toBeLessThanOrEqual(10000);
  expect(Number.isInteger(a.businessRatio)).toBe(true);
  expect(ASSET_ACCOUNT_IDS.has(a.assetAccountId)).toBe(true);
  expect(a.linkedJournalId).toBeNull();
  // 累計と累計の年（prior_accumulated > 0 なら年は必須、供用の年以上）
  expect(Number.isSafeInteger(a.priorAccumulated)).toBe(true);
  expect(a.priorAccumulated).toBeGreaterThanOrEqual(0);
  if (a.priorAccumulated > 0) {
    expect(a.priorThroughYear).not.toBeNull();
    expect(a.priorThroughYear ?? 0).toBeGreaterThanOrEqual(yearOf(serviceDateOf(a)));
  } else {
    expect(a.priorThroughYear).toBeNull();
  }
  // 除却の日と種類は同時に入る。除却の日は供用日以後（累計があれば累計の年の翌年以後）
  expect(a.disposedOn === null).toBe(a.disposalKind === null);
  if (a.disposedOn !== null) {
    expect(isDate(a.disposedOn)).toBe(true);
    expect(a.disposedOn >= serviceDateOf(a)).toBe(true);
    if (a.priorThroughYear !== null) {
      expect(yearOf(a.disposedOn)).toBeGreaterThan(a.priorThroughYear);
    }
    expect(["scrap", "sale"]).toContain(a.disposalKind);
  }
}

describe("straightLineAssetArb（R17/T008）", () => {
  it("data-model §1.3 の制約を満たす（取得日 2007-04-01 以後、耐用年数 2〜50、累計 ≤ 取得価額 − 1 など）", () => {
    fc.assert(
      fc.property(straightLineAssetArb, (a) => {
        expect(a.method).toBe("straight_line");
        expectCommonAssetConstraints(a);
        expect(a.acquisitionCost).toBeLessThanOrEqual(1_000_000_000);
        expect(Number.isInteger(a.usefulLifeYears)).toBe(true);
        expect(a.usefulLifeYears ?? 0).toBeGreaterThanOrEqual(2);
        expect(a.usefulLifeYears ?? 0).toBeLessThanOrEqual(50);
        expect(a.priorAccumulated).toBeLessThanOrEqual(a.acquisitionCost - 1);
      }),
      { numRuns: 300 },
    );
  });

  it("範囲の端と各分岐が出る（供用日あり・なし、累計あり・なし、廃棄・売却・除却なし、割合の両端）", () => {
    const s = fc.sample(straightLineAssetArb, { numRuns: 600, seed: 11 });
    expect(s.some((a) => a.inServiceOn === null)).toBe(true);
    expect(s.some((a) => a.inServiceOn !== null && a.inServiceOn > a.acquiredOn)).toBe(true);
    expect(s.some((a) => a.priorAccumulated > 0)).toBe(true);
    expect(s.some((a) => a.priorAccumulated === 0)).toBe(true);
    expect(s.some((a) => a.disposalKind === "scrap")).toBe(true);
    expect(s.some((a) => a.disposalKind === "sale")).toBe(true);
    expect(s.some((a) => a.disposedOn === null)).toBe(true);
    expect(s.some((a) => a.businessRatio === 0)).toBe(true);
    expect(s.some((a) => a.businessRatio === 10000)).toBe(true);
    expect(s.some((a) => a.usefulLifeYears === 2)).toBe(true);
    expect(s.some((a) => a.usefulLifeYears === 50)).toBe(true);
    expect(s.some((a) => a.acquisitionCost < 10)).toBe(true);
    expect(s.some((a) => a.acquisitionCost > 100_000_000)).toBe(true);
    // 供用の年が取得の年と別になる（12 月に取得して翌年に供用）
    expect(s.some((a) => yearOf(serviceDateOf(a)) > yearOf(a.acquiredOn))).toBe(true);
  });
});

describe("lumpSumAssetArb（R17/T008）", () => {
  it("取得価額 100,000〜199,999、耐用年数なし、累計 ≤ 取得価額など data-model §1.3 の制約を満たす", () => {
    fc.assert(
      fc.property(lumpSumAssetArb, (a) => {
        expect(a.method).toBe("lump_sum");
        expectCommonAssetConstraints(a);
        expect(a.acquisitionCost).toBeGreaterThanOrEqual(100_000);
        expect(a.acquisitionCost).toBeLessThanOrEqual(199_999);
        expect(a.usefulLifeYears).toBeNull();
        expect(a.priorAccumulated).toBeLessThanOrEqual(a.acquisitionCost);
      }),
      { numRuns: 300 },
    );
  });

  it("範囲の端と各分岐が出る（累計 = 取得価額を含む）", () => {
    const s = fc.sample(lumpSumAssetArb, { numRuns: 600, seed: 12 });
    expect(s.some((a) => a.acquisitionCost === 100_000)).toBe(true);
    expect(s.some((a) => a.acquisitionCost === 199_999)).toBe(true);
    expect(s.some((a) => a.priorAccumulated > 0)).toBe(true);
    expect(s.some((a) => a.priorAccumulated === 0)).toBe(true);
    expect(s.some((a) => a.priorAccumulated > 0 && a.priorAccumulated === a.acquisitionCost)).toBe(
      true,
    );
    expect(s.some((a) => a.disposedOn !== null)).toBe(true);
    expect(s.some((a) => a.disposedOn === null)).toBe(true);
    expect(s.some((a) => a.inServiceOn !== null)).toBe(true);
  });
});

describe("deferredAssetArb・deferredDecisionsArb（R17/T008）", () => {
  it("開業費は data-model §1.4 の制約を満たす（総額 > 0、累計 ≤ 総額、累計があれば年は開業の年以上、1080 開業費）", () => {
    fc.assert(
      fc.property(deferredAssetArb, (d) => {
        expect(d.name.length).toBeGreaterThan(0);
        expect(Number.isSafeInteger(d.totalAmount)).toBe(true);
        expect(d.totalAmount).toBeGreaterThan(0);
        expect(d.totalAmount).toBeLessThanOrEqual(1_000_000_000);
        expect(isDate(d.openedOn)).toBe(true);
        expect(d.priorAccumulated).toBeGreaterThanOrEqual(0);
        expect(d.priorAccumulated).toBeLessThanOrEqual(d.totalAmount);
        if (d.priorAccumulated > 0) {
          expect(d.priorThroughYear).not.toBeNull();
          expect(d.priorThroughYear ?? 0).toBeGreaterThanOrEqual(yearOf(d.openedOn));
        } else {
          expect(d.priorThroughYear).toBeNull();
        }
        expect(d.accountId).toBe(accountIdOf("1080"));
        expect(ASSET_ACCOUNT_IDS.has(d.accountId)).toBe(true);
      }),
      { numRuns: 300 },
    );
    const s = fc.sample(deferredAssetArb, { numRuns: 400, seed: 13 });
    expect(s.some((d) => d.priorAccumulated === 0)).toBe(true);
    expect(s.some((d) => d.priorAccumulated > 0)).toBe(true);
    expect(s.some((d) => d.priorAccumulated === d.totalAmount)).toBe(true);
    expect(s.some((d) => d.note !== null)).toBe(true);
  });

  it("年度ごとの決定: 開業費の startYear 以後の年が昇順で重ならず、額は 0 以上で総額 − 累計以下の整数", () => {
    fc.assert(
      fc.property(
        deferredAssetArb.chain((asset) =>
          deferredDecisionsArb(asset).map((decisions) => ({ asset, decisions })),
        ),
        ({ asset, decisions }) => {
          const startYear = (asset.priorThroughYear ?? yearOf(asset.openedOn) - 1) + 1;
          const years = decisions.map((d) => d.fiscalYear);
          expect(years).toEqual([...new Set(years)].sort((a, b) => a - b));
          for (const d of decisions) {
            expect(d.deferredAssetId).toBe(asset.id);
            expect(d.fiscalYear).toBeGreaterThanOrEqual(startYear);
            expect(Number.isSafeInteger(d.amount)).toBe(true);
            expect(d.amount).toBeGreaterThanOrEqual(0);
            expect(d.amount).toBeLessThanOrEqual(asset.totalAmount - asset.priorAccumulated);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("決定の列は空・0 円・上限いっぱいの額を含み得る", () => {
    const s = fc.sample(
      deferredAssetArb.chain((asset) => deferredDecisionsArb(asset).map((d) => ({ asset, d }))),
      { numRuns: 500, seed: 14 },
    );
    expect(s.some(({ d }) => d.length === 0)).toBe(true);
    expect(s.some(({ d }) => d.some((x) => x.amount === 0))).toBe(true);
    expect(s.some(({ d }) => d.length >= 3)).toBe(true);
    expect(
      s.some(({ asset, d }) =>
        d.some((x) => x.amount === asset.totalAmount - asset.priorAccumulated && x.amount > 0),
      ),
    ).toBe(true);
  });
});
