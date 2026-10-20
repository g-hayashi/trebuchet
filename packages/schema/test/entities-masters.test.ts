import { describe, expect, it } from "vitest";
import {
  AccountPatch,
  EntityCreate,
  OpeningBalancesPut,
  PartnerInput,
  TaxSettingsPut,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";

describe("EntityCreate", () => {
  it("正しい入力を受け付け、名称の前後の空白を除く", () => {
    const r = EntityCreate.parse({
      name: " 個人事業 ",
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear: 2026,
    });
    expect(r.name).toBe("個人事業");
  });
  it.each([
    { name: "", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
    { name: "a", kind: "individual", fiscalStartMonth: 13, firstFiscalYear: 2026 },
    { name: "a", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 1999 },
    { name: "a", kind: "npo", fiscalStartMonth: 1, firstFiscalYear: 2026 },
    { name: "a".repeat(101), kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
  ])("不正な入力を拒否する %#", (input) => {
    expect(EntityCreate.safeParse(input).success).toBe(false);
  });
});

describe("マスタの入力", () => {
  it("AccountPatch は空のオブジェクトを拒否する", () => {
    expect(AccountPatch.safeParse({}).success).toBe(false);
    expect(AccountPatch.safeParse({ isActive: false }).success).toBe(true);
  });
  it("AccountPatch は reportLine だけの変更を受け付ける（null で解除、R12a）", () => {
    expect(AccountPatch.safeParse({ reportLine: 31 }).success).toBe(true);
    expect(AccountPatch.safeParse({ reportLine: null }).success).toBe(true);
    expect(AccountPatch.safeParse({ reportLine: 0 }).success).toBe(false);
    expect(AccountPatch.safeParse({ reportLine: 1.5 }).success).toBe(false);
  });
  it("PartnerInput の敬称は 様・御中・null のみ", () => {
    expect(PartnerInput.safeParse({ name: "A社", honorific: "御中" }).success).toBe(true);
    expect(PartnerInput.safeParse({ name: "A社", honorific: null }).success).toBe(true);
    expect(PartnerInput.safeParse({ name: "A社", honorific: "殿" }).success).toBe(false);
  });
  it("TaxSettingsPut は空の配列と存在しない日付を拒否する", () => {
    expect(TaxSettingsPut.safeParse([]).success).toBe(false);
    expect(
      TaxSettingsPut.safeParse([
        { effectiveFrom: "2026-02-30", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
      ]).success,
    ).toBe(false);
  });
  it("OpeningBalancesPut は 0 円と小数を拒否する", () => {
    expect(
      OpeningBalancesPut.safeParse([{ accountId: ID, side: "debit", amount: 0 }]).success,
    ).toBe(false);
    expect(
      OpeningBalancesPut.safeParse([{ accountId: ID, side: "debit", amount: 1.5 }]).success,
    ).toBe(false);
    expect(
      OpeningBalancesPut.safeParse([{ accountId: ID, side: "credit", amount: 100 }]).success,
    ).toBe(true);
  });
  it("OpeningBalancesPut の補助科目は省略・null・ID を受け付ける", () => {
    const row = { accountId: ID, side: "debit", amount: 100 } as const;
    expect(OpeningBalancesPut.safeParse([{ ...row, subAccountId: null }]).success).toBe(true);
    expect(OpeningBalancesPut.safeParse([{ ...row, subAccountId: ID }]).success).toBe(true);
    expect(OpeningBalancesPut.safeParse([{ ...row, subAccountId: "x" }]).success).toBe(false);
  });
});
