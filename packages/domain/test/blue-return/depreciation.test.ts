import { describe, expect, it } from "vitest";
import {
  depreciate,
  type FixedAssetDraft,
  proposeDepreciationAdjustment,
  validateFixedAsset,
} from "../../src/blue-return/depreciation.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { FixedAsset } from "../../src/types.ts";
import { accountIdOf, INDIVIDUAL_ACCOUNT_LIST } from "../blue-return-arbitraries.ts";

const EQUIPMENT = accountIdOf("1060");
const DEPRECIATION = accountIdOf("5180");
const DRAWINGS = accountIdOf("3090");
const AT = "2026-01-10T00:00:00.000Z";

const asset = (over: Partial<FixedAsset> = {}): FixedAsset => ({
  id: "asset-1",
  name: "ノートパソコン",
  quantity: null,
  acquiredOn: "2025-06-15",
  acquisitionCost: 200_000,
  method: "small_asset_28_2",
  usefulLifeYears: null,
  inServiceOn: null,
  priorAccumulated: 0,
  priorThroughYear: null,
  businessRatio: 10000,
  assetAccountId: EQUIPMENT,
  linkedJournalId: null,
  note: null,
  disposedOn: null,
  disposalKind: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const draft = (over: Partial<FixedAssetDraft> = {}): FixedAssetDraft => ({
  name: "ノートパソコン",
  quantity: null,
  acquiredOn: "2025-06-15",
  acquisitionCost: 200_000,
  method: "small_asset_28_2",
  usefulLifeYears: null,
  inServiceOn: null,
  priorAccumulated: 0,
  priorThroughYear: null,
  businessRatio: 10000,
  assetAccountId: EQUIPMENT,
  linkedJournalId: null,
  note: null,
  ...over,
});

const ctx = { accounts: INDIVIDUAL_ACCOUNT_LIST, taxParameters: TAX_PARAMETERS };
const validate = (d: FixedAssetDraft, same: readonly FixedAsset[] = []) =>
  validateFixedAsset(d, same, ctx);
const errorOf = (r: ReturnType<typeof validate>) => {
  if (r.ok) throw new Error("エラーを期待しました");
  return r.error;
};

describe("validateFixedAsset（FR-018〜020、R7）", () => {
  it("取得価額 200,000 円・割合 100% は登録できる（シナリオ1）", () => {
    const r = validate(draft());
    expect(r.ok).toBe(true);
  });

  it("名前・備考の前後の空白を除き、空の数量・備考は null にする", () => {
    const r = validate(draft({ name: "  ノートPC  ", quantity: " ", note: "" }));
    expect(r.ok && r.value).toMatchObject({ name: "ノートPC", quantity: null, note: null });
  });

  it("資産の勘定の区分が資産でなければ ASSET_ACCOUNT_INVALID", () => {
    const e = errorOf(validate(draft({ assetAccountId: DEPRECIATION })));
    expect(e.code).toBe("ASSET_ACCOUNT_INVALID");
    expect(errorOf(validate(draft({ assetAccountId: "no-such" }))).code).toBe(
      "ASSET_ACCOUNT_INVALID",
    );
  });

  it("少額の特例以外の方法は DEPRECIATION_METHOD_UNSUPPORTED（シナリオ6）", () => {
    const bad = { ...draft(), method: "declining_balance" } as unknown as FixedAssetDraft;
    expect(errorOf(validate(bad)).code).toBe("DEPRECIATION_METHOD_UNSUPPORTED");
  });

  it("名前が空、取得価額が正の整数でない、割合が範囲外、日付の形が違えば VALIDATION", () => {
    expect(errorOf(validate(draft({ name: " " }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ acquisitionCost: 0 }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ acquisitionCost: 1.5 }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ businessRatio: 10001 }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ businessRatio: -1 }))).code).toBe("VALIDATION");
    expect(errorOf(validate(draft({ acquiredOn: "2025/06/15" }))).code).toBe("VALIDATION");
  });

  describe("基準額（取得の日に適用される値。シナリオ2）", () => {
    it("2026-03-31 取得の 350,000 円は拒否し、基準額と適用開始日を示す", () => {
      const e = errorOf(validate(draft({ acquiredOn: "2026-03-31", acquisitionCost: 350_000 })));
      expect(e.code).toBe("SMALL_ASSET_OVER_THRESHOLD");
      expect(e.details).toMatchObject({ threshold: 300_000, effectiveFrom: "2006-04-01" });
    });

    it("2026-04-01 取得の 350,000 円は登録できる（基準額が 400,000 円に変わる）", () => {
      expect(validate(draft({ acquiredOn: "2026-04-01", acquisitionCost: 350_000 })).ok).toBe(true);
    });

    it("基準額ちょうどは拒否し、1 円少なければ登録できる", () => {
      expect(
        errorOf(validate(draft({ acquiredOn: "2025-06-15", acquisitionCost: 300_000 }))).code,
      ).toBe("SMALL_ASSET_OVER_THRESHOLD");
      expect(validate(draft({ acquiredOn: "2025-06-15", acquisitionCost: 299_999 })).ok).toBe(true);
      expect(
        errorOf(validate(draft({ acquiredOn: "2026-04-01", acquisitionCost: 400_000 }))).code,
      ).toBe("SMALL_ASSET_OVER_THRESHOLD");
    });

    it("適用期間の外（2029-04-01 以後、2006-03-31 以前）は SMALL_ASSET_NOT_APPLICABLE", () => {
      const after = errorOf(
        validate(draft({ acquiredOn: "2029-04-01", acquisitionCost: 100_000 })),
      );
      expect(after.code).toBe("SMALL_ASSET_NOT_APPLICABLE");
      expect(after.details).toMatchObject({ appliesFrom: "2006-04-01", appliesTo: "2029-03-31" });
      expect(
        errorOf(validate(draft({ acquiredOn: "2006-03-31", acquisitionCost: 100_000 }))).code,
      ).toBe("SMALL_ASSET_NOT_APPLICABLE");
      expect(validate(draft({ acquiredOn: "2029-03-31", acquisitionCost: 100_000 })).ok).toBe(true);
    });
  });

  describe("年間の上限（同じ年の特例の資産の合計。シナリオ3）", () => {
    const others = [
      asset({ id: "a-1", acquisitionCost: 299_000 }),
      asset({ id: "a-2", acquisitionCost: 299_000, acquiredOn: "2025-01-01" }),
    ];
    // 2025 年の既存の合計 598,000 円。上限 3,000,000 円
    const big = [...Array(9).keys()].map((i) =>
      asset({ id: `big-${i}`, acquisitionCost: 299_000, acquiredOn: "2025-02-01" }),
    ); // 2,691,000 円

    it("合計が上限ちょうどなら登録できる", () => {
      // 2,691,000 + 299,000 = 2,990,000 ≤ 3,000,000。さらに 10,000 円で 3,000,000 ちょうど
      expect(validate(draft({ acquisitionCost: 299_000 }), big).ok).toBe(true);
      const exact = [...big, asset({ id: "x", acquisitionCost: 10_000, acquiredOn: "2025-03-01" })];
      expect(validate(draft({ acquisitionCost: 299_000 }), exact).ok).toBe(true);
      const over = [...big, asset({ id: "y", acquisitionCost: 11_000, acquiredOn: "2025-03-01" })];
      const e = errorOf(validate(draft({ acquisitionCost: 299_000 }), over));
      expect(e.code).toBe("SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED");
      expect(e.details).toMatchObject({ limit: 3_000_000, total: 3_001_000 });
    });

    it("details.total は編集中の資産を含めた合計", () => {
      const e = errorOf(validate(draft({ acquisitionCost: 299_000 }), [...big, ...others]));
      expect(e.code).toBe("SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED");
      expect(e.details).toMatchObject({ total: 2_691_000 + 598_000 + 299_000 });
    });

    it("編集中の資産自身（同じ id）は足さない", () => {
      const self = asset({ id: "me", acquisitionCost: 299_000, acquiredOn: "2025-04-01" });
      // self を除くと 2,691,000 + 299,000 = 2,990,000 で上限以内
      expect(validate(draft({ id: "me", acquisitionCost: 299_000 }), [...big, self]).ok).toBe(true);
    });

    it("別の年の資産は足さない", () => {
      const lastYear = asset({ id: "l", acquisitionCost: 299_000, acquiredOn: "2024-12-31" });
      const nextYear = asset({ id: "n", acquisitionCost: 299_000, acquiredOn: "2026-01-01" });
      expect(validate(draft({ acquisitionCost: 299_000 }), [...big, lastYear, nextYear]).ok).toBe(
        true,
      );
    });

    it("取得して同じ年に除却した資産も合計に含む（特例を使ったため）", () => {
      const disposed = asset({
        id: "d",
        acquisitionCost: 11_000,
        acquiredOn: "2025-03-01",
        disposedOn: "2025-09-01",
      });
      // 2,691,000 + 11,000 + 299,000 = 3,001,000 > 3,000,000
      const e = errorOf(validate(draft({ acquisitionCost: 299_000 }), [...big, disposed]));
      expect(e.code).toBe("SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED");
      expect(e.details).toMatchObject({ total: 3_001_000 });
      // 翌年に除却した資産も同じ
      const later = asset({ ...disposed, disposedOn: "2026-02-01" });
      expect(validate(draft({ acquisitionCost: 299_000 }), [...big, later]).ok).toBe(false);
    });
  });
});

