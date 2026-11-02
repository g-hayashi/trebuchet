import { describe, expect, it } from "vitest";
import {
  computeHomeUse,
  type HomeUseInput,
  proposeHomeUseAdjustment,
  validateHomeUseAllocation,
} from "../../src/blue-return/home-use.ts";
import type { AdjustmentRef, HomeUseAllocation, PostedLine, SubAccount } from "../../src/types.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const RENT = accountIdOf("5230");
const UTILITIES = accountIdOf("5100");
const DRAWINGS = accountIdOf("3090");
const CASH = accountIdOf("1010");
const SALES = accountIdOf("4010");
const PERIOD = makeFiscalPeriod(2025);
const AT = "2026-01-10T00:00:00.000Z";

const allocation = (overrides: Partial<HomeUseAllocation> = {}): HomeUseAllocation => ({
  id: "alloc-rent",
  fiscalYear: 2025,
  accountId: RENT,
  subAccountId: null,
  businessRatio: 3000,
  basis: "床面積 15㎡／50㎡",
  changeReason: null,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

let seq = 0;
/** 1 件の仕訳の行（借方 debit / 貸方 credit、同じ金額） */
const journal = (
  debit: string,
  credit: string,
  amount: number,
  opts: { id?: string; debitSub?: string | null; creditSub?: string | null } = {},
): PostedLine[] => {
  seq += 1;
  const journalId = opts.id ?? `j-${seq}`;
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
  };
  return [
    { ...base, lineNo: 1, side: "debit", accountId: debit, subAccountId: opts.debitSub ?? null },
    { ...base, lineNo: 2, side: "credit", accountId: credit, subAccountId: opts.creditSub ?? null },
  ];
};

const input = (overrides: Partial<HomeUseInput> = {}): HomeUseInput => {
  const a = overrides.allocation ?? allocation();
  return {
    allocation: a,
    allocations: [a],
    accounts: INDIVIDUAL_ACCOUNT_LIST,
    period: PERIOD,
    lines: [],
    refs: [],
    ...overrides,
  };
};

const ref = (journalId: string, allocationId = "alloc-rent"): AdjustmentRef => ({
  journalId,
  kind: "home_use",
  allocationId,
  assetId: null,
  deferredAssetId: null,
  fiscalYear: 2025,
});

const propose = (i: HomeUseInput) => {
  const r = proposeHomeUseAdjustment(i);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("computeHomeUse（R5）", () => {
  it("事業分は切り捨て、家事分は残り", () => {
    expect(computeHomeUse(1_200_000, 3000)).toEqual({ business: 360_000, home: 840_000 });
    // 1001 × 28.5% = 285.285 → 事業分 285、家事分 716
    expect(computeHomeUse(1001, 2850)).toEqual({ business: 285, home: 716 });
    expect(computeHomeUse(9999, 1)).toEqual({ business: 0, home: 9999 });
  });

  it("割合 10000 は家事分 0、0 は事業分 0", () => {
    expect(computeHomeUse(12_345, 10000)).toEqual({ business: 12_345, home: 0 });
    expect(computeHomeUse(12_345, 0)).toEqual({ business: 0, home: 12_345 });
  });

  it("帳簿の金額が 0 以下なら按分しない（どちらも 0）", () => {
    expect(computeHomeUse(0, 3000)).toEqual({ business: 0, home: 0 });
    expect(computeHomeUse(-5000, 3000)).toEqual({ business: 0, home: 0 });
  });

  it("割合が 0〜10000 の整数でなければ例外", () => {
    expect(() => computeHomeUse(100, 10001)).toThrow(RangeError);
    expect(() => computeHomeUse(100, -1)).toThrow(RangeError);
    expect(() => computeHomeUse(100, 28.5)).toThrow(RangeError);
  });
});

describe("validateHomeUseAllocation（FR-012〜013）", () => {
  const SUB: SubAccount = { id: "sub-elec", accountId: UTILITIES, name: "電気", isActive: true };
  const ctx = (previous?: Pick<HomeUseAllocation, "businessRatio">) => ({
    accounts: INDIVIDUAL_ACCOUNT_LIST,
    subAccounts: [SUB],
    previous,
  });
  const draft = {
    fiscalYear: 2025,
    accountId: RENT,
    subAccountId: null,
    businessRatio: 3000,
    basis: "床面積 15㎡／50㎡",
    changeReason: null,
  };
  const codeOf = (r: ReturnType<typeof validateHomeUseAllocation>) => (r.ok ? "ok" : r.error.code);

  it("費用の科目で根拠があれば通る。根拠は前後の空白を除く", () => {
    const r = validateHomeUseAllocation({ ...draft, basis: "  床面積  " }, ctx());
    expect(r.ok && r.value).toEqual({ ...draft, basis: "床面積" });
  });

  it("区分が費用でない科目は HOME_USE_ACCOUNT_INVALID", () => {
    expect(codeOf(validateHomeUseAllocation({ ...draft, accountId: CASH }, ctx()))).toBe(
      "HOME_USE_ACCOUNT_INVALID",
    );
    expect(codeOf(validateHomeUseAllocation({ ...draft, accountId: SALES }, ctx()))).toBe(
      "HOME_USE_ACCOUNT_INVALID",
    );
    expect(codeOf(validateHomeUseAllocation({ ...draft, accountId: "missing" }, ctx()))).toBe(
      "HOME_USE_ACCOUNT_INVALID",
    );
  });

  it("補助科目は対象の科目のものに限る", () => {
    expect(
      codeOf(
        validateHomeUseAllocation({ ...draft, accountId: UTILITIES, subAccountId: SUB.id }, ctx()),
      ),
    ).toBe("ok");
    expect(codeOf(validateHomeUseAllocation({ ...draft, subAccountId: SUB.id }, ctx()))).toBe(
      "VALIDATION",
    );
  });

  it("根拠が空（空白だけ）なら HOME_USE_BASIS_REQUIRED（シナリオ2）", () => {
    expect(codeOf(validateHomeUseAllocation({ ...draft, basis: "" }, ctx()))).toBe(
      "HOME_USE_BASIS_REQUIRED",
    );
    expect(codeOf(validateHomeUseAllocation({ ...draft, basis: "  " }, ctx()))).toBe(
      "HOME_USE_BASIS_REQUIRED",
    );
  });

  it("割合が 0〜10000 の整数でなければ VALIDATION", () => {
    for (const businessRatio of [-1, 10001, 12.5]) {
      expect(codeOf(validateHomeUseAllocation({ ...draft, businessRatio }, ctx()))).toBe(
        "VALIDATION",
      );
    }
  });

  it("前の年度と割合が違い理由が空なら HOME_USE_CHANGE_REASON_REQUIRED（シナリオ3）", () => {
    const prev = { businessRatio: 2500 };
    expect(codeOf(validateHomeUseAllocation(draft, ctx(prev)))).toBe(
      "HOME_USE_CHANGE_REASON_REQUIRED",
    );
    expect(codeOf(validateHomeUseAllocation({ ...draft, changeReason: " " }, ctx(prev)))).toBe(
      "HOME_USE_CHANGE_REASON_REQUIRED",
    );
    const r = validateHomeUseAllocation({ ...draft, changeReason: " 在宅勤務の増加 " }, ctx(prev));
    expect(r.ok && r.value.changeReason).toBe("在宅勤務の増加");
    // 前の年度と同じ割合、前の年度の登録がない場合は理由なしでよい
    expect(codeOf(validateHomeUseAllocation(draft, ctx({ businessRatio: 3000 })))).toBe("ok");
    expect(codeOf(validateHomeUseAllocation(draft, ctx()))).toBe("ok");
  });
});

describe("proposeHomeUseAdjustment（FR-014・FR-016、R6）", () => {
  it("シナリオ1: 1,200,000円 × 30% → 事業主貸 840,000 / 地代家賃 840,000 の年度末日付の案", () => {
    const a = propose(input({ lines: journal(RENT, CASH, 1_200_000) }));
    expect(a).toMatchObject({
      bookAmount: 1_200_000,
      ratio: 3000,
      business: 360_000,
      home: 840_000,
      registered: 0,
      difference: 840_000,
      reason: null,
    });
    expect(a.proposal?.kind).toBe("home_use");
    expect(a.proposal?.sourceId).toBe("alloc-rent");
    expect(a.proposal?.breakdown).toEqual({
      bookAmount: 1_200_000,
      ratio: 3000,
      business: 360_000,
      home: 840_000,
    });
    expect(a.proposal?.journal.date).toBe("2025-12-31");
    expect(a.proposal?.journal.lines).toEqual([
      { side: "debit", accountId: DRAWINGS, amount: 840_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: RENT, amount: 840_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
  });

  it("振替を登録した後は差額 0 で案なし。帳簿の金額は振替の行を除く", () => {
    const transfer = journal(DRAWINGS, RENT, 840_000, { id: "t-1" });
    const a = propose(
      input({ lines: [...journal(RENT, CASH, 1_200_000), ...transfer], refs: [ref("t-1")] }),
    );
    expect(a).toMatchObject({
      bookAmount: 1_200_000,
      registered: 840_000,
      difference: 0,
      proposal: null,
      reason: "UP_TO_DATE",
    });
  });

  it("シナリオ5: 振替の後に費用が増えたら、差額だけの追加の案", () => {
    const transfer = journal(DRAWINGS, RENT, 840_000, { id: "t-1" });
    const a = propose(
      input({
        lines: [...journal(RENT, CASH, 1_200_000), ...transfer, ...journal(RENT, CASH, 100_000)],
        refs: [ref("t-1")],
      }),
    );
    // 1,300,000 × 30% = 390,000 → 家事分 910,000、差額 70,000
    expect(a).toMatchObject({ bookAmount: 1_300_000, home: 910_000, difference: 70_000 });
    expect(a.proposal?.journal.lines).toEqual([
      { side: "debit", accountId: DRAWINGS, amount: 70_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: RENT, amount: 70_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
  });

  it("費用の仕訳を取り消した後は逆向き（地代家賃 / 事業主貸、差額の絶対値）の案", () => {
    // 100,000 の家賃の仕訳を取り消した（行に含まれない）。振替は 1,300,000 から求めた 910,000
    const transfer = journal(DRAWINGS, RENT, 910_000, { id: "t-1" });
    const a = propose(
      input({ lines: [...journal(RENT, CASH, 1_200_000), ...transfer], refs: [ref("t-1")] }),
    );
    expect(a).toMatchObject({ home: 840_000, registered: 910_000, difference: -70_000 });
    expect(a.proposal?.journal.lines).toEqual([
      { side: "debit", accountId: RENT, amount: 70_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: DRAWINGS, amount: 70_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
  });

  it("逆向きの振替も登録済みの合計に含める（符号つき）", () => {
    const lines = [
      ...journal(RENT, CASH, 1_200_000),
      ...journal(DRAWINGS, RENT, 910_000, { id: "t-1" }),
      ...journal(RENT, DRAWINGS, 70_000, { id: "t-2" }),
    ];
    const a = propose(input({ lines, refs: [ref("t-1"), ref("t-2")] }));
    expect(a).toMatchObject({ registered: 840_000, difference: 0, proposal: null });
  });

  it("取り消された振替（行に含まれない、status voided）は登録済みに数えない", () => {
    const voided = journal(DRAWINGS, RENT, 840_000, { id: "t-1" }).map((l) => ({
      ...l,
      status: "voided" as const,
    }));
    const a = propose(
      input({ lines: [...journal(RENT, CASH, 1_200_000), ...voided], refs: [ref("t-1")] }),
    );
    expect(a).toMatchObject({ bookAmount: 1_200_000, registered: 0, difference: 840_000 });
  });

  it("他の按分の振替の行も帳簿の金額から除く", () => {
    const lines = [
      ...journal(RENT, CASH, 1_200_000),
      ...journal(DRAWINGS, RENT, 500, { id: "other" }),
    ];
    const a = propose(input({ lines, refs: [ref("other", "alloc-other")] }));
    expect(a).toMatchObject({ bookAmount: 1_200_000, registered: 0 });
  });

  it("帳簿の金額 ≤ 0 で振替もなければ案なし（理由つき）", () => {
    expect(propose(input())).toMatchObject({
      bookAmount: 0,
      proposal: null,
      reason: "BOOK_AMOUNT_NOT_POSITIVE",
    });
    const refund = journal(CASH, RENT, 3000);
    expect(propose(input({ lines: refund }))).toMatchObject({
      bookAmount: -3000,
      business: 0,
      home: 0,
      proposal: null,
      reason: "BOOK_AMOUNT_NOT_POSITIVE",
    });
  });

  it("帳簿の金額 ≤ 0 でも登録済みの振替があれば、全額を戻す案", () => {
    const lines = journal(DRAWINGS, RENT, 840_000, { id: "t-1" });
    const a = propose(input({ lines, refs: [ref("t-1")] }));
    expect(a).toMatchObject({ bookAmount: 0, home: 0, difference: -840_000 });
    expect(a.proposal?.journal.lines).toEqual([
      { side: "debit", accountId: RENT, amount: 840_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: DRAWINGS, amount: 840_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
  });

  it("割合 10000 は案なし（理由つき）。登録済みの振替があれば戻す案", () => {
    const a = allocation({ businessRatio: 10000 });
    expect(
      propose(input({ allocation: a, allocations: [a], lines: journal(RENT, CASH, 1_200_000) })),
    ).toMatchObject({ home: 0, proposal: null, reason: "FULL_BUSINESS" });
    const lines = [
      ...journal(RENT, CASH, 1_200_000),
      ...journal(DRAWINGS, RENT, 840_000, { id: "t-1" }),
    ];
    const back = propose(input({ allocation: a, allocations: [a], lines, refs: [ref("t-1")] }));
    expect(back.difference).toBe(-840_000);
  });

  it("補助科目の指定があればその補助科目の行だけ。科目全体の按分は他の按分の補助科目を除く", () => {
    const elec = allocation({
      id: "alloc-elec",
      accountId: UTILITIES,
      subAccountId: "sub-elec",
      businessRatio: 5000,
    });
    const rest = allocation({ id: "alloc-util", accountId: UTILITIES, businessRatio: 2000 });
    const lines = [
      ...journal(UTILITIES, CASH, 10_000, { debitSub: "sub-elec" }),
      ...journal(UTILITIES, CASH, 4_000, { debitSub: "sub-water" }),
      ...journal(UTILITIES, CASH, 1_000),
    ];
    const both = [elec, rest];
    const e = propose(input({ allocation: elec, allocations: both, lines }));
    expect(e).toMatchObject({ bookAmount: 10_000, home: 5_000 });
    expect(e.proposal?.journal.lines).toEqual([
      { side: "debit", accountId: DRAWINGS, amount: 5_000, taxCategory: "OUT_OF_SCOPE" },
      {
        side: "credit",
        accountId: UTILITIES,
        subAccountId: "sub-elec",
        amount: 5_000,
        taxCategory: "OUT_OF_SCOPE",
      },
    ]);
    const r = propose(input({ allocation: rest, allocations: both, lines }));
    expect(r).toMatchObject({ bookAmount: 5_000, business: 1_000, home: 4_000 });
  });

  it("対象が費用の科目でなければ HOME_USE_ACCOUNT_INVALID", () => {
    const a = allocation({ accountId: CASH });
    const r = proposeHomeUseAdjustment(input({ allocation: a, allocations: [a] }));
    expect(!r.ok && r.error.code).toBe("HOME_USE_ACCOUNT_INVALID");
  });

  it("事業主貸（3090）の科目がなければ ACCOUNT_NOT_FOUND", () => {
    const r = proposeHomeUseAdjustment(
      input({
        accounts: INDIVIDUAL_ACCOUNT_LIST.filter((x) => x.code !== "3090"),
        lines: journal(RENT, CASH, 1000),
      }),
    );
    expect(!r.ok && r.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
