import { describe, expect, it } from "vitest";
import { type BuildBlueReturnInput, buildBlueReturn } from "../../src/blue-return/build.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { AdjustmentRef, HomeUseAllocation, PostedLine, RentDetail } from "../../src/types.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const RENT = accountIdOf("5230");
const DRAWINGS = accountIdOf("3090");
const CASH = accountIdOf("1010");
const AT = "2026-01-10T00:00:00.000Z";

let seq = 0;
const entry = (debit: string, credit: string, amount: number, id?: string): PostedLine[] => {
  seq += 1;
  const journalId = id ?? `j-${seq}`;
  const base = {
    journalId,
    journalNo: seq,
    date: "2025-06-30",
    memo: null,
    status: "active" as const,
    accountName: "",
    subAccountName: null,
    amount,
    taxCategory: "OUT_OF_SCOPE" as const,
    taxAmount: 0,
    partnerId: null,
    partnerName: null,
    description: null,
    subAccountId: null,
  };
  return [
    { ...base, lineNo: 1, side: "debit", accountId: debit },
    { ...base, lineNo: 2, side: "credit", accountId: credit },
  ];
};

const allocation = (overrides: Partial<HomeUseAllocation> = {}): HomeUseAllocation => ({
  id: "alloc-rent",
  fiscalYear: 2025,
  accountId: RENT,
  subAccountId: null,
  businessRatio: 3000,
  basis: "床面積",
  changeReason: null,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const homeUseRef = (journalId: string): AdjustmentRef => ({
  journalId,
  kind: "home_use",
  allocationId: "alloc-rent",
  assetId: null,
  deferredAssetId: null,
  fiscalYear: 2025,
});

const rentRow = (payee: string, annualRent: number, deductibleAmount: number, sortOrder: number) =>
  ({
    id: `rd-${sortOrder}`,
    fiscalYear: 2025,
    payee,
    property: "事務所",
    annualRent,
    deductibleAmount,
    sortOrder,
  }) satisfies RentDetail;

const build = (over: Partial<BuildBlueReturnInput> = {}) =>
  buildBlueReturn({
    period: makeFiscalPeriod(2025),
    accounts: INDIVIDUAL_ACCOUNT_LIST,
    lines: [],
    deductionAnswers: null,
    taxParameters: TAX_PARAMETERS,
    straightLineRates: STRAIGHT_LINE_RATES,
    ...over,
  });

const line = (r: ReturnType<typeof build>, no: number) =>
  r.page1.lines.find((l) => l.no === no)?.amount;
const warning = (r: ReturnType<typeof build>, code: string) =>
  r.warnings.filter((w) => w.code === code);

describe("buildBlueReturn の家事按分の警告（FR-016）", () => {
  it("按分の登録がなければ HOME_USE_ADJUSTMENT_STALE は出ない", () => {
    const r = build({ lines: entry(RENT, CASH, 1_200_000) });
    expect(warning(r, "HOME_USE_ADJUSTMENT_STALE")).toEqual([]);
  });

  it("振替が未登録なら差額（期待される家事分）つきで警告する。欄23は帳簿のまま", () => {
    const r = build({
      lines: entry(RENT, CASH, 1_200_000),
      allocations: [allocation()],
      adjustmentRefs: [],
    });
    const [w, ...rest] = warning(r, "HOME_USE_ADJUSTMENT_STALE");
    expect(rest).toEqual([]);
    expect(w?.details).toMatchObject({
      allocationId: "alloc-rent",
      accountId: RENT,
      bookAmount: 1_200_000,
      home: 840_000,
      registered: 0,
      difference: 840_000,
    });
    expect(w?.message).toContain("家事分 840,000 円に対して振替済みは 0 円です（差額 840,000 円）");
    expect(line(r, 23)).toBe(1_200_000);
  });

  it("振替を登録すれば警告は消え、欄23は事業分になる", () => {
    const r = build({
      lines: [...entry(RENT, CASH, 1_200_000), ...entry(DRAWINGS, RENT, 840_000, "t-1")],
      allocations: [allocation()],
      adjustmentRefs: [homeUseRef("t-1")],
    });
    expect(warning(r, "HOME_USE_ADJUSTMENT_STALE")).toEqual([]);
    expect(line(r, 23)).toBe(360_000);
  });

  it("振替の後に費用が増えたら差額だけの警告。振替が多すぎれば負の差額", () => {
    const more = build({
      lines: [
        ...entry(RENT, CASH, 1_200_000),
        ...entry(DRAWINGS, RENT, 840_000, "t-1"),
        ...entry(RENT, CASH, 100_000),
      ],
      allocations: [allocation()],
      adjustmentRefs: [homeUseRef("t-1")],
    });
    expect(warning(more, "HOME_USE_ADJUSTMENT_STALE")[0]?.details).toMatchObject({
      difference: 70_000,
    });
    const less = build({
      lines: [...entry(RENT, CASH, 1_000_000), ...entry(DRAWINGS, RENT, 840_000, "t-1")],
      allocations: [allocation()],
      adjustmentRefs: [homeUseRef("t-1")],
    });
    expect(warning(less, "HOME_USE_ADJUSTMENT_STALE")[0]?.details).toMatchObject({
      difference: -140_000,
    });
  });

  it("対象の科目が費用でなくなった登録は、エラーコードつきで警告する（決算書は作る）", () => {
    const r = build({ allocations: [allocation({ accountId: CASH })] });
    const [w] = warning(r, "HOME_USE_ADJUSTMENT_STALE");
    expect(w?.details).toMatchObject({
      allocationId: "alloc-rent",
      errorCode: "HOME_USE_ACCOUNT_INVALID",
    });
  });
});

describe("buildBlueReturn の地代家賃の内訳（FR-017）", () => {
  it("2ページに並び順どおりに載せ、必要経費算入額の合計が欄23と同じなら警告しない", () => {
    const r = build({
      lines: entry(RENT, CASH, 500_000),
      rentDetails: [rentRow("大家B", 200_000, 200_000, 1), rentRow("大家A", 600_000, 300_000, 0)],
    });
    expect(r.page2.rentDetails).toEqual([
      { payee: "大家A", property: "事務所", annualRent: 600_000, deductibleAmount: 300_000 },
      { payee: "大家B", property: "事務所", annualRent: 200_000, deductibleAmount: 200_000 },
    ]);
    expect(warning(r, "RENT_DETAILS_MISMATCH")).toEqual([]);
  });

  it("合計が欄23と違えば RENT_DETAILS_MISMATCH（合計・欄23・差）", () => {
    const r = build({
      lines: entry(RENT, CASH, 500_000),
      rentDetails: [rentRow("大家A", 600_000, 300_000, 0)],
    });
    const [w, ...rest] = warning(r, "RENT_DETAILS_MISMATCH");
    expect(rest).toEqual([]);
    expect(w?.details).toEqual({
      rentDetailsTotal: 300_000,
      line23: 500_000,
      difference: -200_000,
    });
    expect(w?.message).toBe(
      "地代家賃の内訳の必要経費算入額の合計（300,000 円）が欄23（500,000 円）と一致しません",
    );
  });

  it("内訳が空で欄23が 0 でなければ警告、欄23 も 0 なら警告しない", () => {
    const withRent = build({ lines: entry(RENT, CASH, 500_000) });
    expect(warning(withRent, "RENT_DETAILS_MISMATCH")).toHaveLength(1);
    expect(warning(build(), "RENT_DETAILS_MISMATCH")).toEqual([]);
  });

  it("按分後の欄23と内訳の合計を比べる（振替の後に一致する）", () => {
    const r = build({
      lines: [...entry(RENT, CASH, 1_200_000), ...entry(DRAWINGS, RENT, 840_000, "t-1")],
      allocations: [allocation()],
      adjustmentRefs: [homeUseRef("t-1")],
      rentDetails: [rentRow("大家A", 1_200_000, 360_000, 0)],
    });
    expect(warning(r, "RENT_DETAILS_MISMATCH")).toEqual([]);
    expect(warning(r, "HOME_USE_ADJUSTMENT_STALE")).toEqual([]);
  });
});
