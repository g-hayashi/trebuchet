import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deferredAmortizationYear,
  proposeDeferredAmortization,
  validateDeferredDecision,
} from "../../src/blue-return/deferred-asset.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { DeferredAmortization, DeferredAsset } from "../../src/types.ts";
import {
  deferredAssetArb,
  deferredDecisionsArb,
  INDIVIDUAL_ACCOUNT_LIST,
} from "../blue-return-arbitraries.ts";

/** 開始年度から 70 か月（6 年弱）先まで。60 か月を過ぎた年度も含める */
const HORIZON = 12;

const startYearOf = (asset: DeferredAsset) =>
  asset.priorThroughYear !== null ? asset.priorThroughYear + 1 : Number(asset.openedOn.slice(0, 4));

/** 開業費と、決定の列と、その決定ごとの「有効な仕訳があるか」 */
const scenarioArb = deferredAssetArb.chain((asset) =>
  fc.record({
    asset: fc.constant(asset),
    decisions: deferredDecisionsArb(asset),
    active: fc.array(fc.boolean(), { minLength: HORIZON, maxLength: HORIZON }),
  }),
);

describe("INV-58: 開業費の上限・目安・決定", () => {
  it("各年度 0 ≤ 決定の額 ≤ 期首の残高、期首の残高 ≥ 0、0 ≤ 目安 ≤ 期首の残高。上限を超える決定は拒否される", () => {
    fc.assert(
      fc.property(scenarioArb, ({ asset, decisions, active }) => {
        const start = startYearOf(asset);
        const accepted: DeferredAmortization[] = [];
        const activeYears = new Set<number>();
        for (let i = 0; i < HORIZON; i++) {
          const year = start + i;
          const ctx = {
            decisions: accepted,
            activeRefs: activeYears,
            taxParameters: TAX_PARAMETERS,
          };
          const r = deferredAmortizationYear(asset, year, ctx);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          const v = r.value;
          expect(Number.isInteger(v.openingBalance)).toBe(true);
          expect(v.openingBalance).toBeGreaterThanOrEqual(0);
          expect(v.target).toBeGreaterThanOrEqual(0);
          expect(v.target).toBeLessThanOrEqual(v.openingBalance);
          expect(v.closingBalance).toBeGreaterThanOrEqual(0);

          const proposed = decisions.find((d) => d.fiscalYear === year);
          if (proposed === undefined) continue;
          const checked = validateDeferredDecision(v, proposed.amount);
          if (proposed.amount > v.openingBalance) {
            expect(!checked.ok && checked.error.code).toBe("DEFERRED_AMORTIZATION_OVER_LIMIT");
            expect(!checked.ok && checked.error.details).toMatchObject({ limit: v.openingBalance });
            continue;
          }
          expect(checked.ok && checked.value).toBe(proposed.amount);
          accepted.push(proposed);
          if (active[i]) activeYears.add(year);
        }
      }),
    );
  });

  it("翌年度の期首の残高 = 期首の残高 − 有効な仕訳のある決定の額。有効な仕訳のない決定は上限を減らさない", () => {
    fc.assert(
      fc.property(scenarioArb, ({ asset, decisions, active }) => {
        const start = startYearOf(asset);
        const accepted: DeferredAmortization[] = [];
        const activeYears = new Set<number>();
        let expectedOpening = asset.totalAmount - asset.priorAccumulated;
        for (let i = 0; i < HORIZON; i++) {
          const year = start + i;
          const r = deferredAmortizationYear(asset, year, {
            decisions: accepted,
            activeRefs: activeYears,
            taxParameters: TAX_PARAMETERS,
          });
          if (!r.ok) return;
          expect(r.value.openingBalance).toBe(expectedOpening);
          const proposed = decisions.find((d) => d.fiscalYear === year);
          if (proposed !== undefined && proposed.amount <= r.value.openingBalance) {
            accepted.push(proposed);
            if (active[i]) {
              activeYears.add(year);
              expectedOpening -= proposed.amount;
            }
          }
        }
      }),
    );
  });

  it("0 円の決定は案を作らない。正の決定は決定の額の貸借一致の案になる", () => {
    fc.assert(
      fc.property(scenarioArb, ({ asset, decisions }) => {
        const first = decisions[0];
        if (first === undefined) return;
        const view = deferredAmortizationYear(asset, first.fiscalYear, {
          decisions: [first],
          activeRefs: new Set(),
          taxParameters: TAX_PARAMETERS,
        });
        if (!view.ok) return;
        const amount = Math.min(first.amount, view.value.openingBalance);
        const withAmount = {
          ...view.value,
          decision: { ...first, amount },
        };
        const proposal = proposeDeferredAmortization(
          asset,
          withAmount,
          first.fiscalYear,
          INDIVIDUAL_ACCOUNT_LIST,
        );
        expect(proposal.ok).toBe(true);
        if (!proposal.ok) return;
        if (amount === 0) {
          expect(proposal.value).toBeNull();
          return;
        }
        const lines = proposal.value?.journal.lines ?? [];
        const sum = (side: "debit" | "credit") =>
          lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);
        expect(sum("debit")).toBe(amount);
        expect(sum("credit")).toBe(amount);
      }),
    );
  });

  it("決定を保存した後でも、決定の額 ≤ 上限（決定の列が妥当なら期末の残高は負にならない）", () => {
    fc.assert(
      fc.property(scenarioArb, ({ asset, decisions }) => {
        const start = startYearOf(asset);
        const accepted: DeferredAmortization[] = [];
        for (let i = 0; i < HORIZON; i++) {
          const year = start + i;
          const active = new Set(accepted.map((d) => d.fiscalYear));
          const r = deferredAmortizationYear(asset, year, {
            decisions: accepted,
            activeRefs: active,
            taxParameters: TAX_PARAMETERS,
          });
          if (!r.ok) return;
          const proposed = decisions.find((d) => d.fiscalYear === year);
          if (proposed !== undefined && proposed.amount <= r.value.openingBalance) {
            accepted.push(proposed);
          }
        }
        const last = deferredAmortizationYear(asset, start + HORIZON, {
          decisions: accepted,
          activeRefs: new Set(accepted.map((d) => d.fiscalYear)),
          taxParameters: TAX_PARAMETERS,
        });
        expect(last.ok && last.value.openingBalance).toBeGreaterThanOrEqual(0);
        const decided = accepted.reduce((s, d) => s + d.amount, 0);
        expect(last.ok && last.value.openingBalance).toBe(
          asset.totalAmount - asset.priorAccumulated - decided,
        );
      }),
    );
  });
});
