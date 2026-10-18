import { describe, expect, it } from "vitest";
import { groupAccountsBySection, sectionsForCategory } from "./accounts";

const acc = (id: string, reportSection: string, sortOrder: number) => ({
  id,
  reportSection: reportSection as "BS_ASSET",
  sortOrder,
});

describe("groupAccountsBySection", () => {
  it("決算書の順（sortOrder）に並べ、区分ごとにまとめる", () => {
    const groups = groupAccountsBySection([
      acc("expense", "PL_EXPENSE", 6010),
      acc("cash", "BS_ASSET", 1010),
      acc("sales", "PL_SALES", 4010),
      acc("bank", "BS_ASSET", 1020),
      acc("loan", "BS_LIABILITY", 2010),
    ]);
    expect(groups.map((g) => g.section)).toEqual([
      "BS_ASSET",
      "BS_LIABILITY",
      "PL_SALES",
      "PL_EXPENSE",
    ]);
    expect(groups[0]?.accounts.map((a) => a.id)).toEqual(["cash", "bank"]);
  });

  it("区分の名前を付ける", () => {
    const [g] = groupAccountsBySection([acc("cash", "BS_ASSET", 1)]);
    expect(g?.label).toBe("資産");
  });
});

describe("sectionsForCategory", () => {
  it("区分ごとに選べる決算書の区分（domain の ALLOWED_SECTIONS と同じ）", () => {
    expect(sectionsForCategory("asset")).toEqual(["BS_ASSET"]);
    expect(sectionsForCategory("equity")).toEqual(["BS_EQUITY", "BS_ASSET"]);
    expect(sectionsForCategory("expense")).toEqual(["PL_COGS", "PL_EXPENSE", "PL_OTHER"]);
  });
});
