import { describe, expect, it } from "vitest";
import {
  AdjustmentCommitInput,
  AdjustmentProposal,
  BlueReturn,
  BlueReturnWarning,
  ClosingNoteKind,
  DeductionAnswersInput,
  DeferredAmortizationInput,
  DeferredAmortizationParam,
  DeferredAssetInput,
  DeferredAssetUpdateInput,
  DepreciationMethod,
  DepreciationRowMethod,
  ErrorCode,
  FixedAssetDisposeInput,
  FixedAssetInput,
  FixedAssetsQuery,
  FixedAssetUpdateInput,
  HomeUseAllocationInput,
  RentDetailInput,
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
  it("3 つの方法を受け付け、省略時の priorAccumulated は 0", () => {
    for (const method of ["small_asset_28_2", "straight_line", "lump_sum"]) {
      expect(FixedAssetInput.safeParse({ ...ok, method }).success).toBe(true);
    }
    const parsed = FixedAssetInput.parse(ok);
    expect(parsed.priorAccumulated).toBe(0);
    const full = FixedAssetInput.parse({
      ...ok,
      method: "straight_line",
      usefulLifeYears: 4,
      inServiceOn: "2026-06-01",
      priorAccumulated: 1000,
      priorThroughYear: 2026,
    });
    expect(full.priorAccumulated).toBe(1000);
    expect(full.priorThroughYear).toBe(2026);
    expect(
      FixedAssetInput.safeParse({ ...ok, inServiceOn: null, priorThroughYear: null }).success,
    ).toBe(true);
  });
  it.each([
    { ...ok, acquisitionCost: 0 },
    { ...ok, acquisitionCost: -1 },
    { ...ok, method: "declining_balance" },
    { ...ok, priorAccumulated: -1 },
    { ...ok, priorThroughYear: 1899 },
    { ...ok, inServiceOn: "2026-02-30" },
    { ...ok, businessRatio: -1 },
    { ...ok, businessRatio: 10001 },
    { ...ok, name: "" },
    { ...ok, acquiredOn: "2026-02-30" },
    { ...ok, acquisitionCost: 1e12 },
    { ...ok, priorAccumulated: 1e12 },
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
  it("除却の種類は scrap / sale だけで、省略時は scrap", () => {
    const base = { disposedOn: "2026-12-01", reason: "廃棄" };
    expect(FixedAssetDisposeInput.parse(base).disposalKind).toBe("scrap");
    expect(FixedAssetDisposeInput.parse({ ...base, disposalKind: "sale" }).disposalKind).toBe(
      "sale",
    );
    expect(FixedAssetDisposeInput.safeParse({ ...base, disposalKind: "gift" }).success).toBe(false);
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
      salesPartners: {
        rows: [{ name: "A社", amount: 1000 }],
        others: 0,
        total: 1000,
        withoutPartner: null,
      },
      depreciation: [],
      specialCircumstances: null,
    },
    page4: {
      opening: { assets: bsSide, liabilityEquity: bsSide },
      closing: { assets: bsSide, liabilityEquity: bsSide },
      carryForwardCheck: "no_prior_year",
      openingDifferenceNote: null,
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
  it("償却と開業費の breakdown を受け付ける", () => {
    const journal = {
      date: "2025-12-31",
      description: "償却",
      lines: [
        { accountId: ID, side: "debit", amount: 400 },
        { accountId: ID2, side: "credit", amount: 400 },
      ],
    };
    const depreciation = {
      kind: "depreciation",
      sourceId: ID,
      journal,
      breakdown: {
        method: "straight_line",
        acquisitionCost: 500000,
        businessRatio: 10000,
        depreciation: 62500,
        deductible: 62500,
        months: 12,
        ratePermille: 250,
        openingBookValue: 500000,
        closingBookValue: 437500,
        disposalKind: null,
        disposalAmount: 0,
        disposalDeductible: 0,
      },
    };
    expect(AdjustmentProposal.safeParse(depreciation).success).toBe(true);
    const deferred = {
      kind: "deferred_amortization",
      sourceId: ID,
      journal,
      breakdown: {
        totalAmount: 600000,
        openingBalance: 600000,
        amount: 100000,
        target: 100000,
        closingBalance: 500000,
      },
    };
    expect(AdjustmentProposal.safeParse(deferred).success).toBe(true);
  });
});

describe("009 の入力と型", () => {
  it("DepreciationMethod は 3 つ、DepreciationRowMethod は deferred を足した 4 つ", () => {
    for (const m of ["small_asset_28_2", "straight_line", "lump_sum"]) {
      expect(DepreciationMethod.safeParse(m).success).toBe(true);
      expect(DepreciationRowMethod.safeParse(m).success).toBe(true);
    }
    expect(DepreciationMethod.safeParse("deferred").success).toBe(false);
    expect(DepreciationRowMethod.safeParse("deferred").success).toBe(true);
  });
  it("DeferredAssetInput / UpdateInput / AmortizationInput / Param", () => {
    const ok = {
      name: "開業費",
      totalAmount: 600000,
      openedOn: "2026-04-01",
      accountId: ID,
    };
    const parsed = DeferredAssetInput.parse(ok);
    expect(parsed.priorAccumulated).toBe(0);
    expect(DeferredAssetInput.safeParse({ ...ok, totalAmount: 0 }).success).toBe(false);
    expect(DeferredAssetInput.safeParse({ ...ok, priorAccumulated: -1 }).success).toBe(false);
    expect(DeferredAssetInput.safeParse({ ...ok, totalAmount: 1e12 }).success).toBe(false);
    expect(DeferredAssetInput.safeParse({ ...ok, priorAccumulated: 1e12 }).success).toBe(false);
    expect(DeferredAssetInput.safeParse({ ...ok, openedOn: "2026-02-30" }).success).toBe(false);
    expect(DeferredAssetUpdateInput.safeParse({ ...ok, reason: "訂正" }).success).toBe(true);
    expect(DeferredAmortizationInput.safeParse({ amount: 0 }).success).toBe(true);
    expect(DeferredAmortizationInput.safeParse({ amount: -1 }).success).toBe(false);
    expect(DeferredAmortizationInput.safeParse({ amount: 1.5 }).success).toBe(false);
    expect(
      DeferredAmortizationParam.safeParse({ year: "2026", deferredAssetId: "x" }).success,
    ).toBe(true);
  });
  it("AdjustmentCommitInput は deferred_amortization を受け付ける", () => {
    expect(
      AdjustmentCommitInput.safeParse({
        kind: "deferred_amortization",
        sourceId: ID,
        expected: { amount: 1 },
      }).success,
    ).toBe(true);
  });
  it("警告のコードに 2 つ、エラーコードに 6 つ足される", () => {
    for (const code of ["ASSET_REGISTER_MISMATCH", "DEPRECIATION_PARAMETER_MISSING"]) {
      expect(BlueReturnWarning.safeParse({ code, message: "m" }).success).toBe(true);
    }
    for (const code of [
      "USEFUL_LIFE_UNSUPPORTED",
      "LUMP_SUM_COST_OUT_OF_RANGE",
      "PRIOR_ACCUMULATED_INVALID",
      "TAX_PARAMETER_MISSING",
      "DEFERRED_AMORTIZATION_OVER_LIMIT",
      "DEPRECIATION_JOURNAL_EXISTS",
    ]) {
      expect(ErrorCode.safeParse(code).success).toBe(true);
    }
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
