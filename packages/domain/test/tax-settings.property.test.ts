import type { AccountingMethod, TaxpayerStatus } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  resolveTaxSetting,
  type TaxSettingDraft,
  validateTaxSettings,
} from "../src/tax-settings.ts";
import { dateInPeriodArb, makeFiscalPeriod } from "./arbitraries.ts";

const FIRST_PERIOD_START = "2026-01-01";

/** 2019-01-01〜2030-12-31 の日付 */
const dateArb = dateInPeriodArb(makeFiscalPeriod(2019, { endDate: "2030-12-31" }));
const statusArb = fc.constantFrom<TaxpayerStatus>("exempt", "general", "simplified", "two_tenths");

/** 有効な組み合わせ（免税は税込のみ） */
const settingAt = (effectiveFrom: string): fc.Arbitrary<TaxSettingDraft> =>
  statusArb.chain((taxpayerStatus) =>
    fc
      .constantFrom<AccountingMethod>(
        ...(taxpayerStatus === "exempt"
          ? (["tax_included"] as const)
          : (["tax_included", "tax_excluded"] as const)),
      )
      .map((accountingMethod) => ({ effectiveFrom, taxpayerStatus, accountingMethod })),
  );

/** 有効な設定の列: 適用開始日が重複せず、最初の行が最初の会計期間の開始日以前。順序はばらばら */
const validSettingsArb: fc.Arbitrary<TaxSettingDraft[]> = fc
  .tuple(
    dateArb.filter((d) => d <= FIRST_PERIOD_START),
    fc.uniqueArray(dateArb, { maxLength: 6 }),
  )
  .map(([first, rest]) => [first, ...rest.filter((d) => d !== first)])
  .chain((dates) => fc.tuple(...dates.map(settingAt)))
  .chain((rows) => fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length }));

/** オラクル: effectiveFrom <= date のうち最新の設定 */
function oracle(date: string, settings: readonly TaxSettingDraft[]) {
  const applicable = settings.filter((s) => s.effectiveFrom <= date);
  applicable.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return applicable[0];
}

describe("validateTaxSettings（FR-009）", () => {
  it("有効な設定の列は成功し、適用開始日の順に並べて返す", () => {
    fc.assert(
      fc.property(validSettingsArb, (settings) => {
        const result = validateTaxSettings(settings, FIRST_PERIOD_START);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const dates = result.value.map((s) => s.effectiveFrom);
        expect(dates).toEqual([...dates].sort());
        expect(result.value).toHaveLength(settings.length);
      }),
    );
  });

  it("適用開始日の重複は TAX_SETTING_GAP で拒否する", () => {
    fc.assert(
      fc.property(
        validSettingsArb.chain((s) => fc.tuple(fc.constant(s), fc.nat(s.length - 1))),
        fc.constantFrom<TaxpayerStatus>("general", "simplified"),
        ([settings, i], status) => {
          const dup = settings[i];
          if (dup === undefined) throw new Error("unreachable");
          const withDup = [...settings, { ...dup, taxpayerStatus: status }];
          const result = validateTaxSettings(withDup, FIRST_PERIOD_START);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("TAX_SETTING_GAP");
        },
      ),
    );
  });

  it("最初の行の適用開始日が最初の会計期間の開始日より後なら TAX_SETTING_GAP で拒否する", () => {
    const laterDateArb = dateArb.filter((d) => d > FIRST_PERIOD_START);
    fc.assert(
      fc.property(
        fc
          .uniqueArray(laterDateArb, { minLength: 1, maxLength: 5 })
          .chain((dates) => fc.tuple(...dates.map(settingAt))),
        (settings) => {
          const result = validateTaxSettings(settings, FIRST_PERIOD_START);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("TAX_SETTING_GAP");
        },
      ),
    );
  });

  it("最初の行の適用開始日が会計期間の開始日と同じなら成功する", () => {
    const result = validateTaxSettings(
      [
        {
          effectiveFrom: FIRST_PERIOD_START,
          taxpayerStatus: "exempt",
          accountingMethod: "tax_included",
        },
      ],
      FIRST_PERIOD_START,
    );
    expect(result.ok).toBe(true);
  });

  it("空の設定は TAX_SETTING_GAP で拒否する", () => {
    const result = validateTaxSettings([], FIRST_PERIOD_START);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TAX_SETTING_GAP");
  });

  it("免税で税抜経理の行があれば VALIDATION で拒否する", () => {
    fc.assert(
      fc.property(
        validSettingsArb.chain((s) => fc.tuple(fc.constant(s), fc.nat(s.length - 1))),
        ([settings, i]) => {
          const broken = settings.map((s, j) =>
            j === i
              ? {
                  ...s,
                  taxpayerStatus: "exempt" as const,
                  accountingMethod: "tax_excluded" as const,
                }
              : s,
          );
          const result = validateTaxSettings(broken, FIRST_PERIOD_START);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("VALIDATION");
        },
      ),
    );
  });

  it("実在しない日付の適用開始日は VALIDATION で拒否する", () => {
    const result = validateTaxSettings(
      [{ effectiveFrom: "2025-02-30", taxpayerStatus: "exempt", accountingMethod: "tax_included" }],
      FIRST_PERIOD_START,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });
});

describe("resolveTaxSetting（FR-009）", () => {
  it("任意の設定列と日付で、effectiveFrom <= date のうち最新の設定を返す（オラクルと一致）", () => {
    fc.assert(
      fc.property(validSettingsArb, dateArb, (settings, date) => {
        expect(resolveTaxSetting(date, settings)).toEqual(oracle(date, settings));
      }),
    );
  });

  it("適用開始日の当日はその設定、前日は前の設定を返す", () => {
    const settings: TaxSettingDraft[] = [
      { effectiveFrom: "2027-01-01", taxpayerStatus: "general", accountingMethod: "tax_included" },
      { effectiveFrom: "2026-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
    ];
    expect(resolveTaxSetting("2027-01-01", settings)?.taxpayerStatus).toBe("general");
    expect(resolveTaxSetting("2026-12-31", settings)?.taxpayerStatus).toBe("exempt");
    expect(resolveTaxSetting("2025-12-31", settings)).toBeUndefined();
  });
});
