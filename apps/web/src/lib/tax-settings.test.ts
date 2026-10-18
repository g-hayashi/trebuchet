import { describe, expect, it } from "vitest";
import { withEffectiveTo } from "./tax-settings";

const s = (id: string, effectiveFrom: string) => ({
  id,
  effectiveFrom,
  taxpayerStatus: "exempt" as const,
  accountingMethod: "tax_included" as const,
});

describe("withEffectiveTo", () => {
  it("適用開始日の順に並べ、次の設定の前日を終了日にする（最後は null）", () => {
    const rows = withEffectiveTo([s("b", "2027-01-01"), s("a", "2026-01-01")]);
    expect(rows.map((r) => [r.id, r.effectiveFrom, r.effectiveTo])).toEqual([
      ["a", "2026-01-01", "2026-12-31"],
      ["b", "2027-01-01", null],
    ]);
  });

  it("月末・うるう年をまたいでも前日を返す", () => {
    const rows = withEffectiveTo([s("a", "2024-01-01"), s("b", "2024-03-01")]);
    expect(rows[0]?.effectiveTo).toBe("2024-02-29");
  });
});
