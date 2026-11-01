import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  depreciate,
  type FixedAssetDraft,
  proposeDepreciationAdjustment,
  validateFixedAsset,
} from "../../src/blue-return/depreciation.ts";
import { resolveTaxParameter } from "../../src/blue-return/tax-parameters.ts";
import { type JournalContext, validateJournal } from "../../src/journal.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { FixedAsset } from "../../src/types.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const EQUIPMENT = accountIdOf("1060");
const AT = "2026-01-10T00:00:00.000Z";
const ctx = { accounts: INDIVIDUAL_ACCOUNT_LIST, taxParameters: TAX_PARAMETERS };

const pad = (n: number) => n.toString().padStart(2, "0");

/** 2025-01-01〜2027-12-31 の日付（基準額が変わる 2026-04-01 の前後を含む） */
const dateArb = fc
  .integer({ min: 0, max: 3 * 365 - 1 })
  .map((offset) => new Date(Date.UTC(2025, 0, 1) + offset * 86_400_000))
  .map((d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);

const ratioArb = fc.oneof(fc.constantFrom(0, 1, 9999, 10000), fc.integer({ min: 0, max: 10000 }));

const costArb = fc.oneof(
  fc.constantFrom(1, 299_999, 300_000, 350_000, 399_999, 400_000),
  fc.integer({ min: 1, max: 500_000 }),
);

const draftArb: fc.Arbitrary<FixedAssetDraft> = fc.record({
  name: fc.constant("備品"),
  quantity: fc.constant(null),
  acquiredOn: dateArb,
  acquisitionCost: costArb,
  method: fc.constant("small_asset_28_2" as const),
  usefulLifeYears: fc.constant(null),
  inServiceOn: fc.constant(null),
  priorAccumulated: fc.constant(0),
  priorThroughYear: fc.constant(null),
  businessRatio: ratioArb,
  assetAccountId: fc.constant(EQUIPMENT),
  linkedJournalId: fc.constant(null),
  note: fc.constant(null),
});

const toAsset = (d: FixedAssetDraft, id: string): FixedAsset => ({
  ...d,
  id,
  disposedOn: null,
  disposalKind: null,
  createdAt: AT,
  updatedAt: AT,
});

const journalCtx = (year: number): JournalContext => ({
  accounts: INDIVIDUAL_ACCOUNT_LIST,
  subAccounts: [],
  partners: [],
  tags: [],
  periods: [makeFiscalPeriod(year)],
  taxSettings: [
    { effectiveFrom: "2019-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
  ],
  taxRates: [],
});

describe("INV-21: 少額減価償却資産の特例の資産", () => {
  it("登録できた資産は、取得価額 < 取得の日の基準額、同じ年の合計 ≤ 年間の上限、必要経費算入額 ≤ 取得価額", () => {
    fc.assert(
      fc.property(fc.array(draftArb, { maxLength: 40 }), (drafts) => {
        const accepted: FixedAsset[] = [];
        for (const [i, d] of drafts.entries()) {
          const threshold = resolveTaxParameter(
            "SMALL_ASSET_THRESHOLD",
            d.acquiredOn,
            TAX_PARAMETERS,
          );
          const limit = resolveTaxParameter(
            "SMALL_ASSET_ANNUAL_LIMIT",
            d.acquiredOn,
            TAX_PARAMETERS,
          );
          const year = d.acquiredOn.slice(0, 4);
          const before = accepted
            .filter((a) => a.acquiredOn.startsWith(year))
            .reduce((s, a) => s + a.acquisitionCost, 0);
          const r = validateFixedAsset(d, accepted, ctx);
          const expectOk =
            threshold !== undefined &&
            limit !== undefined &&
            d.acquisitionCost < threshold.value &&
            before + d.acquisitionCost <= limit.value;
          expect(r.ok).toBe(expectOk);
          if (!r.ok) {
            expect(["SMALL_ASSET_OVER_THRESHOLD", "SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED"]).toContain(
              r.error.code,
            );
            continue;
          }
          const asset = toAsset(r.value, `a-${i}`);
          accepted.push(asset);
          const dep = depreciate(asset, Number(year));
          expect(dep.deductible).toBeGreaterThanOrEqual(0);
          expect(dep.deductible).toBeLessThanOrEqual(asset.acquisitionCost);
          expect(BigInt(dep.deductible)).toBe(
            (BigInt(asset.acquisitionCost) * BigInt(asset.businessRatio)) / 10000n,
          );
          expect(dep.closingBookValue).toBe(0);
        }
        // 登録できた資産の、年ごとの取得価額の合計は上限以内
        const byYear = new Map<string, number>();
        for (const a of accepted) {
          const y = a.acquiredOn.slice(0, 4);
          byYear.set(y, (byYear.get(y) ?? 0) + a.acquisitionCost);
        }
        for (const total of byYear.values()) expect(total).toBeLessThanOrEqual(3_000_000);
      }),
    );
  });

  it("取得した年以外の償却費・必要経費算入額は 0。取得価額と割合は変わらない", () => {
    fc.assert(
      fc.property(draftArb, fc.integer({ min: 2020, max: 2030 }), (d, year) => {
        const asset = toAsset(d, "a");
        const dep = depreciate(asset, year);
        expect(dep.cost).toBe(asset.acquisitionCost);
        expect(dep.businessRatio).toBe(asset.businessRatio);
        if (String(year) !== d.acquiredOn.slice(0, 4)) {
          expect(dep.total).toBe(0);
          expect(dep.deductible).toBe(0);
        } else {
          expect(dep.total).toBe(asset.acquisitionCost);
        }
      }),
    );
  });
});

describe("INV-23: 減価償却の仕訳の案", () => {
  it("validateJournal を通り、貸借一致・行の金額 > 0・年度末日付。金額は取得価額と家事分", () => {
    fc.assert(
      fc.property(draftArb, (d) => {
        const asset = toAsset(d, "a");
        const year = Number(d.acquiredOn.slice(0, 4));
        const r = proposeDepreciationAdjustment(asset, year, INDIVIDUAL_ACCOUNT_LIST);
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        const proposal = r.value;
        expect(proposal).not.toBeNull();
        if (proposal === null) return;
        const { journal } = proposal;
        const side = (s: string) =>
          journal.lines.filter((l) => l.side === s).reduce((sum, l) => sum + l.amount, 0);
        expect(side("debit")).toBe(side("credit"));
        expect(journal.date).toBe(`${year}-12-31`);
        for (const l of journal.lines) {
          expect(Number.isInteger(l.amount) && l.amount > 0).toBe(true);
          expect(l.taxCategory).toBe("OUT_OF_SCOPE");
        }
        const { deductible } = depreciate(asset, year);
        expect(proposal.breakdown).toEqual({
          method: "small_asset_28_2",
          acquisitionCost: d.acquisitionCost,
          businessRatio: d.businessRatio,
          depreciation: d.acquisitionCost,
          deductible,
          months: null,
          ratePermille: null,
          openingBookValue: d.acquisitionCost,
          closingBookValue: 0,
          disposalKind: null,
          disposalAmount: 0,
          disposalDeductible: 0,
        });
        expect(side("debit")).toBe(d.acquisitionCost + (d.acquisitionCost - deductible));
        expect(validateJournal(journal, journalCtx(year)).ok).toBe(true);
      }),
    );
  });

  it("既存の仕訳を結びつけた資産、取得した年以外には案がない", () => {
    fc.assert(
      fc.property(draftArb, fc.integer({ min: 2020, max: 2030 }), (d, year) => {
        const linked = proposeDepreciationAdjustment(
          { ...toAsset(d, "a"), linkedJournalId: "j-1" },
          Number(d.acquiredOn.slice(0, 4)),
          INDIVIDUAL_ACCOUNT_LIST,
        );
        expect(linked.ok && linked.value).toBeNull();
        if (String(year) !== d.acquiredOn.slice(0, 4)) {
          const other = proposeDepreciationAdjustment(
            toAsset(d, "a"),
            year,
            INDIVIDUAL_ACCOUNT_LIST,
          );
          expect(other.ok && other.value).toBeNull();
        }
      }),
    );
  });
});