describe("depreciate（FR-021、R7）", () => {
  it("取得した年は取得価額の全額を償却する。割合 100% なら必要経費算入額も全額、未償却残高 0（シナリオ1）", () => {
    expect(depreciate(asset(), 2025)).toEqual({
      cost: 200_000,
      base: 200_000,
      ordinary: 200_000,
      total: 200_000,
      businessRatio: 10000,
      deductible: 200_000,
      closingBookValue: 0,
    });
  });

  it("割合 50% なら償却費は全額、必要経費算入額は 50%（シナリオ4）", () => {
    expect(depreciate(asset({ businessRatio: 5000 }), 2025)).toMatchObject({
      total: 200_000,
      deductible: 100_000,
      closingBookValue: 0,
    });
  });

  it("必要経費算入額は円未満を切り捨てる", () => {
    expect(
      depreciate(asset({ acquisitionCost: 100_001, businessRatio: 5000 }), 2025).deductible,
    ).toBe(50_000);
    expect(
      depreciate(asset({ acquisitionCost: 99_999, businessRatio: 3333 }), 2025).deductible,
    ).toBe(Math.floor((99_999 * 3333) / 10000));
  });

  it("取得した年以外は償却しない（取得価額と割合は残る）", () => {
    for (const year of [2024, 2026]) {
      expect(depreciate(asset(), year)).toEqual({
        cost: 200_000,
        base: 0,
        ordinary: 0,
        total: 0,
        businessRatio: 10000,
        deductible: 0,
        closingBookValue: 0,
      });
    }
  });
});

