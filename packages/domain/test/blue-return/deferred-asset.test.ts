import { describe, expect, it } from "vitest";
import {
  deferredAmortizationYear,
  deferredRows,
  proposeDeferredAmortization,
  validateDeferredAsset,
  validateDeferredDecision,
} from "../../src/blue-return/deferred-asset.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { DeferredAmortization, DeferredAsset } from "../../src/types.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const AT = "2026-01-10T00:00:00.000Z";
const accounts = INDIVIDUAL_ACCOUNT_LIST;
const taxParameters = TAX_PARAMETERS;

/** 開業費（既定: 2025-04-01 開業、総額 300,000 円、累計 45,000 円（2025 年分まで）、1080 開業費） */
const deferred = (over: Partial<DeferredAsset> = {}): DeferredAsset => ({
  id: "deferred-1",
  name: "開業費",
  totalAmount: 300_000,
  openedOn: "2025-04-01",
  priorAccumulated: 45_000,
  priorThroughYear: 2025,
  accountId: accountIdOf("1080"),
  note: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const decision = (fiscalYear: number, amount: number): DeferredAmortization => ({
  deferredAssetId: "deferred-1",
  fiscalYear,
  amount,
  decidedAt: AT,
  updatedAt: AT,
});

const view = (
  asset: DeferredAsset,
  fiscalYear: number,
  decisions: DeferredAmortization[] = [],
  active: number[] = [],
) => {
  const r = deferredAmortizationYear(asset, fiscalYear, {
    decisions,
    activeRefs: new Set(active),
    taxParameters,
  });
  if (!r.ok) throw new Error(`計算できません: ${r.error.code}`);
  return r.value;
};

const draftOf = (over: Partial<Omit<DeferredAsset, "createdAt" | "updatedAt">> = {}) => {
  const { createdAt: _c, updatedAt: _u, id: _i, ...rest } = deferred();
  return { ...rest, ...over };
};

describe("validateDeferredAsset（FR-012、R5）", () => {
  it("正しい入力はそのまま通り、名前・備考の空白を除く（空の備考は null）", () => {
    const r = validateDeferredAsset(draftOf({ name: " 開業費 ", note: "  " }), { accounts });
    expect(r.ok && r.value).toMatchObject({ name: "開業費", note: null, totalAmount: 300_000 });
  });

  it("名称が空なら VALIDATION（field は name）", () => {
    const r = validateDeferredAsset(draftOf({ name: "  " }), { accounts });
    expect(!r.ok && r.error.code).toBe("VALIDATION");
    expect(!r.ok && r.error.details).toMatchObject({ field: "name" });
  });

  it("総額は 1 円以上 10^12 円未満の整数、開業日は YYYY-MM-DD", () => {
    for (const totalAmount of [0, -1, 1.5, 1e12]) {
      const r = validateDeferredAsset(draftOf({ totalAmount }), { accounts });
      expect(!r.ok && r.error.code).toBe("VALIDATION");
      expect(!r.ok && r.error.details).toMatchObject({ field: "totalAmount" });
    }
    const date = validateDeferredAsset(draftOf({ openedOn: "2025-13-01" }), { accounts });
    expect(!date.ok && date.error.code).toBe("VALIDATION");
    expect(!date.ok && date.error.details).toMatchObject({ field: "openedOn" });
  });

  it("勘定は区分が資産の科目に限る（ASSET_ACCOUNT_INVALID）", () => {
    for (const accountId of [accountIdOf("5180"), "no-such-account"]) {
      const r = validateDeferredAsset(draftOf({ accountId }), { accounts });
      expect(!r.ok && r.error.code).toBe("ASSET_ACCOUNT_INVALID");
    }
  });

  it("累計は 0 以上総額以下の整数。0 より大きければ累計の年が要り、開業の年以上", () => {
    const code = (over: Partial<DeferredAsset>) => {
      const r = validateDeferredAsset(draftOf(over), { accounts });
      return r.ok ? "ok" : r.error.code;
    };
    expect(code({ priorAccumulated: 300_000 })).toBe("ok");
    expect(code({ priorAccumulated: 300_001 })).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(code({ priorAccumulated: -1 })).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(code({ priorAccumulated: 1.5 })).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(code({ priorAccumulated: 1, priorThroughYear: null })).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(code({ priorThroughYear: 2024 })).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(code({ priorThroughYear: 2025.5 })).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(code({ priorAccumulated: 0, priorThroughYear: null })).toBe("ok");
    expect(code({ priorAccumulated: 0, priorThroughYear: 2025 })).toBe("ok");
  });

  it("更新のときの id を保つ", () => {
    const r = validateDeferredAsset({ ...draftOf(), id: "deferred-9" }, { accounts });
    expect(r.ok && r.value.id).toBe("deferred-9");
  });
});

describe("deferredAmortizationYear（FR-013、R5、INV-58）", () => {
  it("US3 シナリオ1: 累計 45,000（2025 年分まで）の 2026 年は、上限 255,000 円、目安は 12 か月分 60,000 円", () => {
    const v = view(deferred(), 2026);
    expect(v).toMatchObject({
      fiscalYear: 2026,
      openingBalance: 255_000,
      target: 60_000,
      decision: null,
      registered: false,
      closingBalance: 255_000,
    });
  });

  it("開業の年は開業の月から数える（4 月開業なら 4〜12 月の 9 か月）。目安は切り上げ", () => {
    const v = view(deferred({ priorAccumulated: 0, priorThroughYear: null }), 2025);
    expect(v.openingBalance).toBe(300_000);
    expect(v.target).toBe(45_000); // 300,000 × 9 / 60
    const odd = view(
      deferred({ totalAmount: 100_001, priorAccumulated: 0, priorThroughYear: null }),
      2026,
    );
    expect(odd.target).toBe(20_001); // ⌈100,001 × 12 / 60⌉ = ⌈20,000.2⌉
  });

  it("60 か月の最後の年（2030 年は 1〜3 月の 3 か月）と、60 か月を過ぎた年（目安 0、上限は残る）", () => {
    const asset = deferred({ priorAccumulated: 0, priorThroughYear: null });
    expect(view(asset, 2030).target).toBe(15_000);
    const after = view(asset, 2031);
    expect(after.target).toBe(0);
    expect(after.openingBalance).toBe(300_000);
    expect(after.closingBalance).toBe(300_000);
  });

  it("目安は上限で抑える", () => {
    const asset = deferred({
      totalAmount: 300_000,
      priorAccumulated: 290_000,
      priorThroughYear: 2025,
    });
    expect(view(asset, 2026).target).toBe(10_000); // min(10,000, 60,000)
  });

  it("有効な仕訳のある決定だけが翌年度の上限を減らす（取り消された仕訳の決定は減らさない）", () => {
    const asset = deferred();
    const decisions = [decision(2026, 100_000)];
    const registered = view(asset, 2027, decisions, [2026]);
    expect(registered.openingBalance).toBe(155_000);
    const cancelled = view(asset, 2027, decisions, []);
    expect(cancelled.openingBalance).toBe(255_000);
  });

  it("決定・登録済みはその年度のものを返す。期末は決定の額を引いた残高（決定がなければ期首のまま）", () => {
    const asset = deferred();
    const decisions = [decision(2026, 255_000), decision(2027, 1)];
    const v = view(asset, 2026, decisions, [2026]);
    expect(v.decision).toMatchObject({ fiscalYear: 2026, amount: 255_000 });
    expect(v.registered).toBe(true);
    expect(v.closingBalance).toBe(0);
    const noJournal = view(asset, 2026, decisions, []);
    expect(noJournal.registered).toBe(false);
    expect(noJournal.decision?.amount).toBe(255_000);
    expect(noJournal.closingBalance).toBe(0);
  });

  it("別の開業費の決定は使わない", () => {
    const other = { ...decision(2026, 100_000), deferredAssetId: "deferred-2" };
    expect(view(deferred(), 2026, [other]).decision).toBeNull();
  });

  it("開始年度（累計の年の翌年、なければ開業の年）より前の年度は計算しない（目安 0、残高は 総額 − 累計）", () => {
    const v = view(deferred(), 2025, [decision(2025, 1)]);
    expect(v).toMatchObject({
      openingBalance: 255_000,
      target: 0,
      decision: null,
      closingBalance: 255_000,
    });
    const beforeOpen = view(deferred({ priorAccumulated: 0, priorThroughYear: null }), 2024);
    expect(beforeOpen).toMatchObject({ openingBalance: 300_000, target: 0, decision: null });
  });

  it("60 か月の月数に税制の値がなければ TAX_PARAMETER_MISSING（details.key・date）", () => {
    const r = deferredAmortizationYear(deferred(), 2026, {
      decisions: [],
      activeRefs: new Set(),
      taxParameters: [],
    });
    expect(!r.ok && r.error.code).toBe("TAX_PARAMETER_MISSING");
    expect(!r.ok && r.error.details).toMatchObject({
      key: "OPENING_COST_AMORTIZATION_MONTHS",
      date: "2025-04-01",
    });
  });
});

describe("validateDeferredDecision（FR-014、INV-58）", () => {
  const v = view(deferred(), 2026); // 上限 255,000

  it("0 円から上限までの整数は通る", () => {
    for (const amount of [0, 1, 60_000, 255_000]) {
      const r = validateDeferredDecision(v, amount);
      expect(r.ok && r.value).toBe(amount);
    }
  });

  it("US3 シナリオ3: 上限を超えると DEFERRED_AMORTIZATION_OVER_LIMIT（details.limit）", () => {
    const r = validateDeferredDecision(v, 255_001);
    expect(!r.ok && r.error.code).toBe("DEFERRED_AMORTIZATION_OVER_LIMIT");
    expect(!r.ok && r.error.details).toMatchObject({ limit: 255_000 });
  });

  it("負・非整数は VALIDATION（field は amount）", () => {
    for (const amount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = validateDeferredDecision(v, amount);
      expect(!r.ok && r.error.code).toBe("VALIDATION");
      expect(!r.ok && r.error.details).toMatchObject({ field: "amount" });
    }
  });
});

describe("proposeDeferredAmortization（FR-015〜017、INV-23）", () => {
  const propose = (
    asset: DeferredAsset,
    decisions: DeferredAmortization[],
    active: number[] = [],
    fiscalYear = 2026,
    accs = accounts,
  ) =>
    proposeDeferredAmortization(
      asset,
      view(asset, fiscalYear, decisions, active),
      fiscalYear,
      accs,
    );

  it("US3 シナリオ2: 決定の額で「減価償却費 / 開業費の勘定」の案（年度末日、対象外）", () => {
    const r = propose(deferred(), [decision(2026, 255_000)]);
    expect(r.ok).toBe(true);
    const p = r.ok ? r.value : null;
    expect(p).not.toBeNull();
    expect(p?.kind).toBe("deferred_amortization");
    expect(p?.sourceId).toBe("deferred-1");
    expect(p?.journal.date).toBe("2026-12-31");
    expect(p?.journal.lines).toEqual([
      {
        side: "debit",
        accountId: accountIdOf("5180"),
        amount: 255_000,
        taxCategory: "OUT_OF_SCOPE",
      },
      {
        side: "credit",
        accountId: accountIdOf("1080"),
        amount: 255_000,
        taxCategory: "OUT_OF_SCOPE",
      },
    ]);
    expect(p?.breakdown).toEqual({
      totalAmount: 300_000,
      openingBalance: 255_000,
      amount: 255_000,
      target: 60_000,
      closingBalance: 0,
    });
  });

  it("開業費の勘定は資産の登録の勘定（1080 でなくてもよい）", () => {
    const r = propose(deferred({ accountId: accountIdOf("1070") }), [decision(2026, 10_000)]);
    const lines = r.ok ? (r.value?.journal.lines ?? []) : [];
    expect(lines[1]?.accountId).toBe(accountIdOf("1070"));
  });

  it("決定がない・0 円・登録済みは案なし（null）", () => {
    expect(propose(deferred(), [])).toEqual({ ok: true, value: null });
    expect(propose(deferred(), [decision(2026, 0)])).toEqual({ ok: true, value: null });
    expect(propose(deferred(), [decision(2026, 10_000)], [2026])).toEqual({
      ok: true,
      value: null,
    });
  });

  it("減価償却費の科目（5180）がなければ ACCOUNT_NOT_FOUND（details.code）", () => {
    const r = propose(
      deferred(),
      [decision(2026, 10_000)],
      [],
      2026,
      accounts.filter((a) => a.code !== "5180"),
    );
    expect(!r.ok && r.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(!r.ok && r.error.details).toMatchObject({ code: "5180" });
    expect(!r.ok && r.error.message).toBe("勘定科目（コード 5180）が見つかりません");
  });
});

describe("deferredRows（FR-019、R11）", () => {
  const ctx = (
    decisions: DeferredAmortization[],
    active: Map<string, Set<number>> = new Map(),
  ) => ({
    decisions,
    activeRefs: active,
    taxParameters,
  });

  it("決定の額 > 0 の年度だけ、開業費の行を載せる（登録の有無を問わない）", () => {
    const asset = deferred({ note: "開業準備" });
    const rows = deferredRows([asset], 2026, ctx([decision(2026, 60_000)]));
    expect(rows).toEqual([
      {
        assetId: "deferred-1",
        name: "開業費",
        quantity: null,
        acquiredOn: "2025-04-01",
        cost: 300_000,
        source: "deferred_asset",
        method: "deferred",
        usefulLifeYears: null,
        ratePermille: null,
        months: null,
        disposedOn: null,
        base: 300_000,
        ordinary: 60_000,
        total: 60_000,
        businessRatio: 10000,
        deductible: 60_000,
        closingBookValue: 195_000,
        note: "開業準備",
      },
    ]);
  });

  it("決定がない・0 円・別の年度の決定・開始年度より前の年度は載せない", () => {
    const asset = deferred();
    expect(deferredRows([asset], 2026, ctx([]))).toEqual([]);
    expect(deferredRows([asset], 2026, ctx([decision(2026, 0)]))).toEqual([]);
    expect(deferredRows([asset], 2026, ctx([decision(2027, 10_000)]))).toEqual([]);
    expect(deferredRows([asset], 2025, ctx([decision(2025, 10_000)]))).toEqual([]);
  });

  it("前の年度の有効な償却を引いた残高から計算し、行は開業日・ID の順", () => {
    const a = deferred();
    const b = deferred({ id: "deferred-0", openedOn: "2025-01-01", priorAccumulated: 0 });
    const decisions = [
      decision(2026, 10_000),
      { ...decision(2026, 20_000), deferredAssetId: "deferred-0" },
      decision(2027, 5_000),
    ];
    const rows = deferredRows(
      [a, b],
      2027,
      ctx(decisions, new Map([["deferred-1", new Set([2026])]])),
    );
    expect(rows.map((r) => r.assetId)).toEqual(["deferred-1"]);
    expect(rows[0]?.closingBookValue).toBe(300_000 - 45_000 - 10_000 - 5_000);
    const both = deferredRows([a, b], 2026, ctx(decisions));
    expect(both.map((r) => r.assetId)).toEqual(["deferred-0", "deferred-1"]);
  });

  it("税制の値がなく計算できない開業費は載せない", () => {
    expect(
      deferredRows([deferred()], 2026, {
        decisions: [decision(2026, 10_000)],
        activeRefs: new Map(),
        taxParameters: [],
      }),
    ).toEqual([]);
  });
});
