import { describe, expect, it } from "vitest";
import type { NewJournal } from "../src/ports.ts";
import type {
  AdjustmentRef,
  ClosingAuditEntry,
  DeferredAsset,
  FixedAsset,
  HomeUseAllocation,
} from "../src/types.ts";
import { ok } from "../src/types.ts";
import { fakeClosingUnitOfWork } from "./fakes.ts";
import { NOW as AT } from "./test-dates.ts";

const journal = (id: string, journalNo: number): NewJournal => ({
  id,
  journalNo,
  date: "2025-12-31",
  fiscalPeriodId: "period-2025",
  memo: null,
  correctsJournalId: null,
  createdAt: AT,
  lines: [
    {
      id: `${id}-1`,
      lineNo: 1,
      side: "debit",
      accountId: "a",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
    {
      id: `${id}-2`,
      lineNo: 2,
      side: "credit",
      accountId: "b",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
  ],
});

const allocation: HomeUseAllocation = {
  id: "alloc-1",
  fiscalYear: 2025,
  accountId: "a",
  subAccountId: null,
  businessRatio: 6000,
  basis: "床面積",
  changeReason: null,
  createdAt: AT,
  updatedAt: AT,
};

const asset: FixedAsset = {
  id: "asset-1",
  name: "PC",
  quantity: null,
  acquiredOn: "2025-05-01",
  acquisitionCost: 250000,
  method: "small_asset_28_2",
  usefulLifeYears: null,
  inServiceOn: null,
  priorAccumulated: 0,
  priorThroughYear: null,
  businessRatio: 10000,
  assetAccountId: "b",
  linkedJournalId: null,
  note: null,
  disposedOn: null,
  disposalKind: null,
  createdAt: AT,
  updatedAt: AT,
};

const ref: AdjustmentRef = {
  journalId: "j-1",
  kind: "home_use",
  allocationId: "alloc-1",
  assetId: null,
  deferredAssetId: null,
  fiscalYear: 2025,
};

const deferred: DeferredAsset = {
  id: "def-1",
  name: "開業費",
  totalAmount: 600000,
  openedOn: "2025-04-01",
  priorAccumulated: 0,
  priorThroughYear: null,
  accountId: "b",
  note: null,
  createdAt: AT,
  updatedAt: AT,
};

const audit: ClosingAuditEntry = {
  id: "audit-1",
  occurredAt: AT,
  targetType: "home_use_allocation",
  targetId: "alloc-1",
  action: "create",
  reason: null,
  beforeJson: null,
  afterJson: "{}",
};

describe("fakeClosingUnitOfWork", () => {
  it("途中の例外で仕訳も参照も残らない（R4。仕訳・按分・資産・参照・履歴・マスタをすべて戻す）", () => {
    const uow = fakeClosingUnitOfWork();
    expect(() =>
      uow.run(({ ledger, masters, closing }) => {
        masters.insertTag({ id: "tag-1", name: "出張" });
        closing.upsertHomeUseAllocation(allocation);
        closing.upsertFixedAsset(asset);
        ledger.insertJournal(journal("j-1", 1));
        closing.insertAdjustmentRef(ref);
        closing.appendClosingAudit(audit);
        closing.replaceRentDetails(2025, [
          {
            id: "r-1",
            fiscalYear: 2025,
            payee: "山田",
            property: "事務所",
            annualRent: 100,
            deductibleAmount: 50,
            sortOrder: 1,
          },
        ]);
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.masters.listTags()).toEqual([]);
    expect(uow.closing.listHomeUseAllocations(2025)).toEqual([]);
    expect(uow.closing.listFixedAssets()).toEqual([]);
    expect(uow.closing.listAdjustmentRefs(2025)).toEqual([]);
    expect(uow.closing.listRentDetails(2025)).toEqual([]);
    expect(uow.closing.audits).toEqual([]);
  });

  it("例外がなければ仕訳と参照が残る。fiscalYear で絞り込める", () => {
    const uow = fakeClosingUnitOfWork();
    uow.run(({ ledger, closing }) => {
      ledger.insertJournal(journal("j-1", 1));
      closing.insertAdjustmentRef(ref);
      closing.upsertHomeUseAllocation(allocation);
      return ok(null);
    });
    expect(uow.ledger.journals.map((j) => j.id)).toEqual(["j-1"]);
    expect(uow.closing.listAdjustmentRefs(2025)).toEqual([ref]);
    expect(uow.closing.listAdjustmentRefs(2024)).toEqual([]);
    expect(uow.closing.listHomeUseAllocations(2024)).toEqual([]);
  });

  it("009 のメソッド: 償却率・開業費・決定の往復と出所ごとの参照", () => {
    const uow = fakeClosingUnitOfWork();
    const c = uow.closing;
    expect(c.listStraightLineRates()).toEqual([]);
    c.straightLineRates = [
      {
        usefulLifeYears: 4,
        ratePermille: 250,
        effectiveFrom: "2007-04-01",
        effectiveTo: null,
        sourceUrl: "https://example.test/",
      },
    ];
    expect(c.listStraightLineRates().map((r) => r.ratePermille)).toEqual([250]);

    c.upsertDeferredAsset(deferred);
    c.upsertDeferredAsset({ ...deferred, name: "開業費（更新）" });
    expect(c.listDeferredAssets().map((d) => d.name)).toEqual(["開業費（更新）"]);

    const decision = {
      deferredAssetId: "def-1",
      fiscalYear: 2025,
      amount: 100000,
      decidedAt: AT,
      updatedAt: AT,
    };
    c.upsertDeferredAmortization(decision);
    c.upsertDeferredAmortization({ ...decision, fiscalYear: 2026, amount: 50000 });
    c.upsertDeferredAmortization({ ...decision, amount: 120000 });
    expect(c.listDeferredAmortizations().map((d) => [d.fiscalYear, d.amount])).toEqual([
      [2025, 120000],
      [2026, 50000],
    ]);

    uow.ledger.insertJournal(journal("j-1", 1));
    uow.ledger.insertJournal(journal("j-2", 2));
    uow.ledger.insertJournal(journal("j-3", 3));
    c.insertAdjustmentRef({
      ...ref,
      journalId: "j-1",
      kind: "depreciation",
      allocationId: null,
      assetId: "asset-1",
    });
    c.insertAdjustmentRef({
      ...ref,
      journalId: "j-2",
      kind: "deferred_amortization",
      allocationId: null,
      deferredAssetId: "def-1",
      fiscalYear: 2026,
    });
    c.insertAdjustmentRef({ ...ref, journalId: "j-3" });
    expect(c.listAdjustmentRefsBySource({ assetId: "asset-1" }).map((r) => r.journalId)).toEqual([
      "j-1",
    ]);
    expect(
      c.listAdjustmentRefsBySource({ deferredAssetId: "def-1" }).map((r) => r.journalId),
    ).toEqual(["j-2"]);
  });

  it("009 のメソッドの書き込みも途中の例外で戻る", () => {
    const uow = fakeClosingUnitOfWork();
    expect(() =>
      uow.run(({ closing }) => {
        closing.upsertDeferredAsset(deferred);
        closing.upsertDeferredAmortization({
          deferredAssetId: "def-1",
          fiscalYear: 2025,
          amount: 1,
          decidedAt: AT,
          updatedAt: AT,
        });
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(uow.closing.listDeferredAssets()).toEqual([]);
    expect(uow.closing.listDeferredAmortizations()).toEqual([]);
  });

  it("参照の仕訳 ID は一意で、存在しない仕訳への参照は拒否する（FK）", () => {
    const uow = fakeClosingUnitOfWork();
    expect(() => uow.closing.insertAdjustmentRef(ref)).toThrow(/FOREIGN KEY/);
    uow.ledger.insertJournal(journal("j-1", 1));
    uow.closing.insertAdjustmentRef(ref);
    expect(() => uow.closing.insertAdjustmentRef(ref)).toThrow(/UNIQUE/);
  });

  it("upsert は id（回答・メモは年度と種別）で置き換え、削除できるものは削除できる", () => {
    const uow = fakeClosingUnitOfWork();
    const c = uow.closing;
    c.upsertHomeUseAllocation(allocation);
    c.upsertHomeUseAllocation({ ...allocation, businessRatio: 5000 });
    expect(c.listHomeUseAllocations(2025).map((a) => a.businessRatio)).toEqual([5000]);

    expect(c.getDeductionAnswers(2025)).toBeUndefined();
    const answers = {
      fiscalYear: 2025,
      doubleEntry: true,
      statementsAttached: true,
      filedOnTime: true,
      eTax: false,
      electronicBooks: false,
      updatedAt: AT,
    };
    c.upsertDeductionAnswers(answers);
    c.upsertDeductionAnswers({ ...answers, eTax: true });
    expect(c.getDeductionAnswers(2025)?.eTax).toBe(true);

    c.upsertClosingNote({
      fiscalYear: 2025,
      kind: "special_circumstances",
      body: "a",
      updatedAt: AT,
    });
    c.upsertClosingNote({
      fiscalYear: 2025,
      kind: "special_circumstances",
      body: "b",
      updatedAt: AT,
    });
    expect(c.listClosingNotes(2025).map((n) => n.body)).toEqual(["b"]);
  });

  it("listTaxParameters は初期の値を返し、listFixedAssets は取得日の順", () => {
    const uow = fakeClosingUnitOfWork();
    expect(uow.closing.listTaxParameters()).toEqual([]);
    uow.closing.upsertFixedAsset({ ...asset, id: "b", acquiredOn: "2025-06-01" });
    uow.closing.upsertFixedAsset({ ...asset, id: "a", acquiredOn: "2025-01-01" });
    expect(uow.closing.listFixedAssets().map((x) => x.id)).toEqual(["a", "b"]);
  });
});