describe("proposeDepreciationAdjustment（FR-021〜022、INV-23）", () => {
  const propose = (a: FixedAsset, year = 2025) =>
    proposeDepreciationAdjustment(a, year, INDIVIDUAL_ACCOUNT_LIST);
  const proposalOf = (a: FixedAsset, year = 2025) => {
    const r = propose(a, year);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };

  it("割合 100% は「減価償却費 / 資産の勘定」だけ。年度末日付、税区分は対象外", () => {
    const p = proposalOf(asset());
    expect(p).toMatchObject({
      kind: "depreciation",
      sourceId: "asset-1",
      breakdown: { acquisitionCost: 200_000, businessRatio: 10000, deductible: 200_000 },
    });
    expect(p?.journal.date).toBe("2025-12-31");
    expect(p?.journal.lines).toEqual([
      { side: "debit", accountId: DEPRECIATION, amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: EQUIPMENT, amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
  });

  it("割合 50% は、家事分の「事業主貸 / 減価償却費」が加わる（シナリオ4）", () => {
    const p = proposalOf(asset({ businessRatio: 5000 }));
    expect(p?.journal.lines).toEqual([
      { side: "debit", accountId: DEPRECIATION, amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: EQUIPMENT, amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "debit", accountId: DRAWINGS, amount: 100_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: DEPRECIATION, amount: 100_000, taxCategory: "OUT_OF_SCOPE" },
    ]);
    expect(p?.breakdown).toMatchObject({ deductible: 100_000, businessRatio: 5000 });
  });

  it("割合 0% は全額が家事分", () => {
    const p = proposalOf(asset({ businessRatio: 0 }));
    expect(p?.journal.lines.map((l) => [l.side, l.accountId, l.amount])).toEqual([
      ["debit", DEPRECIATION, 200_000],
      ["credit", EQUIPMENT, 200_000],
      ["debit", DRAWINGS, 200_000],
      ["credit", DEPRECIATION, 200_000],
    ]);
  });

  it("既存の仕訳を結びつけた資産は案を作らない（シナリオ5）", () => {
    expect(proposalOf(asset({ linkedJournalId: "j-1" }))).toBeNull();
  });

  it("取得した年以外、取得した年の末日までに除却した資産は案を作らない", () => {
    expect(proposalOf(asset(), 2026)).toBeNull();
    expect(proposalOf(asset(), 2024)).toBeNull();
    expect(proposalOf(asset({ disposedOn: "2025-12-31" }))).toBeNull();
    expect(proposalOf(asset({ disposedOn: "2026-01-01" }))).not.toBeNull();
  });

  it("事業主貸・減価償却費の科目がなければ ACCOUNT_NOT_FOUND", () => {
    const r = proposeDepreciationAdjustment(
      asset({ businessRatio: 5000 }),
      2025,
      INDIVIDUAL_ACCOUNT_LIST.filter((a) => a.code !== "5180"),
    );
    expect(!r.ok && r.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
