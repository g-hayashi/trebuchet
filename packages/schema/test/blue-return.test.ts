import { describe, expect, it } from "vitest";
import {
  AdjustmentProposal,
  BlueReturn,
  BlueReturnWarning,
  ClosingNoteKind,
  DeductionAnswersInput,
  ErrorCode,
  FiledDocumentInput,
  FixedAssetDisposeInput,
  FixedAssetInput,
  FixedAssetsQuery,
  FixedAssetUpdateInput,
  HomeUseAllocationInput,
  RentDetailInput,
  TaxReturnMemoInput,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";
const ID2 = "0190f3a0-0000-7000-8000-000000000002";

describe("HomeUseAllocationInput", () => {
  const ok = { accountId: ID, businessRatio: 6000, basis: "床面積の比率" };
  it("正しい入力を受け付ける（0 と 10000 の境界も）", () => {
    expect(HomeUseAllocationInput.safeParse(ok).success).toBe(true);
    expect(HomeUseAllocationInput.safeParse({ ...ok, businessRatio: 0 }).success).toBe(true);
    expect(HomeUseAllocationInput.safeParse({ ...ok, businessRatio: 10000 }).success).toBe(true);
    expect(
      HomeUseAllocationInput.safeParse({ ...ok, subAccountId: ID2, changeReason: "移転" }).success,
    ).toBe(true);
  });
  it.each([
    { ...ok, businessRatio: -1 },
    { ...ok, businessRatio: 10001 },
    { ...ok, businessRatio: 0.5 },
    { accountId: ID, businessRatio: 6000 },
    { ...ok, basis: "x".repeat(1001) },
  ])("不正な入力を拒否する %#", (input) => {
    expect(HomeUseAllocationInput.safeParse(input).success).toBe(false);
  });
  it("空の根拠は形としては受け付ける（業務ルールの HOME_USE_BASIS_REQUIRED は domain が返す。FR-012）", () => {
    expect(HomeUseAllocationInput.safeParse({ ...ok, basis: "" }).success).toBe(true);
    expect(HomeUseAllocationInput.safeParse({ ...ok, basis: "   " }).success).toBe(true);
  });
});

describe("RentDetailInput", () => {
  const ok = {
    payee: "東京都 山田",
    property: "事務所",
    annualRent: 600000,
    deductibleAmount: 300000,
  };
  it("0 ≤ deductibleAmount ≤ annualRent を受け付ける", () => {
    expect(RentDetailInput.safeParse(ok).success).toBe(true);
    expect(RentDetailInput.safeParse({ ...ok, deductibleAmount: 600000 }).success).toBe(true);
    expect(RentDetailInput.safeParse({ ...ok, annualRent: 0, deductibleAmount: 0 }).success).toBe(
      true,
    );
  });
  it.each([
    { ...ok, deductibleAmount: 600001 },
    { ...ok, deductibleAmount: -1 },
    { ...ok, annualRent: -1, deductibleAmount: -1 },
    { ...ok, payee: "" },
    { ...ok, property: "" },
  ])("不正な入力を拒否する %#", (input) => {
    expect(RentDetailInput.safeParse(input).success).toBe(false);
  });
});

describe("FixedAssetInput", () => {
  const ok = {
    name: "ノート PC",
    acquiredOn: "2026-05-10",
    acquisitionCost: 250000,
    method: "small_asset_28_2",
    businessRatio: 10000,
    assetAccountId: ID,
  };
  it("正しい入力を受け付ける", () => {
    expect(FixedAssetInput.safeParse(ok).success).toBe(true);
    expect(FixedAssetInput.safeParse({ ...ok, businessRatio: 0 }).success).toBe(true);
  });
  it.each([
    { ...ok, acquisitionCost: 0 },
    { ...ok, acquisitionCost: -1 },
    { ...ok, method: "straight_line" },
    { ...ok, businessRatio: -1 },
    { ...ok, businessRatio: 10001 },
    { ...ok, name: "" },
    { ...ok, acquiredOn: "2026-02-30" },
  ])("不正な入力を拒否する %#", (input) => {
    expect(FixedAssetInput.safeParse(input).success).toBe(false);
  });
});

describe("FixedAssetUpdateInput / FixedAssetDisposeInput / FixedAssetsQuery", () => {
  const asset = {
    name: "ノート PC",
    acquiredOn: "2026-05-10",
    acquisitionCost: 250000,
    method: "small_asset_28_2",
    businessRatio: 10000,
    assetAccountId: ID,
  };
  it("更新は登録の入力に reason（省略・null 可）を足した形", () => {
    expect(FixedAssetUpdateInput.safeParse(asset).success).toBe(true);
    expect(FixedAssetUpdateInput.safeParse({ ...asset, reason: "割合の見直し" }).success).toBe(
      true,
    );
    expect(FixedAssetUpdateInput.safeParse({ ...asset, reason: null }).success).toBe(true);
    expect(FixedAssetUpdateInput.safeParse({ ...asset, acquisitionCost: 0 }).success).toBe(false);
  });
  it("除却は disposedOn（日付）と reason（文字列）", () => {
    expect(
      FixedAssetDisposeInput.safeParse({ disposedOn: "2026-12-01", reason: "廃棄" }).success,
    ).toBe(true);
    expect(FixedAssetDisposeInput.safeParse({ disposedOn: "2026-02-30", reason: "" }).success).toBe(
      false,
    );
    expect(FixedAssetDisposeInput.safeParse({ disposedOn: "2026-12-01" }).success).toBe(false);
  });
  it("一覧のクエリは year（4桁の年、省略可）を数に変える", () => {
    expect(FixedAssetsQuery.parse({ year: "2026" })).toEqual({ year: 2026 });
    expect(FixedAssetsQuery.parse({})).toEqual({});
    expect(FixedAssetsQuery.safeParse({ year: "26" }).success).toBe(false);
    expect(FixedAssetsQuery.safeParse({ year: "abcd" }).success).toBe(false);
  });
});

describe("DeductionAnswersInput", () => {
  const ok = {
    doubleEntry: true,
    statementsAttached: true,
    filedOnTime: true,
    eTax: false,
    electronicBooks: false,
  };
  it("5つの boolean を受け付ける", () => {
    expect(DeductionAnswersInput.safeParse(ok).success).toBe(true);
  });
  it("欠けた項目と boolean 以外を拒否する", () => {
    const { eTax: _omit, ...rest } = ok;
    expect(DeductionAnswersInput.safeParse(rest).success).toBe(false);
    expect(DeductionAnswersInput.safeParse({ ...ok, eTax: 1 }).success).toBe(false);
  });
});

describe("ClosingNoteKind", () => {
  it("2種だけ", () => {
    expect(ClosingNoteKind.safeParse("special_circumstances").success).toBe(true);
    expect(ClosingNoteKind.safeParse("opening_difference").success).toBe(true);
    expect(ClosingNoteKind.safeParse("other").success).toBe(false);
  });
});

describe("TaxReturnMemoInput", () => {
  it("11種の kind を受け付ける（other は label つき）", () => {
    for (const kind of [
      "salary",
      "social_insurance",
      "small_business_mutual_aid",
      "life_insurance",
      "earthquake_insurance",
      "donation",
      "medical",
      "stocks",
      "crypto",
      "foreign_tax_credit",
    ]) {
      expect(TaxReturnMemoInput.safeParse({ kind }).success).toBe(true);
    }
    expect(TaxReturnMemoInput.safeParse({ kind: "other", label: "ふるさと納税" }).success).toBe(
      true,
    );
  });
  it("other で label なし・空は拒否する", () => {
    expect(TaxReturnMemoInput.safeParse({ kind: "other" }).success).toBe(false);
    expect(TaxReturnMemoInput.safeParse({ kind: "other", label: "  " }).success).toBe(false);
    expect(TaxReturnMemoInput.safeParse({ kind: "other", label: null }).success).toBe(false);
  });
  it("amount は 0 以上の整数", () => {
    expect(TaxReturnMemoInput.safeParse({ kind: "salary", amount: 0 }).success).toBe(true);
    expect(TaxReturnMemoInput.safeParse({ kind: "salary", amount: -1 }).success).toBe(false);
    expect(TaxReturnMemoInput.safeParse({ kind: "salary", amount: 1.5 }).success).toBe(false);
  });
  it("filePath は / で始まる絶対パスだけ", () => {
    expect(
      TaxReturnMemoInput.safeParse({ kind: "salary", filePath: "/Users/a/b.pdf" }).success,
    ).toBe(true);
    expect(TaxReturnMemoInput.safeParse({ kind: "salary", filePath: null }).success).toBe(true);
    expect(TaxReturnMemoInput.safeParse({ kind: "salary", filePath: "docs/a.pdf" }).success).toBe(
      false,
    );
    expect(TaxReturnMemoInput.safeParse({ kind: "salary", filePath: "" }).success).toBe(false);
  });
  it("未知の kind を拒否する", () => {
    expect(TaxReturnMemoInput.safeParse({ kind: "unknown" }).success).toBe(false);
  });
});

describe("FiledDocumentInput", () => {
  const ok = { kind: "blue_return", filePath: "/Users/a/r.pdf" };
  it("4種の kind と絶対パスを受け付ける", () => {
    for (const kind of ["blue_return", "tax_return", "attachment", "other"]) {
      expect(FiledDocumentInput.safeParse({ ...ok, kind }).success).toBe(true);
    }
    expect(
      FiledDocumentInput.safeParse({ ...ok, filedOn: "2026-03-10", memo: "控え" }).success,
    ).toBe(true);
  });
  it.each([
    { ...ok, filePath: "docs/a.pdf" },
    { ...ok, filePath: "./a.pdf" },
    { ...ok, filePath: "" },
    { ...ok, kind: "receipt" },
    { kind: "blue_return" },
  ])("不正な入力を拒否する %#", (input) => {
    expect(FiledDocumentInput.safeParse(input).success).toBe(false);
  });
});

describe("BlueReturnWarning", () => {
  it("data-model §2 の14種のコードを受け付ける", () => {
    const codes = [
      "OPTIONAL_LINES_OVERFLOW",
      "PL_MISMATCH",
      "HOME_USE_ADJUSTMENT_STALE",
      "RENT_DETAILS_MISMATCH",
      "DEPRECIATION_MISMATCH",
      "SALES_TOTAL_MISMATCH",
      "SALES_WITHOUT_PARTNER",
      "DUPLICATE_PARTNER_NAME",
      "OPENING_MISMATCH",
      "DEFERRED_ASSET_NOT_AMORTIZED",
      "OPENING_OWNER_ACCOUNTS",
      "NEGATIVE_BALANCE",
      "DEDUCTION_ANSWERS_MISSING",
      "PRIOR_PERIOD_OPEN",
    ];
    expect(codes).toHaveLength(14);
    for (const code of codes) {
      expect(BlueReturnWarning.safeParse({ code, message: "m" }).success).toBe(true);
    }
    expect(BlueReturnWarning.safeParse({ code: "UNKNOWN", message: "m" }).success).toBe(false);
  });
});

describe("BlueReturn / AdjustmentProposal", () => {
  const bsSide = { rows: [{ label: "現金", amount: 100 }], total: 100 };
  const blueReturn = {
    fiscalYear: 2025,
    formYear: 2025,
    status: "open",
    page1: { lines: [{ no: 1, label: "売上", amount: 1000, kind: "account" }] },
    page2: {
      monthly: {
        months: [{ month: 1, sales: 1000, otherIncome: 0, total: 1000 }],
        total: { sales: 1000, otherIncome: 0, total: 1000 },
      },
      rentDetails: [],
      deduction: null,
    },
    page3: {
      salesPartners: { rows: [{ name: "A社", amount: 1000 }], others: 0, withoutPartner: null },
      depreciation: [],
    },
    page4: {
      opening: { assets: bsSide, liabilityEquity: bsSide },
      closing: { assets: bsSide, liabilityEquity: bsSide },
    },
    transfer: { businessIncome: null, blueDeduction: null },
    warnings: [],
  };
  it("決算書を受け付ける", () => {
    expect(BlueReturn.safeParse(blueReturn).success).toBe(true);
  });
  it("1ページの欄の kind は account / optional / computed / unused だけ。省略は拒否する", () => {
    const withLine = (line: object) => ({ ...blueReturn, page1: { lines: [line] } });
    for (const kind of ["account", "optional", "computed", "unused"]) {
      expect(BlueReturn.safeParse(withLine({ no: 2, label: "x", amount: 0, kind })).success).toBe(
        true,
      );
    }
    expect(
      BlueReturn.safeParse(withLine({ no: 2, label: "x", amount: 0, kind: "other" })).success,
    ).toBe(false);
    expect(BlueReturn.safeParse(withLine({ no: 2, label: "x", amount: 0 })).success).toBe(false);
  });
  it("status が open / closed 以外を拒否する", () => {
    expect(BlueReturn.safeParse({ ...blueReturn, status: "draft" }).success).toBe(false);
  });
  it("AdjustmentProposal を受け付ける", () => {
    const proposal = {
      kind: "home_use",
      sourceId: ID,
      journal: {
        date: "2025-12-31",
        description: "家事按分",
        lines: [
          { accountId: ID, side: "debit", amount: 400 },
          { accountId: ID2, side: "credit", amount: 400 },
        ],
      },
      breakdown: { bookAmount: 1000, ratio: 6000, business: 600, home: 400 },
    };
    expect(AdjustmentProposal.safeParse(proposal).success).toBe(true);
    expect(AdjustmentProposal.safeParse({ ...proposal, kind: "other" }).success).toBe(false);
  });
});

describe("ErrorCode（003 のコード、contracts/http-api.md）", () => {
  it("12種のコードがある", () => {
    const codes = [
      "ENTITY_KIND_UNSUPPORTED",
      "HOME_USE_BASIS_REQUIRED",
      "HOME_USE_CHANGE_REASON_REQUIRED",
      "SMALL_ASSET_OVER_THRESHOLD",
      "SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED",
      "SMALL_ASSET_NOT_APPLICABLE",
      "DEPRECIATION_METHOD_UNSUPPORTED",
      "HOME_USE_ACCOUNT_INVALID",
      "ASSET_ACCOUNT_INVALID",
      "REPORT_LINE_INVALID",
      "ADJUSTMENT_NOT_NEEDED",
      "ADJUSTMENT_CHANGED",
    ];
    expect(codes).toHaveLength(12);
    for (const code of codes) expect(ErrorCode.safeParse(code).success).toBe(true);
  });
});
