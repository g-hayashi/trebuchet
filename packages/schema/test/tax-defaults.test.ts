import { describe, expect, it } from "vitest";
import { type AccountCategory, defaultTaxCategory, type TaxCategoryCode } from "../src/index.ts";

const exemptThenGeneral = [
  { effectiveFrom: "2025-01-01", taxpayerStatus: "exempt" as const },
  { effectiveFrom: "2026-01-01", taxpayerStatus: "general" as const },
];

const CATEGORIES: AccountCategory[] = ["asset", "liability", "equity", "revenue", "expense"];

describe("defaultTaxCategory（FR-017、R5）", () => {
  it.each(CATEGORIES)("免税の期間は %s の科目でも OUT_OF_SCOPE", (category) => {
    expect(defaultTaxCategory("2025-06-01", { category }, exemptThenGeneral)).toBe("OUT_OF_SCOPE");
  });

  it.each<[AccountCategory, TaxCategoryCode]>([
    ["revenue", "SALES_10"],
    ["expense", "PURCHASE_10"],
    ["asset", "OUT_OF_SCOPE"],
    ["liability", "OUT_OF_SCOPE"],
    ["equity", "OUT_OF_SCOPE"],
  ])("課税の期間で %s の科目は %s", (category, expected) => {
    expect(defaultTaxCategory("2026-06-01", { category }, exemptThenGeneral)).toBe(expected);
  });

  it("消費税の設定がない日付は OUT_OF_SCOPE", () => {
    expect(defaultTaxCategory("2024-12-31", { category: "revenue" }, exemptThenGeneral)).toBe(
      "OUT_OF_SCOPE",
    );
  });

  it("科目が未選択（undefined）なら OUT_OF_SCOPE", () => {
    expect(defaultTaxCategory("2026-06-01", undefined, exemptThenGeneral)).toBe("OUT_OF_SCOPE");
  });

  it("日付に適用される最新の設定で決める（並びに依らない）", () => {
    const reversed = [...exemptThenGeneral].reverse();
    expect(defaultTaxCategory("2026-01-01", { category: "expense" }, reversed)).toBe("PURCHASE_10");
    expect(defaultTaxCategory("2025-12-31", { category: "expense" }, reversed)).toBe(
      "OUT_OF_SCOPE",
    );
  });
});
